/**
 * Per-phase model + effort configuration — the ONE place the agent decides which
 * model and reasoning effort each phase uses, and whether CRITIQUE runs.
 *
 * Defaults are CHEAP on purpose: every phase is `gpt-5.4-mini` so testing /
 * free-tier generation never silently spends on a premium model. CRITIQUE is OFF
 * by default. Each value is env-overridable so a deployment can dial a phase up
 * without a code change, and `GenerationQualityMode` is the forward hook for
 * mapping product tiers to stronger models later (today every tier resolves to
 * the same mini config — the premium path is intentionally not wired to a bigger
 * model yet).
 *
 * Do NOT hardcode a premium model as a default anywhere else — read it from here.
 */

import type { ReasoningEffort } from "./modelClient";

/** A model + reasoning effort for one phase. */
export interface PhaseModel {
  model: string;
  effort: ReasoningEffort;
}

/** CRITIQUE additionally carries an on/off gate. */
export interface CritiquePhaseModel extends PhaseModel {
  enabled: boolean;
}

/** The cheap default every phase falls back to (no premium model by default). */
const DEFAULT_MODEL = "gpt-5.4-mini";

function effort(envVar: string, fallback: ReasoningEffort): ReasoningEffort {
  const v = process.env[envVar];
  return v === "minimal" || v === "low" || v === "medium" || v === "high" ? v : fallback;
}

/** Parse a boolean env flag (`"true"`/`"false"`), falling back when unset/garbage. */
function bool(envVar: string, fallback: boolean): boolean {
  const v = process.env[envVar];
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

/** Parse a positive-integer env value, falling back when unset/non-positive. */
function int(envVar: string, fallback: number): number {
  const n = Number(process.env[envVar]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Phase configs. Read these instead of literal model strings. Env overrides:
 *   AI_PLAN_MODEL / AI_PLAN_EFFORT
 *   AI_GENERATE_MODEL / AI_GENERATE_EFFORT
 *   AI_EDIT_MODEL / AI_EDIT_EFFORT
 *   AI_CRITIQUE_ENABLED / AI_CRITIQUE_MODEL / AI_CRITIQUE_EFFORT
 *   AI_CLASSIFIER_MODEL / AI_CLASSIFIER_EFFORT (intent routing — low by default)
 */
export const AI_PHASE_MODELS = {
  /** The single-lesson / per-lesson RICH plan. Defaults to MEDIUM (was high):
   *  high effort sent the lesson-plan call into a reasoning spiral — output grew
   *  2.9K → 23K and reasoning 0.5K → 20.7K across a module's lessons for a plan a
   *  fraction that size. The plan is a structured contract, not creative prose;
   *  medium produces it well and bounds the reasoning. The downstream GENERATE
   *  phase (high) is where depth is actually built. Env: AI_PLAN_EFFORT. */
  plan: {
    model: process.env.AI_PLAN_MODEL ?? DEFAULT_MODEL,
    effort: effort("AI_PLAN_EFFORT", "medium"),
  } satisfies PhaseModel,
  /** The MODULE-PATH per-lesson rich plan (runRichLessonPlan). It does NOT re-ask
   *  on a thin plan (the brief's slide range already sizes it), so the thin-plan
   *  risk that kept the standalone `plan` at medium is absent here — it defaults to
   *  LOW to cut the reasoning that dominated per-lesson wall-clock. The standalone
   *  single-lesson plan (which CAN re-ask) stays `plan`/medium. Env: AI_MODULE_LESSON_PLAN_EFFORT. */
  moduleLessonPlan: {
    model: process.env.AI_MODULE_LESSON_PLAN_MODEL ?? DEFAULT_MODEL,
    effort: effort("AI_MODULE_LESSON_PLAN_EFFORT", "low"),
  } satisfies PhaseModel,
  /** The MODULE plan is the heaviest single call (a whole multi-lesson outline in
   *  one structured response) — high/medium routinely blew past the request
   *  timeout during the model's long silent reasoning phase. It now defaults to
   *  LOW effort over a DELIBERATELY LEAN schema (concept + layout + depth only, no
   *  per-slide keyPoints/notes) so it returns fast; the single-lesson plan stays
   *  high, and the per-lesson GENERATE phase (medium) is where depth is built. */
  modulePlan: {
    model: process.env.AI_MODULE_PLAN_MODEL ?? DEFAULT_MODEL,
    effort: effort("AI_MODULE_PLAN_EFFORT", "low"),
  } satisfies PhaseModel,
  /** GENERATE — the initial slide authoring. Defaults to MEDIUM effort: the plan is
   *  already a binding contract (content + layout per slide), so generation is closer
   *  to a structured fill than open-ended creativity — medium covers it well and cuts
   *  cost/latency; the coverage-driven loop keeps turns bounded. Env: AI_GENERATE_EFFORT. */
  generate: {
    model: process.env.AI_GENERATE_MODEL ?? DEFAULT_MODEL,
    effort: effort("AI_GENERATE_EFFORT", "medium"),
  } satisfies PhaseModel,
  /** REPAIR is a MECHANICAL fill — it's handed the plan + the exact missing slide
   *  briefs and just builds them, so it runs at MEDIUM effort (cheaper than the
   *  creative GENERATE pass). Env: AI_REPAIR_MODEL / AI_REPAIR_EFFORT. */
  repair: {
    model: process.env.AI_REPAIR_MODEL ?? DEFAULT_MODEL,
    effort: effort("AI_REPAIR_EFFORT", "medium"),
  } satisfies PhaseModel,
  /** AUX (quiz + homework) is authored as ONE structured fill, CONCURRENTLY with the
   *  slide loop (phases.ts authorAuxBlocks) and recovered by a deterministic RETRY —
   *  never the model-repair loop (Decision B). It's a small, mechanical fill straight
   *  from the approved plan's quizPlan/homeworkPlan, so it runs at LOW effort. The
   *  retry reuses this same config. Env: AI_AUX_MODEL / AI_AUX_EFFORT. */
  aux: {
    model: process.env.AI_AUX_MODEL ?? DEFAULT_MODEL,
    effort: effort("AI_AUX_EFFORT", "low"),
  } satisfies PhaseModel,
  edit: {
    model: process.env.AI_EDIT_MODEL ?? DEFAULT_MODEL,
    effort: effort("AI_EDIT_EFFORT", "medium"),
  } satisfies PhaseModel,
  critique: {
    enabled: process.env.AI_CRITIQUE_ENABLED === "true",
    model: process.env.AI_CRITIQUE_MODEL ?? DEFAULT_MODEL,
    effort: effort("AI_CRITIQUE_EFFORT", "medium"),
  } satisfies CritiquePhaseModel,
} as const;

/**
 * Deterministic validation + repair gate (the correctness layer that replaces a
 * heavy critique pass). VALIDATE inspects the generated deck against the approved
 * plan; REPAIR fixes hard failures (missing planned slides, placeholder slides,
 * decks short of the contract) — first deterministically, then with ONE targeted,
 * narrow model pass per round. Both default ON: they catch embarrassing failures
 * (the 3-slide deck, the leftover "Section title" placeholder) for near-zero cost.
 * Env: AI_VALIDATE_GENERATION / AI_REPAIR_HARD_FAILURES / AI_MAX_REPAIR_PASSES.
 */
export const AI_VALIDATION = {
  validateGeneration: bool("AI_VALIDATE_GENERATION", true),
  repairHardFailures: bool("AI_REPAIR_HARD_FAILURES", true),
  /** How many targeted model-repair rounds to attempt before settling with a
   *  checkpoint (each round re-validates; deterministic fixes run every round).
   *  Each round is now coverage-DRIVEN (it keeps building until done or stalled),
   *  so a round does far more than before — but a fresh round resets the
   *  no-progress guard + the compacted view, so a stalled round gets another shot.
   *  Raised 2→4. Env: AI_MAX_REPAIR_PASSES. */
  maxRepairPasses: int("AI_MAX_REPAIR_PASSES", 4),
} as const;

/**
 * Per-call max output tokens for the GENERATE/REPAIR authoring turns. High
 * reasoning effort can consume a lot of the budget before any slide content is
 * emitted, so authoring turns get more headroom than the client default
 * (`OPENAI_MAX_OUTPUT_TOKENS`, 16k). Env: AI_GENERATE_MAX_OUTPUT_TOKENS.
 */
export const AI_GENERATE_MAX_OUTPUT_TOKENS = int("AI_GENERATE_MAX_OUTPUT_TOKENS", 24_000);

/**
 * Coverage-driver guard: how many CONSECUTIVE turns may pass with zero new plan
 * specs built before the loop stops and checkpoints (kills the "spin with tiny
 * failed tool calls" burn). Env: AGENT_NO_PROGRESS_LIMIT.
 */
export const AGENT_NO_PROGRESS_LIMIT = int("AGENT_NO_PROGRESS_LIMIT", 3);

/**
 * Per-call timeout (ms) for the PLAN structured-output call — a single big request
 * that legitimately runs longer than a quick tool turn, so it gets more headroom
 * than the client default (`OPENAI_TIMEOUT_MS`, 120s). This is now a HARD deadline:
 * the provider wires an AbortController to the underlying fetch, so a plan call can
 * NOT exceed it (the old SDK `timeout` option was silently ignored by the proxied
 * undici fetch — calls ran 11–18 min). Env: AI_PLAN_TIMEOUT_MS.
 */
export const AI_PLAN_TIMEOUT_MS = int("AI_PLAN_TIMEOUT_MS", 180_000);

/**
 * Output-token budget for a single LESSON plan (the lesson + per-lesson rich plan).
 * SEPARATE from the module skeleton's larger budget: the lesson plan is the call
 * that ran away (high effort + a 32k ceiling let reasoning balloon). A lesson
 * outline is a compact contract — 16k is comfortable headroom for the JSON + bounded
 * (medium-effort) reasoning, and STRUCTURALLY caps a spiral. Env:
 * AI_LESSON_PLAN_MAX_OUTPUT_TOKENS.
 */
export const AI_LESSON_PLAN_MAX_OUTPUT_TOKENS = int("AI_LESSON_PLAN_MAX_OUTPUT_TOKENS", 16_000);

/**
 * Retries for a PLAN call. Low on purpose (was the client default of 5): a plan
 * that dies on a transport timeout used to be retried 5× through the same dead
 * proxy socket, turning one 180s deadline into ~15 min of wasted wall-clock. One
 * retry rides out a transient blip; a real outage fails fast (the module falls
 * back / the lesson is skipped + retried at the loop level). Env: AI_PLAN_MAX_RETRIES.
 */
export const AI_PLAN_MAX_RETRIES = int("AI_PLAN_MAX_RETRIES", 1);

/**
 * STREAM plan calls (default ON). A non-streaming plan holds one idle HTTP socket
 * open through the model's long silent reasoning, which a China-Clash-style proxy
 * drops as dead — the deaths in the logs were all `stream:false` plan calls.
 * Streaming keeps the connection active and lets partial output be salvaged. The
 * background-mode path (create+poll) still wins when explicitly enabled. Env:
 * AI_PLAN_STREAMING.
 */
export const AI_PLAN_STREAMING = bool("AI_PLAN_STREAMING", true);

/**
 * Module loop resumability: backoff (ms) before the ONE retry of a lesson whose
 * rich plan died on a transport error, so a transient proxy blip doesn't skip the
 * lesson. Env: AI_LESSON_RETRY_BACKOFF_MS.
 */
export const AI_LESSON_RETRY_BACKOFF_MS = int("AI_LESSON_RETRY_BACKOFF_MS", 1_500);

/**
 * OPTIONAL OpenAI background mode for plan calls — create the response then POLL
 * to completion instead of holding one long HTTP connection open through the
 * model's silent reasoning (which an idle proxy/LB can drop). OFF by default (the
 * primary fix is small/fast plans); the module FALLBACK plan also uses it
 * automatically after a transport timeout. Env: AI_USE_BACKGROUND_FOR_PLANS.
 */
export const AI_USE_BACKGROUND_FOR_PLANS = bool("AI_USE_BACKGROUND_FOR_PLANS", false);

/**
 * Minimum slide floors a NON-micro lesson plan should hit (PLAN re-asks once if a
 * normal/technical lesson came back too thin). A micro-lesson (the user explicitly
 * asked for a short one) is exempt. Env: AI_MIN_NORMAL_LESSON_SLIDES /
 * AI_MIN_TECHNICAL_LESSON_SLIDES.
 */
export const AI_LESSON_FLOORS = {
  normal: int("AI_MIN_NORMAL_LESSON_SLIDES", 6),
  technical: int("AI_MIN_TECHNICAL_LESSON_SLIDES", 7),
} as const;

/**
 * OPTIONAL lightweight review — NOT the old heavy critique loop. ONE model call,
 * no tool loop, no regeneration: it returns soft, subjective suggestions the user
 * may apply. OFF by default; `onLintThreshold` fires it only when the deterministic
 * linter raises at least `lintThreshold` warnings (i.e. the deck is visibly rough).
 * Env: AI_LIGHT_REVIEW_ENABLED / AI_LIGHT_REVIEW_ON_LINT_THRESHOLD /
 * AI_LIGHT_REVIEW_LINT_THRESHOLD / AI_LIGHT_REVIEW_MODEL / AI_LIGHT_REVIEW_EFFORT.
 */
export const AI_LIGHT_REVIEW = {
  enabled: bool("AI_LIGHT_REVIEW_ENABLED", false),
  onLintThreshold: bool("AI_LIGHT_REVIEW_ON_LINT_THRESHOLD", true),
  lintThreshold: int("AI_LIGHT_REVIEW_LINT_THRESHOLD", 4),
  model: process.env.AI_LIGHT_REVIEW_MODEL ?? DEFAULT_MODEL,
  effort: effort("AI_LIGHT_REVIEW_EFFORT", "medium"),
} as const;

/** Cheap model + effort for intent classification. IMPORTANT: gpt-5.4-mini does
 *  NOT support "minimal" reasoning effort (it accepts none/low/medium/high/xhigh),
 *  so the classifier defaults to "low" — the cheapest value it takes. Do not set
 *  AI_CLASSIFIER_EFFORT=minimal with a 5.4-mini classifier. */
export const AI_CLASSIFIER_MODEL = process.env.AI_CLASSIFIER_MODEL ?? DEFAULT_MODEL;
export const AI_CLASSIFIER_EFFORT: ReasoningEffort = effort("AI_CLASSIFIER_EFFORT", "low");

/**
 * Product-tier hook. `standard` is the testing default. For now ALL tiers resolve
 * to the env/AI_PHASE_MODELS config above — `premium` is where a future plan maps
 * to stronger models. Kept internal (no UI) until tiers ship.
 */
export type GenerationQualityMode = "draft" | "standard" | "premium";

export const DEFAULT_QUALITY_MODE: GenerationQualityMode =
  (process.env.AI_QUALITY_MODE as GenerationQualityMode) || "standard";

// Future hook: a premium tier will map `DEFAULT_QUALITY_MODE === "premium"` to
// stronger per-phase models here. For now every tier resolves to AI_PHASE_MODELS
// (cheap), so call sites read AI_PHASE_MODELS directly.
