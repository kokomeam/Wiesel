/**
 * Social Post Generator — single-source constants (PRD §9.3/§9.4/§8).
 *
 * PLATFORM_LIMITS is imported by BOTH sides (prompt + Zod maxLengths on the
 * server, char/hashtag counters in the UI) — never copied. The goal→stage map
 * and the balanced funnel mix live here so batch planning, the queue chips,
 * and the tests all read one table.
 *
 * The Platform enum is deliberately closed at 2 (LinkedIn, Facebook) for MVP —
 * Instagram is image-first and WiseSel has no image/video generation yet; it
 * returns when visuals ship (Phase 1.5+). To add a platform: extend PLATFORMS
 * + PLATFORM_LIMITS here, extend the DB check constraint in a migration, and
 * the schemas/prompt/counters pick it up (docs/social-posts.md has the guide).
 */

import type { ReasoningEffort } from "@/lib/ai/modelClient";

export const PLATFORMS = ["linkedin", "facebook"] as const;
export type SocialPlatform = (typeof PLATFORMS)[number];

export const SOCIAL_GOALS = [
  "launch",
  "value",
  "benefit",
  "problem_solution",
  "pain_point",
  "promo_cta",
] as const;
export type SocialGoal = (typeof SOCIAL_GOALS)[number];

export const FUNNEL_STAGES = ["tofu", "mofu", "bofu"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const SOCIAL_TONES = [
  "professional",
  "friendly",
  "founder_led",
  "educational",
  "casual",
] as const;
export type SocialTone = (typeof SOCIAL_TONES)[number];

export const POST_STATUSES = ["draft", "ready", "planned", "posted_manual", "archived"] as const;
export type SocialPostStatus = (typeof POST_STATUSES)[number];

export const TIMING_PRESETS = ["none", "same_day", "spread_week", "spread_2_weeks", "custom"] as const;
export type TimingPreset = (typeof TIMING_PRESETS)[number];

export interface PlatformLimits {
  /** Human label for UI. */
  label: string;
  /** Hard character cap — enforced in Zod AND shown by the editor counter. */
  charCap: number;
  /** Soft target length in words — the editor soft-warns outside it. */
  targetWords: readonly [number, number];
  hashtagMin: number;
  hashtagMax: number;
  /** Register + structure lines fed verbatim into the prompt's style guide. */
  register: string;
  structure: string;
  emojiPolicy: string;
  /** Recommended image dimensions — SOFT warning on upload, never a block. */
  imageNorm: { width: number; height: number };
}

export const PLATFORM_LIMITS: Record<SocialPlatform, PlatformLimits> = {
  linkedin: {
    label: "LinkedIn",
    charCap: 3000,
    targetWords: [120, 300],
    hashtagMin: 0,
    hashtagMax: 5,
    register: "professional, educational, founder/authority-friendly",
    structure:
      "hook line, then short whitespace-separated paragraphs, then an optional CTA, hashtags at the end",
    emojiPolicy: "sparse (0-2 total)",
    imageNorm: { width: 1200, height: 627 },
  },
  facebook: {
    label: "Facebook",
    charCap: 5000, // practical cap, not the platform max
    targetWords: [40, 120],
    hashtagMin: 0,
    hashtagMax: 3,
    register: "community/conversational, page-comfortable",
    structure: "opener (often a question), 1-2 short paragraphs, then the CTA",
    emojiPolicy: "sparse-moderate",
    imageNorm: { width: 1200, height: 630 },
  },
};

/** Goal → default funnel stage (PRD §9.4). Creator-overridable per post. */
export const GOAL_STAGE_MAP: Record<SocialGoal, FunnelStage> = {
  value: "tofu",
  problem_solution: "tofu",
  pain_point: "mofu",
  benefit: "bofu",
  launch: "bofu",
  promo_cta: "bofu",
};

export const GOAL_LABELS: Record<SocialGoal, string> = {
  launch: "Course launch announcement",
  value: "Educational / value",
  benefit: "Course benefit",
  problem_solution: "Problem / solution",
  pain_point: "Student pain point",
  promo_cta: "Promotional CTA",
};

/** One slot of a batch plan: what each post should be. */
export interface BatchPlanSlot {
  goal: SocialGoal;
  funnelStage: FunnelStage;
}

/**
 * Balanced-mix stage distribution (PRD §8), ordered VALUE-FIRST (tofu
 * earliest, bofu last — value before ask):
 *   5 → 3/1/1 · 4 → 2/1/1 · 3 → 2/0/1 (mofu drops first) · 2 → 1/0/1 ·
 *   1 → whatever the selected goal maps to.
 * Balanced mode auto-assigns per-slot goals to match the stage; the creator's
 * selected goal claims the bofu slot when it IS a bofu goal.
 */
export function buildBatchPlan(
  count: number,
  funnelMix: "balanced" | "pinned",
  selectedGoal: SocialGoal
): BatchPlanSlot[] {
  const n = Math.max(1, Math.min(5, Math.floor(count)));
  if (funnelMix === "pinned" || n === 1) {
    return Array.from({ length: n }, () => ({
      goal: selectedGoal,
      funnelStage: GOAL_STAGE_MAP[selectedGoal],
    }));
  }
  const stagesByCount: Record<number, FunnelStage[]> = {
    2: ["tofu", "bofu"],
    3: ["tofu", "tofu", "bofu"],
    4: ["tofu", "tofu", "mofu", "bofu"],
    5: ["tofu", "tofu", "tofu", "mofu", "bofu"],
  };
  const stages = stagesByCount[n];
  const tofuGoals: SocialGoal[] = ["value", "problem_solution"];
  let tofuIndex = 0;
  return stages.map((stage) => {
    if (stage === "tofu") {
      const goal = tofuGoals[tofuIndex % tofuGoals.length];
      tofuIndex += 1;
      return { goal, funnelStage: "tofu" as const };
    }
    if (stage === "mofu") return { goal: "pain_point" as const, funnelStage: "mofu" as const };
    // The bofu slot honors the creator's selected goal when it's a bofu goal;
    // otherwise it defaults to the plain benefit ask.
    const goal = GOAL_STAGE_MAP[selectedGoal] === "bofu" ? selectedGoal : "benefit";
    return { goal, funnelStage: "bofu" as const };
  });
}

/**
 * THE manual-publish sentence (PRD §3 language rules + §17.3). One string, one
 * component (ManualPublishNotice) — so the language stays enforceable in one
 * place. verify-social.ts greps the feature UI for banned phrases.
 */
export const MANUAL_PUBLISH_NOTICE =
  "You post this yourself — WiseSel never publishes to social platforms.";

/** Phrases that must NEVER appear in feature UI strings (PRD §3). Lowercase. */
export const BANNED_UI_PHRASES = [
  "auto-schedule",
  "auto-post",
  "publish automatically",
  "connect account",
  "bot posting",
] as const;

/* ─────────────────────────── runtime config ─────────────────────────── */

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export interface SocialConfig {
  maxBatchesPerDay: number;
  maxRevisionsPerDay: number;
  /** Hard per-batch generation ceiling — quality-first, NOT a latency target.
   *  On timeout: typed error, nothing persisted, parameters kept for retry. */
  generationTimeoutMs: number;
  contextMaxTokens: number;
  /** Mid-tier batch generation (undefined → the provider's env default). */
  generateModel: string | undefined;
  generateEffort: ReasoningEffort;
  /** Small/fast tier for revisions, hashtags, alt text, voice derivation. */
  reviseModel: string | undefined;
  reviseEffort: ReasoningEffort;
}

export function socialConfig(): SocialConfig {
  return {
    maxBatchesPerDay: envInt("SOCIAL_MAX_BATCHES_PER_DAY", 20),
    maxRevisionsPerDay: envInt("SOCIAL_MAX_REVISIONS_PER_DAY", 100),
    generationTimeoutMs: envInt("SOCIAL_GENERATION_TIMEOUT_MS", 180_000),
    contextMaxTokens: envInt("SOCIAL_CONTEXT_MAX_TOKENS", 6_000),
    generateModel: process.env.SOCIAL_GENERATE_MODEL || undefined,
    generateEffort: (process.env.SOCIAL_GENERATE_EFFORT as ReasoningEffort) || "medium",
    reviseModel: process.env.SOCIAL_REVISE_MODEL || undefined,
    reviseEffort: (process.env.SOCIAL_REVISE_EFFORT as ReasoningEffort) || "low",
  };
}

/** Image upload constraints (PRD §15). */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const SOCIAL_IMAGES_BUCKET = "social-post-images";
/** Signed display URLs are short-lived and regenerated on view. */
export const IMAGE_SIGNED_URL_TTL_SECONDS = 60 * 60;
