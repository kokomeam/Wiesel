/**
 * Creator Tutor Console ANALYTICS — bad-lesson detection + most-missed questions
 * (TUTOR-1 Wave 5, P5.3).
 *
 * This module is the TS side of migration 20260805120000_tutor_lesson_health.sql:
 *   • LESSON_HEALTH_WEIGHTS — the composite weights, MIRRORING the named SQL
 *     constants in private.recompute_lesson_health (drift-guarded by
 *     scripts/verify-tutor-analytics-console.ts — a divergence trips CI, the
 *     verify-analytics.ts precedent). The DB is the single source of truth that
 *     WRITES composite_score; this mirror exists so the pure UI/tests can reason
 *     about the ranking WITHOUT re-reading the DB, and to pin the SQL against drift.
 *   • computeLessonHealthComposite — the pure weighted sum (the exact formula the
 *     SQL applies), for goldens + the "first-attempt error moves ranking" AC.
 *   • loadMostMissed / loadLessonHealth — the two author-gated definer RPC calls
 *     (rpcJson + Zod, the loadTutorConsole recipe). Both return [] on any error so
 *     the tab renders an EmptyState rather than 500-ing.
 *
 * PRIVACY (Amendment D-4): every number a creator reads here is a cohort-floored
 * (≥5) or per-lesson aggregate emitted by a definer RPC. This module NEVER reads a
 * raw learner table and NEVER recomputes a floor — the RPCs own that.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { rpcJson } from "@/lib/supabase/rpcJson";

type DB = SupabaseClient<Database>;

/* ────────────────────────────── composite weights ───────────────────────────
 * MIRROR of the named SQL constants (v_w_*) in private.recompute_lesson_health.
 * Keep these two in lock-step — the drift guard regex-asserts the migration text
 * encodes exactly these numbers. Sum = 1.0. Each input is normalized 0..1 with
 * HIGHER = worse (needs more attention). */
export const LESSON_HEALTH_WEIGHTS = {
  masteryShortfall: 0.3,
  firstAttemptErrorRate: 0.25,
  confusionDensity: 0.2,
  dropoutAfterRate: 0.15,
  rewatchScrubDensity: 0.1,
} as const;

export type LessonHealthWeightKey = keyof typeof LESSON_HEALTH_WEIGHTS;

/** The five normalized inputs (0..1, higher = worse). Mirrors the rollup columns. */
export interface LessonHealthInputs {
  masteryShortfall: number;
  firstAttemptErrorRate: number;
  confusionDensity: number;
  dropoutAfterRate: number;
  rewatchScrubDensity: number;
}

/**
 * PURE. The deterministic composite — the exact weighted sum the SQL applies
 * (rounded to 6 dp to match round(…, 6) in the migration). Missing/negative
 * inputs are treated as 0 (the SQL coalesces null → 0); inputs are NOT re-clamped
 * to ≤1 (the SQL doesn't either — a rollup column is already normalized upstream).
 */
export function computeLessonHealthComposite(inputs: Partial<LessonHealthInputs>): number {
  const at = (k: LessonHealthWeightKey): number => {
    const v = inputs[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  };
  const raw =
    LESSON_HEALTH_WEIGHTS.masteryShortfall * at("masteryShortfall") +
    LESSON_HEALTH_WEIGHTS.firstAttemptErrorRate * at("firstAttemptErrorRate") +
    LESSON_HEALTH_WEIGHTS.confusionDensity * at("confusionDensity") +
    LESSON_HEALTH_WEIGHTS.dropoutAfterRate * at("dropoutAfterRate") +
    LESSON_HEALTH_WEIGHTS.rewatchScrubDensity * at("rewatchScrubDensity");
  return Math.round(raw * 1e6) / 1e6;
}

/* ─────────────────────────────── lesson_health ──────────────────────────────
 * The lesson_health(p_course_id) RPC payload — the ranked per-lesson rollup. */

const LessonHealthRowSchema = z.object({
  lessonId: z.string(),
  compositeScore: z.coerce.number(),
  masteryShortfall: z.coerce.number().nullable(),
  confusionDensity: z.coerce.number().nullable(),
  firstAttemptErrorRate: z.coerce.number().nullable(),
  rewatchScrubDensity: z.coerce.number().nullable(),
  dropoutAfterRate: z.coerce.number().nullable(),
  rationale: z.string().nullable(),
  computedAt: z.string(),
});
export type LessonHealthRow = z.infer<typeof LessonHealthRowSchema>;

/**
 * Load the ranked lesson-health rollup for a course (author-gated definer RPC).
 * Returns [] when the caller isn't the author, the course has no live publication,
 * or the rollup hasn't run yet — the tab renders an EmptyState in every case.
 */
export async function loadLessonHealth(supabase: DB, courseId: string): Promise<LessonHealthRow[]> {
  try {
    return await rpcJson(
      supabase,
      "lesson_health",
      { p_course_id: courseId },
      z.array(LessonHealthRowSchema)
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        tag: "lesson_health_load",
        courseId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
    return [];
  }
}

/* ─────────────────────────── most_missed_questions ──────────────────────────
 * The most_missed_questions(p_course_id) RPC payload — cohort-floored (≥5) per
 * question, ranked by first_attempt_error_rate desc. */

const PerOptionSchema = z.object({
  option: z.string().nullable(),
  count: z.coerce.number(),
});
export type MostMissedOption = z.infer<typeof PerOptionSchema>;

const MostMissedRowSchema = z.object({
  blockId: z.string(),
  questionId: z.string(),
  lessonId: z.string().nullable(),
  objectiveId: z.string().nullable(),
  distinctLearnerCount: z.coerce.number(),
  firstAttemptErrorRate: z.coerce.number(),
  secondAttemptErrorRate: z.coerce.number().nullable(),
  perOption: z.array(PerOptionSchema),
  conceptNodeIds: z.array(z.string()),
  deepLink: z.object({ lessonId: z.string().nullable(), blockId: z.string() }),
});
export type MostMissedRow = z.infer<typeof MostMissedRowSchema>;

/**
 * Load the cohort-floored most-missed questions for a course (author-gated definer
 * RPC). A question below the ≥5 distinct-learner floor is OMITTED by the RPC (never
 * a partial disclosure). Returns [] on any error.
 */
export async function loadMostMissed(supabase: DB, courseId: string): Promise<MostMissedRow[]> {
  try {
    return await rpcJson(
      supabase,
      "most_missed_questions",
      { p_course_id: courseId },
      z.array(MostMissedRowSchema)
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        tag: "most_missed_load",
        courseId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
    return [];
  }
}
