"use server";

/**
 * Server actions for the Marketing hub. Every mutation goes through the SAME
 * shared tool layer + gate the agent uses (executeMarketingTool / approve /
 * reject) — the hub is just one of the three surfaces. Author-scoped: the server
 * client carries the signed-in user's session, so RLS authorizes the writes.
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { followUpFromEvents, type AgentFollowUp, type MarketingAgentEvent } from "@/lib/marketing/agent/events";
import { resumeAgentAfterAnswer, resumeAgentAfterResolution } from "@/lib/marketing/agent/resume";
import {
  AUTO_APPROVABLE_TOOLS,
  HARD_DENY_TOOLS,
  parseMode,
  parsePolicy,
  type AutonomyPolicy,
} from "@/lib/marketing/autonomy";
import { loadAutonomySettings, upsertAutonomySettings } from "@/lib/marketing/autonomyStore";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { loadCampaignForCourse, loadLandingPage } from "@/lib/marketing/persistence";
import { answerQuestion, dismissQuestion, loadQuestion, type QuestionAnswer } from "@/lib/marketing/questions";
import { runSchedulerTick } from "@/lib/marketing/scheduler";
import { loadAction, type GateOutcome } from "@/lib/marketing/gate";
import {
  acceptMarketingAction,
  approveMarketingAction,
  executeMarketingTool,
  getMarketingTool,
  rejectMarketingAction,
} from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";

/** A pending irreversible action, shaped for in-place ApprovalCard rendering —
 *  request actions return it so the card appears WHERE the creator clicked
 *  instead of a "go approve it elsewhere" toast. */
export interface PendingActionPayload {
  actionId: string;
  toolName: string;
  summary: string;
  preview: Record<string, unknown> | null;
  editableParams: string[] | null;
  requestedBy: "user" | "agent";
}

/** What every mutating action returns so the hub can show a clear confirmation
 *  + a link to the resulting artifact. */
export interface ActionResult {
  message: string;
  href?: string;
  hrefLabel?: string;
  /** True when the action failed — the UI shows the message as an error
   *  instead of crashing to the framework error boundary. */
  error?: boolean;
  /** With `error`: the failure was "someone already resolved this elsewhere"
   *  — the card should collapse (via the sync store), not stay clickable. */
  alreadyResolved?: boolean;
  /** Set when the action recorded a pending approval — render the card here. */
  pending?: PendingActionPayload;
  /** Agent-requested resolutions: the resumed run's transcript, so the chat
   *  panel can SHOW the agent's wrap-up instead of resuming headlessly. */
  agentFollowUp?: AgentFollowUp;
}

const services = () => createMarketingServices();

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  return { supabase, ownerId: user.id, ownerEmail: user.email ?? null };
}

function ctxFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ownerId: string,
  courseId: string,
  campaignId: string | null,
  ownerEmail?: string | null
): MarketingToolContext {
  return {
    supabase,
    courseId,
    campaignId,
    ownerId,
    ownerEmail: ownerEmail ?? null,
    services: services(),
    // LLM-grounded generation when a key is configured; the generation tools
    // fall back to their deterministic templates when absent (mock-first).
    model: isOpenAIConfigured() ? createOpenAIModelClient() : undefined,
    requestedBy: "user",
  };
}

function pendingPayload(toolName: string, out: GateOutcome): PendingActionPayload | undefined {
  if (out.status !== "pending_approval" || !out.actionId) return undefined;
  return {
    actionId: out.actionId,
    toolName,
    summary: out.summary,
    preview: out.approvalPreview ?? null,
    editableParams: getMarketingTool(toolName)?.editableParams ?? null,
    requestedBy: "user",
  };
}

/** Create the campaign container (auto-accepted — it's setup, not a reviewable
 *  asset). Returns the new campaign id. */
export async function createCampaignAction(courseId: string, name: string): Promise<string> {
  const { supabase, ownerId } = await authed();
  const out = await executeMarketingTool(
    "create_campaign",
    { name, goal: null },
    ctxFor(supabase, ownerId, courseId, null)
  );
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidatePath("/marketing");
  return (out.data as { campaignId: string }).campaignId;
}

/** Generate a landing page (creating the campaign first if needed). Leaves the
 *  page STAGED for review. */
export async function generateLandingPageAction(courseId: string): Promise<ActionResult> {
  const { supabase, ownerId } = await authed();
  let campaign = await loadCampaignForCourse(supabase, courseId);
  if (!campaign) {
    const created = await executeMarketingTool(
      "create_campaign",
      { name: "Launch campaign", goal: null },
      ctxFor(supabase, ownerId, courseId, null)
    );
    if (created.actionId) await acceptMarketingAction(supabase, created.actionId);
    campaign = await loadCampaignForCourse(supabase, courseId);
  }
  const out = await executeMarketingTool(
    "generate_landing_page",
    { title: null, ctaLabel: null },
    ctxFor(supabase, ownerId, courseId, campaign?.id ?? null)
  );
  revalidatePath("/marketing");
  const pageId = (out.data as { pageId?: string } | undefined)?.pageId;
  return {
    message: "Generated a landing page — staged for review.",
    href: pageId ? `/marketing/preview/${pageId}` : undefined,
    hrefLabel: pageId ? "Preview" : undefined,
  };
}

/**
 * "Generate Kit" — run the reversible generators back-to-back through the SAME
 * gate (landing page + launch sequence + behavioral followup). Everything lands
 * staged for review; nothing is published or sent.
 */
export async function generateKitAction(courseId: string): Promise<ActionResult> {
  const { supabase, ownerId } = await authed();
  let campaign = await loadCampaignForCourse(supabase, courseId);
  if (!campaign) {
    const c = await executeMarketingTool(
      "create_campaign",
      { name: "Launch campaign", goal: null },
      ctxFor(supabase, ownerId, courseId, null)
    );
    if (c.actionId) await acceptMarketingAction(supabase, c.actionId);
    campaign = await loadCampaignForCourse(supabase, courseId);
  }
  const ctx = ctxFor(supabase, ownerId, courseId, campaign?.id ?? null);
  await executeMarketingTool("generate_landing_page", { title: null, ctaLabel: null }, ctx);
  await executeMarketingTool("generate_email_sequence", { goal: null, length: null }, ctx);
  await executeMarketingTool("generate_followup", { triggerEvent: "page_view" }, ctx);
  revalidatePath("/marketing");
  return { message: "Generated a landing page, launch sequence, and followup — review them below." };
}

/** Keep a staged reversible change; link to the resulting artifact. */
export async function acceptStagedAction(actionId: string): Promise<ActionResult> {
  const { supabase } = await authed();
  const action = await loadAction(supabase, actionId);
  await acceptMarketingAction(supabase, actionId);
  revalidatePath("/marketing");
  if (action?.targetRef?.entity === "landing_page") {
    return { message: "Accepted — kept the change.", href: `/marketing/preview/${action.targetRef.id}`, hrefLabel: "Preview" };
  }
  return { message: "Accepted — kept the change." };
}

/** Reject a staged reversible change (atomic revert, refused once the revert
 *  window closes) or deny a pending one. */
export async function rejectStagedAction(actionId: string): Promise<ActionResult> {
  const { supabase } = await authed();
  try {
    await rejectMarketingAction(supabase, actionId);
  } catch (e) {
    revalidatePath("/marketing");
    return { message: e instanceof Error ? e.message : String(e), error: true };
  }
  revalidatePath("/marketing");
  return { message: "Reverted — the change was rolled back." };
}

/** Request publish. Under manual/assisted this records a pending approval and
 *  returns the card payload (rendered in place); under an auto policy that
 *  covers it, it executes immediately. */
export async function publishPageAction(courseId: string, pageId: string): Promise<ActionResult> {
  const { supabase, ownerId, ownerEmail } = await authed();
  const campaign = await loadCampaignForCourse(supabase, courseId);
  const out = await executeMarketingTool(
    "publish_landing_page",
    { pageId },
    ctxFor(supabase, ownerId, courseId, campaign?.id ?? null, ownerEmail)
  );
  revalidatePath("/marketing");
  if (out.status === "executed") {
    const page = await loadLandingPage(supabase, pageId);
    return {
      message: "Published — auto-approved by your policy.",
      href: page ? `/p/${page.slug}` : undefined,
      hrefLabel: page ? "View live" : undefined,
    };
  }
  return {
    message: "Publish is ready for your approval.",
    pending: pendingPayload("publish_landing_page", out),
  };
}

/** Request unpublish — same in-place approval card contract as publish. */
export async function unpublishPageAction(courseId: string, pageId: string): Promise<ActionResult> {
  const { supabase, ownerId, ownerEmail } = await authed();
  const campaign = await loadCampaignForCourse(supabase, courseId);
  const out = await executeMarketingTool(
    "unpublish_landing_page",
    { pageId },
    ctxFor(supabase, ownerId, courseId, campaign?.id ?? null, ownerEmail)
  );
  revalidatePath("/marketing");
  if (out.status === "executed") {
    return { message: "Unpublished — auto-approved by your policy." };
  }
  return {
    message: "Unpublish is ready for your approval.",
    pending: pendingPayload("unpublish_landing_page", out),
  };
}

/** Approve a pending irreversible action (runs the real effect), then — for an
 *  agent-requested action — auto-resume the agent ONCE with the outcome as an
 *  observation (Amendment 13). The resume is best-effort: its failure never
 *  breaks the approval. */
export async function approvePendingAction(actionId: string): Promise<ActionResult> {
  const { supabase, ownerId } = await authed();
  const action = await loadAction(supabase, actionId);
  if (action && action.status !== "pending") {
    // Resolved on another surface (or another tab won the click race) — tell
    // the stale card to collapse instead of leaving it clickable.
    revalidatePath("/marketing");
    return { message: "Already handled — this request was resolved elsewhere.", error: true, alreadyResolved: true };
  }
  try {
    await approveMarketingAction(actionId, { supabase, ownerId, services: services() });
  } catch (e) {
    revalidatePath("/marketing");
    // Distinguish "someone else resolved it between our check and the atomic
    // claim" (collapse the card) from a genuinely failed execute (the action
    // stays PENDING and retryable after the cause is fixed).
    const now = await loadAction(supabase, actionId);
    const alreadyResolved = !!now && now.status !== "pending";
    return { message: e instanceof Error ? e.message : String(e), error: true, alreadyResolved };
  }

  // A just-approved launch starts sending on the next scheduler heartbeat —
  // kick one course-scoped tick immediately so the first due sends go out now
  // (respecting send windows/ramps) instead of waiting for cron. Best-effort.
  if (action?.toolName === "launch_campaign" && action.courseId) {
    try {
      await runSchedulerTick(supabase, services(), { courseId: action.courseId });
    } catch {
      // the cron tick will pick it up
    }
  }

  // Capture the resumed run's events so the surface that approved can REPLAY
  // the agent's wrap-up (previously the resume was headless — persisted, never
  // shown). Still best-effort: a resume failure never breaks the approval.
  let agentFollowUp: AgentFollowUp | undefined;
  if (action?.requestedBy === "agent" && isOpenAIConfigured()) {
    try {
      const resolved = await loadAction(supabase, actionId);
      if (resolved) {
        const events: MarketingAgentEvent[] = [];
        await resumeAgentAfterResolution({
          supabase,
          model: createOpenAIModelClient(),
          services: services(),
          ownerId,
          action: resolved,
          decision: "approved",
          emit: (e) => events.push(e),
        });
        if (events.length) agentFollowUp = followUpFromEvents(events);
      }
    } catch {
      // best-effort by contract — the approval itself already succeeded
    }
  }
  revalidatePath("/marketing");
  // For a publish, link straight to the now-live page.
  if (action?.toolName === "publish_landing_page" && action.targetRef?.id) {
    const page = await loadLandingPage(supabase, action.targetRef.id);
    if (page?.status === "published") {
      return { message: "Approved — the page is live.", href: `/p/${page.slug}`, hrefLabel: "View live", agentFollowUp };
    }
  }
  return { message: "Approved.", agentFollowUp };
}

/** Deny a pending irreversible action (optional free-text reason flows into
 *  the agent's resumed observation — Amendment 13). */
export async function denyPendingAction(actionId: string, reason?: string): Promise<ActionResult> {
  const { supabase, ownerId } = await authed();
  const action = await loadAction(supabase, actionId);
  if (action && action.status !== "pending") {
    // The gate's reject is a silent no-op on resolved rows — surface the truth
    // instead (the effect may already have run via an approval elsewhere).
    revalidatePath("/marketing");
    return { message: "Already handled — this request was resolved elsewhere.", error: true, alreadyResolved: true };
  }
  try {
    await rejectMarketingAction(supabase, actionId);
  } catch (e) {
    revalidatePath("/marketing");
    return { message: e instanceof Error ? e.message : String(e), error: true };
  }

  let agentFollowUp: AgentFollowUp | undefined;
  if (action?.requestedBy === "agent" && isOpenAIConfigured()) {
    try {
      const events: MarketingAgentEvent[] = [];
      await resumeAgentAfterResolution({
        supabase,
        model: createOpenAIModelClient(),
        services: services(),
        ownerId,
        action,
        decision: "denied",
        denialReason: reason ?? null,
        emit: (e) => events.push(e),
      });
      if (events.length) agentFollowUp = followUpFromEvents(events);
    } catch {
      // best-effort by contract — the denial itself already succeeded
    }
  }
  revalidatePath("/marketing");
  return { message: "Denied — nothing was sent or published.", agentFollowUp };
}

/* ───────────────────── clarifying questions (Q&A inbox) ───────────────────── */

/**
 * Answer a clarifying question. The answer is ALWAYS recorded (even with no
 * OpenAI key — the agent just won't auto-resume). Three follow-ups by source:
 *   agent-raised (model or gate) → resume the conversation once, best-effort;
 *   gate-raised for a USER call  → re-run the tool with the ambiguous param
 *                                  resolved, returning the fresh outcome
 *                                  (usually the in-place approval card).
 */
export async function answerQuestionAction(
  questionId: string,
  value: string,
  freeText?: string
): Promise<ActionResult> {
  const { supabase, ownerId, ownerEmail } = await authed();
  const q = await loadQuestion(supabase, questionId);
  if (!q) return { message: "Question not found.", error: true };

  // "__other__" = the creator typed their own answer (or redirected the agent)
  // instead of picking an option — the text IS the answer.
  const isFreeform = value === "__other__";
  const option = q.options.find((o) => o.value === value);
  const answer: QuestionAnswer = {
    value,
    label: isFreeform ? (freeText?.trim().slice(0, 80) ?? "Custom answer") : (option?.label ?? value),
    freeText: freeText?.trim() ? freeText.trim() : null,
  };
  const resolvedNow = await answerQuestion(supabase, questionId, answer);
  if (!resolvedNow) {
    revalidatePath("/marketing");
    return { message: "Already answered elsewhere.", error: true, alreadyResolved: true };
  }

  // Gate-raised question for a USER-initiated call: retry the tool with the
  // ambiguous param resolved — the user's original intent completes here.
  // (A freeform answer can't be mapped onto the param — it just gets recorded;
  // for agent-raised questions the agent acts on the text instead.)
  if (!isFreeform && q.source === "gate" && q.requestedBy === "user" && q.toolName && q.toolParams) {
    const paramKey = typeof q.toolParams.paramKey === "string" ? q.toolParams.paramKey : null;
    const args = (q.toolParams.args as Record<string, unknown> | undefined) ?? null;
    if (paramKey && args) {
      try {
        const out = await executeMarketingTool(
          q.toolName,
          { ...args, [paramKey]: value },
          ctxFor(supabase, ownerId, q.courseId, q.campaignId, ownerEmail)
        );
        revalidatePath("/marketing");
        if (out.status === "executed") {
          return { message: `Done — ${out.summary}` };
        }
        return {
          message: "Thanks — the action is ready for your approval.",
          pending: pendingPayload(q.toolName, out),
        };
      } catch (e) {
        revalidatePath("/marketing");
        return { message: e instanceof Error ? e.message : String(e), error: true };
      }
    }
  }

  let agentFollowUp: AgentFollowUp | undefined;
  if (q.requestedBy === "agent" && isOpenAIConfigured()) {
    try {
      const events: MarketingAgentEvent[] = [];
      await resumeAgentAfterAnswer({
        supabase,
        model: createOpenAIModelClient(),
        services: services(),
        ownerId,
        question: q,
        answer,
        emit: (e) => events.push(e),
      });
      if (events.length) agentFollowUp = followUpFromEvents(events);
    } catch {
      // best-effort by contract — the answer itself is already recorded
    }
  }
  revalidatePath("/marketing");
  return { message: "Answered — the agent picked it up from here.", agentFollowUp };
}

/** Dismiss a pending question without answering (the agent stays paused until
 *  the creator sends it a new message). */
export async function dismissQuestionAction(questionId: string): Promise<ActionResult> {
  const { supabase } = await authed();
  await dismissQuestion(supabase, questionId);
  revalidatePath("/marketing");
  return { message: "Dismissed." };
}

/* ─────────────────── edit-in-place on the approval card ──────────────────── */

/**
 * Patch a PENDING action's editable params before approving. Only params the
 * tool declared `editableParams` are accepted; the merged args are re-validated
 * against the tool's Zod schema and the side-effect-free preview re-runs so the
 * card re-renders truthfully. The action stays pending.
 */
export async function editPendingAction(
  actionId: string,
  patch: Record<string, unknown>
): Promise<ActionResult & { pending?: PendingActionPayload }> {
  const { supabase, ownerId, ownerEmail } = await authed();
  const action = await loadAction(supabase, actionId);
  if (!action) return { message: "Action not found.", error: true };
  if (action.status !== "pending") {
    return { message: "Already handled — this request was resolved elsewhere.", error: true, alreadyResolved: true };
  }

  const tool = getMarketingTool(action.toolName);
  if (!tool) return { message: `Unknown tool on action: ${action.toolName}`, error: true };
  const editable = new Set(tool.editableParams ?? []);
  const illegal = Object.keys(patch).filter((k) => !editable.has(k));
  if (illegal.length > 0) {
    return { message: `Not editable on this action: ${illegal.join(", ")}.`, error: true };
  }

  const merged = { ...action.params, ...patch };
  const parsed = tool.params.safeParse(merged);
  if (!parsed.success) {
    return { message: `Invalid edit: ${parsed.error.issues[0]?.message ?? "validation failed"}`, error: true };
  }

  // Re-run the side-effect-free preview so summary + preview stay truthful.
  const preview = await tool.execute(parsed.data, {
    ...ctxFor(supabase, ownerId, action.courseId, action.campaignId, ownerEmail),
    approved: false,
  });
  const { error } = await supabase
    .from("marketing_action")
    .update({ params: parsed.data as import("@/lib/database.types").Json, summary: preview.summary })
    .eq("id", actionId)
    .eq("status", "pending");
  if (error) return { message: `Edit failed: ${error.message}`, error: true };

  revalidatePath("/marketing");
  return {
    message: "Updated — review and approve.",
    pending: {
      actionId,
      toolName: action.toolName,
      summary: preview.summary,
      preview: preview.approvalPreview ?? null,
      editableParams: tool.editableParams ?? null,
      requestedBy: action.requestedBy,
    },
  };
}

/* ───────────────────────── autonomy settings ─────────────────────────────── */

export interface AutonomySettingsForm {
  mode: string;
  revertWindowHours: number;
  autoApproveTools: string[];
  maxRecipients: number | null;
  allowedHours: { startHour: number; endHour: number; timezone: string | null } | null;
  firstSendToNewSegmentManual: boolean;
}

export async function loadAutonomySettingsAction(courseId: string) {
  const { supabase } = await authed();
  return loadAutonomySettings(supabase, courseId);
}

/** Save the course's autonomy mode + auto policy. Hard-denied tools are
 *  stripped server-side no matter what the client sent; the whole policy is
 *  re-parsed through the same tolerant schema the gate uses. */
export async function updateAutonomySettingsAction(
  courseId: string,
  form: AutonomySettingsForm
): Promise<ActionResult> {
  const { supabase } = await authed();
  const policy: AutonomyPolicy = parsePolicy({
    autoApproveTools: (form.autoApproveTools ?? []).filter(
      (t) => AUTO_APPROVABLE_TOOLS.has(t) && !HARD_DENY_TOOLS.has(t)
    ),
    maxRecipients: form.maxRecipients,
    maxBudgetCents: null,
    allowedHours: form.allowedHours,
    firstSendToNewSegmentManual: form.firstSendToNewSegmentManual,
  });
  const revertWindowHours = Math.min(720, Math.max(1, Math.round(form.revertWindowHours || 24)));
  try {
    await upsertAutonomySettings(supabase, courseId, {
      mode: parseMode(form.mode),
      policy,
      revertWindowHours,
    });
  } catch (e) {
    return { message: e instanceof Error ? e.message : String(e), error: true };
  }
  revalidatePath("/marketing");
  return { message: "Autonomy settings saved." };
}
