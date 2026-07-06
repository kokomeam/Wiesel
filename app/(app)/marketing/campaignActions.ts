"use server";

/**
 * Server actions for the Email Campaigns surface (wizard, builder, leads).
 * Every mutation routes the SAME shared tool layer + gate the agent uses —
 * these are just the button-shaped entrances to it. Author-scoped via the
 * session-carrying server client (RLS authorizes every write).
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createOpenAIModelClient, isOpenAIConfigured } from "@/lib/ai/providers/openai";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { loadCampaign, loadEmailSequence } from "@/lib/marketing/persistence";
import { runSchedulerTick } from "@/lib/marketing/scheduler";
import { acceptMarketingAction, executeMarketingTool, getMarketingTool } from "@/lib/marketing/tools";
import type { GateOutcome } from "@/lib/marketing/gate";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import type { EmailBody } from "@/lib/marketing/types";
import type { PendingActionPayload } from "./actions";

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
    services: createMarketingServices(),
    model: isOpenAIConfigured() ? createOpenAIModelClient() : undefined,
    requestedBy: "user",
  };
}

/** What a request-an-irreversible-action button gets back: either the pending
 *  card payload (rendered IN PLACE — no scroll-to-inbox round trip) or the
 *  executed outcome when the creator's autonomy policy covered it. */
export interface RequestOutcome {
  status: "pending" | "executed";
  message: string;
  pending?: PendingActionPayload;
}

function requestOutcome(toolName: string, out: GateOutcome, executedMessage: string): RequestOutcome {
  if (out.status === "executed") {
    return { status: "executed", message: executedMessage };
  }
  return {
    status: "pending",
    message: "Ready for your approval.",
    pending:
      out.status === "pending_approval" && out.actionId
        ? {
            actionId: out.actionId,
            toolName,
            summary: out.summary,
            preview: out.approvalPreview ?? null,
            editableParams: getMarketingTool(toolName)?.editableParams ?? null,
            requestedBy: "user",
          }
        : undefined,
  };
}

function revalidate(campaignId?: string) {
  revalidatePath("/marketing");
  revalidatePath("/marketing/email");
  revalidatePath("/marketing/leads");
  if (campaignId) revalidatePath(`/marketing/email/${campaignId}`);
}

export interface WizardInput {
  name: string;
  goal: string;
  leadListId: string | null;
  newListName: string | null;
  sender: { fromName: string; fromEmail: string; replyTo: string | null; mailingAddress: string; businessName: string | null } | null;
  existingSenderId: string | null;
  brief: {
    audienceNotes: string | null;
    proofPoints: string | null;
    offerDetails: string | null;
    thingsToAvoid: string | null;
    freeform: string | null;
    language: string | null;
    offerDeadlineIso: string | null;
  };
  schedule: { startHour: number; endHour: number; timezone: string; skipWeekends: boolean };
  sequenceLength: number | null;
}

/** The whole wizard in one transaction-shaped action: campaign → list → sender
 *  → brief → schedule → the blueprint-driven sequence draft. Setup steps are
 *  auto-accepted (they're scaffolding, not reviewable copy); the SEQUENCE
 *  lands staged for review like any other generation. */
export async function createCampaignWizardAction(courseId: string, input: WizardInput): Promise<{ campaignId: string }> {
  const { supabase, ownerId } = await authed();

  const created = await executeMarketingTool(
    "create_campaign",
    { name: input.name, goal: input.goal },
    ctxFor(supabase, ownerId, courseId, null)
  );
  if (created.actionId) await acceptMarketingAction(supabase, created.actionId);
  const campaignId = (created.data as { campaignId: string }).campaignId;
  const ctx = ctxFor(supabase, ownerId, courseId, campaignId);

  // Attach or create the lead list.
  let listId = input.leadListId;
  if (!listId && input.newListName) {
    const list = await executeMarketingTool(
      "create_lead_list",
      { name: input.newListName, sourceType: "manual_import" },
      ctx
    );
    if (list.actionId) await acceptMarketingAction(supabase, list.actionId);
    listId = (list.data as { listId: string }).listId;
  }
  if (listId) {
    const attach = await executeMarketingTool("attach_lead_list_to_campaign", { campaignId, listId }, ctx);
    if (attach.actionId) await acceptMarketingAction(supabase, attach.actionId);
  }

  // Sender identity (existing or new — mailing address required by schema).
  let senderId = input.existingSenderId;
  if (!senderId && input.sender) {
    const sender = await executeMarketingTool("create_sender_identity", input.sender, ctx);
    if (sender.actionId) await acceptMarketingAction(supabase, sender.actionId);
    senderId = (sender.data as { senderIdentityId: string }).senderIdentityId;
  }
  if (senderId) {
    const attach = await executeMarketingTool(
      "attach_sender_identity_to_campaign",
      { campaignId, senderIdentityId: senderId },
      ctx
    );
    if (attach.actionId) await acceptMarketingAction(supabase, attach.actionId);
  }

  // Brief + schedule.
  const brief = await executeMarketingTool("update_campaign_brief", { campaignId, ...input.brief }, ctx);
  if (brief.actionId) await acceptMarketingAction(supabase, brief.actionId);
  const sched = await executeMarketingTool(
    "create_sending_schedule",
    { campaignId, ...input.schedule },
    ctx
  );
  if (sched.actionId) await acceptMarketingAction(supabase, sched.actionId);

  // The sequence draft — STAGED for review (the reviewable asset).
  await executeMarketingTool("generate_email_sequence", { goal: input.goal, length: input.sequenceLength }, ctx);

  revalidate(campaignId);
  return { campaignId };
}

/* ─────────────────────────── builder actions ─────────────────────────── */

async function campaignCtx(campaignId: string) {
  const { supabase, ownerId, ownerEmail } = await authed();
  const campaign = await loadCampaign(supabase, campaignId);
  if (!campaign) throw new Error("Campaign not found");
  return { supabase, ownerId, campaign, ctx: ctxFor(supabase, ownerId, campaign.courseId, campaign.id, ownerEmail) };
}

export async function approveStepAction(campaignId: string, sequenceId: string, touchId: string, approved: boolean): Promise<void> {
  const { supabase, ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("approve_email_step", { sequenceId, touchId, approved }, ctx);
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate(campaignId);
}

export async function updateStepAction(
  campaignId: string,
  input: { sequenceId: string; touchId: string; subject: string; previewText: string | null; body: EmailBody; delaySeconds: number | null }
): Promise<void> {
  const { ctx } = await campaignCtx(campaignId);
  await executeMarketingTool(
    "write_email_touch",
    { sequenceId: input.sequenceId, touchId: input.touchId, position: null, delaySeconds: input.delaySeconds, triggerEvent: null, subject: input.subject, previewText: input.previewText, body: input.body },
    ctx
  );
  revalidate(campaignId);
}

export async function regenerateStepAction(campaignId: string, sequenceId: string, touchId: string): Promise<void> {
  const { ctx } = await campaignCtx(campaignId);
  await executeMarketingTool("regenerate_email_step", { sequenceId, touchId }, ctx);
  revalidate(campaignId);
}

export async function generateVariantsAction(
  campaignId: string,
  sequenceId: string,
  touchId: string,
  axis: "subject" | "cta" | "hook" | "tone"
): Promise<string[]> {
  const { supabase, ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("generate_email_variants", { sequenceId, touchId, axis }, ctx);
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate(campaignId);
  return ((out.data as { variants?: string[] } | undefined)?.variants ?? []);
}

export async function deleteStepAction(campaignId: string, sequenceId: string, touchId: string): Promise<void> {
  const { ctx } = await campaignCtx(campaignId);
  await executeMarketingTool("delete_email_step", { sequenceId, touchId }, ctx);
  revalidate(campaignId);
}

/** Send a test of one step, rendered through the exact same pipeline a real
 *  subscriber send uses (merge vars, click-tracked links, compliant footer).
 *  Addressed to the CREATOR'S OWN email under assisted/auto mode it executes
 *  immediately and logs (it reaches nobody else); any other address — or
 *  manual mode — records a pending approval resolved right on this page. */
export async function sendTestEmailAction(
  campaignId: string,
  to: string,
  subject: string,
  body: EmailBody
): Promise<RequestOutcome> {
  const { ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("send_test_email", { to, subject, body }, ctx);
  revalidate(campaignId);
  return requestOutcome("send_test_email", out, `Test sent to ${to}.`);
}

/** Attach an existing lead list as the campaign's audience. */
export async function attachLeadListAction(campaignId: string, listId: string): Promise<void> {
  const { supabase, ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("attach_lead_list_to_campaign", { campaignId, listId }, ctx);
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate(campaignId);
}

/** Attach an existing sender identity to the campaign. */
export async function attachSenderAction(campaignId: string, senderIdentityId: string): Promise<void> {
  const { supabase, ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("attach_sender_identity_to_campaign", { campaignId, senderIdentityId }, ctx);
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate(campaignId);
}

/** Create a sender identity (name/email/mailing address) and attach it. */
export async function createSenderAction(
  campaignId: string,
  sender: { fromName: string; fromEmail: string; replyTo: string | null; mailingAddress: string; businessName: string | null }
): Promise<void> {
  const { supabase, ctx } = await campaignCtx(campaignId);
  const created = await executeMarketingTool("create_sender_identity", sender, ctx);
  if (created.actionId) await acceptMarketingAction(supabase, created.actionId);
  const senderIdentityId = (created.data as { senderIdentityId: string }).senderIdentityId;
  const attach = await executeMarketingTool("attach_sender_identity_to_campaign", { campaignId, senderIdentityId }, ctx);
  if (attach.actionId) await acceptMarketingAction(supabase, attach.actionId);
  revalidate(campaignId);
}

/** Process this campaign's due sends right now (the same idempotent tick cron
 *  runs — send windows, ramps, and guardrails all still apply). Lets the
 *  creator see delivery move without waiting for the cron heartbeat. */
export async function processDueSendsAction(
  campaignId: string
): Promise<{ sent: number; heldByWindow: number; heldByRamp: number; processed: number }> {
  const { supabase, campaign } = await campaignCtx(campaignId);
  const result = await runSchedulerTick(supabase, createMarketingServices(), { courseId: campaign.courseId });
  revalidate(campaignId);
  return { sent: result.sent, heldByWindow: result.heldByWindow, heldByRamp: result.heldByRamp, processed: result.processed };
}

export async function runComplianceAction(campaignId: string): Promise<void> {
  const { supabase, ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("review_campaign_compliance", { campaignId }, ctx);
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate(campaignId);
}

export async function approveCampaignAction(campaignId: string): Promise<void> {
  const { supabase, ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("approve_campaign", { campaignId }, ctx);
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate(campaignId);
}

/** Request launch — records the PENDING irreversible action (launch is
 *  hard-denied from auto-approval in every mode) and returns the card payload
 *  so the approval renders in place on the launch step. */
export async function requestLaunchAction(campaignId: string): Promise<RequestOutcome> {
  const { ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("launch_campaign", { campaignId }, ctx);
  revalidate(campaignId);
  return requestOutcome("launch_campaign", out, "Launched.");
}

export async function pauseCampaignAction(campaignId: string): Promise<void> {
  const { supabase, ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("pause_campaign", { campaignId }, ctx);
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate(campaignId);
}

export async function resumeCampaignAction(campaignId: string): Promise<void> {
  const { supabase, ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("resume_campaign", { campaignId }, ctx);
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate(campaignId);
}

export async function cancelCampaignRequestAction(campaignId: string): Promise<RequestOutcome> {
  const { ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("cancel_campaign", { campaignId }, ctx);
  revalidate(campaignId);
  return requestOutcome("cancel_campaign", out, "Cancelled.");
}

/* ────────────────── sequence-level pause / resume ────────────────── */

async function sequenceCtx(sequenceId: string) {
  const { supabase, ownerId, ownerEmail } = await authed();
  const seq = await loadEmailSequence(supabase, sequenceId);
  if (!seq) throw new Error("Sequence not found");
  return { supabase, seq, ctx: ctxFor(supabase, ownerId, seq.courseId, seq.campaignId, ownerEmail) };
}

/** Pause ONE sequence (reversible; queued sends are held, not deleted).
 *  Returns the tool's summary so the UI can state exactly what was held. */
export async function pauseSequenceAction(sequenceId: string): Promise<{ message: string; error?: boolean }> {
  try {
    const { supabase, seq, ctx } = await sequenceCtx(sequenceId);
    const out = await executeMarketingTool("pause_sequence", { sequenceId }, ctx);
    if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
    revalidate(seq.campaignId);
    revalidatePath("/marketing/sequences");
    revalidatePath(`/marketing/sequences/${sequenceId}`);
    return { message: out.summary };
  } catch (e) {
    return { message: e instanceof Error ? e.message : String(e), error: true };
  }
}

/** Resume ONE paused sequence — held sends continue on their schedule. */
export async function resumeSequenceAction(sequenceId: string): Promise<{ message: string; error?: boolean }> {
  try {
    const { supabase, seq, ctx } = await sequenceCtx(sequenceId);
    const out = await executeMarketingTool("resume_sequence", { sequenceId }, ctx);
    if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
    revalidate(seq.campaignId);
    revalidatePath("/marketing/sequences");
    revalidatePath(`/marketing/sequences/${sequenceId}`);
    return { message: out.summary };
  } catch (e) {
    return { message: e instanceof Error ? e.message : String(e), error: true };
  }
}

export async function updateBriefAction(
  campaignId: string,
  brief: { audienceNotes: string | null; proofPoints: string | null; offerDetails: string | null; thingsToAvoid: string | null; freeform: string | null; language: string | null; offerDeadlineIso: string | null }
): Promise<void> {
  const { supabase, ctx } = await campaignCtx(campaignId);
  const out = await executeMarketingTool("update_campaign_brief", { campaignId, ...brief }, ctx);
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate(campaignId);
}

export async function updateVoiceProfileAction(courseId: string, rules: string[]): Promise<void> {
  const { supabase, ownerId } = await authed();
  const out = await executeMarketingTool("update_voice_profile", { rules }, ctxFor(supabase, ownerId, courseId, null));
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate();
}

/* ─────────────────────────── leads actions ─────────────────────────── */

export async function createLeadListAction(courseId: string, name: string, sourceType: "manual_import" | "previous_students" | "custom"): Promise<string> {
  const { supabase, ownerId } = await authed();
  const out = await executeMarketingTool("create_lead_list", { name, sourceType }, ctxFor(supabase, ownerId, courseId, null));
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate();
  return (out.data as { listId: string }).listId;
}

export async function importLeadsAction(
  courseId: string,
  listId: string,
  contacts: { email: string; name: string | null }[],
  consentConfirmationText: string
): Promise<{ imported: number; rejected: number }> {
  const { supabase, ownerId } = await authed();
  const out = await executeMarketingTool(
    "import_leads",
    { listId, contacts, consentConfirmationText },
    ctxFor(supabase, ownerId, courseId, null)
  );
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidate();
  return out.data as { imported: number; rejected: number };
}

/** Request the double-opt-in confirmation send (irreversible → pending
 *  approval, card rendered in place on the Leads page). */
export async function requestConsentConfirmationAction(courseId: string, subscriberId: string): Promise<RequestOutcome> {
  const { supabase, ownerId, ownerEmail } = await authed();
  const out = await executeMarketingTool(
    "send_consent_confirmation",
    { subscriberId },
    ctxFor(supabase, ownerId, courseId, null, ownerEmail)
  );
  revalidate();
  return requestOutcome("send_consent_confirmation", out, "Confirmation sent.");
}

/** Bulk double-opt-in for a whole list — one approval covers every pending,
 *  not-yet-asked contact in it. Hard-denied from auto-approval: this ALWAYS
 *  produces the card, in every mode, under every policy. */
export async function requestConsentConfirmationsAction(courseId: string, listId: string): Promise<RequestOutcome> {
  const { supabase, ownerId, ownerEmail } = await authed();
  const out = await executeMarketingTool(
    "send_consent_confirmations",
    { listId },
    ctxFor(supabase, ownerId, courseId, null, ownerEmail)
  );
  revalidate();
  return requestOutcome("send_consent_confirmations", out, "Confirmations sent.");
}

/** Membership edits go through the SAME gate as everything else (this used to
 *  be a direct delete — the one write path that bypassed the ledger). They're
 *  reversible: quiet log entry + revert window, nothing sent. */
export async function removeLeadFromListAction(courseId: string, listId: string, subscriberId: string): Promise<void> {
  const { supabase, ownerId, ownerEmail } = await authed();
  await executeMarketingTool(
    "remove_leads_from_list",
    { listId, subscriberIds: [subscriberId] },
    ctxFor(supabase, ownerId, courseId, null, ownerEmail)
  );
  revalidate();
}

export interface AudienceFilterInput {
  consent: "confirmed" | "pending" | "any";
  status: "lead" | "subscribed" | "engaged" | "enrolled" | "all";
}

export interface ListBuildResult {
  message: string;
  listId?: string;
  added?: number;
  error?: boolean;
}

/** One step: create a list AND fill it from existing contacts (the "put all my
 *  consented people on a mailing list" button). Reversible — revert removes
 *  the list. */
export async function buildAudienceListAction(
  courseId: string,
  name: string,
  filter: AudienceFilterInput
): Promise<ListBuildResult> {
  const { supabase, ownerId, ownerEmail } = await authed();
  try {
    const out = await executeMarketingTool(
      "build_audience_list",
      { name, filter },
      ctxFor(supabase, ownerId, courseId, null, ownerEmail)
    );
    revalidate();
    const data = out.data as { listId: string; added: number; eligible: number };
    return { message: out.summary, listId: data.listId, added: data.added };
  } catch (e) {
    revalidate();
    return { message: e instanceof Error ? e.message : String(e), error: true };
  }
}

/** Add existing contacts (by filter) to an existing list. Reversible — revert
 *  restores the exact prior membership. */
export async function addLeadsToListAction(
  courseId: string,
  listId: string,
  filter: AudienceFilterInput
): Promise<ListBuildResult> {
  const { supabase, ownerId, ownerEmail } = await authed();
  try {
    const out = await executeMarketingTool(
      "add_leads_to_list",
      { listId, filter, subscriberIds: null },
      ctxFor(supabase, ownerId, courseId, null, ownerEmail)
    );
    revalidate();
    return { message: out.summary, listId, added: (out.data as { added: number }).added };
  } catch (e) {
    revalidate();
    return { message: e instanceof Error ? e.message : String(e), error: true };
  }
}
