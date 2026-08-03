/**
 * Mastery-engine tunables (TUTOR-1 Wave 2 · BKT mastery + refold).
 *
 * The ONE place the deterministic mastery math's numeric knobs live. Every value
 * is env-overridable so a deployment can dial the BKT priors / decay / threshold
 * without a code change; each falls back to the documented default when unset or
 * malformed. Read these instead of literal numbers anywhere in the engine.
 *
 * ZERO MODEL CALLS: nothing under lib/tutor/mastery/* imports a model client — the
 * whole wave is deterministic math. This module has no cross-config coupling; the
 * `int()`/`num()`/`ratio()` helpers are LOCAL copies of the graph config.ts idiom
 * (the directive: don't import that module's private helpers).
 */

/** Parse a positive-integer env value, falling back when unset/non-positive. */
function int(envVar: string, fallback: number): number {
  const n = Number(process.env[envVar]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Parse a finite float env value in [0,1], falling back otherwise. Used for the
 *  BKT probabilities + the mastery threshold (all are 0..1 ratios). */
function ratio(envVar: string, fallback: number): number {
  const n = Number(process.env[envVar]);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Parse a finite positive float env value, falling back when unset/non-positive.
 *  Used for the decay half-life (days) and dwell multiplier. */
function num(envVar: string, fallback: number): number {
  const n = Number(process.env[envVar]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* ───────────────────────────── directive defaults ───────────────────────── */

/** BKT prior: P(L0) — the baseline probability a learner already knows a fresh
 *  concept before any evidence. Also the decay FLOOR (a decayed estimate never
 *  drops below the prior). */
export const TUTOR_BKT_PL0 = ratio("TUTOR_BKT_PL0", 0.25);
/** BKT transit: P(T) — the probability of learning the concept on one practice
 *  opportunity (applied AFTER each observation's Bayesian update). */
export const TUTOR_BKT_PT = ratio("TUTOR_BKT_PT", 0.2);
/** BKT slip: P(S) — the probability of answering wrong DESPITE knowing it. */
export const TUTOR_BKT_PS = ratio("TUTOR_BKT_PS", 0.1);
/** BKT guess: P(G) — the probability of answering right WITHOUT knowing it. */
export const TUTOR_BKT_PG = ratio("TUTOR_BKT_PG", 0.2);

/** Forgetting curve: the base half-life (days) for a concept with ZERO prior
 *  evidence. The effective half-life lengthens with evidence_count. */
export const TUTOR_DECAY_HALFLIFE_DAYS = num("TUTOR_DECAY_HALFLIFE_DAYS", 30);

/** The below-threshold line: a decayed_p under this is "not mastered" (drives
 *  root-cause analysis, the review queue, and the course aggregate's
 *  below_threshold_count). */
export const TUTOR_MASTERY_THRESHOLD = ratio("TUTOR_MASTERY_THRESHOLD", 0.6);

/**
 * MASTERY_MIN_COHORT — the TS mirror of the SQL cohort floor (Amendment D-4).
 * The course-aggregate materializer (queries.ts, W2.4 sibling) and its SQL must
 * NOT publish per-node aggregates for a cohort smaller than this (learner privacy
 * + statistical noise). Kept here as the single TS constant so the sibling's SQL
 * and any TS consumer read the SAME floor.
 *
 * ⚠ DRIFT: this MUST equal the cohort floor encoded in the Wave-2 mastery
 * migration (the sibling authors it; the aggregate CTE's `having count(*) >= N`).
 * verify-tutor-mastery.ts asserts this constant equals 5 so a silent edit trips.
 */
export const MASTERY_MIN_COHORT = int("TUTOR_MASTERY_MIN_COHORT", 5);

/** Dwell signal: a slide whose per-learner dwell exceeds this MULTIPLE of the
 *  cohort median (from rollup_slide_dwell) is a weak "struggled here" signal. */
export const TUTOR_DWELL_OVER_MEDIAN_MULT = num("TUTOR_DWELL_OVER_MEDIAN_MULT", 2);

/* ─────────────────────────────── resolved config ────────────────────────── */

/**
 * The resolved mastery config. A single object so a caller passes ONE `cfg`
 * through the pure math (bkt/decay/weights/refold take the fields they need,
 * never the whole process env). Mirrors resolveExtractionConfig's seam.
 */
export interface MasteryConfig {
  /** BKT prior P(L0) — also the decay floor. */
  pL0: number;
  /** BKT transit P(T). */
  pT: number;
  /** BKT slip P(S). */
  pS: number;
  /** BKT guess P(G). */
  pG: number;
  /** Base decay half-life in days (extended by evidence_count). */
  decayHalfLifeDays: number;
  /** The below-threshold mastery line (0..1). */
  masteryThreshold: number;
  /** Minimum cohort for a published course aggregate (Amendment D-4). */
  minCohort: number;
  /** Dwell-over-median multiple that raises the weak dwell signal. */
  dwellOverMedianMult: number;
}

/** Resolve the whole config from the env-backed constants above. Pure — reads the
 *  module-level constants (already env-resolved at import), returns a fresh
 *  object; `overrides` lets a test pin any knob (the graph resolveExtractionConfig
 *  seam). */
export function resolveMasteryConfig(overrides: Partial<MasteryConfig> = {}): MasteryConfig {
  return {
    pL0: TUTOR_BKT_PL0,
    pT: TUTOR_BKT_PT,
    pS: TUTOR_BKT_PS,
    pG: TUTOR_BKT_PG,
    decayHalfLifeDays: TUTOR_DECAY_HALFLIFE_DAYS,
    masteryThreshold: TUTOR_MASTERY_THRESHOLD,
    minCohort: MASTERY_MIN_COHORT,
    dwellOverMedianMult: TUTOR_DWELL_OVER_MEDIAN_MULT,
    ...overrides,
  };
}
