/**
 * Deterministic template fallback — the mock-first contract (same role as
 * email/generators.ts): with no model configured the WHOLE engine still works
 * end-to-end, grounded in real course facts. Also the fixture path for the
 * no-key test suites. ai_metadata.model records "template-fallback" so the
 * queue can be honest about provenance.
 */

import type { BatchPlanSlot, SocialGoal, SocialPlatform, SocialTone } from "./constants";
import { PLATFORM_LIMITS } from "./constants";
import type { ModelPost } from "./schemas";

export interface TemplateContext {
  courseTitle: string | null;
  description: string | null;
  audience: string | null;
  outcomes: string[];
  moduleTitles: string[];
  /** Manual topic when sourceType='manual'. */
  topic: string | null;
}

function subject(ctx: TemplateContext): string {
  return ctx.courseTitle ?? ctx.topic ?? "this topic";
}

function hashtagFrom(text: string): string | null {
  const cleaned = text
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter((w) => w.length > 2)
    .slice(0, 3)
    .join("");
  return cleaned.length > 2 ? `#${cleaned.slice(0, 30)}` : null;
}

function hashtags(ctx: TemplateContext, platform: SocialPlatform): string[] {
  const max = PLATFORM_LIMITS[platform].hashtagMax;
  const candidates = [
    hashtagFrom(subject(ctx)),
    ctx.moduleTitles[0] ? hashtagFrom(ctx.moduleTitles[0]) : null,
    "#learning",
  ].filter((h): h is string => h !== null);
  return [...new Set(candidates)].slice(0, max);
}

function firstOutcome(ctx: TemplateContext): string | null {
  return ctx.outcomes[0] ?? null;
}

function trimForPlatform(body: string, platform: SocialPlatform): string {
  const cap = PLATFORM_LIMITS[platform].charCap;
  return body.length > cap ? `${body.slice(0, cap - 1)}…` : body;
}

function bodyFor(goal: SocialGoal, ctx: TemplateContext, platform: SocialPlatform): { body: string; cta: string | null } {
  const s = subject(ctx);
  const mod = ctx.moduleTitles[0] ?? null;
  const outcome = firstOutcome(ctx);
  const audience = ctx.audience ?? "learners";
  const short = platform === "facebook";

  switch (goal) {
    case "value": {
      const lead = mod
        ? `One idea from ${s} that changes how ${audience} practice: ${mod}.`
        : `One idea from ${s} worth sitting with today.`;
      const middle = ctx.description
        ? `${ctx.description.split(/(?<=[.!?])\s+/)[0]}`
        : `The best progress comes from small, deliberate reps — not marathon sessions.`;
      const extra = outcome && !short ? `\n\nBy the end, the goal is simple: ${outcome.toLowerCase()}.` : "";
      return { body: `${lead}\n\n${middle}${extra}`, cta: "Follow along — more of this every week." };
    }
    case "problem_solution": {
      const lead = `Most ${audience} get stuck at the same place with ${s}.`;
      const fix = mod
        ? `The fix usually isn't more effort — it's the approach covered in ${mod}: change the order you practice in, and the plateau moves.`
        : `The fix usually isn't more effort — it's changing the order you practice in.`;
      return { body: `${lead}\n\n${fix}`, cta: null };
    }
    case "pain_point": {
      const lead = `"I've tried learning this before and it didn't stick."`;
      const middle = `If that's you, you're not missing talent — you're missing structure. ${s} was built around exactly that gap${mod ? ` (it's why ${mod} comes first)` : ""}.`;
      return { body: `${lead}\n\n${middle}`, cta: short ? null : "If this sounds familiar, the first lesson is a good place to start." };
    }
    case "benefit": {
      const lead = outcome
        ? `What you actually get from ${s}: ${outcome.toLowerCase()}.`
        : `What you actually get from ${s}: a skill you can use the same week.`;
      const middle = ctx.moduleTitles.length
        ? `The path runs through ${Math.min(ctx.moduleTitles.length, 8)} modules — starting with ${ctx.moduleTitles[0]}.`
        : `Step by step, in plain language, with practice built in.`;
      return { body: `${lead}\n\n${middle}`, cta: "Take a look at the full curriculum." };
    }
    case "launch": {
      const lead = `${s} is open.`;
      const middle = ctx.moduleTitles.length
        ? `${ctx.moduleTitles.length} modules, built for ${audience} — beginning with ${ctx.moduleTitles[0]}.`
        : `Built for ${audience}, from first principles to real practice.`;
      const extra = ctx.description && !short ? `\n\n${ctx.description.split(/(?<=[.!?])\s+/)[0]}` : "";
      return { body: `${lead}\n\n${middle}${extra}`, cta: "Enrollment is open — the link is in my profile." };
    }
    case "promo_cta": {
      const lead = `If ${s} has been on your list, this is the nudge.`;
      const middle = outcome
        ? `The whole course points at one thing: ${outcome.toLowerCase()}.`
        : `Everything is structured so you always know the next step.`;
      return { body: `${lead}\n\n${middle}`, cta: "Join today — start with lesson one." };
    }
  }
}

function imageIdea(goal: SocialGoal, ctx: TemplateContext): string {
  const mod = ctx.moduleTitles[0];
  if (goal === "launch" || goal === "promo_cta")
    return `Photo of your workspace with the course outline visible on screen`;
  return mod
    ? `Photo of your own materials mid-practice for ${mod}`
    : `Photo of your desk mid-work session, notes visible`;
}

/** Build the whole batch deterministically — one post per plan slot. */
export function buildTemplatePosts(
  slots: BatchPlanSlot[],
  platform: SocialPlatform,
  tone: SocialTone,
  ctx: TemplateContext
): ModelPost[] {
  return slots.map((slot) => {
    const { body, cta } = bodyFor(slot.goal, ctx, platform);
    return {
      goal: slot.goal,
      funnelStage: slot.funnelStage,
      tone,
      body: trimForPlatform(body, platform),
      cta: slot.funnelStage === "tofu" && cta?.startsWith("Join") ? null : cta,
      hashtags: hashtags(ctx, platform),
      suggestedImageIdea: imageIdea(slot.goal, ctx),
    };
  });
}

/** Deterministic hashtag suggestions (the no-model path for suggest_hashtags). */
export function suggestHashtagsDeterministic(text: string, platform: SocialPlatform): string[] {
  const max = PLATFORM_LIMITS[platform].hashtagMax;
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter((w) => w.length >= 4);
  const uniq = [...new Set(words.map((w) => w.toLowerCase()))].slice(0, Math.max(1, max));
  return uniq.map((w) => `#${w.slice(0, 30)}`);
}
