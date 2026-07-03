/**
 * PURE course-progress summaries for the learner landing page and the
 * "My learning" cards: lessons completed / total, overall percent, and the
 * "continue where you left off" target.
 */

import type { PublicationSnapshot, PublishedLesson } from "@/lib/course/publish/schemas";

export interface LessonProgressRowLike {
  lesson_id: string;
  status: string;
  pct: number;
  last_activity_at: string;
}

export interface LessonProgressView {
  lessonId: string;
  status: "not_started" | "in_progress" | "completed";
  pct: number;
}

export interface CourseProgressSummary {
  totalLessons: number;
  completedLessons: number;
  /** Mean of per-lesson pct across ALL snapshot lessons (missing rows = 0). */
  pct: number;
  /** Lesson to open on "Continue": the most recently active unfinished lesson,
   *  else the first not-started lesson in course order, else null (all done). */
  continueLessonId: string | null;
  byLesson: Map<string, LessonProgressView>;
}

function orderedLessons(snapshot: PublicationSnapshot): PublishedLesson[] {
  return snapshot.modules.flatMap((m) => m.lessons);
}

export function buildCourseProgressSummary(
  snapshot: PublicationSnapshot,
  rows: readonly LessonProgressRowLike[]
): CourseProgressSummary {
  const lessons = orderedLessons(snapshot);
  const rowByLesson = new Map(rows.map((r) => [r.lesson_id, r]));

  const byLesson = new Map<string, LessonProgressView>();
  let completedLessons = 0;
  let pctSum = 0;
  for (const lesson of lessons) {
    const row = rowByLesson.get(lesson.id);
    const status =
      row?.status === "completed"
        ? "completed"
        : row
          ? "in_progress"
          : "not_started";
    const pct = status === "completed" ? 100 : Math.max(0, Math.min(100, row?.pct ?? 0));
    if (status === "completed") completedLessons += 1;
    pctSum += pct;
    byLesson.set(lesson.id, { lessonId: lesson.id, status, pct });
  }

  let continueLessonId: string | null = null;
  let latestActivity = "";
  for (const lesson of lessons) {
    const row = rowByLesson.get(lesson.id);
    if (!row || row.status === "completed") continue;
    if (row.last_activity_at > latestActivity) {
      latestActivity = row.last_activity_at;
      continueLessonId = lesson.id;
    }
  }
  if (!continueLessonId) {
    continueLessonId = lessons.find((l) => byLesson.get(l.id)?.status === "not_started")?.id ?? null;
  }

  return {
    totalLessons: lessons.length,
    completedLessons,
    pct: lessons.length === 0 ? 0 : Math.round(pctSum / lessons.length),
    continueLessonId,
    byLesson,
  };
}
