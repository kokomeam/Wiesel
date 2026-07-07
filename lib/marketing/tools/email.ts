/**
 * Email tools.
 *
 *   REVERSIBLE (auto-stage, Reject-able):
 *     generate_email_sequence — draft a timed launch sequence from the course
 *     generate_followup       — draft an event-triggered behavioral followup
 *     write_email_touch       — author/replace one touch (snapshots the sequence)
 *     pause_sequence          — hold ONE active sequence's queued sends
 *     resume_sequence         — continue a paused sequence's held sends
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
import type { Json } from "@/lib/database.types";
import { getBlueprint, stagesForLength, clampLength, CAMPAIGN_GOALS, type CampaignGoal } from "../blueprints";
import { generateBlueprintSequence, generateFollowup, generateLaunchSequence, type TouchDraft } from "../email/templates";
import { generateSequenceWithModel } from "../email/llmGenerate";
import { resolveCtaDestinations } from "../ctaDestination";
import { resolveCopyLocale } from "../language";
import {
  bodyToJson,
  defaultVoiceRules,
  loadCampaign,
  loadCampaignForCourse,
  loadCourseMarketingContext,
  loadEmailSequence,
  loadSenderIdentity,
  loadVoiceProfile,
} from "../persistence";
import { scoreEmailStep } from "../quality";
import type { QuestionSpec } from "../questions";
import { EmailBodySchema } from "../schemas";
import { enrollSegment, renderSendableEmail, sendBroadcast, sendTimingSentence } from "../scheduler";
import { unsubscribeUrl } from "../tokens";
import { DEFAULT_SEND_WINDOW } from "../types";
import type { AnalyticsEventType, SendWindow, SubscriberStatus } from "../types";
import { voiceLedgerSignal } from "./voice";
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

/** CTA destination: course preview (/learn) when a live publication exists,
 *  else the campaign landing page — see lib/marketing/ctaDestination.ts. */
async function ctaPathFor(ctx: MarketingToolContext, campaignId: string): Promise<string | null> {
  const dest = await resolveCtaDestinations(ctx.supabase, { courseId: ctx.courseId, campaignId });
  return dest.ctaPath;
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

/** "all" (explicitly everyone) / null (unspecified) → no status filter. */
function audienceFilter(status: string | null | undefined): SubscriberStatus | undefined {
  return status && status !== "all" ? (status as SubscriberStatus) : undefined;
}

/** Per-status counts of non-suppressed subscribers — feeds the clarifying
 *  question when a segment send arrives with no segment specified. */
async function statusCounts(ctx: MarketingToolContext, campaignId: string): Promise<Map<string, number>> {
  const { data } = await ctx.supabase.from("subscriber").select("id,status").eq("campaign_id", campaignId);
  const counts = new Map<string, number>();
  for (const s of data ?? []) {
    if (s.status === "unsubscribed" || s.status === "bounced") continue;
    counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  }
  return counts;
}

const STATUS_LABELS: Record<string, string> = {
  lead: "Leads",
  subscribed: "Subscribed",
  engaged: "Engaged",
  enrolled: "Enrolled",
};

/**
 * Targeting is only AMBIGUOUS when no segment was specified AND the audience
 * actually spans ≥2 statuses — a single-status audience has nothing to choose.
 * The "Everyone" answer maps to the explicit "all" value so the retried call
 * doesn't re-trigger the question.
 */
function segmentQuestion(question: string, counts: Map<string, number>): QuestionSpec | null {
  if (counts.size < 2) return null;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const options = [
    { label: `Everyone (${total})`, value: "all", description: "All non-suppressed contacts" },
    ...[...counts.entries()].map(([status, n]) => ({
      label: `${STATUS_LABELS[status] ?? status} (${n})`,
      value: status,
      description: null,
    })),
  ].slice(0, 5);
  return { question, options, paramKey: "status" };
}

/** Plain-text excerpt of an email body for the inline approval preview. A
 *  button's HREF is shown alongside its label — not just the label — so the
 *  creator can catch a wrong/fabricated destination before approving
 *  (observed live: the agent invented "/courses/{id}" links with no such
 *  route; the approval card showed only "[Open the cs61b course]" with the
 *  actual destination invisible, so nothing caught it before it sent). */
function bodyPreviewText(body: { blocks: Array<Record<string, unknown>> }): string {
  const lines: string[] = [];
  for (const b of body.blocks) {
    if (typeof b.label === "string") lines.push(`[${b.label} → ${typeof b.href === "string" ? b.href : "?"}]`);
    else if (typeof b.text === "string") lines.push(b.text);
    else if (Array.isArray(b.items)) lines.push(...(b.items as string[]).map((i) => `• ${i}`));
  }
  const text = lines.join("\n");
  return text.length > 280 ? `${text.slice(0, 277)}…` : text;
}

async function insertSequence(
  ctx: MarketingToolContext,
  campaignId: string,
  draft: ReturnType<typeof generateLaunchSequence>,
  course: Awaited<ReturnType<typeof loadCourseMarketingContext>>
): Promise<{ sequenceId: string; touchCount: number; avgQuality: number }> {
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

  const scores = draft.touches.map((t) =>
    course
      ? scoreEmailStep({
          subject: t.subject,
          previewText: t.previewText,
          body: t.body,
          framework: "PAS",
          isOfferStage: (t.stageName ?? "").toLowerCase().includes("offer") || (t.stageName ?? "").toLowerCase().includes("chance"),
          course: { modules: course.modules, outcomes: course.outcomes },
        })
      : null
  );

  const rows = draft.touches.map((t, i) => ({
    sequence_id: seq.id,
    course_id: ctx.courseId,
    position: t.position,
    delay_seconds: t.delaySeconds,
    trigger_event: t.triggerEvent,
    subject: t.subject,
    preview_text: t.previewText,
    body: bodyToJson(t.body),
    stage_name: t.stageName ?? null,
    purpose: t.purpose ?? null,
    ai_rationale: t.aiRationale ?? null,
    personalization_variables: (t.personalizationVariables ?? []) as never,
    quality_score: (scores[i] as never) ?? null,
  }));
  const { error: te } = await ctx.supabase.from("email_touch").insert(rows);
  if (te) throw new MarketingToolError(`create touches: ${te.message}`);
  const avgQuality = scores.length ? Math.round(scores.reduce((a, s) => a + (s?.score ?? 0), 0) / scores.length) : 0;
  return { sequenceId: seq.id, touchCount: rows.length, avgQuality };
}

/* ─────────────────────────── reversible ──────────────────────────────── */

const generateEmailSequence = defineMarketingTool({
  name: "generate_email_sequence",
  description:
    "Draft a goal-driven email sequence (3-7 emails, chosen by blueprint) from the course + campaign brief + voice profile. Stages as a reviewable draft; does not send.",
  params: z.object({
    goal: z.enum(CAMPAIGN_GOALS as [CampaignGoal, ...CampaignGoal[]]).nullable(),
    length: z.number().int().min(2).max(7).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "generate_email_sequence",
  async execute(args, ctx) {
    const campaignId = await requireCampaignId(ctx);
    const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
    if (!course) throw new MarketingToolError("Course not found");
    const campaign = await loadCampaign(ctx.supabase, campaignId);

    const goal = (args.goal ?? campaign?.goal ?? "launch_course") as CampaignGoal;
    const blueprint = getBlueprint(goal);
    if (!blueprint) throw new MarketingToolError(`Unknown campaign goal "${goal}"`);
    if (goal === "promote_discount" && !campaign?.config.brief?.offerDeadlineIso) {
      throw new MarketingToolError(
        "The \"Promote a discount\" blueprint requires a real offer deadline in the Campaign Brief first (fake-scarcity rule) — call update_campaign_brief with offerDeadlineIso."
      );
    }
    const length = clampLength(blueprint, args.length);
    const stages = stagesForLength(blueprint, length);
    const ctaPath = await ctaPathFor(ctx, campaignId);
    const brief = campaign?.config.brief;

    let draft = generateBlueprintSequence(course, stages, { ctaPath, brief });
    let usedModel = false;
    if (ctx.model) {
      const voiceProfile = await loadVoiceProfile(ctx.supabase, ctx.ownerId);
      const voiceRules = voiceProfile?.rules ?? defaultVoiceRules(course.teachingStyle);
      const ledgerSignal = await voiceLedgerSignal(ctx.supabase, ctx.ownerId);
      const llmTouches = await generateSequenceWithModel(ctx.model, { course, brief, voiceRules, ledgerSignal, stages });
      if (llmTouches) {
        const byKey = new Map(llmTouches.map((t) => [t.stageKey, t]));
        const touches: TouchDraft[] = stages.map((stage, i) => {
          const t = byKey.get(stage.key);
          return t
            ? {
                position: i,
                delaySeconds: stage.dayOffset * 86400,
                triggerEvent: null,
                subject: t.subject,
                previewText: t.previewText,
                body: t.body,
                stageName: stage.name,
                purpose: stage.framework,
                aiRationale: t.aiRationale,
                personalizationVariables: t.personalizationVariables,
              }
            : draft.touches[i];
        });
        draft = { ...draft, touches };
        usedModel = true;
      }
    }

    const { sequenceId, touchCount, avgQuality } = await insertSequence(ctx, campaignId, draft, course);
    if (campaign && campaign.status === "draft") {
      await ctx.supabase
        .from("marketing_campaign")
        .update({ status: "generated", config: { ...campaign.config, blueprintKey: blueprint.key } as unknown as Json })
        .eq("id", campaignId);
    }
    return {
      summary: `Drafted a ${touchCount}-email "${blueprint.label}" sequence${usedModel ? "" : " (deterministic — no model configured)"}. Avg quality score ${avgQuality}/100.`,
      data: { sequenceId, touchCount, blueprintKey: blueprint.key, usedModel, avgQuality },
      target: { entity: "email_sequence", id: sequenceId },
    };
  },
});

const regenerateEmailStep = defineMarketingTool({
  name: "regenerate_email_step",
  description: "Redraft ONE step of a sequence, keeping the others. Stages as reversible (snapshots the sequence).",
  params: z.object({ sequenceId: z.string().min(1), touchId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "regenerate_email_step",
  existingTarget(args) {
    return { entity: "email_sequence", id: args.sequenceId };
  },
  async execute(args, ctx) {
    const seq = await loadEmailSequence(ctx.supabase, args.sequenceId);
    if (!seq) throw new MarketingToolError(`Sequence ${args.sequenceId} not found`);
    const touch = seq.touches.find((t) => t.id === args.touchId);
    if (!touch) throw new MarketingToolError(`Touch ${args.touchId} not found`);
    const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
    if (!course) throw new MarketingToolError("Course not found");
    const campaign = await loadCampaign(ctx.supabase, seq.campaignId);
    const blueprint = getBlueprint(campaign?.goal ?? "launch_course");
    const stage = blueprint?.stages.find((s) => s.name === touch.stageName) ?? blueprint?.stages[touch.position] ?? { key: "step", name: touch.stageName ?? "Step", framework: "PAS" as const, dayOffset: 0 };

    let newDraft = generateBlueprintSequence(course, [stage], { brief: campaign?.config.brief }).touches[0];
    let usedModel = false;
    if (ctx.model) {
      const voiceProfile = await loadVoiceProfile(ctx.supabase, ctx.ownerId);
      const voiceRules = voiceProfile?.rules ?? defaultVoiceRules(course.teachingStyle);
      const ledgerSignal = await voiceLedgerSignal(ctx.supabase, ctx.ownerId);
      const llm = await generateSequenceWithModel(ctx.model, { course, brief: campaign?.config.brief, voiceRules, ledgerSignal, stages: [stage] });
      if (llm?.[0]) {
        newDraft = { ...newDraft, subject: llm[0].subject, previewText: llm[0].previewText, body: llm[0].body, aiRationale: llm[0].aiRationale, personalizationVariables: llm[0].personalizationVariables };
        usedModel = true;
      }
    }
    const score = scoreEmailStep({
      subject: newDraft.subject,
      previewText: newDraft.previewText,
      body: newDraft.body,
      framework: stage.framework,
      isOfferStage: stage.framework === "offer_transformation_deadline",
      course: { modules: course.modules, outcomes: course.outcomes },
    });
    const { error } = await ctx.supabase
      .from("email_touch")
      .update({
        subject: newDraft.subject,
        preview_text: newDraft.previewText,
        body: bodyToJson(newDraft.body),
        ai_rationale: newDraft.aiRationale ?? null,
        personalization_variables: (newDraft.personalizationVariables ?? []) as never,
        quality_score: score as never,
        approval_status: "draft",
      })
      .eq("id", args.touchId);
    if (error) throw new MarketingToolError(`regenerate_email_step: ${error.message}`);
    if (campaign && campaign.status !== "draft" && campaign.status !== "generated") {
      await ctx.supabase.from("marketing_campaign").update({ status: "in_review" }).eq("id", campaign.id);
    }
    return {
      summary: `Regenerated "${touch.stageName ?? touch.subject}"${usedModel ? "" : " (deterministic)"} — quality ${score.score}/100.`,
      data: { quality: score },
      target: { entity: "email_sequence", id: args.sequenceId },
    };
  },
});

const generateEmailVariants = defineMarketingTool({
  name: "generate_email_variants",
  description:
    "Generate subject/CTA/hook/tone VARIANTS for one step, for the creator to pick manually. Selection only — never an A/B experiment. Stages as reversible (informational; doesn't change the live step until the creator applies one).",
  params: z.object({ sequenceId: z.string().min(1), touchId: z.string().min(1), axis: z.enum(["subject", "cta", "hook", "tone"]) }),
  reversibility: "reversible",
  actionKind: "generate_email_variants",
  existingTarget(args) {
    return { entity: "email_sequence", id: args.sequenceId };
  },
  async execute(args, ctx) {
    const seq = await loadEmailSequence(ctx.supabase, args.sequenceId);
    if (!seq) throw new MarketingToolError(`Sequence ${args.sequenceId} not found`);
    const touch = seq.touches.find((t) => t.id === args.touchId);
    if (!touch) throw new MarketingToolError(`Touch ${args.touchId} not found`);

    // Deterministic variant generator (no model required) — 3 options per axis.
    const variants: string[] =
      args.axis === "subject"
        ? [touch.subject, `${touch.subject}?`, touch.subject.replace(/^\w/, (c) => c.toUpperCase())]
        : args.axis === "cta"
          ? ["Get the free first lesson", "Start learning now", "See what's inside"]
          : args.axis === "hook"
            ? ["Here's the short version:", "Quick question for you:", "Something worth knowing:"]
            : ["Warmer, more personal tone", "Direct, no-fluff tone", "Encouraging, coach-like tone"];

    // Note stored on the action for audit; nothing on the touch changes here —
    // "Accept" a variant is a separate regenerate/update call the creator makes.
    return {
      summary: `Generated ${variants.length} ${args.axis} variant(s) for "${touch.stageName ?? touch.subject}".`,
      data: { axis: args.axis, variants },
      target: { entity: "email_sequence", id: args.sequenceId },
    };
  },
});

const deleteEmailStep = defineMarketingTool({
  name: "delete_email_step",
  description: "Delete one step from a sequence. Only allowed before launch (the sequence hasn't sent it yet). Stages as reversible.",
  params: z.object({ sequenceId: z.string().min(1), touchId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "delete_email_step",
  existingTarget(args) {
    return { entity: "email_sequence", id: args.sequenceId };
  },
  async execute(args, ctx) {
    const { data: sent } = await ctx.supabase
      .from("scheduled_send")
      .select("id")
      .eq("touch_id", args.touchId)
      .eq("status", "sent")
      .limit(1);
    if (sent && sent.length > 0) throw new MarketingToolError("This step has already sent to at least one lead and can no longer be deleted.");
    const { error } = await ctx.supabase.from("email_touch").delete().eq("id", args.touchId).eq("sequence_id", args.sequenceId);
    if (error) throw new MarketingToolError(`delete_email_step: ${error.message}`);
    return { summary: "Deleted the email step.", target: { entity: "email_sequence", id: args.sequenceId } };
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
      ctaPath: await ctaPathFor(ctx, campaignId),
      triggerEvent: (args.triggerEvent as AnalyticsEventType | null) ?? undefined,
    });
    const { sequenceId, touchCount } = await insertSequence(ctx, campaignId, draft, course);
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
    "Author or replace one email touch in a sequence (subject, preview, body). Stages as reversible (snapshots the whole sequence). " +
    "Any button that should link to the course MUST use the exact merge token {{ctaUrl}} as its href (or {{freeLessonUrl}} for the landing/free-lesson offer) — never hand-write a course URL.",
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
      // §3 business rule: editing an APPROVED step returns it (and the
      // campaign) to review — future unsent steps re-require approval. This is
      // the ONLY write path for touch content, so the reset can't be bypassed.
      const { error } = await ctx.supabase
        .from("email_touch")
        .update({
          subject: args.subject,
          preview_text: args.previewText,
          body: bodyToJson(args.body),
          approval_status: "draft",
          ...(args.delaySeconds !== null ? { delay_seconds: args.delaySeconds } : {}),
          ...(args.triggerEvent !== null ? { trigger_event: args.triggerEvent } : {}),
        })
        .eq("id", args.touchId)
        .eq("sequence_id", args.sequenceId);
      if (error) throw new MarketingToolError(`write_email_touch: ${error.message}`);
      const campaign = await loadCampaign(ctx.supabase, seq.campaignId);
      if (campaign && (campaign.status === "approved" || campaign.status === "in_review")) {
        await ctx.supabase.from("marketing_campaign").update({ status: "in_review" }).eq("id", campaign.id);
      }
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

/** The campaign's delivery-timing sentence — appended to every executed summary
 *  that enqueues sends, so the agent (and the creator) never mistake
 *  "enrolled/queued" for "delivered". */
async function campaignTimingSentence(ctx: MarketingToolContext, campaignId: string): Promise<string> {
  const campaign = await loadCampaign(ctx.supabase, campaignId);
  const window = (campaign?.config.sendWindow as SendWindow | undefined) ?? DEFAULT_SEND_WINDOW;
  return sendTimingSentence(ctx.services.clock.epochMs(), window);
}

const activateSequence = defineMarketingTool({
  name: "activate_sequence",
  description:
    "Make a draft sequence LIVE. For a timed launch this enrolls current subscribers and begins scheduling sends. Irreversible — requires approval.",
  params: z.object({ sequenceId: z.string().min(1) }),
  reversibility: "irreversible",
  actionKind: "activate_sequence",
  segmentKey: () => "status:all",
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
        approvalPreview: {
          name: seq.name,
          kind: seq.kind,
          touches: seq.touches.length,
          audience: willEnroll.length,
          effectLabel:
            seq.kind === "time_launch"
              ? `activate & enroll ${willEnroll.length}`
              : "activate sequence",
          touchSubjects: seq.touches.slice(0, 3).map((t) => t.subject),
        },
      };
    }

    await ctx.supabase.from("email_sequence").update({ status: "active" }).eq("id", seq.id);
    let enrolled = 0;
    if (seq.kind === "time_launch") {
      ({ enrolled } = await enrollSegment(ctx.supabase, seq, willEnroll, { nowMs: ctx.services.clock.epochMs() }));
    }
    return {
      summary: `Activated "${seq.name}"${enrolled ? ` — enrolled ${enrolled} subscriber(s). ${await campaignTimingSentence(ctx, seq.campaignId)}` : "."}`,
      data: { enrolled },
      target: { entity: "email_sequence", id: seq.id },
    };
  },
});

/* ─────────────────── reversible: pause / resume ONE sequence ───────────────
 * The campaign-level pause_campaign/resume_campaign stop everything; these
 * stop ONE sequence (e.g. hold the behavioral followup while the launch
 * sequence keeps sending). The scheduler skips any sequence that isn't
 * `active`, so held sends stay `pending` — nothing is deleted. */

async function countPendingSequenceSends(ctx: MarketingToolContext, sequenceId: string): Promise<number> {
  const { count } = await ctx.supabase
    .from("scheduled_send")
    .select("id", { count: "exact", head: true })
    .eq("sequence_id", sequenceId)
    .eq("status", "pending");
  return count ?? 0;
}

const pauseSequence = defineMarketingTool({
  name: "pause_sequence",
  description:
    "Pause ONE active sequence — its queued sends are HELD (not deleted) until it's resumed. Reversible. Use pause_campaign to stop the whole campaign.",
  params: z.object({ sequenceId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "pause_sequence",
  existingTarget(args) {
    return { entity: "email_sequence", id: args.sequenceId };
  },
  async execute(args, ctx) {
    const seq = await loadEmailSequence(ctx.supabase, args.sequenceId);
    if (!seq) throw new MarketingToolError(`Sequence ${args.sequenceId} not found`);
    if (seq.status !== "active") {
      throw new MarketingToolError(`"${seq.name}" is ${seq.status} — only an active sequence can be paused.`);
    }
    await ctx.supabase.from("email_sequence").update({ status: "paused" }).eq("id", seq.id);
    const queued = await countPendingSequenceSends(ctx, seq.id);
    return {
      summary: `Paused "${seq.name}" — ${queued} queued send(s) are held until you resume. Nothing is lost.`,
      data: { heldSends: queued },
      target: { entity: "email_sequence", id: seq.id },
    };
  },
});

const resumeSequence = defineMarketingTool({
  name: "resume_sequence",
  description:
    "Resume ONE paused sequence — held sends continue on their schedule. Refused while its campaign is paused/cancelled (resume the campaign instead).",
  params: z.object({ sequenceId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "resume_sequence",
  existingTarget(args) {
    return { entity: "email_sequence", id: args.sequenceId };
  },
  async execute(args, ctx) {
    const seq = await loadEmailSequence(ctx.supabase, args.sequenceId);
    if (!seq) throw new MarketingToolError(`Sequence ${args.sequenceId} not found`);
    if (seq.status !== "paused") {
      throw new MarketingToolError(`"${seq.name}" is ${seq.status} — only a paused sequence can be resumed.`);
    }
    // A sequence must not quietly out-run its own campaign's pause/cancel —
    // the scheduler keys off SEQUENCE status, so this guard is the only thing
    // preventing "campaign says paused but emails go out".
    const campaign = await loadCampaign(ctx.supabase, seq.campaignId);
    if (campaign && (campaign.status === "paused" || campaign.status === "cancelled")) {
      throw new MarketingToolError(
        `The campaign "${campaign.name}" is ${campaign.status} — ${
          campaign.status === "paused" ? "resume the campaign instead (resume_campaign)" : "a cancelled campaign cannot send again"
        }.`
      );
    }
    await ctx.supabase.from("email_sequence").update({ status: "active" }).eq("id", seq.id);
    const queued = await countPendingSequenceSends(ctx, seq.id);
    return {
      summary: `Resumed "${seq.name}" — ${queued} held send(s) continue on their schedule.`,
      data: { resumedSends: queued },
      target: { entity: "email_sequence", id: seq.id },
    };
  },
});

const enrollSegmentInSequence = defineMarketingTool({
  name: "enroll_segment_in_sequence",
  description:
    "Bulk-enroll a subscriber segment into an ACTIVE sequence (triggers real sends). Irreversible — requires approval. status: null = unspecified (the creator may be asked to choose); pass \"all\" to explicitly target everyone.",
  params: z.object({
    sequenceId: z.string().min(1),
    status: z.enum([...SUBSCRIBER_STATUSES, "all"]).nullable(),
  }),
  reversibility: "irreversible",
  actionKind: "enroll_segment_in_sequence",
  segmentKey: (args) => `status:${args.status ?? "all"}`,
  async clarifyTargeting(args, ctx) {
    if (args.status != null) return null;
    const seq = await loadEmailSequence(ctx.supabase, args.sequenceId);
    if (!seq) return null; // the preview path reports the real error
    const counts = await statusCounts(ctx, seq.campaignId);
    return segmentQuestion(`Which segment should be enrolled into "${seq.name}"?`, counts);
  },
  async execute(args, ctx) {
    const seq = await loadEmailSequence(ctx.supabase, args.sequenceId);
    if (!seq) throw new MarketingToolError(`Sequence ${args.sequenceId} not found`);
    const ids = await segmentIds(ctx, seq.campaignId, audienceFilter(args.status));

    if (!ctx.approved) {
      return {
        summary: `Enroll ${ids.length} subscriber(s) into "${seq.name}" — sends will go out.`,
        target: { entity: "email_sequence", id: seq.id },
        approvalPreview: {
          name: seq.name,
          audience: ids.length,
          segment: args.status ?? "all",
          effectLabel: `enroll ${ids.length} ${ids.length === 1 ? "person" : "people"}`,
        },
      };
    }
    if (seq.status !== "active") throw new MarketingToolError("Activate the sequence before enrolling a segment.");
    const { enrolled } = await enrollSegment(ctx.supabase, seq, ids, { nowMs: ctx.services.clock.epochMs() });
    return {
      summary: `Enrolled ${enrolled} subscriber(s) into "${seq.name}". ${await campaignTimingSentence(ctx, seq.campaignId)}`,
      data: { enrolled },
      target: { entity: "email_sequence", id: seq.id },
    };
  },
});

const sendBroadcastTool = defineMarketingTool({
  name: "send_broadcast",
  description:
    "Send a one-off email to a subscriber segment. Irreversible — requires approval. status: null = unspecified (the creator may be asked to choose); pass \"all\" to explicitly target everyone. " +
    "Any button that should link to the course MUST use the exact merge token {{ctaUrl}} as its href (or {{freeLessonUrl}} for the landing/free-lesson offer) — you do NOT know the app's real URL structure, so NEVER hand-write a path from the course id or title (there is no /courses/{id} route or similar; that link 404s for every recipient). These tokens resolve automatically to the correct, live destination at send time.",
  params: z.object({
    subject: z.string().min(1).max(120),
    body: EmailBodySchema,
    status: z.enum([...SUBSCRIBER_STATUSES, "all"]).nullable(),
  }),
  reversibility: "irreversible",
  actionKind: "send_broadcast",
  segmentKey: (args) => `status:${args.status ?? "all"}`,
  editableParams: ["subject", "status"],
  async clarifyTargeting(args, ctx) {
    if (args.status != null) return null;
    let campaignId: string;
    try {
      campaignId = await requireCampaignId(ctx);
    } catch {
      return null; // the preview path reports the real error
    }
    const counts = await statusCounts(ctx, campaignId);
    return segmentQuestion(`Which segment should "${args.subject}" go to?`, counts);
  },
  async execute(args, ctx) {
    const campaignId = await requireCampaignId(ctx);
    const ids = await segmentIds(ctx, campaignId, audienceFilter(args.status));
    if (!ctx.approved) {
      return {
        summary: `Send "${args.subject}" to ${ids.length} subscriber(s).`,
        approvalPreview: {
          subject: args.subject,
          audience: ids.length,
          segment: args.status ?? "all",
          effectLabel: `send to ${ids.length} ${ids.length === 1 ? "person" : "people"}`,
          bodyPreview: bodyPreviewText(args.body),
        },
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
    "Send a single test email to the creator's own address — rendered through the SAME pipeline a real send uses (merge vars, click-tracked links, the compliant footer), so what you see is what a subscriber would get. Irreversible (a real send) — requires approval. " +
    "Any button that should link to the course MUST use the exact merge token {{ctaUrl}} as its href (or {{freeLessonUrl}} for the landing/free-lesson offer) — never hand-write a course URL.",
  params: z.object({
    to: z.string().min(1).max(254),
    subject: z.string().min(1).max(120),
    body: EmailBodySchema,
  }),
  reversibility: "irreversible",
  actionKind: "send_test_email",
  editableParams: ["to", "subject"],
  async execute(args, ctx) {
    if (!ctx.approved) {
      return {
        summary: `Send a test email to ${args.to}.`,
        approvalPreview: {
          to: args.to,
          subject: args.subject,
          effectLabel: `send test to ${args.to}`,
          bodyPreview: bodyPreviewText(args.body),
        },
      };
    }
    const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
    const campaign = ctx.campaignId ? await loadCampaign(ctx.supabase, ctx.campaignId) : null;
    const sender = campaign?.senderIdentityId ? await loadSenderIdentity(ctx.supabase, campaign.senderIdentityId) : null;
    // Not tied to a real subscriber — a validly-signed but non-existent id, so
    // the unsubscribe link is genuinely clickable (proves the mechanism) and
    // degrades gracefully ("already unsubscribed") rather than a dead "#".
    const testSubscriberId = `test-${crypto.randomUUID()}`;
    const dest = await resolveCtaDestinations(ctx.supabase, { courseId: ctx.courseId, campaignId: ctx.campaignId });
    const { subject, body, text } = renderSendableEmail({
      subject: args.subject,
      body: args.body,
      vars: {
        firstName: null, // no real recipient name for a self-test — renders the "there" fallback
        courseName: course?.title ?? null,
        creatorName: sender?.fromName ?? null,
        freeLessonUrl: dest.freeLessonUrl,
        ctaUrl: dest.ctaUrl,
        offerDeadline: (campaign?.config.brief?.offerDeadlineIso as string | undefined) ?? null,
      },
      dims: { subscriberId: testSubscriberId, campaignId: ctx.campaignId ?? undefined, courseId: ctx.courseId },
      unsubscribeUrl: unsubscribeUrl(testSubscriberId),
      locale: course ? resolveCopyLocale(course, campaign?.config.brief) : "en",
      senderName: sender?.fromName ?? null,
      mailingAddress: sender?.mailingAddress ?? null,
    });
    const res = await ctx.services.email.send({
      to: args.to,
      subject: `[TEST] ${subject}`,
      body,
      text,
      unsubscribeUrl: unsubscribeUrl(testSubscriberId),
      fromName: sender?.fromName ?? null,
      replyTo: sender?.replyTo ?? sender?.fromEmail ?? null,
      meta: { test: true },
    });
    return { summary: `Test email sent to ${args.to}.`, data: { providerMessageId: res.providerMessageId } };
  },
});

export const emailTools = [
  generateEmailSequence,
  regenerateEmailStep,
  generateEmailVariants,
  deleteEmailStep,
  generateFollowupTool,
  writeEmailTouch,
  pauseSequence,
  resumeSequence,
  activateSequence,
  enrollSegmentInSequence,
  sendBroadcastTool,
  sendTestEmail,
];
