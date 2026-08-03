/**
 * Concept-graph EXTRACTION tunables (TUTOR-1 Wave 1.3 · Directive §1.2).
 *
 * The ONE place the extraction pipeline's numeric knobs live. Every value is
 * env-overridable so a deployment can dial the grain / thresholds / budget
 * without a code change; each falls back to the directive default when unset or
 * malformed. Read these instead of literal numbers anywhere in the pipeline.
 *
 * The `int()`/`num()`/`bool()` helpers are LOCAL copies of the modelConfig.ts
 * idiom (the directive: don't import that module's private helpers) so this
 * module has no cross-config coupling.
 */

/** Parse a positive-integer env value, falling back when unset/non-positive. */
function int(envVar: string, fallback: number): number {
  const n = Number(process.env[envVar]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Parse a finite float env value in [0,1], falling back otherwise. Used for the
 *  cosine-similarity + confidence thresholds (both are 0..1 ratios). */
function ratio(envVar: string, fallback: number): number {
  const n = Number(process.env[envVar]);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Parse a boolean env flag (`"true"`/`"false"`), falling back when unset/garbage. */
function bool(envVar: string, fallback: boolean): boolean {
  const v = process.env[envVar];
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

/**
 * The resolved extraction config. A single frozen object so a caller passes ONE
 * `cfg` through the pure normalization helpers (they take the fields they need,
 * never the whole process env).
 */
export interface ExtractionConfig {
  /** Grain: minimum durable concepts a lesson should yield (soft — a lesson can
   *  legitimately be 0; the zero case is FLAGGED, not forced up). */
  grainMinPerLesson: number;
  /** Grain: max durable concepts per lesson. Over this ⇒ keep the top-N by
   *  confidence and flag `grain_over:{lessonId}`. */
  grainMaxPerLesson: number;
  /** Grain: whole-course cap. Over this ⇒ keep the top-by-confidence set and flag
   *  `grain_course_over`. */
  grainCourseMax: number;
  /** Canonicalization: cosine similarity ≥ this clusters two proposals for merge
   *  adjudication. */
  canonSimThreshold: number;
  /** The hard cap on model calls the orchestrator may spend (a CallBudget-style
   *  counter). Exhaustion STOPS proposing + checkpoints — never a silent partial. */
  maxCalls: number;
  /** Edge pruning: an inferred edge below this confidence is dropped. */
  edgeMinConfidence: number;
  /** Per-lesson chunk cap (chars) before the truncation marker is appended. */
  chunkMaxChars: number;
  /** Verify-time toggle mirror (unused by the core; kept so a deployment can read
   *  the resolved config as one object). */
  imageVerifyEnabled: boolean;
}

/** The truncation marker appended to a lesson chunk clipped at `chunkMaxChars`.
 *  Stable string so goldens assert its presence deterministically. */
export const CHUNK_TRUNCATION_MARKER = "\n…[truncated]";

/** Directive defaults (Directive §1.2 step 1). */
export const TUTOR_GRAIN_MIN_PER_LESSON = int("TUTOR_GRAIN_MIN_PER_LESSON", 1);
export const TUTOR_GRAIN_MAX_PER_LESSON = int("TUTOR_GRAIN_MAX_PER_LESSON", 4);
export const TUTOR_GRAIN_COURSE_MAX = int("TUTOR_GRAIN_COURSE_MAX", 60);
export const TUTOR_CANON_SIM_THRESHOLD = ratio("TUTOR_CANON_SIM_THRESHOLD", 0.85);
export const TUTOR_EXTRACTION_MAX_CALLS = int("TUTOR_EXTRACTION_MAX_CALLS", 40);
export const TUTOR_EDGE_MIN_CONFIDENCE = ratio("TUTOR_EDGE_MIN_CONFIDENCE", 0.5);
/** ~6000 chars per lesson chunk (Directive §1.2 step 2). */
export const TUTOR_CHUNK_MAX_CHARS = int("TUTOR_CHUNK_MAX_CHARS", 6000);
export const TUTOR_IMAGE_VERIFY_ENABLED = bool("TUTOR_IMAGE_VERIFY_ENABLED", true);

/** Resolve the whole config from the env-backed constants above. Pure — reads the
 *  module-level constants (already env-resolved at import), returns a fresh object. */
export function resolveExtractionConfig(overrides: Partial<ExtractionConfig> = {}): ExtractionConfig {
  return {
    grainMinPerLesson: TUTOR_GRAIN_MIN_PER_LESSON,
    grainMaxPerLesson: TUTOR_GRAIN_MAX_PER_LESSON,
    grainCourseMax: TUTOR_GRAIN_COURSE_MAX,
    canonSimThreshold: TUTOR_CANON_SIM_THRESHOLD,
    maxCalls: TUTOR_EXTRACTION_MAX_CALLS,
    edgeMinConfidence: TUTOR_EDGE_MIN_CONFIDENCE,
    chunkMaxChars: TUTOR_CHUNK_MAX_CHARS,
    imageVerifyEnabled: TUTOR_IMAGE_VERIFY_ENABLED,
    ...overrides,
  };
}
