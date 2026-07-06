/**
 * The governance gate — a FIRST-CLASS, reversibility-graded primitive.
 *
 * EVERY mutating marketing tool call routes through `runThroughGate`, whatever
 * the surface (the "Generate Kit" button, a tool card, or the agent loop). The
 * gate reads the tool's declared `reversibility` and routes:
 *
 *   read         → execute; never recorded.
 *   reversible   → execute immediately; snapshot the target BEFORE; record an
 *                  `auto_approved` ledger row. NOT a blocking card — a quiet,
 *                  dismissible activity-log entry with a one-click Revert that
 *                  stays open for the course's revert window (default 24h).
 *   irreversible → routed by the AUTONOMY ENGINE (lib/marketing/autonomy.ts):
 *                    · hard-denied tools    → always a pending approval card
 *                    · manual mode          → always a pending approval card
 *                    · assisted (default)   → a card — but ambiguous targeting
 *                      raises a clarifying question first, and a test email to
 *                      the creator's OWN address auto-logs
 *                    · auto mode            → executes ONLY on a clean match
 *                      against the creator's explicit policy (allowlist +
 *                      caps + hours + first-segment-send); any single
 *                      guardrail failing falls back to the card
 *                  Every routing writes the full AutonomyDecision audit onto
 *                  the ledger row (`autonomy_decision`).
 *
 * A separate interaction kind rides the same rails: `interaction: "question"`
 * tools (ask_creator) and gate-raised targeting questions both return
 * `needs_clarification` — the loop's ONE "blocked, waiting on a human" branch
 * alongside `pending_approval`.
 *
 * Reject of a reversible action replays the before-snapshot through the entity
 * registry (atomic, byte-for-byte) — refused once the revert window closes.
 * The DB ledger (`marketing_action`) is the single source of truth for
 * activity + approvals + audit.
 *
 * Tool lookup for approve() lives in tools/index.ts (registry) to avoid a cycle;
 * this module is pure mechanics over a given tool + the ledger.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import {
  evaluateAutonomy,
  HARD_DENY_TOOLS,
  type AutonomyDecision,
  type AutonomyFacts,
} from "./autonomy";
import { hasSegmentBeenSent, loadAutonomySettings, recordSegmentSend } from "./autonomyStore";
import { restoreEntity, snapshotEntity } from "./entities";
import { insertQuestion, type QuestionSpec } from "./questions";
import type { ActionStatus, MarketingActionRow, Reversibility } from "./types";
import type {
  EntityRef,
  MarketingTool,
  MarketingToolContext,
  MarketingToolResult,
} from "./tools/types";

type DB = SupabaseClient<Database>;
type ActionRow = Database["public"]["Tables"]["marketing_action"]["Row"];

export type GateStatus =
  | "read"
  | "staged"
  | "pending_approval"
  | "executed"
  | "needs_clarification";

export interface GateOutcome {
  status: GateStatus;
  /** The marketing_action row id (null for read tools + questions). */
  actionId: string | null;
  reversibility: Reversibility;
  summary: string;
  data?: unknown;
  target?: EntityRef | null;
  /** For pending_approval: details to render in the approval card. */
  approvalPreview?: Record<string, unknown>;
  /** For needs_clarification: the stored question awaiting the creator. */
  questionId?: string;
  question?: QuestionSpec;
  /** Irreversible routings: the full autonomy audit (also on the ledger row). */
  autonomy?: AutonomyDecision;
  /** Staged reversible actions: Revert stays available until this instant. */
  revertExpiresAt?: string | null;
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
    conversationId: row.conversation_id ?? null,
    revertExpiresAt: row.revert_expires_at,
    autonomyDecision: row.autonomy_decision ?? null,
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
    revertExpiresAt?: string | null;
    autonomyDecision?: AutonomyDecision | null;
    resolvedAt?: string | null;
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
      conversation_id: ctx.conversationId ?? null,
      revert_expires_at: fields.revertExpiresAt ?? null,
      autonomy_decision: (fields.autonomyDecision as unknown as Json) ?? null,
      resolved_at: fields.resolvedAt ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`gate: failed to record action — ${error?.message}`);
  return data.id;
}

/** The creator's email for the send_test_email owner guard. Prefers the
 *  ctx-provided value; falls back to the session user. A miss returns null →
 *  the guard evaluates false → the test email stays on the card path. */
async function resolveOwnerEmail(ctx: MarketingToolContext): Promise<string | null> {
  if (ctx.ownerEmail) return ctx.ownerEmail;
  try {
    const { data } = await ctx.supabase.auth.getUser();
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}

/** Recipients this preview says the call reaches; null = nothing countable. */
function extractAudienceCount(tool: MarketingTool, preview: MarketingToolResult): number | null {
  const p = preview.approvalPreview ?? {};
  if (typeof p.audience === "number") return p.audience;
  if (typeof p.count === "number") return p.count;
  if (tool.name === "send_test_email" || tool.name === "send_consent_confirmation") return 1;
  return null;
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

  // 0 — interaction tools (ask_creator): record the question, pause. The
  // tool's execute never runs; the gate IS the implementation.
  if (tool.interaction === "question") {
    const spec = a as QuestionSpec;
    const questionId = await insertQuestion(ctx.supabase, {
      courseId: ctx.courseId,
      campaignId: ctx.campaignId,
      conversationId: ctx.conversationId ?? null,
      source: "model",
      toolCallId: ctx.toolCallId ?? null,
      spec,
      requestedBy: ctx.requestedBy,
    });
    return {
      status: "needs_clarification",
      actionId: null,
      reversibility: tool.reversibility,
      summary: spec.question,
      questionId,
      question: spec,
    };
  }

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
    // NEVER consults the autonomy mode and has no path to pending_approval —
    // reversible actions execute in every mode; the ledger row is a quiet,
    // revertable log entry, not a blocking card.
    const settings = await loadAutonomySettings(ctx.supabase, ctx.courseId);
    const existing = tool.existingTarget ? await tool.existingTarget(a, ctx) : null;
    const before = existing ? await snapshotEntity(ctx.supabase, existing) : null;
    const outcome: MarketingToolResult = await tool.execute(a, { ...ctx, approved: true });
    const target = outcome.target ?? existing ?? null;
    const revertExpiresAt = new Date(
      ctx.services.clock.epochMs() + settings.revertWindowHours * 3_600_000
    ).toISOString();
    const actionId = await insertAction(ctx, tool, {
      status: "auto_approved",
      params: a,
      summary: outcome.summary,
      target,
      beforeSnapshot: before,
      revertExpiresAt,
    });
    return {
      status: "staged",
      actionId,
      reversibility: "reversible",
      summary: outcome.summary,
      data: outcome.data,
      target,
      revertExpiresAt,
    };
  }

  // ── irreversible — the autonomy ladder ──────────────────────────────────
  const settings = await loadAutonomySettings(ctx.supabase, ctx.courseId);
  const hardDenied = HARD_DENY_TOOLS.has(tool.name);

  // Ambiguous targeting → a clarifying question INSTEAD of a half-specified
  // card (assisted + auto; manual mode always goes straight to the card).
  // Nothing executes, no pending row is created.
  if (!hardDenied && settings.mode !== "manual" && tool.clarifyTargeting) {
    const spec = await tool.clarifyTargeting(a, ctx);
    if (spec) {
      const questionId = await insertQuestion(ctx.supabase, {
        courseId: ctx.courseId,
        campaignId: ctx.campaignId,
        conversationId: ctx.conversationId ?? null,
        source: "gate",
        toolName: tool.name,
        toolCallId: ctx.toolCallId ?? null,
        toolParams: { args: a, paramKey: spec.paramKey ?? null },
        spec,
        requestedBy: ctx.requestedBy,
      });
      return {
        status: "needs_clarification",
        actionId: null,
        reversibility: "irreversible",
        summary: spec.question,
        questionId,
        question: spec,
      };
    }
  }

  // Side-effect-free preview — exactly as before; the preview also feeds the
  // autonomy facts (audience size etc.).
  const preview: MarketingToolResult = await tool.execute(a, { ...ctx, approved: false });

  const segmentKey = tool.segmentKey ? tool.segmentKey(a) : null;
  let recipientIsOwner = false;
  if (tool.name === "send_test_email" && typeof (a as { to?: unknown }).to === "string") {
    const ownerEmail = await resolveOwnerEmail(ctx);
    recipientIsOwner =
      Boolean(ownerEmail) &&
      (a as { to: string }).to.trim().toLowerCase() === ownerEmail!.trim().toLowerCase();
  }
  const facts: AutonomyFacts = {
    toolName: tool.name,
    audienceCount: extractAudienceCount(tool, preview),
    budgetCents:
      typeof preview.approvalPreview?.budgetCents === "number"
        ? preview.approvalPreview.budgetCents
        : null,
    segmentKey,
    segmentSeenBefore: segmentKey
      ? await hasSegmentBeenSent(ctx.supabase, ctx.courseId, segmentKey)
      : null,
    nowMs: ctx.services.clock.epochMs(),
    recipientIsOwner,
  };
  const decision = evaluateAutonomy(settings.mode, settings.policy, facts);

  if (decision.route === "pending_approval") {
    const actionId = await insertAction(ctx, tool, {
      status: "pending",
      params: a,
      summary: preview.summary,
      target: preview.target ?? null,
      beforeSnapshot: null,
      autonomyDecision: decision,
    });
    return {
      status: "pending_approval",
      actionId,
      reversibility: "irreversible",
      summary: preview.summary,
      data: preview.data,
      target: preview.target ?? null,
      approvalPreview: preview.approvalPreview,
      autonomy: decision,
    };
  }

  // auto_log / auto_execute — the policy (or the owner-test-email rule)
  // granted this in advance: perform the real effect and record it EXECUTED
  // with the full audit. This is the only path where the gate itself runs an
  // irreversible effect, and it exists ONLY under a creator-authored grant.
  const outcome = await tool.execute(a, { ...ctx, approved: true });
  const nowIso = ctx.services.clock.now();
  const actionId = await insertAction(ctx, tool, {
    status: "executed",
    params: a,
    summary: outcome.summary,
    target: outcome.target ?? null,
    beforeSnapshot: null,
    autonomyDecision: decision,
    resolvedAt: nowIso,
  });
  if (segmentKey) {
    await recordSegmentSend(ctx.supabase, {
      courseId: ctx.courseId,
      campaignId: ctx.campaignId,
      segmentKey,
      nowIso,
    });
  }
  return {
    status: "executed",
    actionId,
    reversibility: "irreversible",
    summary: outcome.summary,
    data: outcome.data,
    target: outcome.target ?? null,
    autonomy: decision,
  };
}

/* ───────────────────────────── ledger ops ────────────────────────────── */

export async function loadAction(supabase: DB, actionId: string): Promise<MarketingActionRow | null> {
  const { data } = await supabase.from("marketing_action").select("*").eq("id", actionId).maybeSingle();
  return data ? actionRowToDomain(data) : null;
}

/** Dismiss a logged reversible change: keep it; resolve the log entry. */
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
 *                                            REFUSED once the revert window
 *                                            has closed (fail-closed).
 * Idempotent: a resolved action is a no-op.
 */
export async function rejectAction(
  supabase: DB,
  actionId: string,
  opts: { nowIso?: string } = {}
): Promise<void> {
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
    // Window comparisons honor an injected now (tests run on a fixed clock);
    // production callers omit it and get wall-clock.
    const nowIso = opts.nowIso ?? new Date().toISOString();
    // No window (legacy row) or a closed window both refuse — fail closed.
    if (!action.revertExpiresAt || action.revertExpiresAt <= nowIso) {
      throw new Error("Revert window expired — this change can no longer be rolled back.");
    }
    if (action.targetRef) {
      await restoreEntity(
        supabase,
        action.targetRef as EntityRef,
        (action.beforeSnapshot as Json | null) ?? null
      );
    }
    const { error } = await supabase
      .from("marketing_action")
      .update({ status: "reverted", resolved_at: nowIso })
      .eq("id", actionId)
      .eq("status", "auto_approved")
      .gt("revert_expires_at", nowIso);
    if (error) throw new Error(`gate.reject(revert): ${error.message}`);
    return;
  }

  // already resolved (executed/approved/rejected/reverted) — nothing to do.
}

/** Mark a pending/claimed irreversible action as executed (called after
 *  approve runs the real effect). */
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
    .in("status", ["pending", "approved"]);
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

/** Reversible actions still in their revert window (quiet log w/ Revert). */
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

/**
 * The activity log: recent reversible changes (revertable while their window
 * is open, dismissible always) + irreversible actions the autonomy engine
 * executed under a policy grant (audited, never revertable). Quiet entries —
 * the pending-approval inbox is the separate, loud surface.
 */
export async function listRecentActivity(
  supabase: DB,
  courseId: string,
  opts: { limit?: number } = {}
): Promise<MarketingActionRow[]> {
  const { data } = await supabase
    .from("marketing_action")
    .select("*")
    .eq("course_id", courseId)
    .or("status.eq.auto_approved,and(status.eq.executed,autonomy_decision.not.is.null)")
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 20);
  return (data ?? []).map(actionRowToDomain);
}
