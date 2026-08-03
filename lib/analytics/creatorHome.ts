/**
 * PURE helpers for the creator dashboard (/dashboard) — merge the cross-course
 * batch queries (courses, live publications, enrollments, review rollups, open
 * agent findings, draft messages) into per-course health + portfolio totals.
 *
 * No IO, no Supabase client — importable by scripts/verify-creator-home.ts
 * with no DB. The page does the querying (the /analytics picker pattern:
 * courses by author_id, then .in('course_id', ids) batches under author RLS);
 * this module does ALL the math so it stays testable.
 */

import { z } from "zod";
import type { Database } from "@/lib/database.types";

/* ───────────────────────────── Input row types ──────────────────────────── */

type Tables = Database["public"]["Tables"];

export type CourseRow = Pick<
  Tables["courses"]["Row"],
  "id" | "title" | "status" | "updated_at"
> & {
  /** Optional — the column ships in migration 20260711000000; pre-migration
   *  callers (and old test fixtures) simply omit it. */
  cover_image_url?: string | null;
};
export type LivePublicationRow = Pick<
  Tables["course_publications"]["Row"],
  "id" | "course_id" | "version" | "visibility"
>;
export type EnrollmentRow = Pick<Tables["enrollments"]["Row"], "course_id" | "status">;
export type ReviewRollupRow = Pick<
  Tables["rollup_course_reviews"]["Row"],
  "course_id" | "avg_rating" | "review_count"
>;
export type OpenFindingRow = Pick<
  Tables["agent_findings"]["Row"],
  "id" | "course_id" | "finding" | "created_at"
>;
export type DraftMessageRow = Pick<Tables["learner_messages"]["Row"], "id" | "course_id">;
export type FunnelRollupRow = Pick<
  Tables["rollup_lesson_funnel"]["Row"],
  "lesson_id" | "started_count" | "completed_count" | "dropoff_pct"
>;

/* ───────────────────────────── Course health ────────────────────────────── */

export interface CourseHealth {
  id: string;
  title: string;
  /** true when a live publication exists (course_publications status='live'). */
  isLive: boolean;
  /** Live version number, null for drafts. */
  version: number | null;
  /** Live publication id (the funnel rollup key), null for drafts. */
  publicationId: string | null;
  learners: number;
  completedLearners: number;
  /** rollup_course_reviews.avg_rating; null when the course has no reviews. */
  avgRating: number | null;
  reviewCount: number;
  openFindings: number;
  draftMessages: number;
  updatedAt: string;
  /** courses.cover_image_url; null pre-migration or when no cover was set. */
  coverImageUrl: string | null;
}

/** Merge the batch rows into per-course health, preserving `courses` order.
 *  A course with zero rows anywhere still gets a complete all-zero entry. */
export function buildCourseHealth(
  courses: CourseRow[],
  pubs: LivePublicationRow[],
  enrollments: EnrollmentRow[],
  reviews: ReviewRollupRow[],
  findings: OpenFindingRow[],
  drafts: DraftMessageRow[]
): CourseHealth[] {
  const pubByCourse = new Map(pubs.map((p) => [p.course_id, p]));
  const reviewByCourse = new Map(reviews.map((r) => [r.course_id, r]));

  const learnerCount = new Map<string, number>();
  const completedCount = new Map<string, number>();
  for (const row of enrollments) {
    learnerCount.set(row.course_id, (learnerCount.get(row.course_id) ?? 0) + 1);
    if (row.status === "completed") {
      completedCount.set(row.course_id, (completedCount.get(row.course_id) ?? 0) + 1);
    }
  }

  const findingCount = new Map<string, number>();
  for (const row of findings) {
    findingCount.set(row.course_id, (findingCount.get(row.course_id) ?? 0) + 1);
  }
  const draftCount = new Map<string, number>();
  for (const row of drafts) {
    draftCount.set(row.course_id, (draftCount.get(row.course_id) ?? 0) + 1);
  }

  return courses.map((course) => {
    const pub = pubByCourse.get(course.id);
    const review = reviewByCourse.get(course.id);
    const reviewCount = review?.review_count ?? 0;
    return {
      id: course.id,
      title: course.title || "Untitled course",
      isLive: pub !== undefined,
      version: pub?.version ?? null,
      publicationId: pub?.id ?? null,
      learners: learnerCount.get(course.id) ?? 0,
      completedLearners: completedCount.get(course.id) ?? 0,
      // A defensive guard: recompute uses HAVING count(*)>0, but a 0-count
      // row must never render a rating of e.g. 0.00 stars.
      avgRating: reviewCount > 0 ? (review?.avg_rating ?? null) : null,
      reviewCount,
      openFindings: findingCount.get(course.id) ?? 0,
      draftMessages: draftCount.get(course.id) ?? 0,
      updatedAt: course.updated_at,
      coverImageUrl: course.cover_image_url ?? null,
    };
  });
}

/* ─────────────────────────── Portfolio totals ───────────────────────────── */

export interface PortfolioTotals {
  courses: number;
  liveCourses: number;
  learners: number;
  completedLearners: number;
  /** completed / total enrollments, rounded; null when there are 0 enrollments. */
  completionRatePct: number | null;
  /** review_count-weighted mean across courses; null when there are no reviews. */
  avgRating: number | null;
  reviewCount: number;
  openFindings: number;
  /** Courses with ≥1 open finding (the stat tile's "across N courses"). */
  coursesWithFindings: number;
  draftMessages: number;
}

export function portfolioTotals(health: CourseHealth[]): PortfolioTotals {
  let learners = 0;
  let completedLearners = 0;
  let reviewCount = 0;
  let ratingWeightedSum = 0;
  let openFindings = 0;
  let coursesWithFindings = 0;
  let draftMessages = 0;
  let liveCourses = 0;

  for (const c of health) {
    learners += c.learners;
    completedLearners += c.completedLearners;
    openFindings += c.openFindings;
    if (c.openFindings > 0) coursesWithFindings += 1;
    draftMessages += c.draftMessages;
    if (c.isLive) liveCourses += 1;
    if (c.avgRating !== null && c.reviewCount > 0) {
      reviewCount += c.reviewCount;
      ratingWeightedSum += c.avgRating * c.reviewCount;
    }
  }

  return {
    courses: health.length,
    liveCourses,
    learners,
    completedLearners,
    completionRatePct:
      learners > 0 ? Math.round((completedLearners / learners) * 100) : null,
    avgRating:
      reviewCount > 0 ? Math.round((ratingWeightedSum / reviewCount) * 10) / 10 : null,
    reviewCount,
    openFindings,
    coursesWithFindings,
    draftMessages,
  };
}

/* ─────────────────────────── Spotlight course ───────────────────────────── */

/** The funnel-snapshot course: most learners WITH a live publication (funnel
 *  rollups only exist per live publication). Ties break alphabetically by
 *  title so the pick is deterministic. Null when nothing is live. */
export function pickSpotlightCourse(health: CourseHealth[]): CourseHealth | null {
  let best: CourseHealth | null = null;
  for (const c of health) {
    if (!c.isLive) continue;
    if (
      best === null ||
      c.learners > best.learners ||
      (c.learners === best.learners && c.title.localeCompare(best.title) < 0)
    ) {
      best = c;
    }
  }
  return best;
}

/* ─────────────────────────── Funnel summary ─────────────────────────────── */

export interface FunnelLesson {
  lessonId: string;
  started: number;
  completed: number;
  /** Precomputed in SQL via lag(); null on the first lesson. */
  dropoffPct: number | null;
}

export interface FunnelSummary {
  lessons: FunnelLesson[];
  /** Largest positive drop-off; null when the funnel has no drop yet. */
  biggestDropoff: FunnelLesson | null;
  /** max(started) across lessons — the shared bar-scale denominator. */
  maxStarted: number;
}

/** Pass rows already ordered by lesson_order (the query orders them). */
export function funnelSummary(rows: FunnelRollupRow[]): FunnelSummary {
  const lessons: FunnelLesson[] = rows.map((r) => ({
    lessonId: r.lesson_id,
    started: r.started_count,
    completed: r.completed_count,
    dropoffPct: r.dropoff_pct,
  }));

  let biggestDropoff: FunnelLesson | null = null;
  for (const lesson of lessons) {
    if (lesson.dropoffPct === null || lesson.dropoffPct <= 0) continue;
    if (biggestDropoff === null || lesson.dropoffPct > (biggestDropoff.dropoffPct ?? 0)) {
      biggestDropoff = lesson;
    }
  }

  return {
    lessons,
    biggestDropoff,
    maxStarted: lessons.reduce((max, l) => Math.max(max, l.started), 0),
  };
}

/* ─────────────────── Attention rail (agent findings) ────────────────────── */

/** The slice of agent_findings.finding jsonb the rail renders. Parsed
 *  DEFENSIVELY — the jsonb is model-authored; garbage rows are skipped,
 *  never thrown (see lib/ai/maintenanceSchema.ts for the full shape). */
const FindingCardSchema = z.object({
  title: z.string().min(1),
  severity: z.enum(["low", "medium", "high"]).catch("medium"),
  evidence: z
    .object({ summary: z.string().catch("") })
    .catch({ summary: "" }),
});

export interface AttentionFinding {
  id: string;
  courseId: string;
  title: string;
  severity: "low" | "medium" | "high";
  /** The evidence one-liner ("Q3: 64% incorrect over 41 attempts…"); "" when absent. */
  summary: string;
  createdAt: string;
}

const SEVERITY_RANK: Record<AttentionFinding["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Parse + rank open findings for the "Needs your attention" rail:
 *  severity desc, then newest first, capped. Unparseable jsonb → skipped. */
export function parseAttentionFindings(
  rows: OpenFindingRow[],
  cap = 5
): AttentionFinding[] {
  const parsed: AttentionFinding[] = [];
  for (const row of rows) {
    const result = FindingCardSchema.safeParse(row.finding);
    if (!result.success) continue;
    parsed.push({
      id: row.id,
      courseId: row.course_id,
      title: result.data.title,
      severity: result.data.severity,
      summary: result.data.evidence.summary,
      createdAt: row.created_at,
    });
  }
  return parsed
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.createdAt.localeCompare(a.createdAt)
    )
    .slice(0, cap);
}

/* ──────────────── Lesson titles from a publication snapshot ─────────────── */

/**
 * Defensive lessonId→title walk over a publication `snapshot` jsonb, for the
 * funnel card's labels. Deliberately NOT the strict PublicationSnapshotSchema
 * parse — a malformed snapshot must degrade to id-less labels on the
 * dashboard, not 500 the whole page.
 */
export function lessonTitlesFromSnapshot(snapshot: unknown): Map<string, string> {
  const titles = new Map<string, string>();
  if (typeof snapshot !== "object" || snapshot === null) return titles;
  const modules = (snapshot as { modules?: unknown }).modules;
  if (!Array.isArray(modules)) return titles;
  for (const mod of modules) {
    if (typeof mod !== "object" || mod === null) continue;
    const lessons = (mod as { lessons?: unknown }).lessons;
    if (!Array.isArray(lessons)) continue;
    for (const lesson of lessons) {
      if (typeof lesson !== "object" || lesson === null) continue;
      const { id, title } = lesson as { id?: unknown; title?: unknown };
      if (typeof id === "string" && typeof title === "string") {
        titles.set(id, title);
      }
    }
  }
  return titles;
}
