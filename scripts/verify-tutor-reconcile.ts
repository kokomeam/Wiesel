/**
 * Concept-graph RECONCILIATION — PURE suite (no DB, no OpenAI key). TUTOR-1 W1.4.
 *
 * Covers, per Directive §W1.4:
 *   - the MATCHER: titleOrAliasMatch (both directions incl. the node's aliases),
 *     scorePair (title/cosine/threshold boundary), matchCandidates +
 *     matchNodes (candidate→node and node→candidate best-match, ties)
 *   - the CLASSIFIER golden per classification: matched-changed update /
 *     matched-unchanged suppressed / creator_edited suppressed+flag / added /
 *     removed-retired / creator-created suppressed+flag / split (lineage on
 *     parent AND every child, confidenceFactor) / merged (survivor update +
 *     merged_into rows honoring the DDL CHECK)
 *   - contentVanished flag paths (creator_edited_content_gone,
 *     locked_edge_endpoint_retired)
 *   - diffEdges: create / delete / no-op / locked-suppression
 *   - a FULL mock-model + stateful recording-stub run: persist-before-stage, ONE
 *     change-set, the fate finding proposed w/ change_set_id, classified counts,
 *     the pending-guard short-circuit.
 *
 * Run: `npx tsx scripts/verify-tutor-reconcile.ts`
 */

import {
  buildPublicationSnapshot,
} from "@/lib/course/publish/snapshot";
import { PublicationSnapshotSchema, type PublicationSnapshot } from "@/lib/course/publish/schemas";
import {
  createBlock,
  createLesson,
  createModule,
  createSlide,
} from "@/lib/course/factories";
import { defaultCourseTheme } from "@/lib/course/persistence";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";

import { resolveExtractionConfig } from "@/lib/tutor/graph/config";
import {
  matchCandidates,
  matchNodes,
  scorePair,
  titleOrAliasMatch,
  classifyReconciliation,
  diffEdges,
  runGraphReconciliation,
  graphReconciliationDedupeKey,
  type CandidateLite,
  type StoredNodeLite,
  type SplitLineage,
  type MergeLineage,
} from "@/lib/tutor/graph/reconcile";
import type { ConceptAnchor, ConceptEdge } from "@/lib/tutor/graph/schemas";
import { PROPOSAL_RESPONSE_NAME } from "@/lib/tutor/graph/propose";
import { MERGE_RESPONSE_NAME } from "@/lib/tutor/graph/canonicalize";
import { EDGE_RESPONSE_NAME } from "@/lib/tutor/graph/edges";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { tutorEventId } from "@/lib/tutor/telemetry";
import { withPooledModel } from "@/lib/ai/subagent";
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const CFG = { lineageConfidence: resolveExtractionConfig().lineageConfidence };
const THRESHOLD = resolveExtractionConfig().reconcileMatchThreshold; // 0.8

/* ─────────────────────────── lightweight builders ───────────────────────── */

let idSeq = 0;
const nid = () => `node-${(idSeq += 1).toString().padStart(3, "0")}`;

function storedNode(over: Partial<StoredNodeLite> & { title: string }): StoredNodeLite {
  return {
    id: over.id ?? nid(),
    title: over.title,
    aliases: over.aliases ?? [],
    anchors: over.anchors ?? [],
    createdBy: over.createdBy ?? "extraction",
    creatorEdited: over.creatorEdited ?? false,
    embedding: over.embedding ?? null,
    version: over.version ?? 1,
    description: over.description ?? `${over.title} desc`,
  };
}

function candidate(over: Partial<CandidateLite> & { title: string }): CandidateLite {
  return {
    title: over.title,
    description: over.description ?? `${over.title} desc`,
    aliases: over.aliases ?? [],
    anchors: over.anchors ?? [],
    anchorDowngraded: over.anchorDowngraded ?? false,
    embedding: over.embedding ?? null,
  };
}

const anchor = (lessonId: string, blockId: string, slideId?: string): ConceptAnchor => ({ lessonId, blockId, ...(slideId ? { slideId } : {}) });

async function main() {
  /* ───────────────────────────── matcher ─────────────────────────────────── */
  console.log("\n# matcher — title/alias + cosine + both directions");

  check(
    "titleOrAliasMatch equates exact titles (case/whitespace)",
    titleOrAliasMatch({ title: "Law of Demand", aliases: [] }, { title: "law  of demand", aliases: [] })
  );
  check(
    "titleOrAliasMatch matches the CANDIDATE title against a NODE alias",
    titleOrAliasMatch({ title: "Demand Curve", aliases: [] }, { title: "Law of Demand", aliases: ["Demand Curve"] })
  );
  check(
    "titleOrAliasMatch matches a CANDIDATE alias against the NODE title (both directions)",
    titleOrAliasMatch({ title: "X", aliases: ["Law of Demand"] }, { title: "law of demand", aliases: [] })
  );
  check(
    "titleOrAliasMatch is false for unrelated titles",
    !titleOrAliasMatch({ title: "Supply" , aliases: [] }, { title: "Demand", aliases: [] })
  );

  // cosine + threshold boundary. Identical vectors → 1 (≥0.8 matches);
  // orthogonal → 0 (below).
  const vA = [1, 0, 0];
  const vAlmost = [0.9, 0.436, 0]; // cosine with [1,0,0] ≈ 0.9 (≥0.8)
  const vLow = [0.6, 0.8, 0]; // cosine 0.6 (<0.8)
  check("scorePair title match wins (score 1, byTitle)", (() => { const s = scorePair(candidate({ title: "A" }), storedNode({ title: "a" }), THRESHOLD); return s.matched && s.score === 1 && s.byTitle; })());
  check("scorePair cosine ≥ threshold matches (byTitle false)", (() => { const s = scorePair(candidate({ title: "Zzz", embedding: vA }), storedNode({ title: "Yyy", embedding: vAlmost }), 0.8); return s.matched && !s.byTitle && s.score >= 0.8; })());
  check("scorePair cosine below threshold does NOT match", !scorePair(candidate({ title: "Zzz", embedding: vA }), storedNode({ title: "Yyy", embedding: vLow }), 0.8).matched);
  check(
    "scorePair threshold boundary is inclusive (== threshold matches)",
    (() => {
      const half = Math.SQRT1_2; // cos 45°
      const s = scorePair(candidate({ title: "P", embedding: [1, 0] }), storedNode({ title: "Q", embedding: [1, 1] }), half - 1e-9);
      return s.matched && !s.byTitle;
    })()
  );

  // matchCandidates (candidate→node).
  const nDemand = storedNode({ title: "Law of Demand", id: "n-demand" });
  const nSupply = storedNode({ title: "Law of Supply", id: "n-supply" });
  const cv = matchCandidates([candidate({ title: "law of demand" }), candidate({ title: "Elasticity" })], [nDemand, nSupply], THRESHOLD);
  check("matchCandidates: exact-title candidate matches its node", cv[0].nodeId === "n-demand" && cv[0].byTitle);
  check("matchCandidates: an unmatched candidate → nodeId null", cv[1].nodeId === null);

  // matchNodes (node→candidate).
  const nv = matchNodes([nDemand, nSupply], [candidate({ title: "law of demand" })], THRESHOLD);
  check("matchNodes: a node matches its candidate", nv[0].candidateIndex === 0);
  check("matchNodes: a node with no candidate → candidateIndex null", nv[1].candidateIndex === null);

  // cosine tie / strictly-higher: two nodes, candidate closer to one.
  const cvCos = matchCandidates(
    [candidate({ title: "Q", embedding: vA })],
    [storedNode({ title: "N1", id: "cos-1", embedding: vLow }), storedNode({ title: "N2", id: "cos-2", embedding: vAlmost })],
    0.8
  );
  check("matchCandidates picks the strictly-higher-cosine node", cvCos[0].nodeId === "cos-2");

  /* ─────────────────────────── classifier goldens ────────────────────────── */
  console.log("\n# classifier — one golden per classification");
  const snapBlocks = new Set(["blk-1", "blk-2", "blk-3"]);

  // MATCHED-CHANGED → op update (description changed).
  {
    idSeq = 0;
    const node = storedNode({ id: "m1", title: "Scarcity", description: "old desc", anchors: [anchor("L1", "blk-1")] });
    const cand = candidate({ title: "Scarcity", description: "a materially different description", anchors: [anchor("L1", "blk-1")] });
    const plan = classifyReconciliation([cand], [node], matchCandidates([cand], [node], THRESHOLD), matchNodes([node], [cand], THRESHOLD), CFG, snapBlocks);
    const op = plan.nodeOps.find((o) => o.kind === "update" && o.classification === "matched");
    check("matched-changed → ONE update op keeping the node id", op !== undefined && op.kind === "update" && op.nodeId === "m1" && !!op.patch.content, JSON.stringify(plan.nodeOps));
    check("matched-changed counts matched:1, others 0", plan.classified.matched === 1 && plan.classified.added === 0 && plan.classified.removed === 0);
  }

  // MATCHED-UNCHANGED → suppressed (no item).
  {
    const node = storedNode({ id: "m2", title: "Scarcity", description: "same", anchors: [anchor("L1", "blk-1")] });
    const cand = candidate({ title: "Scarcity", description: "same", anchors: [anchor("L1", "blk-1")] });
    const plan = classifyReconciliation([cand], [node], matchCandidates([cand], [node], THRESHOLD), matchNodes([node], [cand], THRESHOLD), CFG, snapBlocks);
    check("matched-unchanged → suppressed (no update op)", plan.nodeOps.every((o) => o.kind !== "update") && plan.nodeOps.some((o) => o.kind === "suppressed" && o.reason === "unchanged"));
    check("matched-unchanged still counts matched:1", plan.classified.matched === 1);
  }

  // creator_edited → suppressed (+ flag when content gone).
  {
    const node = storedNode({ id: "m3", title: "Scarcity", description: "old", creatorEdited: true, anchors: [anchor("L1", "gone-block")] });
    const cand = candidate({ title: "Scarcity", description: "totally new text", anchors: [anchor("L1", "blk-1")] });
    const plan = classifyReconciliation([cand], [node], matchCandidates([cand], [node], THRESHOLD), matchNodes([node], [cand], THRESHOLD), CFG, snapBlocks);
    check("creator_edited node → suppressed, never auto-changed", plan.nodeOps.some((o) => o.kind === "suppressed" && o.reason === "creator_edited") && plan.nodeOps.every((o) => o.kind !== "update"));
    check("creator_edited + content gone → creator_edited_content_gone flag", plan.flags.includes("creator_edited_content_gone:m3"));
  }
  {
    // creator_edited but content STILL present → suppressed, NO content-gone flag.
    const node = storedNode({ id: "m3b", title: "Scarcity", description: "old", creatorEdited: true, anchors: [anchor("L1", "blk-1")] });
    const cand = candidate({ title: "Scarcity", description: "changed", anchors: [anchor("L1", "blk-1")] });
    const plan = classifyReconciliation([cand], [node], matchCandidates([cand], [node], THRESHOLD), matchNodes([node], [cand], THRESHOLD), CFG, snapBlocks);
    check("creator_edited + content present → NO content-gone flag", !plan.flags.some((f) => f.startsWith("creator_edited_content_gone")));
  }

  // ADDED → create.
  {
    const cand = candidate({ title: "Brand New Concept", anchors: [anchor("L1", "blk-2")] });
    const plan = classifyReconciliation([cand], [], matchCandidates([cand], [], THRESHOLD), matchNodes([], [cand], THRESHOLD), CFG, snapBlocks);
    const op = plan.nodeOps.find((o) => o.kind === "create");
    check("added → a create op with classification added", op !== undefined && op.kind === "create" && op.classification === "added");
    check("added counts added:1", plan.classified.added === 1);
  }

  // REMOVED → update flipping status→retired (never delete).
  {
    const node = storedNode({ id: "r1", title: "Obsolete", createdBy: "extraction", anchors: [anchor("L1", "blk-1")] });
    const plan = classifyReconciliation([], [node], [], matchNodes([node], [], THRESHOLD), CFG, snapBlocks);
    const op = plan.nodeOps.find((o) => o.kind === "update" && o.classification === "removed");
    check("removed → an update op (retire), never a delete op", op !== undefined && op.kind === "update" && op.patch.retire === true);
    check("removed counts removed:1", plan.classified.removed === 1);
  }

  // creator-CREATED unmatched → suppressed + flag.
  {
    const node = storedNode({ id: "r2", title: "Hand Authored", createdBy: "creator", anchors: [anchor("L1", "blk-1")] });
    const plan = classifyReconciliation([], [node], [], matchNodes([node], [], THRESHOLD), CFG, snapBlocks);
    check("creator-created unmatched → suppressed, NOT retired", plan.nodeOps.some((o) => o.kind === "suppressed" && o.reason === "creator_node") && plan.nodeOps.every((o) => o.kind !== "update"));
    check("creator-created unmatched → creator_node_unmatched flag", plan.flags.includes("creator_node_unmatched:r2"));
  }

  // SPLIT → parent retired + children created, lineage on ALL with confidenceFactor.
  {
    const parent = storedNode({ id: "sp", title: "Big Concept", anchors: [anchor("L1", "blk-1")] });
    // Two candidates that BOTH best-match the parent by title/alias.
    const c1 = candidate({ title: "Big Concept", anchors: [anchor("L1", "blk-1")] }); // title match
    const c2 = candidate({ title: "Also Big", aliases: ["Big Concept"], anchors: [anchor("L1", "blk-2")] }); // alias match
    const plan = classifyReconciliation([c1, c2], [parent], matchCandidates([c1, c2], [parent], THRESHOLD), matchNodes([parent], [c1, c2], THRESHOLD), CFG, snapBlocks);
    const children = plan.nodeOps.filter((o) => o.kind === "create" && o.classification === "split");
    const parentRetire = plan.nodeOps.find((o) => o.kind === "update" && o.classification === "split" && o.patch.retire);
    check("split → ≥2 children created", children.length === 2, JSON.stringify(plan.nodeOps));
    check("split → parent retired via update", parentRetire !== undefined);
    const lineage = parentRetire && (parentRetire as { lineage?: SplitLineage }).lineage;
    check(
      "split parent lineage has parentNodeId + all child placeholders + confidenceFactor",
      !!lineage && lineage.parentNodeId === "sp" && lineage.childNodeIds.length === 2 && lineage.confidenceFactor === CFG.lineageConfidence
    );
    check(
      "split lineage rides EVERY child op (siblings + factor)",
      children.every((c) => {
        const l = (c as { lineage?: SplitLineage }).lineage;
        return !!l && l.parentNodeId === "sp" && l.childNodeIds.length === 2 && l.confidenceFactor === CFG.lineageConfidence;
      })
    );
    check("split counts split:3 (2 children + parent)", plan.classified.split === 3);
  }

  // MERGE → survivor update + merged_into rows honoring the DDL CHECK.
  {
    // Two nodes whose best candidate is the SAME candidate → merge.
    const n1 = storedNode({ id: "mg1", title: "Consumer Surplus", anchors: [anchor("L1", "blk-1")] });
    const n2 = storedNode({ id: "mg2", title: "Buyer Surplus", aliases: ["Consumer Surplus"], anchors: [anchor("L1", "blk-2")] });
    const cand = candidate({ title: "Consumer Surplus", anchors: [anchor("L1", "blk-1")] });
    const plan = classifyReconciliation([cand], [n1, n2], matchCandidates([cand], [n1, n2], THRESHOLD), matchNodes([n1, n2], [cand], THRESHOLD), CFG, snapBlocks);
    const merges = plan.nodeOps.filter((o) => o.kind === "update" && o.classification === "merged");
    const survivor = merges.find((o) => o.kind === "update" && !!o.patch.content);
    const absorbed = merges.find((o) => o.kind === "update" && !!o.patch.mergeIntoNodeId);
    check("merge → a survivor update carrying fresh content", survivor !== undefined);
    check(
      "merge → an absorbed row flips status→merged_into WITH merged_into_node_id (DDL CHECK)",
      absorbed !== undefined && absorbed.kind === "update" && typeof absorbed.patch.mergeIntoNodeId === "string" && absorbed.patch.mergeIntoNodeId.length > 0
    );
    const surLineage = survivor && (survivor as { lineage?: MergeLineage }).lineage;
    const absLineage = absorbed && (absorbed as { lineage?: MergeLineage }).lineage;
    check(
      "merge lineage names survivor + mergedNodeIds on BOTH rows",
      !!surLineage && !!absLineage && surLineage.survivorNodeId === absLineage.survivorNodeId && surLineage.mergedNodeIds.length >= 1
    );
    check("merge counts merged:2 (survivor + 1 absorbed)", plan.classified.merged === 2);
  }

  /* ─────────────────────────────── diffEdges ─────────────────────────────── */
  console.log("\n# diffEdges — create / delete / no-op / locked suppression");
  const nodesE = ["e1", "e2", "e3"];
  const mkEdge = (id: string, s: string, t: string, kind: ConceptEdge["kind"], locked = false): ConceptEdge => ({
    id,
    courseId: "c",
    sourceNodeId: s,
    targetNodeId: t,
    kind,
    evidenceRefs: [],
    creatorLocked: locked,
    version: 1,
    createdAt: "",
    updatedAt: "",
  });
  const inferred = [
    { sourceIndex: 0, targetIndex: 1, kind: "prerequisite" as const, evidenceQuote: "q", confidence: 0.9 }, // e1→e2 exists
    { sourceIndex: 1, targetIndex: 2, kind: "prerequisite" as const, evidenceQuote: "q", confidence: 0.9 }, // e2→e3 new
  ];
  const existing = [
    mkEdge("edge-a", "e1", "e2", "prerequisite"), // still inferred → no-op
    mkEdge("edge-b", "e1", "e3", "prerequisite"), // no longer inferred → delete
    mkEdge("edge-locked", "e3", "e1", "related", true), // locked → never deleted
  ];
  const ops = diffEdges(inferred, nodesE, existing);
  check("diffEdges creates the newly-inferred e2→e3", ops.some((o) => o.kind === "create" && o.sourceNodeId === "e2" && o.targetNodeId === "e3"));
  check("diffEdges no-ops the still-inferred e1→e2", !ops.some((o) => o.kind === "create" && o.sourceNodeId === "e1" && o.targetNodeId === "e2") && !ops.some((o) => o.kind === "delete" && o.edge.id === "edge-a"));
  check("diffEdges deletes the no-longer-inferred non-locked edge", ops.some((o) => o.kind === "delete" && o.edge.id === "edge-b"));
  check("diffEdges NEVER deletes a locked edge (AC-T1.8)", !ops.some((o) => o.kind === "delete" && o.edge.id === "edge-locked"));

  /* ─────────────────── full run (mock model + stateful stub) ──────────────── */
  console.log("\n# full reconciliation run (mock model + stateful recording stub)");
  await fullRun();

  /* ─────────────────── pending-guard short-circuit ───────────────────────── */
  console.log("\n# pending-guard short-circuit");
  await pendingGuard();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

/* ══════════════════════ stateful recording supabase stub ══════════════════ */

interface RecordedCall {
  table: string | null;
  method: string;
  arg?: unknown;
}

/**
 * A STATEFUL in-memory graph stub so the reconcile orchestrator's list/create/
 * update/delete + snapshot_map wipe/insert + edge RPC all behave coherently
 * (listConceptNodes after the diff must return the post-diff active set for edge
 * re-inference). Records call ORDER so persist-before-stage is assertable.
 */
function makeStatefulStub(opts: {
  authorId: string;
  courseId: string;
  seedNodes: { id: string; title: string; description: string; status: string; created_by: string; creator_edited: boolean; aliases: string[]; anchors: unknown[]; version: number }[];
  onCall: (c: RecordedCall) => void;
  pendingChangeSetId?: string | null;
}) {
  const nodes = new Map<string, Record<string, unknown>>();
  for (const n of opts.seedNodes) {
    nodes.set(n.id, {
      id: n.id,
      course_id: opts.courseId,
      title: n.title,
      description: n.description,
      status: n.status,
      merged_into_node_id: null,
      created_by: n.created_by,
      creator_edited: n.creator_edited,
      aliases: n.aliases,
      anchors: n.anchors,
      embedding: null,
      external_taxonomy_ref: null,
      version: n.version,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  }
  const edges = new Map<string, Record<string, unknown>>();
  const snapMap = new Map<string, Record<string, unknown>>();
  let nodeSeq = 0;

  function builder(table: string) {
    const state: { table: string; op: string; filters: Record<string, unknown>; payload?: unknown } = { table, op: "", filters: {} };

    const resolveTerminal = async (): Promise<{ data: unknown; error: unknown }> => {
      // pending guard (change_set_items!inner join)
      if (table === "change_set_items" && state.op === "select") {
        opts.onCall({ table, method: "select(pending-guard)" });
        return { data: opts.pendingChangeSetId ? { change_set_id: opts.pendingChangeSetId } : null, error: null };
      }
      if (table === "courses" && state.op === "select") {
        opts.onCall({ table, method: "select(author)" });
        return { data: { author_id: opts.authorId }, error: null };
      }
      if (table === "concept_nodes" && state.op === "select") {
        opts.onCall({ table, method: "select(list)", arg: state.filters });
        const wantStatus = state.filters["status"];
        const wantId = state.filters["id"];
        let rows = [...nodes.values()];
        if (wantId) return { data: rows.find((r) => r.id === wantId) ?? null, error: null };
        if (wantStatus) rows = rows.filter((r) => r.status === wantStatus);
        return { data: rows, error: null };
      }
      if (table === "concept_nodes" && state.op === "insert") {
        opts.onCall({ table, method: "insert", arg: state.payload });
        nodeSeq += 1;
        const p = state.payload as Record<string, unknown>;
        const now = new Date().toISOString();
        const row: Record<string, unknown> = {
          id: `new-node-${nodeSeq}`,
          course_id: p.course_id,
          title: p.title,
          description: p.description ?? "",
          status: p.status ?? "active",
          merged_into_node_id: p.merged_into_node_id ?? null,
          created_by: p.created_by ?? "reconciliation",
          creator_edited: p.creator_edited ?? false,
          aliases: p.aliases ?? [],
          anchors: p.anchors ?? [],
          embedding: p.embedding ?? null,
          external_taxonomy_ref: null,
          version: 1,
          created_at: now,
          updated_at: now,
        };
        nodes.set(row.id as string, row);
        return { data: row, error: null };
      }
      if (table === "concept_nodes" && state.op === "update") {
        opts.onCall({ table, method: "update", arg: { set: state.payload, filters: state.filters } });
        const id = state.filters["id"] as string;
        const row = nodes.get(id);
        // versioned update returns an array (data[0]); zero rows ⇒ conflict.
        if (!row) return { data: [], error: null };
        const set = state.payload as Record<string, unknown>;
        // honor the .eq('version', expected) guard.
        if ("version" in state.filters && row.version !== state.filters["version"]) return { data: [], error: null };
        Object.assign(row, set);
        return { data: [row], error: null };
      }
      if (table === "concept_edges" && state.op === "select") {
        opts.onCall({ table, method: "select(list)", arg: state.filters });
        const wantId = state.filters["id"];
        if (wantId) return { data: edges.get(wantId as string) ?? null, error: null };
        return { data: [...edges.values()], error: null };
      }
      if (table === "concept_edges" && state.op === "delete") {
        opts.onCall({ table, method: "delete", arg: state.filters });
        edges.delete(state.filters["id"] as string);
        return { data: null, error: null };
      }
      if (table === "snapshot_concept_map" && state.op === "delete") {
        opts.onCall({ table, method: "delete", arg: state.filters });
        for (const [k, v] of [...snapMap.entries()]) if (v.publication_id === state.filters["publication_id"]) snapMap.delete(k);
        return { data: null, error: null };
      }
      if (table === "snapshot_concept_map" && state.op === "insert") {
        opts.onCall({ table, method: "insert", arg: state.payload });
        const p = state.payload as Record<string, unknown>;
        const row = { ...p, created_at: new Date().toISOString() };
        snapMap.set(`${p.publication_id}::${p.node_id}`, row);
        return { data: row, error: null };
      }
      if (table === "change_sets" && state.op === "insert") {
        opts.onCall({ table, method: "insert", arg: state.payload });
        return { data: { id: "reconcile-cs-1" }, error: null };
      }
      if (table === "change_set_items" && state.op === "insert") {
        opts.onCall({ table, method: "insert", arg: state.payload });
        return { data: null, error: null };
      }
      if (table === "agent_findings" && state.op === "insert") {
        opts.onCall({ table, method: "insert", arg: state.payload });
        return { data: { id: "reconcile-finding-1" }, error: null };
      }
      if (table === "agent_findings" && state.op === "update") {
        opts.onCall({ table, method: "update", arg: state.payload });
        return { data: null, error: null };
      }
      if (table === "learning_events" && state.op === "upsert") {
        opts.onCall({ table, method: "upsert(telemetry)", arg: state.payload });
        return { data: null, error: null };
      }
      opts.onCall({ table, method: `${state.op}(unhandled)`, arg: state.filters });
      return { data: null, error: null };
    };

    const thenable = { then(resolve: (v: { data: unknown; error: unknown }) => unknown) { return resolveTerminal().then(resolve); } };
    const chain: Record<string, unknown> = {
      select() { state.op = state.op || "select"; return chain; },
      insert(p: unknown) { state.op = "insert"; state.payload = p; return chain; },
      upsert(p: unknown) { state.op = "upsert"; state.payload = p; return chain; },
      update(p: unknown) { state.op = "update"; state.payload = p; return chain; },
      delete() { state.op = "delete"; return chain; },
      eq(col: string, val: unknown) { state.filters[col] = val; return chain; },
      like() { return chain; },
      limit() { return chain; },
      order() { return chain; },
      maybeSingle() { return thenable; },
      single() { return thenable; },
      then(resolve: (v: { data: unknown; error: unknown }) => unknown) { return thenable.then(resolve); },
    };
    return chain;
  }

  return {
    from(table: string) { return builder(table); },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "tutor_upsert_concept_edge") {
        opts.onCall({ table: "concept_edges", method: "rpc(upsert_edge)", arg: args });
        const now = new Date().toISOString();
        const row = {
          id: args.p_id,
          course_id: args.p_course_id,
          source_node_id: args.p_source_node_id,
          target_node_id: args.p_target_node_id,
          kind: args.p_kind,
          evidence_refs: args.p_evidence_refs ?? [],
          creator_locked: args.p_creator_locked ?? false,
          version: 1,
          created_at: now,
          updated_at: now,
        };
        edges.set(args.p_id as string, row);
        return { data: row, error: null };
      }
      opts.onCall({ table: null, method: `rpc(${fn})`, arg: args });
      return { data: null, error: null };
    },
    _state: { nodes, edges, snapMap },
  };
}

/* ────────────────────── snapshot fixture for the full run ─────────────────── */

function flatDeck(title: string, slides: [string, string[]][]): SlideDeckBlock {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.title = title;
  deck.slides = slides.map(([heading, bullets], i) => {
    const s = createSlide("title_bullets");
    for (const el of s.elements) {
      if (el.type === "heading") el.text = heading;
      else if (el.type === "bullet_list") el.items = bullets;
    }
    s.order = i;
    return s;
  });
  return deck;
}

function buildSnapshot(): { snapshot: PublicationSnapshot; doc: CourseDocument } {
  const owner = crypto.randomUUID();
  const m = createModule("M1", 0);
  const lessonA = createLesson("Lesson A", 0);
  lessonA.objective = "Understand scarcity and opportunity cost.";
  lessonA.blocks = [flatDeck("Deck A", [["Scarcity", ["Wants exceed resources available."]], ["Opportunity Cost", ["The next-best alternative forgone."]]])];
  lessonA.blocks.forEach((b, i) => (b.order = i));
  m.lessons = [lessonA];

  const doc: CourseDocument = {
    id: crypto.randomUUID(),
    title: "Reconcile Fixture",
    description: "pure",
    plan: { outcomes: ["x"], prerequisites: [] },
    modules: [m],
    theme: defaultCourseTheme(),
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ownerId: owner, aiReadableVersion: "1.0" },
  };
  const snapshot = PublicationSnapshotSchema.parse(buildPublicationSnapshot(doc).snapshot);
  return { snapshot, doc };
}

async function fullRun() {
  const { snapshot, doc } = buildSnapshot();
  const lesson = doc.modules[0].lessons[0];
  const blockA = lesson.blocks[0].id;
  const slideA = (lesson.blocks[0] as SlideDeckBlock).slides[0].id;

  // The proposal reproposes "Scarcity" (matches an existing node) + adds "New Idea".
  const proposal = {
    concepts: [
      { title: "Scarcity", description: "Wants exceed resources available.", lessonAnchors: [{ blockId: blockA, slideId: slideA }], confidence: 0.9, isAssumedPrior: false, evidenceQuote: "Wants exceed resources." },
      { title: "New Idea", description: "A concept the new publication introduces.", lessonAnchors: [{ blockId: blockA, slideId: null }], confidence: 0.85, isAssumedPrior: false, evidenceQuote: "A new idea appears." },
    ],
  };
  const merge = { groups: [] as unknown[] };
  const edges = { edges: [{ sourceIndex: 0, targetIndex: 1, kind: "prerequisite", confidence: 0.9, evidenceQuote: "Scarcity precedes the new idea." }] };
  const rawModel = createMockModelClient([], { structured: { [PROPOSAL_RESPONSE_NAME]: proposal, [MERGE_RESPONSE_NAME]: merge, [EDGE_RESPONSE_NAME]: edges } });

  const courseId = doc.id;
  const OWNER = doc.metadata.ownerId ?? crypto.randomUUID();
  const calls: RecordedCall[] = [];
  // Seed: an existing "Scarcity" node (→ matched-unchanged? no — description
  // differs so it's matched-changed), and an "Obsolete" node no candidate matches
  // (→ removed/retired).
  const stub = makeStatefulStub({
    authorId: OWNER,
    courseId,
    seedNodes: [
      { id: "seed-scarcity", title: "Scarcity", description: "OLD scarcity description", status: "active", created_by: "extraction", creator_edited: false, aliases: [], anchors: [{ lessonId: lesson.id, blockId: blockA }], version: 1 },
      { id: "seed-obsolete", title: "Obsolete Concept", description: "no longer taught", status: "active", created_by: "extraction", creator_edited: false, aliases: [], anchors: [{ lessonId: lesson.id, blockId: blockA }], version: 1 },
    ],
    onCall: (c) => calls.push(c),
  });

  const runId = crypto.randomUUID();
  // W3.1 · D-2: cost telemetry now emits from the withPooledModel decorator (the
  // inline emit was retired — emitAndAccumulate only ACCUMULATES usage now). Wrap the
  // mock exactly as tutorGraphReconcile assembles it: creator pool + a cost context
  // keyed runKey=runId → deterministic `${runId}:${seq}` ids, retry-stable.
  const model = withPooledModel(rawModel, {
    cost: { supabase: stub as never, courseId, emittedBy: OWNER, jobType: "reconciliation", runKey: runId },
  });
  const result = await runGraphReconciliation(
    { supabase: stub as never, model, loadSnapshot: async () => ({ snapshot, version: 7 }), config: { canonSimThreshold: -1 } },
    { courseId, publicationId: crypto.randomUUID(), runId }
  );

  check("reconcile run ok", result.ok, JSON.stringify({ checkpoint: result.checkpoint, flags: result.flags }));
  check("classified: 1 matched (Scarcity changed)", result.classified.matched === 1, JSON.stringify(result.classified));
  check("classified: 1 added (New Idea)", result.classified.added === 1, JSON.stringify(result.classified));
  check("classified: 1 removed (Obsolete retired)", result.classified.removed === 1, JSON.stringify(result.classified));
  check("classified: 0 split, 0 merged", result.classified.split === 0 && result.classified.merged === 0);

  // The Obsolete node was RETIRED not deleted.
  const obsolete = stub._state.nodes.get("seed-obsolete");
  check("removed node is status='retired' (never deleted)", obsolete?.status === "retired");
  const scarcity = stub._state.nodes.get("seed-scarcity");
  check("matched-changed node kept its id + bumped version", scarcity?.id === "seed-scarcity" && (scarcity?.version as number) === 2);

  // persist-before-stage: the change_sets insert comes AFTER every node/edge write.
  const csIdx = calls.findIndex((c) => c.table === "change_sets" && c.method === "insert");
  const nodeWriteIdxs = calls.map((c, i) => ((c.table === "concept_nodes" && (c.method === "insert" || c.method === "update")) ? i : -1)).filter((i) => i >= 0);
  const edgeRpcIdxs = calls.map((c, i) => (c.method === "rpc(upsert_edge)" ? i : -1)).filter((i) => i >= 0);
  check("exactly ONE change_sets insert", calls.filter((c) => c.table === "change_sets" && c.method === "insert").length === 1);
  check("all node/edge writes persist BEFORE the change_sets insert", csIdx > 0 && [...nodeWriteIdxs, ...edgeRpcIdxs].every((i) => i < csIdx));

  // ONE change_set_items insert; its rows are node_type concept_graph with the
  // right ops + classifications in the payloads.
  const itemsInsert = calls.find((c) => c.table === "change_set_items" && c.method === "insert");
  const itemRows = (itemsInsert?.arg as Record<string, unknown>[]) ?? [];
  check("every change_set_items row is node_type concept_graph", itemRows.length > 0 && itemRows.every((r) => r.node_type === "concept_graph"));
  const classes = itemRows.map((r) => ((r.after as Record<string, unknown>)?.classification ?? (r.before as Record<string, unknown>)?.classification));
  check("items carry classifications (matched/added/removed present)", classes.includes("matched") && classes.includes("added") && classes.includes("removed"));
  check("the removed item is op 'update' (retire), not a delete", itemRows.some((r) => r.op === "update" && (r.before as Record<string, unknown>)?.classification === "removed"));
  check("the added item is op 'create'", itemRows.some((r) => r.op === "create" && (r.after as Record<string, unknown>)?.classification === "added"));

  // fate finding proposed w/ change_set_id + reconciliation discriminator.
  const findingInsert = calls.find((c) => c.table === "agent_findings" && c.method === "insert");
  const findingUpdate = calls.find((c) => c.table === "agent_findings" && c.method === "update");
  check("fate finding inserted with the reconciliation dedupe_key", !!findingInsert && (findingInsert.arg as Record<string, unknown>).dedupe_key === graphReconciliationDedupeKey(courseId));
  check("fate finding stamps the graph_reconciliation discriminator", !!findingInsert && ((findingInsert.arg as Record<string, unknown>).finding as Record<string, unknown>).discriminator === "graph_reconciliation");
  check("fate finding flipped to 'proposed' with the change_set_id", !!findingUpdate && (findingUpdate.arg as Record<string, unknown>).status === "proposed" && (findingUpdate.arg as Record<string, unknown>).change_set_id === "reconcile-cs-1");

  // Cost telemetry (W3.1 · D-2): the withPooledModel decorator emits ONE cost row per
  // GATED model call — the reconcile fixture (one lesson, a 2-unit cluster, ≥2 active
  // taught nodes after the diff) drives 5 gated calls in ORDER: propose → embed
  // (canonicalize) → merge → embed (embedForMatching) → edge (reconcile-edges). The ids
  // are now `${runId}:${seq}` (seq = the decorator's per-instance monotonic counter over
  // the call order → 0..4), NOT the old `propose:{runId}:{lessonId}` / `reconcile-embed`
  // synthetic ids the retired inline path minted.
  const telemetry = calls.filter((c) => c.method === "upsert(telemetry)");
  const emittedIds = new Set(
    telemetry.map((c) => (((c.arg as unknown[])?.[0] ?? {}) as Record<string, unknown>).client_event_id as string)
  );
  check("model calls emit telemetry via the decorator (≥2: proposal + embed)", telemetry.length >= 2, `telemetry=${telemetry.length}`);
  const expectSeqId = (seq: number) => emittedIds.has(tutorEventId(`${runId}:${seq}`));
  check(
    "cost ids are the deterministic `${runId}:${seq}` sequence 0..4",
    [0, 1, 2, 3, 4].every(expectSeqId),
    [...emittedIds].join(",")
  );
  check(
    "proposal + embed cost ids are runId-scoped (retry-stable), not the retired synthetic ids",
    expectSeqId(0) && expectSeqId(1) && !emittedIds.has(tutorEventId(`propose:${runId}:${lesson.id}`)) && !emittedIds.has(tutorEventId(`reconcile-embed:${runId}:0`))
  );

  // The inline emitTutorModelCall path is GONE from reconcile.ts — the decorator is the
  // ONLY emitter (comments may still mention it; no CALL remains).
  const reconcileSrc = readFileSync(new URL("../lib/tutor/graph/reconcile.ts", import.meta.url), "utf8");
  check("reconcile.ts contains NO emitTutorModelCall call (inline emit retired)", !/emitTutorModelCall\s*\(/.test(reconcileSrc));
}

async function pendingGuard() {
  const { snapshot, doc } = buildSnapshot();
  const model = createMockModelClient([], { structured: {} });
  const calls: RecordedCall[] = [];
  const stub = makeStatefulStub({
    authorId: doc.metadata.ownerId ?? crypto.randomUUID(),
    courseId: doc.id,
    seedNodes: [{ id: "n", title: "T", description: "d", status: "active", created_by: "extraction", creator_edited: false, aliases: [], anchors: [], version: 1 }],
    onCall: (c) => calls.push(c),
    pendingChangeSetId: "existing-pending-cs",
  });
  const result = await runGraphReconciliation(
    { supabase: stub as never, model, loadSnapshot: async () => ({ snapshot, version: 1 }) },
    { courseId: doc.id, publicationId: crypto.randomUUID(), runId: crypto.randomUUID() }
  );
  check("pending set short-circuits to alreadyPending", result.alreadyPending === true);
  check("alreadyPending returns the existing change-set id", result.changeSetId === "existing-pending-cs");
  check("alreadyPending makes NO model calls", model.getCalls().length === 0 && model.getEmbedCalls().length === 0);
  check("alreadyPending persists NO node writes", calls.filter((c) => c.table === "concept_nodes" && (c.method === "insert" || c.method === "update")).length === 0);
  check("alreadyPending stages NO change_sets", calls.filter((c) => c.table === "change_sets" && c.method === "insert").length === 0);
}

main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
