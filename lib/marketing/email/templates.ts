/**
 * Deterministic email-sequence generators — the mock-first content engine for
 * launch sequences + behavioral followups, grounded in the course. Phase 4's
 * agent can author richer copy via the same `write_email_touch` tool; this is
 * the no-key baseline + the deterministic fixture for tests.
 *
 * Time offsets are seconds from enrollment. Every touch's body is a valid
 * `EmailBody` (length-capped via the schema at the tool boundary).
 */

import type { BlueprintStage, CopyFramework } from "../blueprints";
import type { AnalyticsEventType, CampaignBrief, CourseMarketingContext, EmailBody, SequenceKind } from "../types";

const DAY = 86400;

export interface TouchDraft {
  position: number;
  delaySeconds: number | null;
  triggerEvent: AnalyticsEventType | null;
  subject: string;
  previewText: string | null;
  body: EmailBody;
  stageName?: string;
  purpose?: string;
  aiRationale?: string;
  personalizationVariables?: string[];
}

export interface SequenceDraft {
  name: string;
  kind: SequenceKind;
  trigger: { event?: AnalyticsEventType };
  touches: TouchDraft[];
}

function cta(ctaPath: string | null, label: string) {
  return { kind: "button" as const, label, href: ctaPath ?? "#" };
}

/** A timed 4-touch launch sequence: welcome → value → proof → close. */
export function generateLaunchSequence(
  course: CourseMarketingContext,
  opts: { ctaPath?: string | null } = {}
): SequenceDraft {
  const path = opts.ctaPath ?? null;
  const firstOutcome = course.outcomes[0] ?? `the core ideas behind ${course.title}`;
  return {
    name: "Launch sequence",
    kind: "time_launch",
    trigger: {},
    touches: [
      {
        position: 0,
        delaySeconds: 0,
        triggerEvent: null,
        subject: `Welcome — your free first lesson`,
        previewText: `Here's the lesson you came for, plus what the full course covers.`,
        body: {
          blocks: [
            { kind: "heading", text: `Welcome to ${course.title}` },
            { kind: "paragraph", text: `Thanks for signing up! Your first lesson is ready, and it'll get you to: ${firstOutcome}.` },
            cta(path, "Open your first lesson"),
          ],
        },
      },
      {
        position: 1,
        delaySeconds: 2 * DAY,
        triggerEvent: null,
        subject: `The #1 mistake beginners make`,
        previewText: `And how this course helps you avoid it.`,
        body: {
          blocks: [
            { kind: "paragraph", text: `Most people stall on the same hurdle when learning ${course.title}. The good news: it's avoidable with the right approach.` },
            { kind: "paragraph", text: `That's exactly what the course is built around — practical steps, not theory.` },
            cta(path, "See how it works"),
          ],
        },
      },
      {
        position: 2,
        delaySeconds: 4 * DAY,
        triggerEvent: null,
        subject: `What you'll be able to do in a few weeks`,
        previewText: `The outcomes, at a glance.`,
        body: {
          blocks: [
            { kind: "heading", text: `By the end, you'll be able to:` },
            {
              kind: "bullets",
              items: (course.outcomes.length ? course.outcomes : [firstOutcome]).slice(0, 5),
            },
            cta(path, "Start learning"),
          ],
        },
      },
      {
        position: 3,
        delaySeconds: 6 * DAY,
        triggerEvent: null,
        subject: `Ready when you are`,
        previewText: `A quick nudge before you go.`,
        body: {
          blocks: [
            { kind: "paragraph", text: `If you've been meaning to dive into ${course.title}, this is your sign. Everything you need is inside.` },
            cta(path, "Enroll now"),
          ],
        },
      },
    ],
  };
}

const FRAMEWORK_OPENERS: Record<CopyFramework, (course: CourseMarketingContext, brief: CampaignBrief | undefined) => string> = {
  PAS: (course) =>
    `Most people trying to learn ${course.title} stall on the same hurdle. It costs them time and confidence — and it's completely avoidable with the right approach.`,
  claim_mechanism_proof: (course) =>
    `By the end of ${course.title}, you'll be able to ${course.outcomes[0] ?? "apply what you learn with confidence"}. Here's exactly how the course gets you there.`,
  objection_reframe_evidence: (course) =>
    `"Is this really for me?" is the question most people ask before starting ${course.title}. Here's the honest answer.`,
  offer_transformation_deadline: (course, brief) =>
    brief?.offerDeadlineIso
      ? `${course.title} — here's what's included, and why now is the moment to start.`
      : `If you've been meaning to start ${course.title}, this is your sign.`,
};

/** Blueprint-driven deterministic generator (Amendment 1's default engine when
 *  no model is configured). One touch per stage, grounded in the course +
 *  brief; the LLM path (email/llmGenerate.ts) produces richer copy against the
 *  SAME rubric when a model is available. */
export function generateBlueprintSequence(
  course: CourseMarketingContext,
  stages: BlueprintStage[],
  opts: { ctaPath?: string | null; brief?: CampaignBrief } = {}
): SequenceDraft {
  const path = opts.ctaPath ?? null;
  return {
    name: "Launch sequence",
    kind: "time_launch",
    trigger: {},
    touches: stages.map((stage, i) => ({
      position: i,
      delaySeconds: stage.dayOffset * DAY,
      triggerEvent: null,
      subject: `${stage.name} — ${course.title}`,
      previewText: FRAMEWORK_OPENERS[stage.framework](course, opts.brief).slice(0, 90),
      body: {
        blocks: [
          { kind: "paragraph", text: FRAMEWORK_OPENERS[stage.framework](course, opts.brief) },
          {
            kind: "bullets",
            items: (course.outcomes.length ? course.outcomes : [`the core ideas behind ${course.title}`]).slice(0, 3),
          },
          cta(path, stage.framework === "offer_transformation_deadline" ? "Enroll now" : "Learn more"),
        ],
      },
      stageName: stage.name,
      purpose: stage.framework,
      personalizationVariables: [],
    })),
  };
}

/** An event-triggered followup: fires when a behavioral event lands (default:
 *  a page view that didn't convert). */
export function generateFollowup(
  course: CourseMarketingContext,
  opts: { ctaPath?: string | null; triggerEvent?: AnalyticsEventType } = {}
): SequenceDraft {
  const path = opts.ctaPath ?? null;
  const triggerEvent = opts.triggerEvent ?? "page_view";
  return {
    name: "Behavioral followup",
    kind: "event_triggered",
    trigger: { event: triggerEvent },
    touches: [
      {
        position: 0,
        delaySeconds: 2 * 3600, // 2h after the trigger
        triggerEvent,
        subject: `Still thinking it over?`,
        previewText: `Answers to the questions people ask before starting.`,
        body: {
          blocks: [
            { kind: "paragraph", text: `Saw you checking out ${course.title} — totally normal to have questions before starting.` },
            { kind: "paragraph", text: `Here's the short version: it's beginner-friendly, self-paced, and built around real outcomes.` },
            cta(path, "Take another look"),
          ],
        },
      },
      {
        position: 1,
        delaySeconds: 2 * DAY,
        triggerEvent,
        subject: `One link, one free lesson`,
        previewText: `In case the timing's better now.`,
        body: {
          blocks: [
            { kind: "paragraph", text: `No pressure — but the free first lesson is right here whenever you're ready.` },
            cta(path, "Get the free lesson"),
          ],
        },
      },
    ],
  };
}
