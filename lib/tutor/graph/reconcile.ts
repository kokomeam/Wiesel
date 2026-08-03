/**
 * Concept-graph RECONCILIATION orchestrator (TUTOR-1 Wave 1.4 · Directive §W1.4).
 *
 * When a course with an EXISTING active graph republishes, we don't re-extract
 * from scratch — we re-derive candidates from the NEW publication's snapshot
 * (the SAME chunk→propose→grain→canonicalize pipeline extraction uses, imported
 * verbatim from extraction.ts), then DIFF them against the stored graph and
 * classify every change so the creator reviews a precise delta:
 *
 *   matched  — a candidate ≈ an active node (exact/alias title, else embedding
 *              cosine ≥ TUTOR_RECONCILE_MATCH_THRESHOLD). Keeps the node id.
 *              Material change on a non-creator_edited node → op 'update'; nothing
 *              material OR creator_edited → suppressed (no item). A creator_edited
 *              node whose anchor content vanished → FLAG, never auto-change.
 *   added    — an unmatched candidate → a NEW node (created_by 'reconciliation').
 *   removed  — an active node no candidate matches → op 'update' status→'retired'
 *              (NEVER deleted). A creator-CREATED node is suppressed + FLAGGED.
 *   split    — ONE active node is the best match of ≥2 candidates → children
 *              created, parent retired; lineage {parent→children, confidenceFactor}.
 *   merged   — ≥2 active nodes best-match ONE candidate → the STRONGEST survives
 *              (op 'update' with fresh fields), the others flip 'merged_into' →
 *              survivor; lineage {survivor, mergedNodeIds}.
 *
 * Anchors re-resolve against the NEW snapshot (R-13 downgrade). Edges: locked
 * edges NEVER produce items (AC-T1.8) — unless an endpoint got retired-for-content
 * deletion, then FLAG only; non-locked edges re-infer over the POST-DIFF active
 * taught set (create new / delete no-longer-inferred / no-op unchanged). Snapshot
 * map: fresh rows for the new publication for every post-diff active node.
 *
 * Persist-then-stage EXACTLY like stageExtractionResult (§W1.4): apply every
 * mutation NOW (nodes via repository writes, edges via the definer RPC), then ONE
 * change_sets row whose items carry before/after ConceptGraphItemPayloads with
 * classification+lineage, then the fate finding (dedupe_key
 * `graph_reconciliation:{courseId}`, open→proposed). Reject through the existing
 * concept_graph partition restores the PRIOR graph byte-for-byte. A pending
 * concept_graph set short-circuits ({alreadyPending}) via the shared guard.
 *
 * Budgeted + cost-emitted like extraction (jobType 'reconciliation'; runId-scoped
 * retry-stable synthetic ids).
 */

import type { Database, Json } from "@/lib/database.types";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import { resolveExtractionConfig, type ExtractionConfig } from "./config";
import {
  generateCandidates,
  inferAndHardenEdges,
  buildSnapshotAnchorIndex,
  resolveAnchors,
  lessonIdForBlock,
  emitAndAccumulate,
  type GraphExtractionDeps,
  type RunGraphExtractionArgs,
  type CallBudget,
  type UsageTotals,
} from "./extraction";
import { normalizeTitleKey } from "./canonicalize";
import type { PublicationSnapshot } from "@/lib/course/publish/schemas";
import {
  createConceptNode,
  versionedUpdateConceptNode,
  listConceptNodes,
  listConceptEdges,
  upsertConceptEdge,
  deleteConceptEdge,
  type ConceptNodeCreateInput,
} from "./repository";
import type { ConceptAnchor, ConceptEdge, ConceptNode } from "./schemas";
import { ConceptGraphItemPayloadSchema, type ConceptGraphItemPayload } from "./schemas";
import { findPendingConceptGraphChangeSet } from "./stageGraphChangeSet";
import { ConceptEdgeCycleError } from "./errors";

/* ─────────────────────────────── result type ────────────────────────────── */

export interface GraphReconciliationResult {
  ok: boolean;
  alreadyPending?: boolean;
  changeSetId: string | null;
  findingId: string | null;
  nodeCount: number;
  edgeCount: number;
  assumedPriorCount: number;
  flags: string[];
  droppedEdges: { reason: string; count: number }[];
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number };
  checkpoint: string | null;
  /** The per-classification counts (Directive §W1.4 API). */
  classified: { matched: number; added: number; removed: number; split: number; merged: number };
}

/** dedupe_key for the reconciliation fate row (parallels graphExtractionDedupeKey). */
export function graphReconciliationDedupeKey(courseId: string): string {
  return `graph_reconciliation:${courseId}`;
}

/* ─────────────────────── the PURE matcher + classifier ───────────────────── */

/** A stored active node reduced to the fields the matcher/classifier read. */
export interface StoredNodeLite {
  id: string;
  title: string;
  aliases: string[];
  anchors: ConceptAnchor[];
  createdBy: ConceptNode["createdBy"];
  creatorEdited: boolean;
  embedding: number[] | null;
  version: number;
  description: string;
}

/** A candidate concept reduced to the fields the matcher/classifier read. Carries
 *  its embedding (the reconciliation embed batch fills it) + resolved anchors. */
export interface CandidateLite {
  title: string;
  description: string;
  aliases: string[];
  anchors: ConceptAnchor[];
  anchorDowngraded: boolean;
  embedding: number[] | null;
}

/** One candidate→node match verdict. `nodeId` null ⇒ unmatched (an addition).
 *  `byTitle` records the exact/alias path won (score 1); else `score` is cosine. */
export interface MatchVerdict {
  candidateIndex: number;
  nodeId: string | null;
  score: number;
  byTitle: boolean;
}

/** Cosine similarity of two equal-length vectors (0 for a zero/absent vector). */
function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0,
    ma = 0,
    mb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  const denom = Math.sqrt(ma) * Math.sqrt(mb);
  return denom === 0 ? 0 : dot / denom;
}

/** BOTH-direction title/alias equality: the candidate's title/aliases vs the
 *  node's title/aliases, normalized. A match if ANY normalized string on one
 *  side equals ANY on the other (Directive: "check BOTH directions incl. the
 *  node's aliases"). Pure. */
export function titleOrAliasMatch(cand: { title: string; aliases: string[] }, node: { title: string; aliases: string[] }): boolean {
  const candKeys = new Set([cand.title, ...cand.aliases].map(normalizeTitleKey));
  const nodeKeys = [node.title, ...node.aliases].map(normalizeTitleKey);
  return nodeKeys.some((k) => candKeys.has(k));
}

/** Score one candidate↔node pair: a title/alias match is 1 (byTitle), else cosine
 *  (0 when either vector is absent). Below threshold ⇒ NOT a match (score 0,
 *  byTitle false, matched:false). Pure — the ONE place the match rule lives. */
export function scorePair(
  cand: CandidateLite,
  node: StoredNodeLite,
  threshold: number
): { matched: boolean; score: number; byTitle: boolean } {
  if (titleOrAliasMatch(cand, node)) return { matched: true, score: 1, byTitle: true };
  const score = cosine(cand.embedding, node.embedding);
  if (score >= threshold) return { matched: true, score, byTitle: false };
  return { matched: false, score: 0, byTitle: false };
}

/**
 * PURE matcher — candidate→node direction. For each candidate, pick the
 * best-matching active node: an exact/alias title match wins (score 1, byTitle);
 * else the strictly-highest-cosine node ≥ threshold (ties → earliest node order,
 * deterministic). No qualifying node → { nodeId:null } (an addition).
 */
export function matchCandidates(
  candidates: CandidateLite[],
  storedNodes: StoredNodeLite[],
  threshold: number
): MatchVerdict[] {
  return candidates.map((cand, candidateIndex) => {
    let best: { nodeId: string; score: number; byTitle: boolean } | null = null;
    for (const node of storedNodes) {
      const s = scorePair(cand, node, threshold);
      if (!s.matched) continue;
      // A title match (score 1) dominates; then strictly-higher cosine; ties keep
      // the earliest node (stable, since we only replace on a STRICTLY better score).
      if (best === null || s.score > best.score) best = { nodeId: node.id, score: s.score, byTitle: s.byTitle };
    }
    if (best) return { candidateIndex, nodeId: best.nodeId, score: best.score, byTitle: best.byTitle };
    return { candidateIndex, nodeId: null, score: 0, byTitle: false };
  });
}

/** One node→candidate best-match verdict. `candidateIndex` null ⇒ the node has no
 *  matching candidate (a removal). */
export interface NodeMatchVerdict {
  nodeId: string;
  candidateIndex: number | null;
  score: number;
  byTitle: boolean;
}

/**
 * PURE matcher — node→candidate direction. For each stored active node, pick its
 * best-matching candidate under the SAME rule. Used to detect MERGE (≥2 nodes
 * best-match ONE candidate) and to confirm a MATCHED pair is mutual.
 */
export function matchNodes(
  storedNodes: StoredNodeLite[],
  candidates: CandidateLite[],
  threshold: number
): NodeMatchVerdict[] {
  return storedNodes.map((node) => {
    let best: { candidateIndex: number; score: number; byTitle: boolean } | null = null;
    candidates.forEach((cand, candidateIndex) => {
      const s = scorePair(cand, node, threshold);
      if (!s.matched) return;
      if (best === null || s.score > best.score) best = { candidateIndex, score: s.score, byTitle: s.byTitle };
    });
    if (best !== null) {
      const b = best as { candidateIndex: number; score: number; byTitle: boolean };
      return { nodeId: node.id, candidateIndex: b.candidateIndex, score: b.score, byTitle: b.byTitle };
    }
    return { nodeId: node.id, candidateIndex: null, score: 0, byTitle: false };
  });
}

/* ─────────────────────────── classification plan ────────────────────────── */

export type Classification = "matched" | "added" | "removed" | "split" | "merged";

/** Split/merge lineage payloads (Wave 2's mastery redistribution reads these). */
export interface SplitLineage {
  parentNodeId: string;
  childNodeIds: string[];
  confidenceFactor: number;
}
export interface MergeLineage {
  survivorNodeId: string;
  mergedNodeIds: string[];
}

/** One planned node operation. `create` mints a node from a candidate; `update`
 *  mutates an existing node (matched update / removed-retire / split-parent-retire
 *  / merged survivor+absorbed). `suppressed` produces NO change_set item (a flag
 *  may still be raised). */
export type NodeOp =
  | {
      kind: "create";
      classification: Extract<Classification, "added" | "split">;
      candidateIndex: number;
      lineage?: SplitLineage;
      /** For split children: the placeholder id used to wire lineage BEFORE the
       *  DB mints real ids — the executor rewrites lineage to real ids. */
      placeholderId: string;
    }
  | {
      kind: "update";
      classification: Exclude<Classification, "added">;
      nodeId: string;
      /** How to mutate the node. */
      patch: NodeUpdatePatch;
      lineage?: SplitLineage | MergeLineage;
    }
  | {
      kind: "suppressed";
      classification: Classification;
      nodeId: string;
      reason: string;
    };

/** What a node 'update' op changes. `retire` flips status→retired; `mergeInto`
 *  flips status→merged_into + merged_into_node_id; `content` overwrites
 *  title/description/aliases/anchors (matched-changed / merged survivor). */
export interface NodeUpdatePatch {
  retire?: true;
  mergeIntoNodeId?: string;
  content?: { title: string; description: string; aliases: string[]; anchors: ConceptAnchor[] };
}

export interface ReconciliationPlan {
  nodeOps: NodeOp[];
  flags: string[];
  classified: { matched: number; added: number; removed: number; split: number; merged: number };
  /** The ids of nodes RETIRED specifically because their creator_edited/anchor
   *  content vanished — endpoints whose retirement a locked edge must be flagged
   *  for (Directive: locked_edge_endpoint_retired). Populated for content-deletion
   *  retirements only. */
  contentDeletedRetiredNodeIds: string[];
}

/** Does a matched candidate materially differ from its node? (title/description/
 *  anchors). Aliases are additive metadata; a pure alias delta is NOT material
 *  on its own — a title/description/anchor change is what surfaces a review. */
function materialChange(cand: CandidateLite, node: StoredNodeLite): boolean {
  if (normalizeTitleKey(cand.title) !== normalizeTitleKey(node.title)) return true;
  if (cand.description.trim() !== node.description.trim()) return true;
  return !anchorsEqual(cand.anchors, node.anchors);
}

/** Anchor-set equality (order-insensitive), on the (lessonId,blockId,slideId) key. */
function anchorsEqual(a: ConceptAnchor[], b: ConceptAnchor[]): boolean {
  const key = (x: ConceptAnchor) => `${x.lessonId}::${x.blockId}::${x.slideId ?? ""}`;
  const sa = new Set(a.map(key));
  const sb = new Set(b.map(key));
  if (sa.size !== sb.size) return false;
  for (const k of sa) if (!sb.has(k)) return false;
  return true;
}

/** Do NONE of a node's anchor blockIds still exist in the new snapshot? (⇒ its
 *  underlying content vanished — the creator_edited protection case). A node with
 *  zero anchors is NOT "content gone" (it never had trackable content). */
function contentVanished(node: StoredNodeLite, snapshotBlockIds: Set<string>): boolean {
  if (node.anchors.length === 0) return false;
  return node.anchors.every((a) => !snapshotBlockIds.has(a.blockId));
}

/**
 * PURE classifier — the heart of W1.4. Consumes BOTH match directions
 * (candidate→node and node→candidate) + the stored nodes + the candidates, and
 * emits the full node-op plan with classifications + lineage. No DB, no model —
 * golden-testable.
 *
 *   SPLIT   — ONE node is the candToNode best match of ≥2 candidates. Those
 *             candidates become the children; the parent is retired.
 *   MERGE   — ≥2 nodes have the SAME nodeToCand best candidate. Those nodes merge:
 *             the strongest survives, the rest flip 'merged_into'.
 *   MATCHED — a candidate/node that are each other's best (mutual), not consumed by
 *             a split/merge: update-or-suppress.
 *   ADDED   — a candidate with no matching node.
 *   REMOVED — an active node with no matching candidate (either direction) and not
 *             a split/merge participant: retire (or suppress+flag a creator node).
 *
 * PRECEDENCE (a node/candidate can only be classified once):
 *   1. MERGE groups are formed first (they claim their member nodes + the shared
 *      candidate). 2. SPLIT groups next over the remaining nodes/candidates.
 *   3. MATCHED over the remaining mutual pairs. 4. ADDED / REMOVED for leftovers.
 */
export function classifyReconciliation(
  candidates: CandidateLite[],
  storedNodes: StoredNodeLite[],
  candVerdicts: MatchVerdict[],
  nodeVerdicts: NodeMatchVerdict[],
  cfg: Pick<ExtractionConfig, "lineageConfidence">,
  snapshotBlockIds: Set<string>
): ReconciliationPlan {
  const flags: string[] = [];
  const nodeOps: NodeOp[] = [];
  const classified = { matched: 0, added: 0, removed: 0, split: 0, merged: 0 };
  const contentDeletedRetiredNodeIds: string[] = [];

  const nodeById = new Map(storedNodes.map((n) => [n.id, n]));
  const orderOfNode = new Map(storedNodes.map((n, i) => [n.id, i]));
  const candToNode = new Map<number, string | null>();
  for (const v of candVerdicts) candToNode.set(v.candidateIndex, v.nodeId);
  const nodeToCand = new Map<string, number | null>();
  const nodeVerdictById = new Map(nodeVerdicts.map((v) => [v.nodeId, v]));
  for (const v of nodeVerdicts) nodeToCand.set(v.nodeId, v.candidateIndex);

  const consumedNodes = new Set<string>();
  const consumedCandidates = new Set<number>();
  const contentDeletedSet = new Set<string>();

  // === (1) MERGE: group nodes by their nodeToCand best candidate; ≥2 ⇒ merge. ===
  const nodesByBestCand = new Map<number, string[]>();
  for (const v of nodeVerdicts) {
    if (v.candidateIndex === null) continue;
    nodesByBestCand.set(v.candidateIndex, [...(nodesByBestCand.get(v.candidateIndex) ?? []), v.nodeId]);
  }
  for (const [candIndex, nodeIds] of nodesByBestCand) {
    if (nodeIds.length < 2) continue;
    const cand = candidates[candIndex];
    // Survivor = the strongest match (byTitle then higher score; ties → node order).
    const ranked = nodeIds
      .map((id) => {
        const v = nodeVerdictById.get(id)!;
        return { id, byTitle: v.byTitle, score: v.score, order: orderOfNode.get(id) ?? 0 };
      })
      .sort((a, b) => Number(b.byTitle) - Number(a.byTitle) || b.score - a.score || a.order - b.order);
    const survivor = ranked[0].id;
    const absorbed = ranked.slice(1).map((r) => r.id);
    const lineage: MergeLineage = { survivorNodeId: survivor, mergedNodeIds: absorbed };
    for (const id of nodeIds) consumedNodes.add(id);
    consumedCandidates.add(candIndex);

    nodeOps.push({
      kind: "update",
      classification: "merged",
      nodeId: survivor,
      patch: {
        content: {
          title: cand.title,
          description: cand.description,
          aliases: mergeAliases(cand, absorbed.map((id) => nodeById.get(id)!)),
          anchors: cand.anchors,
        },
      },
      lineage,
    });
    classified.merged += 1;
    for (const id of absorbed) {
      nodeOps.push({ kind: "update", classification: "merged", nodeId: id, patch: { mergeIntoNodeId: survivor }, lineage });
      classified.merged += 1;
    }
  }

  // === (2) SPLIT: group candidates by their candToNode best node; ≥2 ⇒ split. ===
  const candsByBestNode = new Map<string, number[]>();
  for (const v of candVerdicts) {
    if (v.nodeId === null || consumedCandidates.has(v.candidateIndex)) continue;
    candsByBestNode.set(v.nodeId, [...(candsByBestNode.get(v.nodeId) ?? []), v.candidateIndex]);
  }
  for (const [nodeId, candIndexes] of candsByBestNode) {
    if (consumedNodes.has(nodeId)) continue; // a merged node isn't also a split source
    if (candIndexes.length < 2) continue;
    consumedNodes.add(nodeId);
    for (const ci of candIndexes) consumedCandidates.add(ci);

    const childPlaceholders = candIndexes.map((ci) => `split-child:${nodeId}:${ci}`);
    const lineage: SplitLineage = {
      parentNodeId: nodeId,
      childNodeIds: [...childPlaceholders],
      confidenceFactor: cfg.lineageConfidence,
    };
    candIndexes.forEach((ci, k) => {
      nodeOps.push({ kind: "create", classification: "split", candidateIndex: ci, placeholderId: childPlaceholders[k], lineage });
      classified.split += 1;
    });
    nodeOps.push({ kind: "update", classification: "split", nodeId, patch: { retire: true }, lineage });
    classified.split += 1;
  }

  // === (3) MATCHED / ADDED over the remaining candidates. ===
  for (let ci = 0; ci < candidates.length; ci += 1) {
    if (consumedCandidates.has(ci)) continue;
    const nodeId = candToNode.get(ci) ?? null;
    const cand = candidates[ci];
    // Unmatched OR the best node was consumed elsewhere ⇒ ADD.
    if (nodeId === null || consumedNodes.has(nodeId)) {
      nodeOps.push({ kind: "create", classification: "added", candidateIndex: ci, placeholderId: `added:${ci}` });
      classified.added += 1;
      continue;
    }
    const node = nodeById.get(nodeId);
    if (!node) {
      nodeOps.push({ kind: "create", classification: "added", candidateIndex: ci, placeholderId: `added:${ci}` });
      classified.added += 1;
      continue;
    }
    consumedNodes.add(nodeId);
    if (node.creatorEdited) {
      if (contentVanished(node, snapshotBlockIds)) flags.push(`creator_edited_content_gone:${node.id}`);
      nodeOps.push({ kind: "suppressed", classification: "matched", nodeId, reason: "creator_edited" });
      classified.matched += 1;
      continue;
    }
    if (!materialChange(cand, node)) {
      nodeOps.push({ kind: "suppressed", classification: "matched", nodeId, reason: "unchanged" });
      classified.matched += 1;
      continue;
    }
    nodeOps.push({
      kind: "update",
      classification: "matched",
      nodeId,
      patch: { content: { title: cand.title, description: cand.description, aliases: unionAliases(cand, node), anchors: cand.anchors } },
    });
    classified.matched += 1;
  }

  // === (4) REMOVED: any active node not consumed by a merge/split/match. ===
  for (const node of storedNodes) {
    if (consumedNodes.has(node.id)) continue;
    if (node.createdBy === "creator") {
      nodeOps.push({ kind: "suppressed", classification: "removed", nodeId: node.id, reason: "creator_node" });
      flags.push(`creator_node_unmatched:${node.id}`);
      classified.removed += 1;
      continue;
    }
    if (contentVanished(node, snapshotBlockIds)) {
      contentDeletedRetiredNodeIds.push(node.id);
      contentDeletedSet.add(node.id);
    }
    nodeOps.push({ kind: "update", classification: "removed", nodeId: node.id, patch: { retire: true } });
    classified.removed += 1;
  }

  void contentDeletedSet;
  return { nodeOps, flags, classified, contentDeletedRetiredNodeIds };
}

/** Merge a candidate's aliases with a node's title/aliases (the node's title is
 *  now an alias of the survivor). Deduped, dropping the candidate's own title. */
function unionAliases(cand: CandidateLite, node: StoredNodeLite): string[] {
  const canonKey = normalizeTitleKey(cand.title);
  const out = new Set<string>();
  for (const a of [...cand.aliases, node.title, ...node.aliases]) {
    const t = a.trim();
    if (t && normalizeTitleKey(t) !== canonKey) out.add(t);
  }
  return [...out];
}

/** Merge a candidate's aliases with the absorbed nodes' titles+aliases (a merge:
 *  every absorbed title becomes a searchable alias of the survivor). */
function mergeAliases(cand: CandidateLite, absorbed: StoredNodeLite[]): string[] {
  const canonKey = normalizeTitleKey(cand.title);
  const out = new Set<string>();
  for (const a of cand.aliases) {
    const t = a.trim();
    if (t && normalizeTitleKey(t) !== canonKey) out.add(t);
  }
  for (const node of absorbed) {
    for (const a of [node.title, ...node.aliases]) {
      const t = a.trim();
      if (t && normalizeTitleKey(t) !== canonKey) out.add(t);
    }
  }
  return [...out];
}

/* ─────────────────────── edge re-inference (pure diff) ───────────────────── */

/** An edge op resolved against the post-diff active graph. `create` inserts an
 *  inferred edge that doesn't exist; `delete` drops a non-locked edge no longer
 *  inferred. Locked + unchanged edges produce NO op. */
export type EdgeOp =
  | { kind: "create"; sourceNodeId: string; targetNodeId: string; edgeKind: ConceptEdge["kind"]; evidenceRefs: unknown[] }
  | { kind: "delete"; edge: ConceptEdge };

/**
 * PURE edge diff. Given the freshly inferred edges (index-addressed against the
 * `activeNodes` list), the existing edges, and the set of LOCKED edge ids:
 *   - a locked edge is untouched (no op, ever — AC-T1.8);
 *   - an inferred edge with no existing (non-)locked twin → 'create';
 *   - an existing NON-locked edge no longer inferred → 'delete';
 *   - an edge both existing and inferred → no op.
 * Inferred edges whose endpoints aren't active (index out of range) are dropped.
 */
export function diffEdges(
  inferred: { sourceIndex: number; targetIndex: number; kind: ConceptEdge["kind"]; evidenceQuote: string; confidence: number }[],
  activeNodeIds: string[],
  existingEdges: ConceptEdge[]
): EdgeOp[] {
  const ops: EdgeOp[] = [];
  const key = (s: string, t: string, k: string) => `${s}->${t}:${k}`;

  // Resolve inferred edges to node-id triples (drop out-of-range endpoints).
  const inferredKeys = new Set<string>();
  const inferredResolved: { s: string; t: string; k: ConceptEdge["kind"]; evidence: unknown[] }[] = [];
  for (const e of inferred) {
    const s = activeNodeIds[e.sourceIndex];
    const t = activeNodeIds[e.targetIndex];
    if (!s || !t || s === t) continue;
    const kk = key(s, t, e.kind);
    if (inferredKeys.has(kk)) continue;
    inferredKeys.add(kk);
    inferredResolved.push({ s, t, k: e.kind, evidence: [{ quote: e.evidenceQuote, confidence: e.confidence }] });
  }

  const existingByKey = new Map<string, ConceptEdge>();
  for (const e of existingEdges) existingByKey.set(key(e.sourceNodeId, e.targetNodeId, e.kind), e);

  // creates: inferred not already existing.
  for (const ie of inferredResolved) {
    const existing = existingByKey.get(key(ie.s, ie.t, ie.k));
    if (!existing) ops.push({ kind: "create", sourceNodeId: ie.s, targetNodeId: ie.t, edgeKind: ie.k, evidenceRefs: ie.evidence });
  }
  // deletes: existing NON-locked edge no longer inferred.
  for (const e of existingEdges) {
    if (e.creatorLocked) continue; // locked edges never touched
    if (!inferredKeys.has(key(e.sourceNodeId, e.targetNodeId, e.kind))) ops.push({ kind: "delete", edge: e });
  }
  return ops;
}

/* ─────────────────────────────── orchestrator ───────────────────────────── */

export async function runGraphReconciliation(
  deps: GraphExtractionDeps,
  args: RunGraphExtractionArgs
): Promise<GraphReconciliationResult> {
  const cfg = resolveExtractionConfig(deps.config);
  const totals: UsageTotals = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 };
  const budget: CallBudget = { remaining: cfg.maxCalls };
  const flags: string[] = [];
  const emptyClassified = { matched: 0, added: 0, removed: 0, split: 0, merged: 0 };

  const fail = (checkpoint: string | null, ok: boolean): GraphReconciliationResult => ({
    ok,
    changeSetId: null,
    findingId: null,
    nodeCount: 0,
    edgeCount: 0,
    assumedPriorCount: 0,
    flags,
    droppedEdges: [],
    usage: totals,
    checkpoint,
    classified: emptyClassified,
  });

  try {
    // Idempotency guard BEFORE any model spend: a pending concept_graph set means
    // a run already awaits review — short-circuit (the shared extraction guard).
    const pending = await findPendingConceptGraphChangeSet(deps.supabase, args.courseId);
    if (pending) {
      return {
        ...fail(null, true),
        alreadyPending: true,
        changeSetId: pending,
      };
    }

    // Stages 1–4: shared candidate generation over the NEW publication's snapshot.
    const cand = await generateCandidates(deps, args, cfg, budget, totals, "reconciliation");
    if (!cand.ok) return fail(cand.checkpoint, false);
    const { authorId, snapshot, version, canonicals, checkpoint } = cand;
    flags.push(...cand.flags);

    // Taught candidates only diff against taught nodes (assumed priors are a
    // separate table; reconciliation of priors is not in W1.4's scope).
    const taughtCandidates = canonicals.filter((c) => !c.isAssumedPrior);

    // Resolve each candidate's anchors against the NEW snapshot (R-13 downgrade).
    const anchorIndex = buildSnapshotAnchorIndex(snapshot);
    const snapshotBlockIds = anchorIndex.blockIds;
    const candidateLites: CandidateLite[] = taughtCandidates.map((c) => {
      const { resolved, downgraded } = resolveAnchors(c.anchors, anchorIndex);
      const anchors = resolved
        .map((a) => ({
          lessonId: lessonIdForBlock(snapshot, a.blockId),
          blockId: a.blockId,
          ...(a.slideId ? { slideId: a.slideId } : {}),
        }))
        .filter((a) => a.lessonId.length > 0) as ConceptAnchor[];
      return { title: c.title, description: c.description, aliases: c.aliases, anchors, anchorDowngraded: downgraded, embedding: null };
    });

    // Load the stored ACTIVE nodes (status='active' — retired/merged_into are
    // superseded and excluded from the diff).
    const storedActive = await listConceptNodes(deps.supabase, args.courseId, { status: "active" });
    const storedLites: StoredNodeLite[] = storedActive.map((n) => ({
      id: n.id,
      title: n.title,
      aliases: n.aliases,
      anchors: n.anchors,
      createdBy: n.createdBy,
      creatorEdited: n.creatorEdited,
      embedding: n.embedding,
      version: n.version,
      description: n.description,
    }));

    // Embed everything that lacks a vector so the cosine fallback can fire. ONE
    // batched call (budget-gated); a stored node that already carries an embedding
    // reuses it. Failure ⇒ title/alias matching still works (cosine returns 0).
    await embedForMatching(deps, args, authorId, candidateLites, storedLites, budget, totals, flags);

    // The pure matcher (both directions) + classifier.
    const candVerdicts = matchCandidates(candidateLites, storedLites, cfg.reconcileMatchThreshold);
    const nodeVerdicts = matchNodes(storedLites, candidateLites, cfg.reconcileMatchThreshold);
    const plan = classifyReconciliation(candidateLites, storedLites, candVerdicts, nodeVerdicts, cfg, snapshotBlockIds);
    flags.push(...plan.flags);

    // Existing edges + the set of active nodes AFTER the diff (needed for edge
    // re-inference, which must not point at a retired/merged endpoint).
    const existingEdges = await listConceptEdges(deps.supabase, args.courseId);

    // PERSIST-then-STAGE. Everything below applies to the live graph NOW, collects
    // before/after change_set item payloads, then writes ONE change_sets row + the
    // fate finding.
    const staged = await applyAndStage(deps, {
      courseId: args.courseId,
      authorId,
      runId: args.runId,
      publicationId: args.publicationId,
      version,
      plan,
      candidateLites,
      storedLites,
      existingEdges,
      snapshot,
      cfg,
      budget,
      totals,
      flags,
      droppedEdges: [],
      checkpoint,
    });

    return {
      ok: true,
      alreadyPending: staged.alreadyPending,
      changeSetId: staged.changeSetId,
      findingId: staged.findingId,
      nodeCount: staged.nodeCount,
      edgeCount: staged.edgeCount,
      assumedPriorCount: 0,
      flags,
      droppedEdges: staged.droppedEdges,
      usage: totals,
      checkpoint,
      classified: plan.classified,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, false);
  }
}

/* ────────────────────────── embedding for matching ──────────────────────── */

/** Embed (in one batched call) every candidate + every stored node that lacks a
 *  vector, filling `embedding` in place. Reuses a stored node's existing vector.
 *  Best-effort: a failure leaves vectors null (title/alias matching still works).
 *  Budget-gated + cost-emitted under 'reconciliation'. */
async function embedForMatching(
  deps: GraphExtractionDeps,
  args: RunGraphExtractionArgs,
  authorId: string,
  candidates: CandidateLite[],
  storedNodes: StoredNodeLite[],
  budget: CallBudget,
  totals: UsageTotals,
  flags: string[]
): Promise<void> {
  if (!deps.model.embed || budget.remaining <= 0) return;
  // Build the input list: every candidate, then every stored node WITHOUT a vector.
  const toEmbed: { text: string; sink: (v: number[]) => void }[] = [];
  for (const c of candidates) toEmbed.push({ text: `${c.title}: ${c.description}`, sink: (v) => (c.embedding = v) });
  for (const n of storedNodes) {
    if (n.embedding && n.embedding.length > 0) continue;
    toEmbed.push({ text: `${n.title}: ${n.description}`, sink: (v) => (n.embedding = v) });
  }
  if (toEmbed.length === 0) return;

  budget.remaining -= 1;
  const t0 = Date.now();
  try {
    const res = await deps.model.embed({
      model: TUTOR_MODELS.embedding.model,
      inputs: toEmbed.map((x) => x.text),
      timeoutMs: TUTOR_MODELS.embedding.timeoutMs,
    });
    if (res.vectors.length === toEmbed.length) {
      toEmbed.forEach((x, i) => x.sink(res.vectors[i]));
    } else {
      flags.push("reconcile_embed_size_mismatch");
    }
    await emitAndAccumulate(
      deps,
      {
        courseId: args.courseId,
        authorId,
        jobType: "embedding",
        model: TUTOR_MODELS.embedding.model,
        usage: { inputTokens: res.usage.inputTokens, cachedTokens: 0, outputTokens: 0 },
        latencyMs: Date.now() - t0,
        providerResponseId: `reconcile-embed:${args.runId}:0`,
      },
      totals
    );
  } catch {
    flags.push("reconcile_embed_failed");
  }
}

/* ──────────────────────────── apply + stage ─────────────────────────────── */

interface ApplyAndStageArgs {
  courseId: string;
  authorId: string;
  runId: string;
  publicationId: string;
  version: number;
  plan: ReconciliationPlan;
  candidateLites: CandidateLite[];
  storedLites: StoredNodeLite[];
  existingEdges: ConceptEdge[];
  snapshot: PublicationSnapshot;
  cfg: ExtractionConfig;
  budget: CallBudget;
  totals: UsageTotals;
  flags: string[];
  droppedEdges: { reason: string; count: number }[];
  checkpoint: string | null;
}

interface StagedItem {
  entity: ConceptGraphItemPayload["entity"];
  nodeId: string;
  op: "create" | "update" | "delete";
  before: Json | null;
  after: Json | null;
}

/** Build a concept_graph item payload with classification + lineage validated. */
function payload(
  entity: ConceptGraphItemPayload["entity"],
  row: Record<string, unknown>,
  classification: Classification | null,
  lineage?: unknown
): Json {
  const p: ConceptGraphItemPayload = { entity, row, classification, ...(lineage !== undefined ? { lineage } : {}) };
  ConceptGraphItemPayloadSchema.parse(p);
  return p as unknown as Json;
}

/**
 * Persist every planned mutation, then stage ONE change_sets row + a fate finding.
 * Applies in FK-safe order: node creates first (children of a split get real ids),
 * then node updates (matched/retire/merge), then edge ops, then snapshot_map. The
 * change_set_items carry before/after so Reject restores byte-for-byte.
 */
async function applyAndStage(
  deps: GraphExtractionDeps,
  a: ApplyAndStageArgs
): Promise<{
  alreadyPending: boolean;
  changeSetId: string | null;
  findingId: string | null;
  nodeCount: number;
  edgeCount: number;
  droppedEdges: { reason: string; count: number }[];
}> {
  const supabase = deps.supabase;
  const items: StagedItem[] = [];

  // Re-fetch a node row as the raw DB shape (before/after payloads store rows).
  const rawNode = async (id: string): Promise<Record<string, unknown> | null> => {
    const { data, error } = await supabase.from("concept_nodes").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`applyAndStage rawNode ${id}: ${error.message}`);
    return (data as Record<string, unknown> | null) ?? null;
  };
  const rawEdge = async (id: string): Promise<Record<string, unknown> | null> => {
    const { data, error } = await supabase.from("concept_edges").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`applyAndStage rawEdge ${id}: ${error.message}`);
    return (data as Record<string, unknown> | null) ?? null;
  };

  // (1) NODE CREATES (added + split children). Record placeholder→real id so split
  //     lineage can be rewritten before the parent-retire item is built.
  const placeholderToRealId = new Map<string, string>();
  for (const op of a.plan.nodeOps) {
    if (op.kind !== "create") continue;
    const cand = a.candidateLites[op.candidateIndex];
    const input: ConceptNodeCreateInput = {
      courseId: a.courseId,
      title: cand.title,
      description: cand.description,
      createdBy: "reconciliation",
      aliases: cand.aliases,
      anchors: cand.anchors,
      embedding: cand.embedding ?? null,
    };
    const created = await createConceptNode(supabase, input);
    placeholderToRealId.set(op.placeholderId, created.id);
  }

  // Resolve a lineage's placeholder child ids → real ids (split children).
  const resolveLineage = (lineage: SplitLineage | MergeLineage | undefined): unknown => {
    if (!lineage) return undefined;
    if ("childNodeIds" in lineage) {
      return {
        parentNodeId: lineage.parentNodeId,
        childNodeIds: lineage.childNodeIds.map((c) => placeholderToRealId.get(c) ?? c),
        confidenceFactor: lineage.confidenceFactor,
      };
    }
    return lineage;
  };

  // Emit the create items now that ids exist (with resolved lineage for splits).
  for (const op of a.plan.nodeOps) {
    if (op.kind !== "create") continue;
    const realId = placeholderToRealId.get(op.placeholderId)!;
    const row = await rawNode(realId);
    if (!row) throw new Error(`applyAndStage: created node ${realId} not found`);
    items.push({
      entity: "concept_node",
      nodeId: realId,
      op: "create",
      before: null,
      after: payload("concept_node", row, op.classification, resolveLineage(op.lineage)),
    });
  }

  // (2) NODE UPDATES (matched-changed / removed-retire / split-parent-retire /
  //     merged survivor+absorbed). Capture the BEFORE row, apply the versioned
  //     update, capture the AFTER row.
  const storedById = new Map(a.storedLites.map((n) => [n.id, n]));
  for (const op of a.plan.nodeOps) {
    if (op.kind !== "update") continue;
    const before = await rawNode(op.nodeId);
    if (!before) throw new Error(`applyAndStage: update target ${op.nodeId} not found`);
    const expectedVersion = storedById.get(op.nodeId)?.version ?? (before.version as number);
    const set: Parameters<typeof versionedUpdateConceptNode>[3] = {};
    if (op.patch.retire) set.status = "retired";
    if (op.patch.mergeIntoNodeId) {
      set.status = "merged_into";
      set.merged_into_node_id = op.patch.mergeIntoNodeId;
    }
    if (op.patch.content) {
      set.title = op.patch.content.title;
      set.description = op.patch.content.description;
      set.aliases = op.patch.content.aliases as unknown as Database["public"]["Tables"]["concept_nodes"]["Row"]["aliases"];
      set.anchors = op.patch.content.anchors as unknown as Database["public"]["Tables"]["concept_nodes"]["Row"]["anchors"];
    }
    await versionedUpdateConceptNode(supabase, op.nodeId, expectedVersion, set);
    const after = await rawNode(op.nodeId);
    items.push({
      entity: "concept_node",
      nodeId: op.nodeId,
      op: "update",
      before: payload("concept_node", before, op.classification, resolveLineage(op.lineage as SplitLineage | MergeLineage | undefined)),
      after: after ? payload("concept_node", after, op.classification, resolveLineage(op.lineage as SplitLineage | MergeLineage | undefined)) : null,
    });
  }

  // (3) EDGE DIFF over the POST-diff active taught node set.
  const { edgeItems, edgeCount, droppedEdges } = await reconcileEdges(deps, a, rawEdge);
  items.push(...edgeItems);

  // (4) SNAPSHOT MAP — fresh rows for the NEW publication for every post-diff
  //     active node. Wipe this publication's prior rows first (a republish never
  //     mixes maps; the composite PK would otherwise collide).
  const snapMapItems = await rebuildSnapshotMap(deps, a);
  items.push(...snapMapItems);

  // (5) ONE change_sets row + the items (rows already persisted — capture order).
  const nodeCreates = a.plan.classified.added + a.plan.classified.split; // approximate for summary
  const summary = `Concept graph reconciled: ${a.plan.classified.added} added, ${a.plan.classified.matched} matched, ${a.plan.classified.removed} removed, ${a.plan.classified.split} split, ${a.plan.classified.merged} merged`;
  void nodeCreates;
  const csInsert = await supabase.from("change_sets").insert({ course_id: a.courseId, status: "pending", summary }).select("id").single();
  if (csInsert.error || !csInsert.data) throw new Error(`reconcile: change_sets insert failed: ${csInsert.error?.message}`);
  const changeSetId = csInsert.data.id;

  if (items.length > 0) {
    const itemRows = items.map((it) => ({
      change_set_id: changeSetId,
      course_id: a.courseId,
      node_type: "concept_graph",
      node_id: it.nodeId,
      op: it.op,
      before: it.before,
      after: it.after,
    }));
    const ins = await supabase.from("change_set_items").insert(itemRows);
    if (ins.error) throw new Error(`reconcile: change_set_items insert failed: ${ins.error.message}`);
  }

  // (6) FATE finding — open→proposed w/ change_set_id.
  const findingPayload: Json = {
    discriminator: "graph_reconciliation",
    title: "Concept graph reconciled",
    counts: a.plan.classified,
    flags: a.flags,
    droppedEdges,
    checkpoint: a.checkpoint,
    publicationId: a.publicationId,
    version: a.version,
    runId: a.runId,
    at: (deps.nowIso ?? (() => new Date().toISOString()))(),
  } as unknown as Json;

  let findingId: string | null = null;
  const findingInsert = await supabase
    .from("agent_findings")
    .insert({
      run_id: a.runId,
      course_id: a.courseId,
      kind: "structure_gap",
      severity: "low",
      dedupe_key: graphReconciliationDedupeKey(a.courseId),
      finding: findingPayload,
    })
    .select("id")
    .maybeSingle();
  if (findingInsert.error) {
    if (findingInsert.error.code === "23505") {
      const existing = await supabase
        .from("agent_findings")
        .select("id")
        .eq("course_id", a.courseId)
        .eq("dedupe_key", graphReconciliationDedupeKey(a.courseId))
        .eq("status", "open")
        .maybeSingle();
      if (existing.data) {
        await supabase.from("agent_findings").update({ run_id: a.runId, finding: findingPayload }).eq("id", existing.data.id);
        findingId = existing.data.id;
      }
    } else {
      throw new Error(`reconcile: agent_findings insert failed: ${findingInsert.error.message}`);
    }
  } else {
    findingId = findingInsert.data?.id ?? null;
  }

  if (findingId) {
    const flip = await supabase.from("agent_findings").update({ status: "proposed", change_set_id: changeSetId }).eq("id", findingId);
    if (flip.error) throw new Error(`reconcile: agent_findings proposed-flip failed: ${flip.error.message}`);
  }

  return {
    alreadyPending: false,
    changeSetId,
    findingId,
    nodeCount: items.filter((i) => i.entity === "concept_node").length,
    edgeCount,
    droppedEdges,
  };
}

/* ─────────────────────────── edge reconciliation ────────────────────────── */

/** Re-infer edges over the POST-diff active taught nodes, diff vs existing edges,
 *  and apply create/delete ops (locked edges untouched). Flags a locked edge whose
 *  endpoint got retired-for-content-deletion. */
async function reconcileEdges(
  deps: GraphExtractionDeps,
  a: ApplyAndStageArgs,
  rawEdge: (id: string) => Promise<Record<string, unknown> | null>
): Promise<{ edgeItems: StagedItem[]; edgeCount: number; droppedEdges: { reason: string; count: number }[] }> {
  const supabase = deps.supabase;
  const edgeItems: StagedItem[] = [];

  // The post-diff active TAUGHT node set: reload from the DB (authoritative after
  // the node writes above — retired/merged nodes are excluded).
  const activeNodes = await listConceptNodes(supabase, a.courseId, { status: "active" });
  const activeIds = activeNodes.map((n) => n.id);
  const activeIdSet = new Set(activeIds);

  // Endpoint-retired flag for LOCKED edges (Directive: locked_edge_endpoint_retired).
  const retiredForContent = new Set(a.plan.contentDeletedRetiredNodeIds);
  for (const e of a.existingEdges) {
    if (!e.creatorLocked) continue;
    if (retiredForContent.has(e.sourceNodeId) || retiredForContent.has(e.targetNodeId)) {
      a.flags.push(`locked_edge_endpoint_retired:${e.id}`);
    }
  }

  // Re-infer edges over the active taught nodes (one model call, budget-gated).
  const inferResult =
    activeNodes.length >= 2
      ? await inferAndHardenEdges(
          deps,
          a.courseId,
          a.authorId,
          a.runId,
          activeNodes.map((n) => ({ title: n.title, description: n.description })),
          a.cfg,
          a.budget,
          a.totals,
          "reconciliation",
          "reconcile-edges"
        )
      : { edges: [], droppedEdges: [], flags: [] };
  a.flags.push(...inferResult.flags);

  // The existing edges that STILL connect two active nodes are the diff baseline;
  // an existing edge whose endpoint is now retired/merged is left as-is UNLESS the
  // FK cascade already removed it (a retired node keeps the row; a merged/absorbed
  // node keeps the row too — status change, not delete). We diff against every
  // existing edge but the delete path only fires for non-locked edges.
  const ops = diffEdges(
    inferResult.edges.map((e) => ({ sourceIndex: e.sourceIndex, targetIndex: e.targetIndex, kind: e.kind, evidenceQuote: e.evidenceQuote, confidence: e.confidence })),
    activeIds,
    a.existingEdges
  );

  let edgeCount = 0;
  for (const op of ops) {
    if (op.kind === "create") {
      // Only create if BOTH endpoints are active (the RPC also enforces this).
      if (!activeIdSet.has(op.sourceNodeId) || !activeIdSet.has(op.targetNodeId)) continue;
      const id = crypto.randomUUID();
      let created;
      try {
        created = await upsertConceptEdge(supabase, {
          id,
          courseId: a.courseId,
          sourceNodeId: op.sourceNodeId,
          targetNodeId: op.targetNodeId,
          kind: op.edgeKind,
          evidenceRefs: op.evidenceRefs,
        });
      } catch (err) {
        // A newly-inferred edge could close a cycle WITH a surviving old edge (the
        // hardening passes only saw the fresh inference, not the retained graph).
        // The RPC's cycle gate refuses it — skip + flag, don't abort the run.
        if (err instanceof ConceptEdgeCycleError) {
          a.flags.push(`reconcile_edge_cycle_skipped:${op.sourceNodeId}->${op.targetNodeId}`);
          continue;
        }
        throw err;
      }
      const row = await rawEdge(created.id);
      edgeItems.push({ entity: "concept_edge", nodeId: created.id, op: "create", before: null, after: row ? payload("concept_edge", row, null) : null });
      edgeCount += 1;
      continue;
    }
    // delete: capture the BEFORE row, delete it (railRestore re-inserts on reject).
    const before = await rawEdge(op.edge.id);
    await deleteConceptEdge(supabase, op.edge.id);
    edgeItems.push({ entity: "concept_edge", nodeId: op.edge.id, op: "delete", before: before ? payload("concept_edge", before, null) : null, after: null });
    edgeCount += 1;
  }
  return { edgeItems, edgeCount, droppedEdges: inferResult.droppedEdges };
}

/* ─────────────────────────── snapshot map rebuild ───────────────────────── */

/** Delete this publication's prior snapshot_concept_map rows, then insert a fresh
 *  row per post-diff active node (Directive: fresh rows for the NEW publication).
 *  Each fresh row stages as an op 'create' item so a reject drops them. Because
 *  reconciliation runs on a NEW publication id, the wipe only clears a same-run
 *  retry's rows — the prior publication's map is untouched (its own change-set
 *  owns it). Each node's stored anchors RE-RESOLVE against the new snapshot so
 *  anchor_downgraded reflects the R-13 re-resolution. */
async function rebuildSnapshotMap(
  deps: GraphExtractionDeps,
  a: ApplyAndStageArgs
): Promise<StagedItem[]> {
  const supabase = deps.supabase;
  const items: StagedItem[] = [];

  // Wipe the prior rows for THIS publication (idempotent on a retry).
  const del = await supabase.from("snapshot_concept_map").delete().eq("publication_id", a.publicationId);
  if (del.error) throw new Error(`reconcile: snapshot_map wipe failed: ${del.error.message}`);

  const anchorIndex = buildSnapshotAnchorIndex(a.snapshot);
  const activeNodes = await listConceptNodes(supabase, a.courseId, { status: "active" });
  for (const node of activeNodes) {
    // Re-resolve the node's anchors against the NEW snapshot (R-13 downgrade).
    const { resolved, downgraded } = resolveAnchors(
      node.anchors.map((an) => ({ blockId: an.blockId, ...(an.slideId ? { slideId: an.slideId } : {}) })),
      anchorIndex
    );
    const anchors = resolved
      .map((an) => ({
        lessonId: lessonIdForBlock(a.snapshot, an.blockId),
        blockId: an.blockId,
        ...(an.slideId ? { slideId: an.slideId } : {}),
      }))
      .filter((an) => an.lessonId.length > 0);
    const row = {
      publication_id: a.publicationId,
      node_id: node.id,
      course_id: a.courseId,
      version: a.version,
      anchors: anchors as unknown as Json,
      anchor_downgraded: downgraded,
    };
    const { data, error } = await supabase.from("snapshot_concept_map").insert(row).select("*").single();
    if (error || !data) throw new Error(`reconcile: snapshot_map insert failed: ${error?.message}`);
    items.push({
      entity: "snapshot_map",
      nodeId: (data as { node_id: string }).node_id,
      op: "create",
      before: null,
      after: payload("snapshot_map", data as unknown as Record<string, unknown>, null),
    });
  }
  return items;
}
