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

/* ─────────────────── Graph-aware mastery review source (TUTOR-1 W2) ──────── */

/**
 * The shape a `/home` "Worth a review" card renders — identical whether it comes
 * from the legacy heuristic (below-threshold quizzes) or the graph-aware mastery
 * review queue. The page must not change, so both sources produce THIS.
 */
export interface HomeReviewItem {
  /** Stable React key (block_id for the heuristic, node_id for mastery). */
  key: string;
  /** The bold primary line (quiz title, or the concept title to review). */
  quizTitle: string;
  /** The muted secondary line's first half (lesson title, or a reason label). */
  lessonTitle: string;
  /** The muted secondary line's second half (course title). */
  courseTitle: string;
  /** The trailing rose pill — a 0..100 percentage (quiz score, or mastery level). */
  scorePct: number;
  /** Where the card links (the lesson, or the course landing). */
  href: string;
}

/**
 * One row of the `my_review_queue(course_id)` definer RPC. `title` is joined from
 * concept_nodes INSIDE the definer function (learners can't read concept_nodes
 * directly) — it is optional here so the mapper still runs against a DB where the
 * title column hasn't been re-applied yet (the row simply lacks a display title
 * then, and that node is skipped rather than shown as a raw uuid).
 */
export interface MasteryReviewRow {
  node_id: string;
  title?: string | null;
  rank: number;
  score: number;
  reason?: unknown;
}

/** A learner's OWN learner_mastery row (own-readable via the select policy) —
 *  the source of the mastery-level percentage shown in the pill. */
export interface MasteryLevelRow {
  node_id: string;
  decayed_p: number;
}

/** The reason jsonb a mastery queue row carries (all optional — defensive parse). */
interface MasteryReviewReason {
  belowThreshold?: boolean;
  dependents?: number;
  decayGap?: number;
}

function parseReason(reason: unknown): MasteryReviewReason {
  if (!reason || typeof reason !== "object") return {};
  const r = reason as Record<string, unknown>;
  return {
    belowThreshold: typeof r.belowThreshold === "boolean" ? r.belowThreshold : undefined,
    dependents: typeof r.dependents === "number" ? r.dependents : undefined,
    decayGap: typeof r.decayGap === "number" ? r.decayGap : undefined,
  };
}

/**
 * Map graph-aware mastery review-queue rows (one course) into `HomeReviewItem`s —
 * the SAME shape the heuristic produces, so the page renders identically. The pill
 * shows the learner's current mastery level (decayed_p, from their own
 * learner_mastery rows) as a percentage; the secondary line names WHY the concept
 * surfaced ("Below mastery" when the node is under threshold, else "Fading" for a
 * decayed but still-above-threshold concept). A row whose title didn't resolve
 * (pre-migration DB, or a merged/retired node) is skipped — never shown as a uuid.
 * Rows arrive rank-ordered from the RPC; order is preserved.
 */
export function masteryReviewItems(
  rows: readonly MasteryReviewRow[],
  courseTitle: string,
  courseHref: string,
  masteryLevels: readonly MasteryLevelRow[]
): HomeReviewItem[] {
  const levelByNode = new Map(masteryLevels.map((m) => [m.node_id, m.decayed_p]));
  const out: HomeReviewItem[] = [];
  for (const row of rows) {
    const title = row.title?.trim();
    if (!title) continue; // no learner-readable title → skip (never render a uuid)
    const reason = parseReason(row.reason);
    const level = levelByNode.get(row.node_id);
    // Pill = current mastery level %. Absent (no own row yet) → derive from the
    // decay gap as a coarse fallback, else 0.
    const scorePct =
      level !== undefined
        ? Math.round(clamp01(level) * 100)
        : reason.decayGap !== undefined
          ? Math.round(clamp01(1 - reason.decayGap) * 100)
          : 0;
    out.push({
      key: row.node_id,
      quizTitle: title,
      lessonTitle: reason.belowThreshold ? "Below mastery" : "Fading — worth a refresh",
      courseTitle,
      scorePct,
      href: courseHref,
    });
  }
  return out;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * PURE. Choose which "Worth a review" source drives the page: the graph-aware
 * mastery queue when it has any rows, else the legacy quiz heuristic (the day-one
 * / cold-start story — a brand-new learner with no mastery rows still gets the
 * below-threshold-quiz list). Returns a discriminated result so the caller renders
 * the right item builder. The decision is on ROW PRESENCE only (deterministic).
 */
export function pickReviewSource<M, H>(
  masteryRows: readonly M[],
  heuristicRows: readonly H[]
): { source: "mastery"; rows: M[] } | { source: "heuristic"; rows: H[] } {
  if (masteryRows.length > 0) return { source: "mastery", rows: [...masteryRows] };
  return { source: "heuristic", rows: [...heuristicRows] };
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
