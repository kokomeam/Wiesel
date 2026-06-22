/**
 * Visual-pipeline configuration (spec §20). Programmatic diagrams ON, AI image
 * generation ON (the LIVE illustration fallback for concepts no diagram fits —
 * accuracy-critical visuals still go programmatic), web image search OFF,
 * validation ON. Every flag is env-overridable. Centralizing them here means the
 * router, the planner, and the image path all read ONE source of truth.
 */

function boolEnv(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v == null || v.trim() === "") return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
}
function numEnv(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export const AI_VISUALS = {
  /** Master switch for the whole visual pipeline. */
  enabled: boolEnv("AI_VISUALS_ENABLED", true),
  /** Render typed diagrams as SVG (the live, accurate path). */
  programmaticDiagrams: boolEnv("AI_PROGRAMMATIC_DIAGRAMS_ENABLED", true),
  /** Generate an educational illustration with an image model when no programmatic
   *  diagram fits AND the visual isn't accuracy-critical. LIVE. Env:
   *  AI_IMAGE_GENERATION_ENABLED (set false to fall back to manual placeholders). */
  imageGeneration: boolEnv("AI_IMAGE_GENERATION_ENABLED", true),
  /** Source images from the web with licensing safeguards (Phase 5 — OFF). */
  webImageSearch: boolEnv("AI_WEB_IMAGE_SEARCH_ENABLED", false),
  /** Validate required visuals before insertion / finalization. */
  validation: boolEnv("AI_VISUAL_VALIDATION_ENABLED", true),
  /** Don't flood a lesson with visuals (but enough for a typical 2–4-visual deck). */
  maxPerLesson: numEnv("AI_VISUAL_MAX_PER_LESSON", 5),
  maxRequiredPerDeck: numEnv("AI_VISUAL_MAX_REQUIRED_PER_DECK", 4),
  /** Require a `reason` on every selected visual. */
  requireReason: boolEnv("AI_VISUAL_REQUIRE_REASON", true),
  /** Hard-validate accuracy-critical AI visuals (or warn + require human review). */
  accuracyCriticalValidate: boolEnv("AI_VISUAL_ACCURACY_CRITICAL_VALIDATE", true),
} as const;

export type AiVisualsConfig = typeof AI_VISUALS;
