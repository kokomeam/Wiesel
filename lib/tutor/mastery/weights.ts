/**
 * Evidence weights — the documented weight table for every mastery signal
 * (TUTOR-1 Wave 2). PURE + deterministic; quoted verbatim in docs/tutor/mastery.md.
 * ZERO MODEL CALLS.
 *
 * Each weight is the `w ∈ (0,1]` fed to `updateBkt`: how far a single observation
 * of that kind may move the BKT estimate. Stronger, more trustworthy signals
 * (a fresh graded answer) weigh more than weak, ambiguous ones (a single
 * long-dwell slide). Every default carries its RATIONALE below — a silent edit to
 * these numbers trips a drift assertion in verify-tutor-mastery.ts.
 */

/**
 * Attempt-ordinal weights (A1.2) — indexed by ordinal 1 / 2 / ≥3.
 *
 * RATIONALE (retry contamination): a learner's FIRST attempt on a question is the
 * cleanest read of their knowledge. Later attempts carry answer-memory ("I saw
 * the right choice last time"), not fresh knowledge — so they weigh far less. A
 * third-or-later attempt is almost pure recall, weighted to a floor.
 *
 *   ordinal 1 → 1.0   (full-strength: the uncontaminated first read)
 *   ordinal 2 → 0.5   (half: partial answer-memory contamination)
 *   ordinal ≥3 → 0.15 (floor: predominantly recall, not knowledge)
 */
export const ORDINAL_WEIGHTS = [1.0, 0.5, 0.15] as const;

/** Resolve the ordinal weight for a 1-based attempt ordinal (≥3 clamps to the
 *  floor). ordinal ≤ 0 is treated as 1 (defensive — the mapper derives ≥1). */
export function ordinalWeight(ordinal: number): number {
  if (ordinal <= 1) return ORDINAL_WEIGHTS[0];
  if (ordinal === 2) return ORDINAL_WEIGHTS[1];
  return ORDINAL_WEIGHTS[2];
}

/**
 * HISTORICAL detail-less attempts (the cold-start story). Pre-deployment quiz
 * data has only a block-level score (no per-question quiz_attempt_detail rows).
 * We derive direction from the score and apply this factor ON TOP of the ordinal
 * weight, to every node anchored to the block.
 *
 * RATIONALE: a block-level score is a coarse, whole-quiz signal spread across
 * every concept the block teaches — it can't isolate which concept the learner
 * missed. So it's discounted heavily (0.3×) versus a per-question read.
 */
export const HISTORICAL_DETAILLESS_FACTOR = 0.3;

/** The score fraction (0..1) at/above which a historical detail-less attempt (and
 *  a self-report) counts as POSITIVE evidence. Mirrors the learn runtime's
 *  passing bar. */
export const HISTORICAL_PASS_FRACTION = 0.6;

/**
 * Hint-request weights, by the rung reached (0–4). A hint request is an implicit
 * signal about how much the learner needed help.
 *
 * RATIONALE (productive struggle): asking for an EARLY hint (rung 0–1) and then
 * proceeding is healthy engagement — a small POSITIVE signal. Needing MID hints
 * (rung 2–3) signals a gap — a small NEGATIVE. Reaching the FINAL rung (4) means
 * the answer itself was surfaced — the strongest negative among hints.
 *
 *   rung 0–1 → +0.10  (positive: productive struggle)
 *   rung 2–3 → −0.15  (negative: a real gap)
 *   rung 4   → −0.30  (negative: the answer was given)
 */
export interface HintWeight {
  direction: 1 | -1;
  weight: number;
}
export function hintWeight(rung: number): HintWeight {
  if (rung <= 1) return { direction: 1, weight: 0.1 };
  if (rung <= 3) return { direction: -1, weight: 0.15 };
  return { direction: -1, weight: 0.3 };
}

/**
 * self_report weight — the learner's own "I get this / I don't" (evidence_correct
 * carries the direction).
 *
 * RATIONALE: self-assessment is honest signal but weakly calibrated (learners
 * over- and under-estimate), so it's a light touch.
 */
export const SELF_REPORT_WEIGHT = 0.25;

/**
 * tutor_inference weights, by the inference strength recorded in the event
 * metadata (direction also from metadata: positive | negative).
 *
 * RATIONALE: an inference the tutor drew from a conversation turn is indirect
 * evidence. `weak` is a passing cue; `moderate` is a clearer read — both below a
 * graded answer's strength.
 *
 *   weak     → 0.10
 *   moderate → 0.25
 */
export const TUTOR_INFERENCE_WEIGHTS = { weak: 0.1, moderate: 0.25 } as const;
export type TutorInferenceStrength = keyof typeof TUTOR_INFERENCE_WEIGHTS;
export function tutorInferenceWeight(strength: TutorInferenceStrength): number {
  return TUTOR_INFERENCE_WEIGHTS[strength];
}

/**
 * content_engagement weights (metadata.signal ∈ completed | rewatch | scrub_back).
 *
 * RATIONALE: completing a piece of content is a small POSITIVE (exposure to the
 * material). Rewatching or scrubbing BACK signals the learner didn't get it the
 * first time — a small NEGATIVE.
 *
 *   completed          → +0.10
 *   rewatch/scrub_back → −0.05
 */
export interface ContentEngagementWeight {
  direction: 1 | -1;
  weight: number;
}
export function contentEngagementWeight(
  signal: "completed" | "rewatch" | "scrub_back"
): ContentEngagementWeight {
  if (signal === "completed") return { direction: 1, weight: 0.1 };
  return { direction: -1, weight: 0.05 };
}

/**
 * dwell_over_median (DERIVED, not an event): a slide whose per-learner dwell
 * exceeds `dwellOverMedianMult`× the cohort median (from rollup_slide_dwell) is a
 * weak "struggled here" NEGATIVE signal.
 *
 * RATIONALE: a very long dwell on one slide relative to peers hints at confusion,
 * but dwell is noisy (the learner may have stepped away — visibility-gated dwell
 * mitigates but doesn't eliminate this), so it's the LIGHTEST negative.
 *
 *   dwell > mult × cohort-median → −0.05
 */
export const DWELL_OVER_MEDIAN_WEIGHT = 0.05;

/**
 * tutor_evidence_recorded weights (TUTOR-1 Amendment A3 Wave 2) — one
 * observation per tutor TOOL COMPLETION, by `outcome`.
 *
 * RATIONALE (conservative v1 — mirror the practice_answer magnitudes): a tool
 * completion is a graded read of the learner's knowledge, the same trust class
 * as a first practice answer, so it carries the practice weight
 * (ORDINAL_WEIGHTS[0] = 1.0 — tool completions have no retry ordinal; each
 * completionKey is one fresh observation):
 *
 *   demonstrated     → +1.0  (positive at the practice-correct weight)
 *   partial          → +0.5  (positive at HALF the correct weight)
 *   not_demonstrated → −1.0  (negative at the practice-wrong weight)
 *
 * [FWD] `confidence` and `misconceptionSlug` deliberately do NOT modulate the
 * weight in v1 — a later wave may down-weight an "unsure" demonstrated or
 * sharpen a misconception-tagged not_demonstrated; today they ride the event
 * for the rollup/registry only.
 */
export const TOOL_EVIDENCE_PARTIAL_FACTOR = 0.5;
export type ToolEvidenceOutcomeKind = "demonstrated" | "partial" | "not_demonstrated";
export interface ToolEvidenceWeight {
  direction: 1 | -1;
  weight: number;
}
export function toolEvidenceWeight(outcome: ToolEvidenceOutcomeKind): ToolEvidenceWeight {
  if (outcome === "demonstrated") return { direction: 1, weight: ORDINAL_WEIGHTS[0] };
  if (outcome === "partial")
    return { direction: 1, weight: ORDINAL_WEIGHTS[0] * TOOL_EVIDENCE_PARTIAL_FACTOR };
  return { direction: -1, weight: ORDINAL_WEIGHTS[0] };
}
