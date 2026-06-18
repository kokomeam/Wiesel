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

/**
 * Phase configs. Read these instead of literal model strings. Env overrides:
 *   AI_PLAN_MODEL / AI_PLAN_EFFORT
 *   AI_GENERATE_MODEL / AI_GENERATE_EFFORT
 *   AI_EDIT_MODEL / AI_EDIT_EFFORT
 *   AI_CRITIQUE_ENABLED / AI_CRITIQUE_MODEL / AI_CRITIQUE_EFFORT
 *   AI_CLASSIFIER_MODEL (intent routing; effort is always minimal)
 */
export const AI_PHASE_MODELS = {
  plan: {
    model: process.env.AI_PLAN_MODEL ?? DEFAULT_MODEL,
    effort: effort("AI_PLAN_EFFORT", "high"),
  } satisfies PhaseModel,
  generate: {
    model: process.env.AI_GENERATE_MODEL ?? DEFAULT_MODEL,
    effort: effort("AI_GENERATE_EFFORT", "medium"),
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

/** Cheap model for intent classification (always minimal effort). */
export const AI_CLASSIFIER_MODEL = process.env.AI_CLASSIFIER_MODEL ?? DEFAULT_MODEL;

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
