/**
 * The governance gate — a FIRST-CLASS, reversibility-graded primitive.
 *
 * EVERY mutating marketing tool call routes through `runThroughGate`, whatever
 * the surface (the "Generate Kit" button, a tool card, or the agent loop). The
 * gate reads the tool's declared `reversibility` and routes:
 *
 *   read         → execute; never recorded.
 *   reversible   → execute immediately; snapshot the target BEFORE; record an
 *                  `auto_approved` ledger row (staged, REJECT-able).
 *   irreversible → DON'T execute; run the tool's side-effect-FREE preview and
 *                  record a `pending` row. A human approve() runs the real
 *                  effect; reject() (deny) discards it.
 *
 * Reject of a reversible action replays the before-snapshot through the entity
 * registry (atomic, byte-for-byte). The DB ledger (`marketing_action`) is the
 * single source of truth for staging + approvals + audit.
 *
 * Tool lookup for approve() lives in tools/index.ts (registry) to avoid a cycle;
 * this module is pure mechanics over a given tool + the ledger.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { restoreEntity, snapshotEntity } from "./entities";
import type { ActionStatus, MarketingActionRow, Reversibility } from "./types";
import type {
  EntityRef,
  MarketingTool,
  MarketingToolContext,
  MarketingToolResult,
} from "./tools/types";

type DB = SupabaseClient<Database>;
type ActionRow = Database["public"]["Tables"]["marketing_action"]["Row"];

export type GateStatus = "read" | "staged" | "pending_approval";

export interface GateOutcome {
  status: GateStatus;
  /** The marketing_action row id (null for read tools). */
  actionId: string | null;
  reversibility: Reversibility;
  summary: string;
  data?: unknown;
  target?: EntityRef | null;
  /** For pending_approval: details to render in the approval card. */
  approvalPreview?: Record<string, unknown>;
}

function actionRowToDomain(row: ActionRow): MarketingActionRow {
  return {
    id: row.id,
    courseId: row.course_id,
    campaignId: row.campaign_id,
    toolName: row.tool_name,
    actionKind: row.action_kind,
    reversibility: row.reversibility as Exclude<Reversibility, "read">,
    status: row.status as ActionStatus,
    params: (row.params as Record<string, unknown>) ?? {},
    beforeSnapshot: row.before_snapshot ?? null,
    targetRef: (row.target_ref as { entity: string; id: string } | null) ?? null,
    summary: row.summary,
    requestedBy: row.requested_by as "user" | "agent",
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

async function insertAction(
  ctx: MarketingToolContext,
  tool: MarketingTool,
  fields: {
    status: ActionStatus;
    params: unknown;
    summary: string;
    target: EntityRef | null;
    beforeSnapshot: Json | null;
  }
): Promise<string> {
  const { data, error } = await ctx.supabase
    .from("marketing_action")
    .insert({
      course_id: ctx.courseId,
      campaign_id: ctx.campaignId,
      tool_name: tool.name,
      action_kind: tool.actionKind ?? tool.name,
      reversibility: tool.reversibility === "reversible" ? "reversible" : "irreversible",
      status: fields.status,
      params: (fields.params ?? {}) as Json,
      before_snapshot: fields.beforeSnapshot,
      target_ref: (fields.target as unknown as Json) ?? null,
      summary: fields.summary,
      requested_by: ctx.requestedBy,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`gate: failed to record action — ${error?.message}`);
  return data.id;
}

/** The one entry point every mutating tool call flows through. */
export async function runThroughGate(
  tool: MarketingTool,
  args: unknown,
  ctx: MarketingToolContext
): Promise<GateOutcome> {
  const parsed = tool.params.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for ${tool.name}: ${parsed.error.message}`);
  }
  const a = parsed.data;

  if (tool.reversibility === "read") {
    const outcome = await tool.execute(a, ctx);
    return {
      status: "read",
      actionId: null,
      reversibility: "read",
      summary: outcome.summary,
      data: outcome.data,
    };
  }

  if (tool.reversibility === "reversible") {
    const existing = tool.existingTarget ? await tool.existingTarget(a, ctx) : null;
    const before = existing ? await snapshotEntity(ctx.supabase, existing) : null;
    const outcome: MarketingToolResult = await tool.execute(a, { ...ctx, approved: true });
    const target = outcome.target ?? existing ?? null;
    const actionId = await insertAction(ctx, tool, {
      status: "auto_approved",
      params: a,
      summary: outcome.summary,
      target,
      beforeSnapshot: before,
    });
    return {
      status: "staged",
      actionId,
      reversibility: "reversible",
      summary: outcome.summary,
      data: outcome.data,
      target,
    };
  }

  // irreversible — DO NOT execute; preview only, then record pending.
  const preview: MarketingToolResult = await tool.execute(a, { ...ctx, approved: false });
  const actionId = await insertAction(ctx, tool, {
    status: "pending",
    params: a,
    summary: preview.summary,
    target: preview.target ?? null,
    beforeSnapshot: null,
  });
  return {
    status: "pending_approval",
    actionId,
    reversibility: "irreversible",
    summary: preview.summary,
    data: preview.data,
    target: preview.target ?? null,
    approvalPreview: preview.approvalPreview,
  };
}

/* ───────────────────────────── ledger ops ────────────────────────────── */

export async function loadAction(supabase: DB, actionId: string): Promise<MarketingActionRow | null> {
  const { data } = await supabase.from("marketing_action").select("*").eq("id", actionId).maybeSingle();
  return data ? actionRowToDomain(data) : null;
}

/** Accept a staged reversible change: keep it; clear the staging flag. */
export async function acceptAction(supabase: DB, actionId: string): Promise<void> {
  const { error } = await supabase
    .from("marketing_action")
    .update({ status: "executed", resolved_at: new Date().toISOString() })
    .eq("id", actionId)
    .eq("status", "auto_approved");
  if (error) throw new Error(`gate.accept: ${error.message}`);
}

/**
 * Reject:
 *   pending (irreversible, never executed) → deny: mark 'rejected', no undo.
 *   auto_approved (reversible, applied)    → revert via the entity registry,
 *                                            then mark 'reverted'. Atomic.
 * Idempotent: a resolved action is a no-op.
 */
export async function rejectAction(supabase: DB, actionId: string): Promise<void> {
  const action = await loadAction(supabase, actionId);
  if (!action) throw new Error("Action not found");

  if (action.status === "pending") {
    const { error } = await supabase
      .from("marketing_action")
      .update({ status: "rejected", resolved_at: new Date().toISOString() })
      .eq("id", actionId)
      .eq("status", "pending");
    if (error) throw new Error(`gate.reject(deny): ${error.message}`);
    return;
  }

  if (action.status === "auto_approved") {
    if (action.targetRef) {
      await restoreEntity(
        supabase,
        action.targetRef as EntityRef,
        (action.beforeSnapshot as Json | null) ?? null
      );
    }
    const { error } = await supabase
      .from("marketing_action")
      .update({ status: "reverted", resolved_at: new Date().toISOString() })
      .eq("id", actionId)
      .eq("status", "auto_approved");
    if (error) throw new Error(`gate.reject(revert): ${error.message}`);
    return;
  }

  // already resolved (executed/approved/rejected/reverted) — nothing to do.
}

/** Mark a pending irreversible action as executed (called after approve runs the
 *  real effect). */
export async function markActionExecuted(
  supabase: DB,
  actionId: string,
  target: EntityRef | null
): Promise<void> {
  const patch: Database["public"]["Tables"]["marketing_action"]["Update"] = {
    status: "executed",
    resolved_at: new Date().toISOString(),
  };
  if (target) patch.target_ref = target as unknown as Json;
  const { error } = await supabase
    .from("marketing_action")
    .update(patch)
    .eq("id", actionId)
    .eq("status", "pending");
  if (error) throw new Error(`gate.markExecuted: ${error.message}`);
}

/** Pending irreversible actions awaiting human approval (the approval inbox). */
export async function listPendingApprovals(
  supabase: DB,
  courseId: string
): Promise<MarketingActionRow[]> {
  const { data } = await supabase
    .from("marketing_action")
    .select("*")
    .eq("course_id", courseId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  return (data ?? []).map(actionRowToDomain);
}

/** Staged reversible actions awaiting accept/reject (the review surface). */
export async function listStagedActions(
  supabase: DB,
  courseId: string
): Promise<MarketingActionRow[]> {
  const { data } = await supabase
    .from("marketing_action")
    .select("*")
    .eq("course_id", courseId)
    .eq("status", "auto_approved")
    .order("created_at", { ascending: false });
  return (data ?? []).map(actionRowToDomain);
}
