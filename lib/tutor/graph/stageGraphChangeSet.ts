/**
 * Stage an extraction result as a reviewable change-set (TUTOR-1 Wave 1.3 · Directive §1.2 step 6).
 *
 * "Persist rows first, then stage" — the stageStructureChangeSet convention:
 *   (a) IDEMPOTENCY GUARD — a PENDING change_set that already has concept_graph
 *       items for this course short-circuits ({alreadyPending, changeSetId}). An
 *       Inngest step retry then never double-stages.
 *   (b) PERSIST every row: createConceptNode (created_by 'extraction'),
 *       upsertConceptEdge (the definer RPC — service-role path; a cycle error here
 *       is a BUG loudly surfaced because the pure passes already guaranteed
 *       acyclicity), upsertAssumedPrior, insert snapshot_concept_map rows.
 *   (c) ONE change_sets row (status 'pending') + a change_set_items row per
 *       PERSISTED row (node_type 'concept_graph', op 'create', node_id = the row
 *       id, before=null, after=ConceptGraphItemPayload{entity,row}) — so Reject
 *       (lib/tutor/railRestore.ts) deletes every one of them.
 *   (d) The FATE row in agent_findings, then flip open→proposed with the
 *       change_set_id (the lib/ai/maintenance.ts persistFinding convention).
 *
 * ⚠ agent_findings CHECK conformance: the 20260703000000 CHECKs are
 *   kind ∈ (content_issue, learner_risk, structure_gap) and
 *   severity ∈ (low, medium, high). No migration widens them, and this package
 *   may not add one, so the fate row uses kind 'structure_gap' + severity 'low'
 *   (the closest allowed values) and stamps the true discriminator
 *   ('graph_extraction') + counts + flags + dropped-edge log INSIDE the finding
 *   jsonb. See GRAPH_EXTRACTION_FINDING_KIND / _SEVERITY.
 *
 * The supabase arg is the ADMIN client (the extraction pipeline runs service-role;
 * the edge RPC's author-or-service-role gate rides that). We keep the DB surface
 * behind a small structural interface so the pure suite can stub it and assert
 * capture-ORDER (rows persisted BEFORE the change_set insert).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import {
  createConceptNode,
  upsertAssumedPrior,
  upsertConceptEdge,
  type ConceptNodeCreateInput,
  type ConceptEdgeUpsertInput,
} from "./repository";
import { ConceptGraphItemPayloadSchema, type ConceptGraphItemPayload } from "./schemas";

type DB = SupabaseClient<Database>;

/**
 * agent_findings CHECK-conformant values for the extraction fate row (see the
 * module header). The true kind ('graph_extraction') lives in the finding jsonb's
 * `discriminator`, so a downstream reader still identifies it precisely.
 */
export const GRAPH_EXTRACTION_FINDING_KIND = "structure_gap" as const;
export const GRAPH_EXTRACTION_FINDING_SEVERITY = "low" as const;
export const GRAPH_EXTRACTION_DISCRIMINATOR = "graph_extraction" as const;

/** dedupe_key for the extraction fate row (Directive §1.2 step 6d). */
export function graphExtractionDedupeKey(courseId: string): string {
  return `graph_extraction:${courseId}`;
}

/* ─────────────────────────────── inputs ─────────────────────────────────── */

/** A node to persist. `anchors` are already snapshot-resolved (Directive step 7). */
export interface StageNodeInput {
  title: string;
  description: string;
  aliases: string[];
  anchors: ConceptNodeCreateInput["anchors"];
  embedding?: number[] | null;
}

/** An edge to persist, INDEX-addressed against the staged node list (the
 *  orchestrator resolves indexes → the freshly-created node ids). */
export interface StageEdgeInput {
  sourceNodeIndex: number;
  targetNodeIndex: number;
  kind: ConceptEdgeUpsertInput["kind"];
  evidenceRefs?: unknown[];
}

export interface StageAssumedPriorInput {
  title: string;
  description: string;
  evidence?: unknown[];
}

/** A snapshot_concept_map row to insert (Directive step 7 — anchor resolution). */
export interface StageSnapshotMapInput {
  nodeIndex: number;
  anchors: ConceptGraphItemPayload["row"]["anchors"];
  anchorDowngraded: boolean;
}

export interface StageExtractionArgs {
  courseId: string;
  authorId: string;
  runId: string;
  publicationId: string;
  version: number;
  nodes: StageNodeInput[];
  edges: StageEdgeInput[];
  assumedPriors: StageAssumedPriorInput[];
  snapshotMap: StageSnapshotMapInput[];
  /** The finding jsonb evidence blob: counts + flags + dropped-edge log. */
  evidence: {
    flags: string[];
    droppedEdges: { reason: string; count: number }[];
    checkpoint: string | null;
  };
  /** Injectable clock (pure/testable); defaults to wall time. */
  nowIso?: () => string;
}

export interface StageExtractionResult {
  alreadyPending: boolean;
  changeSetId: string | null;
  findingId: string | null;
  nodeCount: number;
  edgeCount: number;
  assumedPriorCount: number;
  snapshotMapCount: number;
}

/* ─────────────────────────── idempotency guard ──────────────────────────── */

/**
 * Is there already a PENDING change_set carrying concept_graph items for this
 * course? A single join query: change_set_items(node_type='concept_graph') ⋈
 * change_sets(status='pending', course_id). Returns the change_set id if so.
 *
 * Exported so the reconciliation stager (W1.4) reuses the SAME guard — a
 * concept_graph pending set short-circuits both extraction and reconciliation.
 */
export async function findPendingConceptGraphChangeSet(
  supabase: DB,
  courseId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("change_set_items")
    .select("change_set_id, change_sets!inner(id, status, course_id)")
    .eq("node_type", "concept_graph")
    .eq("change_sets.course_id", courseId)
    .eq("change_sets.status", "pending")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findPendingConceptGraphChangeSet: ${error.message}`);
  if (!data) return null;
  return (data as { change_set_id: string }).change_set_id;
}

/* ─────────────────────────── change-set item build ──────────────────────── */

/** Build a concept_graph change_set_items row's `after` payload from a persisted
 *  row. Validated through the shared payload schema so a malformed row is caught
 *  HERE, not at reject time. */
function buildAfterPayload(
  entity: ConceptGraphItemPayload["entity"],
  row: Record<string, unknown>
): Json {
  const payload: ConceptGraphItemPayload = {
    entity,
    row,
    classification: "added",
  };
  // Validate (throws on a malformed row) — the rail parses the SAME schema on reject.
  ConceptGraphItemPayloadSchema.parse(payload);
  return payload as unknown as Json;
}

/* ──────────────────────────────── main ──────────────────────────────────── */

/**
 * Persist the extraction result and stage it as ONE pending change-set + a
 * proposed fate finding. Returns the change-set + finding ids (null on the
 * already-pending short-circuit). Throws on any DB failure — the Inngest wrapper
 * decides retries (a step retry hits the idempotency guard and no-ops).
 */
export async function stageExtractionResult(
  supabase: DB,
  args: StageExtractionArgs
): Promise<StageExtractionResult> {
  const now = args.nowIso ?? (() => new Date().toISOString());

  // (a) Idempotency guard.
  const existing = await findPendingConceptGraphChangeSet(supabase, args.courseId);
  if (existing) {
    return {
      alreadyPending: true,
      changeSetId: existing,
      findingId: null,
      nodeCount: 0,
      edgeCount: 0,
      assumedPriorCount: 0,
      snapshotMapCount: 0,
    };
  }

  // (b) Persist the rows. Collect each persisted row + its change_set_items payload.
  const items: {
    entity: ConceptGraphItemPayload["entity"];
    nodeId: string;
    after: Json;
  }[] = [];

  // Nodes first (edges + snapshot-map rows reference their ids).
  const nodeIds: string[] = [];
  for (const n of args.nodes) {
    const created = await createConceptNode(supabase, {
      courseId: args.courseId,
      title: n.title,
      description: n.description,
      createdBy: "extraction",
      aliases: n.aliases,
      anchors: n.anchors,
      embedding: n.embedding ?? null,
    });
    nodeIds.push(created.id);
    items.push({
      entity: "concept_node",
      nodeId: created.id,
      after: buildAfterPayload("concept_node", created as unknown as Record<string, unknown>),
    });
  }

  // Edges via the definer RPC. A cycle error here is a BUG (the pure passes
  // guaranteed acyclicity) — surface it loudly.
  for (const e of args.edges) {
    const sourceId = nodeIds[e.sourceNodeIndex];
    const targetId = nodeIds[e.targetNodeIndex];
    if (!sourceId || !targetId) {
      throw new Error(
        `stageExtractionResult: edge references an out-of-range node index (${e.sourceNodeIndex}→${e.targetNodeIndex})`
      );
    }
    const edgeId = crypto.randomUUID();
    const created = await upsertConceptEdge(supabase, {
      id: edgeId,
      courseId: args.courseId,
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      kind: e.kind,
      evidenceRefs: e.evidenceRefs ?? [],
    });
    items.push({
      entity: "concept_edge",
      nodeId: created.id,
      after: buildAfterPayload("concept_edge", created as unknown as Record<string, unknown>),
    });
  }

  // Assumed priors.
  for (const p of args.assumedPriors) {
    const created = await upsertAssumedPrior(supabase, {
      courseId: args.courseId,
      title: p.title,
      description: p.description,
      evidence: p.evidence ?? [],
    });
    items.push({
      entity: "assumed_prior",
      nodeId: created.id,
      after: buildAfterPayload("assumed_prior", created as unknown as Record<string, unknown>),
    });
  }

  // Snapshot-map rows.
  for (const m of args.snapshotMap) {
    const nodeId = nodeIds[m.nodeIndex];
    if (!nodeId) {
      throw new Error(`stageExtractionResult: snapshot_map references an out-of-range node index (${m.nodeIndex})`);
    }
    const row = {
      publication_id: args.publicationId,
      node_id: nodeId,
      course_id: args.courseId,
      version: args.version,
      anchors: (m.anchors ?? []) as unknown as Json,
      anchor_downgraded: m.anchorDowngraded,
    };
    const { data, error } = await supabase
      .from("snapshot_concept_map")
      .insert(row)
      .select("*")
      .single();
    if (error || !data) throw new Error(`stageExtractionResult: snapshot_map insert failed: ${error?.message}`);
    items.push({
      entity: "snapshot_map",
      // snapshot_map has a composite PK; the rail keys its delete on node_id.
      nodeId: (data as { node_id: string }).node_id,
      after: buildAfterPayload("snapshot_map", data as unknown as Record<string, unknown>),
    });
  }

  // (c) ONE change_sets row + the items. Rows are ALREADY persisted (capture order:
  //     every persist above happened before this insert).
  const summary = `Concept graph: ${args.nodes.length} concept${args.nodes.length === 1 ? "" : "s"}, ${args.edges.length} edge${args.edges.length === 1 ? "" : "s"}, ${args.assumedPriors.length} assumed prior${args.assumedPriors.length === 1 ? "" : "s"}`;
  const csInsert = await supabase
    .from("change_sets")
    .insert({
      course_id: args.courseId,
      status: "pending",
      summary,
    })
    .select("id")
    .single();
  if (csInsert.error || !csInsert.data) {
    throw new Error(`stageExtractionResult: change_sets insert failed: ${csInsert.error?.message}`);
  }
  const changeSetId = csInsert.data.id;

  if (items.length > 0) {
    const itemRows = items.map((it) => ({
      change_set_id: changeSetId,
      course_id: args.courseId,
      node_type: "concept_graph",
      node_id: it.nodeId,
      op: "create",
      before: null as Json | null,
      after: it.after,
    }));
    const itemsInsert = await supabase.from("change_set_items").insert(itemRows);
    if (itemsInsert.error) {
      throw new Error(`stageExtractionResult: change_set_items insert failed: ${itemsInsert.error.message}`);
    }
  }

  // (d) The FATE row in agent_findings, then flip open→proposed w/ change_set_id.
  const findingPayload: Json = {
    discriminator: GRAPH_EXTRACTION_DISCRIMINATOR,
    title: "Concept graph extracted",
    counts: {
      nodes: args.nodes.length,
      edges: args.edges.length,
      assumedPriors: args.assumedPriors.length,
      snapshotMap: args.snapshotMap.length,
    },
    flags: args.evidence.flags,
    droppedEdges: args.evidence.droppedEdges,
    checkpoint: args.evidence.checkpoint,
    publicationId: args.publicationId,
    version: args.version,
    runId: args.runId,
    at: now(),
  } as unknown as Json;

  let findingId: string | null = null;
  const findingInsert = await supabase
    .from("agent_findings")
    .insert({
      run_id: args.runId,
      course_id: args.courseId,
      kind: GRAPH_EXTRACTION_FINDING_KIND,
      severity: GRAPH_EXTRACTION_FINDING_SEVERITY,
      dedupe_key: graphExtractionDedupeKey(args.courseId),
      finding: findingPayload,
    })
    .select("id")
    .maybeSingle();
  if (findingInsert.error) {
    // 23505 = an open row with this dedupe_key already exists — adopt it (the
    // persistFinding convention). Extraction can legitimately re-file a fate row.
    if (findingInsert.error.code === "23505") {
      const existingFinding = await supabase
        .from("agent_findings")
        .select("id")
        .eq("course_id", args.courseId)
        .eq("dedupe_key", graphExtractionDedupeKey(args.courseId))
        .eq("status", "open")
        .maybeSingle();
      if (existingFinding.data) {
        await supabase
          .from("agent_findings")
          .update({ run_id: args.runId, finding: findingPayload })
          .eq("id", existingFinding.data.id);
        findingId = existingFinding.data.id;
      }
    } else {
      throw new Error(`stageExtractionResult: agent_findings insert failed: ${findingInsert.error.message}`);
    }
  } else {
    findingId = findingInsert.data?.id ?? null;
  }

  if (findingId) {
    const flip = await supabase
      .from("agent_findings")
      .update({ status: "proposed", change_set_id: changeSetId })
      .eq("id", findingId);
    if (flip.error) throw new Error(`stageExtractionResult: agent_findings proposed-flip failed: ${flip.error.message}`);
  }

  return {
    alreadyPending: false,
    changeSetId,
    findingId,
    nodeCount: args.nodes.length,
    edgeCount: args.edges.length,
    assumedPriorCount: args.assumedPriors.length,
    snapshotMapCount: args.snapshotMap.length,
  };
}
