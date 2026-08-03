/**
 * PURE helpers for the student portal home (/home) — streaks, latest-attempt
 * folding, the "worth a review" queue, quiz accuracy, and enrollment summary.
 *
 * No Supabase imports, no Date.now(): callers pass today's date in. Verified
 * headless by `npx tsx scripts/verify-student-home.ts`.
 */

/* ───────────────────────────── Row shapes ──────────────────────────────── */

/** The subset of a quiz_attempts row the home page reads. */
export interface QuizAttemptRowLike {
  block_id: string;
  course_id: string;
  score: number;
  max_score: number;
  attempt_number: number;
  submitted_at: string;
}

/** The subset of a my_learning() row the summary reads. */
export interface LearningRowLike {
  enrollment_status: string;
  total_lessons: number;
  completed_lessons: number;
}

export interface LearningSummary {
  /** Enrollments still being worked through (anything not completed). */
  inProgress: number;
  /** Enrollments the server flipped to completed. */
  completed: number;
  /** Lessons completed across every enrollment. */
  lessonsCompleted: number;
  /** Lessons available across every enrollment. */
  lessonsTotal: number;
}

/* ─────────────────────────────── Streak ────────────────────────────────── */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** 'YYYY-MM-DD' → whole days since the epoch (UTC — no timezone drift). */
function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

/**
 * Consecutive-day learning streak.
 *
 * Counts back from today if the learner was active today, else from
 * yesterday (an unbroken streak survives until a full day is missed).
 * Input dates are 'YYYY-MM-DD'; unsorted/duplicated entries and malformed
 * strings are tolerated. Returns 0 when neither today nor yesterday saw
 * activity.
 */
export function computeStreak(dates: readonly string[], todayIso: string): number {
  if (!ISO_DAY.test(todayIso)) return 0;
  const days = new Set<number>();
  for (const date of dates) {
    if (ISO_DAY.test(date)) days.add(dayNumber(date));
  }
  const today = dayNumber(todayIso);
  let cursor: number;
  if (days.has(today)) cursor = today;
  else if (days.has(today - 1)) cursor = today - 1;
  else return 0;

  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor -= 1;
  }
  return streak;
}

/* ─────────────────────────── Quiz attempt folds ────────────────────────── */

/**
 * Keep only the NEWEST attempt per quiz block (by submitted_at; ties broken
 * by attempt_number). Input order doesn't matter.
 */
export function latestAttemptsPerBlock<T extends QuizAttemptRowLike>(
  rows: readonly T[]
): T[] {
  const byBlock = new Map<string, T>();
  for (const row of rows) {
    const current = byBlock.get(row.block_id);
    if (
      !current ||
      row.submitted_at > current.submitted_at ||
      (row.submitted_at === current.submitted_at &&
        row.attempt_number > current.attempt_number)
    ) {
      byBlock.set(row.block_id, row);
    }
  }
  return [...byBlock.values()];
}

export type ReviewQueueItem<T extends QuizAttemptRowLike = QuizAttemptRowLike> = T & {
  /** score / max_score, 0..1. */
  scoreRatio: number;
};

/**
 * Quizzes worth another look: latest attempts scoring BELOW the threshold
 * (default 70%), sorted worst-first. Attempts with max_score 0 are ungradable
 * and excluded.
 */
export function reviewQueue<T extends QuizAttemptRowLike>(
  latest: readonly T[],
  threshold = 0.7
): ReviewQueueItem<T>[] {
  return latest
    .filter((row) => row.max_score > 0 && row.score / row.max_score < threshold)
    .map((row) => ({ ...row, scoreRatio: row.score / row.max_score }))
    .sort((a, b) => a.scoreRatio - b.scoreRatio);
}

/**
 * Rounded mean accuracy (%) across the latest attempt per quiz. Attempts with
 * max_score 0 are skipped; null when nothing gradable exists.
 */
export function quizAccuracyPct(latest: readonly QuizAttemptRowLike[]): number | null {
  const gradable = latest.filter((row) => row.max_score > 0);
  if (gradable.length === 0) return null;
  const mean =
    gradable.reduce((sum, row) => sum + row.score / row.max_score, 0) / gradable.length;
  return Math.round(mean * 100);
}

/* ─────────────────────────── Enrollment summary ────────────────────────── */

export function summarizeLearning(rows: readonly LearningRowLike[]): LearningSummary {
  let inProgress = 0;
  let completed = 0;
  let lessonsCompleted = 0;
  let lessonsTotal = 0;
  for (const row of rows) {
    if (row.enrollment_status === "completed") completed += 1;
    else inProgress += 1;
    lessonsCompleted += row.completed_lessons;
    lessonsTotal += row.total_lessons;
  }
  return { inProgress, completed, lessonsCompleted, lessonsTotal };
}
