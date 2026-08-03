/**
 * Concept-graph entity snapshot / restore registry + the tutor reversibility
 * ledger — the generic revert engine `tutor_action` rows use, mirroring the
 * marketing gate (lib/marketing/entities.ts + gate.ts) at tutor-scoped paths.
 *
 *   snapshot(id) → the entity's full row as JSON (null if absent)
 *   restore(id, before):
 *     before === null → DELETE the entity (revert of a create)
 *     before !== null → upsert the entity back to `before` (revert of an update)
 *
 * concept_edges restore THROUGH the definer RPC (upsertConceptEdge), NOT a raw
 * upsert — the DAG cycle gate must hold even on a restore, and the table has no
 * client insert/update policy anyway. Restore runs under the author-scoped
 * client so RLS still applies.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { upsertConceptEdge } from "./repository";

type DB = SupabaseClient<Database>;

/** The env-configurable reversibility window (hours). Default 24h — the
 *  marketing gate's default. */
export const TUTOR_REVERT_WINDOW_HOURS = (() => {
  const raw = Number(process.env.TUTOR_REVERT_WINDOW_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
})();

/** The two graph entities the ledger can snapshot/restore. */
export type TutorEntityKind = "concept_node" | "concept_edge";

export interface TutorEntityRef {
  entity: TutorEntityKind;
  id: string;
}

interface TutorEntitySnapshotter {
  snapshot(supabase: DB, id: string): Promise<Json | null>;
  restore(supabase: DB, id: string, before: Json | null): Promise<void>;
}

/** concept_nodes — a plain single-row entity (has full CRUD policies). */
const conceptNodeSnapshotter: TutorEntitySnapshotter = {
  async snapshot(supabase, id) {
    const { data } = await supabase.from("concept_nodes").select("*").eq("id", id).maybeSingle();
    return (data as unknown as Json) ?? null;
  },
  async restore(supabase, id, before) {
    if (before === null) {
      const { error } = await supabase.from("concept_nodes").delete().eq("id", id);
      if (error) throw new Error(`restore(delete concept_nodes/${id}): ${error.message}`);
      return;
    }
    const { error } = await supabase.from("concept_nodes").upsert(before as never, { onConflict: "id" });
    if (error) throw new Error(`restore(upsert concept_nodes/${id}): ${error.message}`);
  },
};

/**
 * concept_edges — restore rides the definer RPC so the cycle gate holds even
 * when replaying a prior edge (and because the table has no client write
 * policy). A restore of an update passes NO expectedVersion (the gate already
 * bumped versions on every write; replaying the prior row wins-last is the
 * intended revert semantics, and its version field is ignored by the RPC).
 */
const conceptEdgeSnapshotter: TutorEntitySnapshotter = {
  async snapshot(supabase, id) {
    const { data } = await supabase.from("concept_edges").select("*").eq("id", id).maybeSingle();
    return (data as unknown as Json) ?? null;
  },
  async restore(supabase, id, before) {
    if (before === null) {
      const { error } = await supabase.from("concept_edges").delete().eq("id", id);
      if (error) throw new Error(`restore(delete concept_edges/${id}): ${error.message}`);
      return;
    }
    const row = before as unknown as Database["public"]["Tables"]["concept_edges"]["Row"];
    await upsertConceptEdge(supabase, {
      id: row.id,
      courseId: row.course_id,
      sourceNodeId: row.source_node_id,
      targetNodeId: row.target_node_id,
      kind: row.kind as "prerequisite" | "part_of" | "related",
      evidenceRefs: (row.evidence_refs as unknown[] | null) ?? [],
      creatorLocked: row.creator_locked,
    });
  },
};

const REGISTRY: Record<TutorEntityKind, TutorEntitySnapshotter> = {
  concept_node: conceptNodeSnapshotter,
  concept_edge: conceptEdgeSnapshotter,
};

export async function snapshotTutorEntity(supabase: DB, ref: TutorEntityRef): Promise<Json | null> {
  const s = REGISTRY[ref.entity];
  if (!s) throw new Error(`No snapshotter for tutor entity '${ref.entity}'`);
  return s.snapshot(supabase, ref.id);
}

export async function restoreTutorEntity(
  supabase: DB,
  ref: TutorEntityRef,
  before: Json | null
): Promise<void> {
  const s = REGISTRY[ref.entity];
  if (!s) throw new Error(`No snapshotter for tutor entity '${ref.entity}'`);
  await s.restore(supabase, ref.id, before);
}

/* ─────────────────────────────── the ledger ─────────────────────────────── */

export interface RecordTutorActionInput {
  courseId: string;
  toolName: string;
  actionKind: string;
  reversibility?: "reversible" | "irreversible";
  params?: Json;
  beforeSnapshot?: Json | null;
  targetRef?: TutorEntityRef | null;
  summary?: string | null;
  requestedBy?: "agent" | "user";
  /** Injectable clock (tests run on a fixed clock; prod omits → wall-clock). */
  nowIso?: string;
  /** Override the default revert window (hours). */
  revertWindowHours?: number;
}

export interface TutorActionRecord {
  id: string;
  courseId: string;
  status: "executed" | "reverted";
  revertExpiresAt: string | null;
}

/** Insert a ledger row. A reversible action stamps revert_expires_at =
 *  now + TUTOR_REVERT_WINDOW_HOURS; an irreversible one leaves it null (it was
 *  never revertable — the audit trail records it). */
export async function recordTutorAction(
  supabase: DB,
  input: RecordTutorActionInput
): Promise<TutorActionRecord> {
  const reversibility = input.reversibility ?? "reversible";
  const nowIso = input.nowIso ?? new Date().toISOString();
  const windowHours = input.revertWindowHours ?? TUTOR_REVERT_WINDOW_HOURS;
  const revertExpiresAt =
    reversibility === "reversible"
      ? new Date(new Date(nowIso).getTime() + windowHours * 3600_000).toISOString()
      : null;

  const insert: Database["public"]["Tables"]["tutor_action"]["Insert"] = {
    course_id: input.courseId,
    tool_name: input.toolName,
    action_kind: input.actionKind,
    reversibility,
    status: "executed",
    params: input.params ?? {},
    before_snapshot: input.beforeSnapshot ?? null,
    target_ref: (input.targetRef as unknown as Json) ?? null,
    summary: input.summary ?? null,
    requested_by: input.requestedBy ?? "user",
    revert_expires_at: revertExpiresAt,
  };
  const { data, error } = await supabase.from("tutor_action").insert(insert).select("*").single();
  if (error || !data) throw new Error(`recordTutorAction: ${error?.message}`);
  return {
    id: data.id,
    courseId: data.course_id,
    status: data.status as "executed" | "reverted",
    revertExpiresAt: data.revert_expires_at,
  };
}

/**
 * PURE revert-window predicate — extracted so it's unit-testable without a DB.
 * Fail closed: no window (null) OR a closed window both refuse (mirrors the
 * marketing gate's rejectAction). Returns the refusal reason, or null when the
 * revert is allowed.
 */
export function revertRefusal(revertExpiresAt: string | null, nowIso: string): string | null {
  if (!revertExpiresAt) return "This action was never revertable (no revert window).";
  if (revertExpiresAt <= nowIso) {
    return "Revert window expired — this change can no longer be rolled back.";
  }
  return null;
}

export type RevertResult = { reverted: boolean; reason?: string };

/**
 * Revert a reversible tutor_action: refuse past the window (fail closed),
 * restore the before_snapshot through the entity registry, then flip
 * executed→reverted with resolved_at. An already-reverted action is a typed
 * no-op (`{ reverted: false }`, no error) — idempotent, the marketing precedent.
 */
export async function revertTutorAction(
  supabase: DB,
  actionId: string,
  opts: { nowIso?: string } = {}
): Promise<RevertResult> {
  const { data: action, error: loadErr } = await supabase
    .from("tutor_action")
    .select("*")
    .eq("id", actionId)
    .maybeSingle();
  if (loadErr) throw new Error(`revertTutorAction(load): ${loadErr.message}`);
  if (!action) throw new Error("tutor_action not found");

  if (action.status === "reverted") return { reverted: false, reason: "already reverted" };

  const nowIso = opts.nowIso ?? new Date().toISOString();
  const refusal = revertRefusal(action.revert_expires_at, nowIso);
  if (refusal) throw new Error(refusal);

  if (action.target_ref) {
    await restoreTutorEntity(
      supabase,
      action.target_ref as unknown as TutorEntityRef,
      (action.before_snapshot as Json | null) ?? null
    );
  }

  const { error } = await supabase
    .from("tutor_action")
    .update({ status: "reverted", resolved_at: nowIso })
    .eq("id", actionId)
    .eq("status", "executed");
  if (error) throw new Error(`revertTutorAction(flip): ${error.message}`);
  return { reverted: true };
}
