/**
 * Campaign lifecycle tools — the full state machine from Draft to
 * Completed/Cancelled (§3). `launch_campaign` is the ONE irreversible,
 * outward-facing gate: it snapshots the approved audience (Amendment 4c) and
 * begins enrollment; everything before it is reversible content work.
 *
 * Persisted transitions: draft → generated (on first sequence draft) →
 * in_review (once any step needs approval) → approved (all steps signed off,
 * `approve_campaign`) → active (`launch_campaign`, enrollment begins
 * immediately — MVP has no async gap between "scheduled" and "sending", so
 * those labels are logical, not persisted states) → paused/completed/cancelled.
 */

import { z } from "zod";
import type { Json } from "@/lib/database.types";
import { evaluateLaunchChecklist, snapshotApprovedAudience } from "../campaignLifecycle";
import { loadCampaign, loadEmailSequence, loadCourseMarketingContext } from "../persistence";
import { enrollSegment, sendTimingSentence, sendWindowState } from "../scheduler";
import { DEFAULT_SEND_WINDOW, type SendWindow } from "../types";
import { defineMarketingTool, MarketingToolError, type MarketingToolContext } from "./types";

async function primarySequenceId(ctx: MarketingToolContext, campaignId: string): Promise<string | null> {
  const { data } = await ctx.supabase
    .from("email_sequence")
    .select("id")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

/* ─────────────────────────── read: list campaigns ────────────────────────── */

const listMarketingCampaigns = defineMarketingTool({
  name: "list_marketing_campaigns",
  description: "List all campaigns for this course with their goal and lifecycle status.",
  params: z.object({}),
  reversibility: "read",
  async execute(_args, ctx) {
    const { data } = await ctx.supabase
      .from("marketing_campaign")
      .select("id,name,goal,status,compliance_status,created_at")
      .eq("course_id", ctx.courseId)
      .order("created_at", { ascending: false });
    return {
      summary: `${data?.length ?? 0} campaign(s).`,
      data: { campaigns: data ?? [] },
    };
  },
});

/* ───────────────────────── reversible: brief + steps ─────────────────────── */

const updateCampaignBrief = defineMarketingTool({
  name: "update_campaign_brief",
  description:
    "Set the Campaign Brief (audience notes, proof points, offer details, things to avoid, language override, real offer deadline). Stages as reversible.",
  params: z.object({
    campaignId: z.string().min(1),
    audienceNotes: z.string().max(2000).nullable(),
    proofPoints: z.string().max(2000).nullable(),
    offerDetails: z.string().max(2000).nullable(),
    thingsToAvoid: z.string().max(2000).nullable(),
    freeform: z.string().max(4000).nullable(),
    language: z.string().max(10).nullable(),
    offerDeadlineIso: z.string().nullable(),
  }),
  reversibility: "reversible",
  actionKind: "update_campaign_brief",
  existingTarget(args) {
    return { entity: "campaign", id: args.campaignId };
  },
  async execute(args, ctx) {
    const campaign = await loadCampaign(ctx.supabase, args.campaignId);
    if (!campaign) throw new MarketingToolError(`Campaign ${args.campaignId} not found`);
    const brief = {
      ...(campaign.config.brief ?? {}),
      ...(args.audienceNotes !== null ? { audienceNotes: args.audienceNotes } : {}),
      ...(args.proofPoints !== null ? { proofPoints: args.proofPoints } : {}),
      ...(args.offerDetails !== null ? { offerDetails: args.offerDetails } : {}),
      ...(args.thingsToAvoid !== null ? { thingsToAvoid: args.thingsToAvoid } : {}),
      ...(args.freeform !== null ? { freeform: args.freeform } : {}),
      ...(args.language !== null ? { language: args.language } : {}),
      ...(args.offerDeadlineIso !== null ? { offerDeadlineIso: args.offerDeadlineIso } : {}),
    };
    const { error } = await ctx.supabase
      .from("marketing_campaign")
      .update({ config: { ...campaign.config, brief } as unknown as Json })
      .eq("id", args.campaignId);
    if (error) throw new MarketingToolError(`update_campaign_brief: ${error.message}`);
    return { summary: "Updated the campaign brief.", target: { entity: "campaign", id: args.campaignId } };
  },
});

/** Editing/approving one step. Approving is reversible (never reaches a real
 *  person). Per §3's business rule, editing an APPROVED step (via
 *  write_email_touch/update_email_step) must drop it — and the campaign —
 *  back to pending review; that reset lives in email.ts next to the edit
 *  tools themselves so it can't be bypassed by a second write path. */
const approveEmailStep = defineMarketingTool({
  name: "approve_email_step",
  description: "Mark one email step approved (or back to draft). Reversible — does not send anything.",
  params: z.object({ touchId: z.string().min(1), sequenceId: z.string().min(1), approved: z.boolean() }),
  reversibility: "reversible",
  actionKind: "approve_email_step",
  existingTarget(args) {
    return { entity: "email_sequence", id: args.sequenceId };
  },
  async execute(args, ctx) {
    const { error } = await ctx.supabase
      .from("email_touch")
      .update({ approval_status: args.approved ? "approved" : "draft" })
      .eq("id", args.touchId)
      .eq("sequence_id", args.sequenceId);
    if (error) throw new MarketingToolError(`approve_email_step: ${error.message}`);

    const seq = await loadEmailSequence(ctx.supabase, args.sequenceId);
    if (seq) {
      const campaign = await loadCampaign(ctx.supabase, seq.campaignId);
      if (campaign && (campaign.status === "draft" || campaign.status === "generated")) {
        await ctx.supabase.from("marketing_campaign").update({ status: "in_review" }).eq("id", campaign.id);
      }
    }
    return { summary: `${args.approved ? "Approved" : "Un-approved"} the email step.`, target: { entity: "email_sequence", id: args.sequenceId } };
  },
});

const approveCampaign = defineMarketingTool({
  name: "approve_campaign",
  description:
    "Sign off the campaign's content once every step is approved (does not send or schedule anything). Reversible.",
  params: z.object({ campaignId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "approve_campaign",
  existingTarget(args) {
    return { entity: "campaign", id: args.campaignId };
  },
  async execute(args, ctx) {
    const campaign = await loadCampaign(ctx.supabase, args.campaignId);
    if (!campaign) throw new MarketingToolError(`Campaign ${args.campaignId} not found`);
    const seqId = await primarySequenceId(ctx, args.campaignId);
    const seq = seqId ? await loadEmailSequence(ctx.supabase, seqId) : null;
    if (!seq || seq.touches.length === 0 || !seq.touches.every((t) => t.approvalStatus === "approved")) {
      throw new MarketingToolError("Every email step must be approved before the campaign can be approved.");
    }
    const { error } = await ctx.supabase
      .from("marketing_campaign")
      .update({ status: "approved", approved_at: ctx.services.clock.now(), approved_by: ctx.ownerId })
      .eq("id", args.campaignId);
    if (error) throw new MarketingToolError(`approve_campaign: ${error.message}`);
    return { summary: `Approved "${campaign.name}" — ready to launch.`, target: { entity: "campaign", id: args.campaignId } };
  },
});

/* ───────────────────────── irreversible: launch / cancel ─────────────────── */

const launchCampaign = defineMarketingTool({
  name: "launch_campaign",
  description:
    "Launch the campaign: snapshot the approved audience and begin enrollment/sending on the configured schedule. Irreversible (outward-facing) — requires approval.",
  params: z.object({ campaignId: z.string().min(1) }),
  reversibility: "irreversible",
  actionKind: "launch_campaign",
  async execute(args, ctx) {
    const campaign = await loadCampaign(ctx.supabase, args.campaignId);
    if (!campaign) throw new MarketingToolError(`Campaign ${args.campaignId} not found`);
    const checklist = await evaluateLaunchChecklist(ctx.supabase, campaign);

    const window = (campaign.config.sendWindow as SendWindow | undefined) ?? DEFAULT_SEND_WINDOW;
    const timing = sendTimingSentence(ctx.services.clock.epochMs(), window);

    if (!ctx.approved) {
      const audienceCount = campaign.leadListId ? (await snapshotApprovedAudience(ctx.supabase, campaign.leadListId)).length : 0;
      return {
        summary: checklist.canLaunch
          ? `Launch "${campaign.name}" — ${audienceCount} subscriber(s) will be enrolled in the sequence. ${timing}`
          : `"${campaign.name}" is not ready to launch — ${checklist.items.filter((i) => !i.ok).length} checklist item(s) unmet.`,
        target: { entity: "campaign", id: campaign.id },
        approvalPreview: {
          name: campaign.name,
          audience: audienceCount,
          checklist: checklist.items,
          effectLabel: `launch to ${audienceCount} ${audienceCount === 1 ? "person" : "people"}`,
        },
      };
    }

    if (!checklist.canLaunch) {
      throw new MarketingToolError(
        `Cannot launch — unmet: ${checklist.items.filter((i) => !i.ok).map((i) => i.label).join("; ")}`
      );
    }
    const audienceIds = campaign.leadListId ? await snapshotApprovedAudience(ctx.supabase, campaign.leadListId) : [];
    const seqId = await primarySequenceId(ctx, args.campaignId);
    const seq = seqId ? await loadEmailSequence(ctx.supabase, seqId) : null;
    if (!seq) throw new MarketingToolError("No sequence to launch.");

    await ctx.supabase.from("email_sequence").update({ status: "active" }).eq("id", seq.id);
    const { enrolled } = await enrollSegment(ctx.supabase, seq, audienceIds, { nowMs: ctx.services.clock.epochMs() });
    await ctx.supabase
      .from("marketing_campaign")
      .update({ status: "active", config: { ...campaign.config, approvedAudienceIds: audienceIds } as unknown as Json })
      .eq("id", args.campaignId);

    const windowNow = sendWindowState(ctx.services.clock.epochMs(), window);
    return {
      summary: `Launched "${campaign.name}" — enrolled ${enrolled} subscriber(s). ${timing}`,
      data: {
        enrolled,
        nextWindowOpensAt: windowNow.nextOpenMs !== null ? new Date(windowNow.nextOpenMs).toISOString() : null,
        sendWindowOpenNow: windowNow.openNow,
      },
      target: { entity: "campaign", id: campaign.id },
    };
  },
});

const cancelCampaign = defineMarketingTool({
  name: "cancel_campaign",
  description: "Terminally cancel the campaign — stops all future sends. Irreversible — requires approval.",
  params: z.object({ campaignId: z.string().min(1) }),
  reversibility: "irreversible",
  actionKind: "cancel_campaign",
  async execute(args, ctx) {
    const campaign = await loadCampaign(ctx.supabase, args.campaignId);
    if (!campaign) throw new MarketingToolError(`Campaign ${args.campaignId} not found`);
    if (!ctx.approved) {
      return {
        summary: `Cancel "${campaign.name}" — all future queued sends will stop permanently.`,
        target: { entity: "campaign", id: campaign.id },
        approvalPreview: { name: campaign.name, effectLabel: "cancel campaign" },
      };
    }
    const seqId = await primarySequenceId(ctx, args.campaignId);
    if (seqId) {
      await ctx.supabase.from("email_sequence").update({ status: "paused" }).eq("id", seqId);
      await ctx.supabase.from("sequence_enrollment").update({ status: "cancelled" }).eq("sequence_id", seqId).eq("status", "active");
      await ctx.supabase.from("scheduled_send").update({ status: "cancelled" }).eq("sequence_id", seqId).eq("status", "pending");
    }
    await ctx.supabase.from("marketing_campaign").update({ status: "cancelled" }).eq("id", args.campaignId);
    return { summary: `Cancelled "${campaign.name}".`, target: { entity: "campaign", id: campaign.id } };
  },
});

/* ───────────────────────── reversible: pause / resume ─────────────────────── */

const pauseCampaign = defineMarketingTool({
  name: "pause_campaign",
  description: "Pause an active campaign — stops future queued sends without cancelling it. Reversible control.",
  params: z.object({ campaignId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "pause_campaign",
  existingTarget(args) {
    return { entity: "campaign", id: args.campaignId };
  },
  async execute(args, ctx) {
    const campaign = await loadCampaign(ctx.supabase, args.campaignId);
    if (!campaign) throw new MarketingToolError(`Campaign ${args.campaignId} not found`);
    const seqId = await primarySequenceId(ctx, args.campaignId);
    if (seqId) await ctx.supabase.from("email_sequence").update({ status: "paused" }).eq("id", seqId);
    await ctx.supabase.from("marketing_campaign").update({ status: "paused" }).eq("id", args.campaignId);
    return { summary: `Paused "${campaign.name}".`, target: { entity: "campaign", id: campaign.id } };
  },
});

const resumeCampaign = defineMarketingTool({
  name: "resume_campaign",
  description: "Resume a paused campaign — only unsent steps continue. Reversible control.",
  params: z.object({ campaignId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "resume_campaign",
  existingTarget(args) {
    return { entity: "campaign", id: args.campaignId };
  },
  async execute(args, ctx) {
    const campaign = await loadCampaign(ctx.supabase, args.campaignId);
    if (!campaign) throw new MarketingToolError(`Campaign ${args.campaignId} not found`);
    const seqId = await primarySequenceId(ctx, args.campaignId);
    if (seqId) await ctx.supabase.from("email_sequence").update({ status: "active" }).eq("id", seqId);
    await ctx.supabase.from("marketing_campaign").update({ status: "active" }).eq("id", args.campaignId);
    return { summary: `Resumed "${campaign.name}".`, target: { entity: "campaign", id: campaign.id } };
  },
});

const getLaunchChecklist = defineMarketingTool({
  name: "get_launch_checklist",
  description: "Get the launch-readiness checklist for a campaign (read-only).",
  params: z.object({ campaignId: z.string().min(1) }),
  reversibility: "read",
  async execute(args, ctx) {
    const campaign = await loadCampaign(ctx.supabase, args.campaignId);
    if (!campaign) throw new MarketingToolError(`Campaign ${args.campaignId} not found`);
    const checklist = await evaluateLaunchChecklist(ctx.supabase, campaign);
    return {
      summary: checklist.canLaunch ? "Ready to launch." : `${checklist.items.filter((i) => !i.ok).length} item(s) unmet.`,
      data: checklist,
    };
  },
});

const analyzeCourseForMarketing = defineMarketingTool({
  name: "analyze_course_for_marketing",
  description:
    "Run the Course Marketing Analyst: extract audience, benefits, pain points, outcomes, objections, differentiators, and credibility signals from the course plan and the campaign brief.",
  params: z.object({ campaignId: z.string().min(1).nullable() }),
  reversibility: "read",
  async execute(args, ctx) {
    const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
    if (!course) throw new MarketingToolError("Course not found");
    const campaign = args.campaignId ? await loadCampaign(ctx.supabase, args.campaignId) : null;
    const brief = campaign?.config.brief;

    const findings = {
      audience: { value: course.audience ?? brief?.audienceNotes ?? "Not specified", source: course.audience ? "course" : brief?.audienceNotes ? "brief" : "none" },
      outcomes: { value: course.outcomes, source: "course" },
      credibility: { value: brief?.proofPoints ?? null, source: brief?.proofPoints ? "brief" : "none" },
      differentiators: { value: course.teachingStyle, source: "course" },
      thingsToAvoid: { value: brief?.thingsToAvoid ?? null, source: brief?.thingsToAvoid ? "brief" : "none" },
      missingInfo: [
        !course.audience && !brief?.audienceNotes ? "audience" : null,
        !brief?.proofPoints ? "credibility/proof points" : null,
      ].filter((x): x is string => !!x),
    };
    return {
      summary: `Analyzed "${course.title}" — ${findings.missingInfo.length ? `missing: ${findings.missingInfo.join(", ")}` : "grounding is complete"}.`,
      data: findings,
    };
  },
});

export const campaignLifecycleTools = [
  listMarketingCampaigns,
  updateCampaignBrief,
  approveEmailStep,
  approveCampaign,
  launchCampaign,
  cancelCampaign,
  pauseCampaign,
  resumeCampaign,
  getLaunchChecklist,
  analyzeCourseForMarketing,
];
