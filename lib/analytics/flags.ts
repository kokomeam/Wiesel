/**
 * Flag thresholds + decision logic (Milestone 3/4). PURE — applied at render
 * time by the dashboard over rollup rows; the raw statistics themselves are
 * computed once in SQL and never recomputed here.
 *
 * ⚠ The STUCK-LEARNER constants are MIRRORED in the migration
 * (supabase/migrations/20260702050000_analytics_events.sql, learner_flags
 * section) because the nightly cron needs them in SQL — edit BOTH together.
 * verify-analytics.ts asserts these TS values match the documented SQL.
 */

/* ───────────────── Stuck-queue thresholds (SQL mirror) ─────────────────── */

/** Enrolled + active but silent for this many days → inactive_7d_incomplete. */
export const INACTIVE_DAYS = 7;
/** This many failing attempts on the SAME quiz → repeated_quiz_failure… */
export const FAILURE_MIN_ATTEMPTS = 2;
/** …where "failing" means score/maxScore strictly below this fraction. */
export const FAILURE_SCORE_PCT = 0.6;

export type LearnerFlagType = "inactive_7d_incomplete" | "repeated_quiz_failure";

/* ─────────────── Item-analysis thresholds (TS-only truth) ──────────────── */

/** Red: fewer than this % answer correctly… */
export const LOW_PCT_CORRECT = 40;
/** …once at least this many responses exist (below it, too noisy to flag). */
export const LOW_PCT_MIN_N = 20;
/** Red: some wrong answer drew at least this many times the key's count. */
export const DISTRACTOR_RATIO = 2;
/** Red: point-biserial discrimination below this (item doesn't separate). */
export const LOW_DISCRIMINATION = 0.1;

export interface QuestionStatsInput {
  n: number;
  /** 0..100 (null when no responses). */
  pctCorrect: number | null;
  /** answer bucket → count. */
  answerDistribution: Record<string, number>;
  /** The correct answer's bucket (null for short_answer — no distractor check). */
  keyValue: string | null;
  /** Point-biserial (null when undefined). */
  discrimination: number | null;
}

export interface QuestionFlag {
  type: "low_correct" | "strong_distractor" | "low_discrimination";
  detail: string;
}

/** The Content-health item-analysis flags — red rows in the dashboard. */
export function questionFlags(q: QuestionStatsInput): QuestionFlag[] {
  const flags: QuestionFlag[] = [];
  if (q.pctCorrect !== null && q.pctCorrect < LOW_PCT_CORRECT && q.n >= LOW_PCT_MIN_N) {
    flags.push({
      type: "low_correct",
      detail: `Only ${q.pctCorrect}% correct across ${q.n} responses`,
    });
  }
  if (q.keyValue !== null) {
    const keyCount = q.answerDistribution[q.keyValue] ?? 0;
    for (const [bucket, count] of Object.entries(q.answerDistribution)) {
      if (bucket === q.keyValue) continue;
      if (count >= DISTRACTOR_RATIO * Math.max(keyCount, 1)) {
        flags.push({
          type: "strong_distractor",
          detail: `A wrong answer drew ${count} responses vs ${keyCount} for the key`,
        });
        break; // one distractor flag per question is enough
      }
    }
  }
  if (q.discrimination !== null && q.discrimination < LOW_DISCRIMINATION) {
    flags.push({
      type: "low_discrimination",
      detail: `Discrimination ${q.discrimination.toFixed(2)} — strong and weak learners miss it alike`,
    });
  }
  return flags;
}

/* ───────────────────── Slide-dwell outliers ────────────────────────────── */

/** Below this many viewers a slide's dwell median is too noisy to flag. */
export const DWELL_MIN_N = 5;
/** Skim: median under this fraction of the publication's reference median… */
export const SKIM_RATIO = 0.3;
/** …AND under this absolute floor (a genuinely brief glance). */
export const SKIM_MAX_MS = 5_000;
/** Stall: median over this multiple of the reference median… */
export const STALL_RATIO = 2.5;
/** …AND over this absolute floor (a genuinely long stop). */
export const STALL_MIN_MS = 45_000;

export type DwellOutlier = "skimmed" | "stall" | null;

/**
 * Classify one slide's median dwell against the publication's reference
 * median (the median of all slide medians). Both the ratio AND the absolute
 * floor must trip — a uniformly fast deck flags nothing.
 */
export function dwellOutlier(
  medianMs: number,
  referenceMedianMs: number,
  n: number
): DwellOutlier {
  if (n < DWELL_MIN_N || referenceMedianMs <= 0) return null;
  if (medianMs < SKIM_RATIO * referenceMedianMs && medianMs < SKIM_MAX_MS) {
    return "skimmed";
  }
  if (medianMs > STALL_RATIO * referenceMedianMs && medianMs > STALL_MIN_MS) {
    return "stall";
  }
  return null;
}

/* ───────────────────── Stuck-queue row descriptions ────────────────────── */

export interface StuckQuizDetail {
  blockId: string;
  failedAttempts: number;
  lastScorePct: number | null;
}

/** Human "why flagged" line for a learner_flags row's detail jsonb. */
export function describeLearnerFlag(
  flagType: LearnerFlagType,
  detail: Record<string, unknown>
): string {
  if (flagType === "inactive_7d_incomplete") {
    const completed = typeof detail.completedLessons === "number" ? detail.completedLessons : 0;
    const total = typeof detail.totalLessons === "number" ? detail.totalLessons : 0;
    const last = typeof detail.lastActivityAt === "string" ? new Date(detail.lastActivityAt) : null;
    const days =
      last && !Number.isNaN(last.getTime())
        ? Math.max(INACTIVE_DAYS, Math.floor((Date.now() - last.getTime()) / 86_400_000))
        : INACTIVE_DAYS;
    return `Inactive ${days} days — ${completed}/${total} lessons complete`;
  }
  const quizzes = Array.isArray(detail.quizzes) ? (detail.quizzes as StuckQuizDetail[]) : [];
  const worst = quizzes[0];
  if (!worst) return "Repeated failing quiz attempts";
  const score = typeof worst.lastScorePct === "number" ? `, last score ${worst.lastScorePct}%` : "";
  const more = quizzes.length > 1 ? ` (+${quizzes.length - 1} more quiz${quizzes.length > 2 ? "zes" : ""})` : "";
  return `${worst.failedAttempts} failing attempts on the same quiz${score}${more}`;
}
