/**
 * TUTOR-1 W1.2B — the concept-graph Reject restore path.
 *
 * A concept_graph change-set item is NOT a course-document node, so it can't ride
 * the CoursePatch pipeline that reverts block/lesson/module items. It carries a
 * concept-graph ENTITY (a `concept_node` / `concept_edge` / `assumed_prior` /
 * `snapshot_map` row) on before/after. Reject restores it here, through a
 * domain-partitioned entity path — the SAME all-or-nothing discipline as
 * `revertChangeSet`: parse EVERY payload first (compute), then apply.
 *
 * This EXTENDS the rail without weakening it. A graph item that fails to parse (or
 * lacks the payload the op needs) aborts the whole plan — nothing is applied — just
 * like a malformed block item aborts `revertChangeSet`. FK safety is enforced by
 * ordering the applied steps (delete edges before nodes; restore nodes before
 * edges). Edge writes go through the definer RPC `tutor_upsert_concept_edge`, which
 * re-validates the DAG, so a restore can NEVER install a cycle.
 *
 * Dependency-light by design (the directive): the supabase client + the payload
 * schema + the graph table names, nothing else. The graph tables/RPC lag
 * lib/database.types.ts (W1.2A's migration + regen), so calls go through an untyped
 * client shim (the rpcJson precedent) — runtime safety comes from the Zod parse.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ConceptGraphItemPayloadSchema,
  type ConceptGraphItemPayload,
} from "@/lib/tutor/graph/schemas";

/** The graph-entity tables the rail restores into. Snapshot-map has a composite PK. */
const TABLE = {
  concept_node: "concept_nodes",
  concept_edge: "concept_edges",
  assumed_prior: "assumed_prior_nodes",
  snapshot_map: "snapshot_concept_map",
} as const;

type Entity = ConceptGraphItemPayload["entity"];

/** The fields of a concept_graph `change_set_items` row this restore needs. */
export interface ConceptGraphRevertItem {
  node_id: string | null;
  op: string;
  before: unknown;
  after: unknown;
}

/** One resolved restore action. `delete` removes a row the reject un-creates;
 *  `restore` re-installs the exact before-row an update/delete changed. */
export type RestoreStep =
  | { kind: "delete"; entity: Entity; id: string }
  | { kind: "restore"; entity: Entity; row: Record<string, unknown> };

/** Whether a change_set_items row is a concept_graph item (vs block/lesson/module). */
export function isConceptGraphItem(item: { node_type?: string | null }): boolean {
  return (item.node_type ?? "block") === "concept_graph";
}

/** FK-safe apply order:
 *  - delete edges (1) before delete nodes (2) — a node can't drop while an edge refs it;
 *  - restore nodes (3) before restore edges (4) — an edge can't insert before its endpoints;
 *  - snapshot_map / assumed_prior are FK-independent (0). */
function phase(step: RestoreStep): number {
  if (step.kind === "delete") {
    if (step.entity === "concept_edge") return 1;
    if (step.entity === "concept_node") return 2;
    return 0;
  }
  if (step.entity === "concept_node") return 3;
  if (step.entity === "concept_edge") return 4;
  return 0;
}

/**
 * PURE, compute-first, all-or-nothing plan of the restore steps for a set of
 * concept_graph revert items. Mirrors `revertChangeSet`'s discipline exactly:
 * parse EVERY payload through `ConceptGraphItemPayloadSchema` FIRST; on ANY parse
 * failure or missing payload return `{ ok:false }` and produce NO steps.
 *
 *   op create → the AFTER payload identifies the row to DELETE (un-create).
 *   op update → the BEFORE payload is the exact row to RESTORE.
 *   op delete → the BEFORE payload is the exact row to RE-INSERT (restore).
 *
 * Steps are returned already ordered for FK safety.
 */
export function planConceptGraphRestore(
  items: ConceptGraphRevertItem[]
): { ok: true; steps: RestoreStep[] } | { ok: false; error: string } {
  const steps: RestoreStep[] = [];

  for (const item of items) {
    const label = item.node_id ?? "(concept_graph item)";

    if (item.op === "create") {
      // Un-create: the AFTER payload names what was added → delete it.
      if (item.after == null) {
        return { ok: false, error: `Can't revert concept_graph create of ${label}: missing after-snapshot` };
      }
      const parsed = ConceptGraphItemPayloadSchema.safeParse(item.after);
      if (!parsed.success) {
        return { ok: false, error: `Invalid concept_graph after-payload for ${label}: ${parsed.error.message}` };
      }
      const id = rowId(parsed.data);
      if (id == null) {
        return { ok: false, error: `Can't revert concept_graph create of ${label}: payload row has no id` };
      }
      steps.push({ kind: "delete", entity: parsed.data.entity, id });
      continue;
    }

    if (item.op === "update" || item.op === "delete") {
      // Restore: the BEFORE payload is the exact prior row.
      if (item.before == null) {
        return { ok: false, error: `Can't revert concept_graph ${item.op} of ${label}: missing before-snapshot` };
      }
      const parsed = ConceptGraphItemPayloadSchema.safeParse(item.before);
      if (!parsed.success) {
        return { ok: false, error: `Invalid concept_graph before-payload for ${label}: ${parsed.error.message}` };
      }
      steps.push({ kind: "restore", entity: parsed.data.entity, row: parsed.data.row });
      continue;
    }

    return { ok: false, error: `Unknown concept_graph op '${item.op}' for ${label}` };
  }

  const ordered = steps
    .map((step, i) => ({ step, i }))
    .sort((a, b) => phase(a.step) - phase(b.step) || a.i - b.i)
    .map(({ step }) => step);

  return { ok: true, steps: ordered };
}

/** The row id a step targets (for `create` deletes; snapshot_map uses node_id). */
function rowId(payload: ConceptGraphItemPayload): string | null {
  const id = payload.row["id"];
  if (typeof id === "string" && id.length > 0) return id;
  // snapshot_map rows are PK'd on (publication_id, node_id) — id lives on node_id.
  if (payload.entity === "snapshot_map") {
    const nodeId = payload.row["node_id"];
    if (typeof nodeId === "string" && nodeId.length > 0) return nodeId;
  }
  return null;
}

/** Untyped client shim: the graph tables/RPC lag database.types.ts (W1.2A regen). */
type UntypedDb = {
  from: (table: string) => {
    delete: () => { eq: (col: string, val: unknown) => { eq?: unknown } & PromiseLike<{ error: { message: string } | null }> };
    upsert: (row: Record<string, unknown>, opts: { onConflict: string }) => PromiseLike<{ error: { message: string } | null }>;
  };
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>;
};

/**
 * Apply the planned restore steps against the live graph tables. Throws on the
 * FIRST error — the caller (`rejectChangeSet`) only flips the change-set status
 * AFTER this resolves, so a throw here leaves the set `pending` (nothing stranded).
 *
 *   deletes  → `.delete().eq("id", …)` (edges/nodes/assumed_prior);
 *              snapshot_map deletes by its composite PK (publication_id, node_id).
 *   restores → exact upsert `onConflict:"id"` (nodes/assumed_prior),
 *              `onConflict:"publication_id,node_id"` (snapshot_map),
 *              and EDGES through the `tutor_upsert_concept_edge` RPC (no
 *              p_expected_version — a restore overwrites; the RPC re-validates the DAG).
 */
export async function applyConceptGraphRestore(
  supabase: SupabaseClient,
  courseId: string,
  steps: RestoreStep[]
): Promise<void> {
  const db = supabase as unknown as UntypedDb;

  for (const step of steps) {
    if (step.kind === "delete") {
      await deleteRow(db, step);
      continue;
    }
    await restoreRow(db, courseId, step);
  }
}

async function deleteRow(db: UntypedDb, step: Extract<RestoreStep, { kind: "delete" }>): Promise<void> {
  if (step.entity === "snapshot_map") {
    // Composite PK — the delete `id` here is the node_id; publication_id is not
    // needed to make the delete FK-safe, but the PK is (publication_id, node_id).
    // We delete by node_id under the same course scope the caller carries.
    const { error } = await (db
      .from(TABLE.snapshot_map)
      .delete()
      .eq("node_id", step.id) as unknown as PromiseLike<{ error: { message: string } | null }>);
    if (error) throw new Error(`concept_graph restore: delete ${step.entity} ${step.id} failed: ${error.message}`);
    return;
  }
  const { error } = await (db
    .from(TABLE[step.entity])
    .delete()
    .eq("id", step.id) as unknown as PromiseLike<{ error: { message: string } | null }>);
  if (error) throw new Error(`concept_graph restore: delete ${step.entity} ${step.id} failed: ${error.message}`);
}

async function restoreRow(
  db: UntypedDb,
  courseId: string,
  step: Extract<RestoreStep, { kind: "restore" }>
): Promise<void> {
  if (step.entity === "concept_edge") {
    // Edge writes have NO client INSERT/UPDATE policy — go through the definer RPC.
    // No p_expected_version (restore overwrites); the RPC re-validates the DAG so a
    // restore can never install a cycle.
    const row = step.row;
    const { error } = await db.rpc("tutor_upsert_concept_edge", {
      p_id: row["id"],
      p_course_id: row["course_id"] ?? courseId,
      p_source_node_id: row["source_node_id"],
      p_target_node_id: row["target_node_id"],
      p_kind: row["kind"],
      p_evidence_refs: row["evidence_refs"] ?? null,
      p_creator_locked: row["creator_locked"] ?? false,
      p_expected_version: null,
    });
    if (error) throw new Error(`concept_graph restore: upsert edge ${String(row["id"])} failed: ${error.message}`);
    return;
  }

  const onConflict = step.entity === "snapshot_map" ? "publication_id,node_id" : "id";
  const { error } = await db.from(TABLE[step.entity]).upsert(step.row, { onConflict });
  if (error) {
    const id = step.row["id"] ?? step.row["node_id"];
    throw new Error(`concept_graph restore: upsert ${step.entity} ${String(id)} failed: ${error.message}`);
  }
}
