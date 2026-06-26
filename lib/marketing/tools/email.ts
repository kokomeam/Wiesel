/**
 * Email tools.
 *
 *   REVERSIBLE (auto-stage, Reject-able):
 *     generate_email_sequence — draft a timed launch sequence from the course
 *     generate_followup       — draft an event-triggered behavioral followup
 *     write_email_touch       — author/replace one touch (snapshots the sequence)
 *   IRREVERSIBLE (approval-gated; outward-facing):
 *     activate_sequence          — make a draft sequence live (+ enroll current
 *                                  subscribers for a timed launch)
 *     enroll_segment_in_sequence — bulk-enroll a segment into an active sequence
 *     send_broadcast             — one-off send to a segment
 *     send_test_email            — send a single test to the creator's address
 *
 * Sends inside an active sequence are pre-authorized by `activate_sequence`'s
 * approval — the gate sits at activate / enroll / broadcast, not per-touch.
 */

import { z } from "zod";
import { renderEmailText } from "../email/render";
import { generateFollowup, generateLaunchSequence } from "../email/templates";
import {
  bodyToJson,
  listLandingPages,
  loadCampaignForCourse,
  loadCourseMarketingContext,
  loadEmailSequence,
} from "../persistence";
import { EmailBodySchema } from "../schemas";
import { enrollSegment, sendBroadcast } from "../scheduler";
import type { AnalyticsEventType, SubscriberStatus } from "../types";
import {
  defineMarketingTool,
  MarketingToolError,
  type MarketingToolContext,
} from "./types";

const TRIGGER_EVENTS = ["page_view", "form_submit", "email_open"] as const;
const SUBSCRIBER_STATUSES = [
  "lead",
  "subscribed",
  "engaged",
  "enrolled",
] as const;

async function requireCampaignId(ctx: MarketingToolContext): Promise<string> {
  if (ctx.campaignId) return ctx.campaignId;
  const c = await loadCampaignForCourse(ctx.supabase, ctx.courseId);
  if (!c) throw new MarketingToolError("No campaign yet — generate a landing page or create a campaign first.");
  return c.id;
}

async function landingPathFor(ctx: MarketingToolContext, campaignId: string): Promise<string | null> {
  const pages = await listLandingPages(ctx.supabase, campaignId);
  const pub = pages.find((p) => p.status === "published") ?? pages[0];
  return pub ? `/p/${pub.slug}` : null;
}

/** Non-suppressed subscriber ids for a segment (optional status filter). */
async function segmentIds(
  ctx: MarketingToolContext,
  campaignId: string,
  status?: SubscriberStatus | null
): Promise<string[]> {
  let q = ctx.supabase.from("subscriber").select("id,status").eq("campaign_id", campaignId);
  if (status) q = q.eq("status", status);
  const { data } = await q;
  return (data ?? [])
    .filter((s) => s.status !== "unsubscribed" && s.status !== "bounced")
    .map((s) => s.id);
}

async function insertSequence(
  ctx: MarketingToolContext,
  campaignId: string,
  draft: ReturnType<typeof generateLaunchSequence>
): Promise<{ sequenceId: string; touchCount: number }> {
  const { data: seq, error } = await ctx.supabase
    .from("email_sequence")
    .insert({
      campaign_id: campaignId,
      course_id: ctx.courseId,
      name: draft.name,
      kind: draft.kind,
      trigger: draft.trigger,
      status: "draft",
    })
    .select("id")
    .single();
  if (error || !seq) throw new MarketingToolError(`create sequence: ${error?.message}`);

  const rows = draft.touches.map((t) => ({
    sequence_id: seq.id,
    course_id: ctx.courseId,
    position: t.position,
    delay_seconds: t.delaySeconds,
    trigger_event: t.triggerEvent,
    subject: t.subject,
    preview_text: t.previewText,
    body: bodyToJson(t.body),
  }));
  const { error: te } = await ctx.supabase.from("email_touch").insert(rows);
  if (te) throw new MarketingToolError(`create touches: ${te.message}`);
  return { sequenceId: seq.id, touchCount: rows.length };
}

/* ─────────────────────────── reversible ──────────────────────────────── */

const generateEmailSequence = defineMarketingTool({
  name: "generate_email_sequence",
  description:
    "Draft a timed launch email sequence (welcome → value → proof → close) from the course. Stages as a reviewable draft; does not send.",
  params: z.object({}),
  reversibility: "reversible",
  actionKind: "generate_email_sequence",
  async execute(_args, ctx) {
    const campaignId = await requireCampaignId(ctx);
    const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
    if (!course) throw new MarketingToolError("Course not found");
    const draft = generateLaunchSequence(course, { landingPath: await landingPathFor(ctx, campaignId) });
    const { sequenceId, touchCount } = await insertSequence(ctx, campaignId, draft);
    return {
      summary: `Drafted a ${touchCount}-email launch sequence.`,
      data: { sequenceId, touchCount },
      target: { entity: "email_sequence", id: sequenceId },
    };
  },
});

const generateFollowupTool = defineMarketingTool({
  name: "generate_followup",
  description:
    "Draft an event-triggered behavioral followup (e.g. viewed the page but didn't enroll). Stages as a reviewable draft; does not send.",
  params: z.object({
    triggerEvent: z.enum(TRIGGER_EVENTS).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "generate_followup",
  async execute(args, ctx) {
    const campaignId = await requireCampaignId(ctx);
    const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
    if (!course) throw new MarketingToolError("Course not found");
    const draft = generateFollowup(course, {
      landingPath: await landingPathFor(ctx, campaignId),
      triggerEvent: (args.triggerEvent as AnalyticsEventType | null) ?? undefined,
    });
    const { sequenceId, touchCount } = await insertSequence(ctx, campaignId, draft);
    return {
      summary: `Drafted a ${touchCount}-touch followup (trigger: ${draft.trigger.event}).`,
      data: { sequenceId, touchCount },
      target: { entity: "email_sequence", id: sequenceId },
    };
  },
});

const writeEmailTouch = defineMarketingTool({
  name: "write_email_touch",
  description:
    "Author or replace one email touch in a sequence (subject, preview, body). Stages as reversible (snapshots the whole sequence).",
  params: z.object({
    sequenceId: z.string().min(1),
    touchId: z.string().nullable(),
    position: z.number().int().min(0).nullable(),
    delaySeconds: z.number().int().min(0).nullable(),
    triggerEvent: z.enum(TRIGGER_EVENTS).nullable(),
    subject: z.string().min(1).max(120),
    previewText: z.string().max(160).nullable(),
    body: EmailBodySchema,
  }),
  reversibility: "reversible",
  actionKind: "write_email_touch",
  existingTarget(args) {
    return { entity: "email_sequence", id: args.sequenceId };
  },
  async execute(args, ctx) {
    const seq = await loadEmailSequence(ctx.supabase, args.sequenceId);
    if (!seq) throw new MarketingToolError(`Sequence ${args.sequenceId} not found`);

    if (args.touchId) {
      const { error } = await ctx.supabase
        .from("email_touch")
        .update({
          subject: args.subject,
          preview_text: args.previewText,
          body: bodyToJson(args.body),
          ...(args.delaySeconds !== null ? { delay_seconds: args.delaySeconds } : {}),
          ...(args.triggerEvent !== null ? { trigger_event: args.triggerEvent } : {}),
        })
        .eq("id", args.touchId)
        .eq("sequence_id", args.sequenceId);
      if (error) throw new MarketingToolError(`write_email_touch: ${error.message}`);
    } else {
      const position = args.position ?? seq.touches.length;
      const { error } = await ctx.supabase.from("email_touch").insert({
        sequence_id: args.sequenceId,
        course_id: ctx.courseId,
        position,
        delay_seconds: args.delaySeconds,
        trigger_event: args.triggerEvent,
        subject: args.subject,
        preview_text: args.previewText,
        body: bodyToJson(args.body),
      });
      if (error) throw new MarketingToolError(`write_email_touch (add): ${error.message}`);
    }
    return {
      summary: `${args.touchId ? "Updated" : "Added"} a touch in "${seq.name}".`,
      target: { entity: "email_sequence", id: args.sequenceId },
    };
  },
});

/* ───────────────────────── irreversible ──────────────────────────────── */

const activateSequence = defineMarketingTool({
  name: "activate_sequence",
  description:
    "Make a draft sequence LIVE. For a timed launch this enrolls current subscribers and begins scheduling sends. Irreversible — requires approval.",
  params: z.object({ sequenceId: z.string().min(1) }),
  reversibility: "irreversible",
  actionKind: "activate_sequence",
  async execute(args, ctx) {
    const seq = await loadEmailSequence(ctx.supabase, args.sequenceId);
    if (!seq) throw new MarketingToolError(`Sequence ${args.sequenceId} not found`);
    const willEnroll = seq.kind === "time_launch" ? await segmentIds(ctx, seq.campaignId) : [];

    if (!ctx.approved) {
      return {
        summary:
          seq.kind === "time_launch"
            ? `Activate "${seq.name}" and enroll ${willEnroll.length} subscriber(s) — sends will go out.`
            : `Activate "${seq.name}" — it will enroll subscribers when its trigger fires.`,
        target: { entity: "email_sequence", id: seq.id },
        approvalPreview: { name: seq.name, kind: seq.kind, touches: seq.touches.length, audience: willEnroll.length },
      };
    }

    await ctx.supabase.from("email_sequence").update({ status: "active" }).eq("id", seq.id);
    let enrolled = 0;
    if (seq.kind === "time_launch") {
      ({ enrolled } = await enrollSegment(ctx.supabase, seq, willEnroll, { nowMs: ctx.services.clock.epochMs() }));
    }
    return {
      summary: `Activated "${seq.name}"${enrolled ? ` — enrolled ${enrolled} subscriber(s).` : "."}`,
      data: { enrolled },
      target: { entity: "email_sequence", id: seq.id },
    };
  },
});

const enrollSegmentInSequence = defineMarketingTool({
  name: "enroll_segment_in_sequence",
  description:
    "Bulk-enroll a subscriber segment into an ACTIVE sequence (triggers real sends). Irreversible — requires approval.",
  params: z.object({
    sequenceId: z.string().min(1),
    status: z.enum(SUBSCRIBER_STATUSES).nullable(),
  }),
  reversibility: "irreversible",
  actionKind: "enroll_segment_in_sequence",
  async execute(args, ctx) {
    const seq = await loadEmailSequence(ctx.supabase, args.sequenceId);
    if (!seq) throw new MarketingToolError(`Sequence ${args.sequenceId} not found`);
    const ids = await segmentIds(ctx, seq.campaignId, (args.status as SubscriberStatus | null) ?? undefined);

    if (!ctx.approved) {
      return {
        summary: `Enroll ${ids.length} subscriber(s) into "${seq.name}" — sends will go out.`,
        target: { entity: "email_sequence", id: seq.id },
        approvalPreview: { name: seq.name, audience: ids.length, segment: args.status ?? "all" },
      };
    }
    if (seq.status !== "active") throw new MarketingToolError("Activate the sequence before enrolling a segment.");
    const { enrolled } = await enrollSegment(ctx.supabase, seq, ids, { nowMs: ctx.services.clock.epochMs() });
    return {
      summary: `Enrolled ${enrolled} subscriber(s) into "${seq.name}".`,
      data: { enrolled },
      target: { entity: "email_sequence", id: seq.id },
    };
  },
});

const sendBroadcastTool = defineMarketingTool({
  name: "send_broadcast",
  description: "Send a one-off email to a subscriber segment. Irreversible — requires approval.",
  params: z.object({
    subject: z.string().min(1).max(120),
    body: EmailBodySchema,
    status: z.enum(SUBSCRIBER_STATUSES).nullable(),
  }),
  reversibility: "irreversible",
  actionKind: "send_broadcast",
  async execute(args, ctx) {
    const campaignId = await requireCampaignId(ctx);
    const ids = await segmentIds(ctx, campaignId, (args.status as SubscriberStatus | null) ?? undefined);
    if (!ctx.approved) {
      return {
        summary: `Send "${args.subject}" to ${ids.length} subscriber(s).`,
        approvalPreview: { subject: args.subject, audience: ids.length, segment: args.status ?? "all" },
      };
    }
    const { sent, skipped } = await sendBroadcast(ctx.supabase, ctx.services, {
      courseId: ctx.courseId,
      subscriberIds: ids,
      subject: args.subject,
      body: args.body,
      nowMs: ctx.services.clock.epochMs(),
    });
    return { summary: `Sent to ${sent} subscriber(s)${skipped ? ` (${skipped} skipped).` : "."}`, data: { sent, skipped } };
  },
});

const sendTestEmail = defineMarketingTool({
  name: "send_test_email",
  description:
    "Send a single test email to the creator's own address. Irreversible (a real send) — requires approval.",
  params: z.object({
    to: z.string().min(1).max(254),
    subject: z.string().min(1).max(120),
    body: EmailBodySchema,
  }),
  reversibility: "irreversible",
  actionKind: "send_test_email",
  async execute(args, ctx) {
    if (!ctx.approved) {
      return {
        summary: `Send a test email to ${args.to}.`,
        approvalPreview: { to: args.to, subject: args.subject },
      };
    }
    const text = renderEmailText(args.body, { unsubscribeUrl: "#" });
    const res = await ctx.services.email.send({
      to: args.to,
      subject: args.subject,
      body: args.body,
      text,
      unsubscribeUrl: "#",
      meta: { test: true },
    });
    return { summary: `Test email sent to ${args.to}.`, data: { providerMessageId: res.providerMessageId } };
  },
});

export const emailTools = [
  generateEmailSequence,
  generateFollowupTool,
  writeEmailTouch,
  activateSequence,
  enrollSegmentInSequence,
  sendBroadcastTool,
  sendTestEmail,
];
