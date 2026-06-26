/**
 * Deterministic email-sequence generators — the mock-first content engine for
 * launch sequences + behavioral followups, grounded in the course. Phase 4's
 * agent can author richer copy via the same `write_email_touch` tool; this is
 * the no-key baseline + the deterministic fixture for tests.
 *
 * Time offsets are seconds from enrollment. Every touch's body is a valid
 * `EmailBody` (length-capped via the schema at the tool boundary).
 */

import type { AnalyticsEventType, CourseMarketingContext, EmailBody, SequenceKind } from "../types";

const DAY = 86400;

export interface TouchDraft {
  position: number;
  delaySeconds: number | null;
  triggerEvent: AnalyticsEventType | null;
  subject: string;
  previewText: string | null;
  body: EmailBody;
}

export interface SequenceDraft {
  name: string;
  kind: SequenceKind;
  trigger: { event?: AnalyticsEventType };
  touches: TouchDraft[];
}

function cta(landingPath: string | null, label: string) {
  return { kind: "button" as const, label, href: landingPath ?? "#" };
}

/** A timed 4-touch launch sequence: welcome → value → proof → close. */
export function generateLaunchSequence(
  course: CourseMarketingContext,
  opts: { landingPath?: string | null } = {}
): SequenceDraft {
  const path = opts.landingPath ?? null;
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

/** An event-triggered followup: fires when a behavioral event lands (default:
 *  a page view that didn't convert). */
export function generateFollowup(
  course: CourseMarketingContext,
  opts: { landingPath?: string | null; triggerEvent?: AnalyticsEventType } = {}
): SequenceDraft {
  const path = opts.landingPath ?? null;
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
