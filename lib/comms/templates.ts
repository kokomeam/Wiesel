/**
 * The three learner-message templates (Milestone 6). PURE builders returning
 * {subject, body: EmailBody}. Tone: warm, short, from the creator — a person
 * checking in, never a system notification. The Comms subagent personalizes
 * from these skeletons (and the service falls back to them verbatim when the
 * model is unavailable); the Stuck-queue "Draft follow-up" button prefills
 * them deterministically with no model call.
 */

import type { EmailBody } from "./types";

export type CommsTemplateId = "stalled_nudge" | "almost_done" | "struggling_topic";

export interface TemplateContext {
  learnerName: string;
  creatorName: string;
  courseTitle: string;
  /** Landing page of the course (continue link). */
  courseUrl: string;
  /** For struggling_topic: the exact lesson to return to. */
  lessonTitle?: string;
  lessonUrl?: string;
}

export interface TemplateDraft {
  template: CommsTemplateId;
  subject: string;
  body: EmailBody;
}

export function stalledNudge(ctx: TemplateContext): TemplateDraft {
  return {
    template: "stalled_nudge",
    subject: `Still thinking about ${ctx.courseTitle}?`,
    body: [
      { kind: "paragraph", text: `Hi ${ctx.learnerName},` },
      {
        kind: "paragraph",
        text: `I noticed you haven't been back to ${ctx.courseTitle} in a little while — no pressure at all, life gets busy. Your progress is saved exactly where you left it.`,
      },
      {
        kind: "paragraph",
        text: "If you've got twenty minutes this week, the next lesson is a good one to pick back up with.",
      },
      { kind: "button", label: "Pick up where you left off", href: ctx.courseUrl },
      { kind: "paragraph", text: `— ${ctx.creatorName}` },
    ],
  };
}

export function almostDone(ctx: TemplateContext): TemplateDraft {
  return {
    template: "almost_done",
    subject: `You're so close to finishing ${ctx.courseTitle}`,
    body: [
      { kind: "paragraph", text: `Hi ${ctx.learnerName},` },
      {
        kind: "paragraph",
        text: `You've worked through most of ${ctx.courseTitle} — genuinely well done. There's just a little left, and the last stretch ties everything together.`,
      },
      { kind: "button", label: "Finish the course", href: ctx.courseUrl },
      { kind: "paragraph", text: `— ${ctx.creatorName}` },
    ],
  };
}

export function strugglingOnTopic(ctx: TemplateContext): TemplateDraft {
  const lesson = ctx.lessonTitle ?? "that lesson";
  return {
    template: "struggling_topic",
    subject: `A hand with ${lesson}?`,
    body: [
      { kind: "paragraph", text: `Hi ${ctx.learnerName},` },
      {
        kind: "paragraph",
        text: `I saw the quiz in “${lesson}” has been putting up a fight — that section trips a lot of people up, and it usually clicks on a second pass.`,
      },
      {
        kind: "paragraph",
        text: "If anything in there reads ambiguously to you, reply and tell me — it helps me make the course better.",
      },
      ...(ctx.lessonUrl
        ? ([{ kind: "button", label: `Revisit “${lesson}”`, href: ctx.lessonUrl }] as EmailBody)
        : []),
      { kind: "paragraph", text: `— ${ctx.creatorName}` },
    ],
  };
}

export function buildTemplate(id: CommsTemplateId, ctx: TemplateContext): TemplateDraft {
  switch (id) {
    case "stalled_nudge":
      return stalledNudge(ctx);
    case "almost_done":
      return almostDone(ctx);
    case "struggling_topic":
      return strugglingOnTopic(ctx);
  }
}
