/**
 * TUTOR-1 Amendment A4, Wave 3 — retrieval ELIGIBILITY (the scope boundary).
 *
 * A lesson is ELIGIBLE for retrieval iff the learner has COMPLETED it (the A0-2
 * predicate: `learn_progress.status = 'completed'`) OR it is the ACTIVE lesson.
 * Nothing else — never lesson ORDINAL position (a learner who jumped ahead has
 * few eligible lessons, and that is correct: A4-14). This is the hard boundary
 * every retrieval query is filtered by, INSIDE the SQL.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/**
 * The set of lessons the learner has COMPLETED for a course (the reusable
 * eligibility predicate — index-covered on `(user_id, course_id)`). Best-effort:
 * any error → empty set (retrieval then scopes to the active lesson only — the
 * conservative direction, never widening scope on a failed read).
 */
export async function loadCompletedLessonIds(
  client: DB,
  userId: string,
  courseId: string
): Promise<Set<string>> {
  try {
    const { data, error } = await client
      .from("learn_progress")
      .select("lesson_id")
      .eq("user_id", userId)
      .eq("course_id", courseId)
      .eq("status", "completed");
    if (error || !data) return new Set();
    return new Set(data.map((r) => r.lesson_id));
  } catch {
    return new Set();
  }
}

export interface Eligibility {
  /** The active (docked) lesson, or null (a general/course-landing turn). */
  activeLessonId: string | null;
  /** Completed lessons OTHER than the active one (the Tier-2 candidate pool). */
  completed: string[];
  /** The full eligible set = active ∪ completed (the retrieval filter). */
  eligible: Set<string>;
}

/**
 * Compute the eligible lessons = the active lesson (if any) ∪ the completed
 * lessons. PURE. `completed` excludes the active lesson (it's the Tier-2 pool);
 * `eligible` includes the active lesson.
 */
export function computeEligibleLessons(args: {
  activeLessonId: string | null;
  completedLessonIds: Iterable<string>;
}): Eligibility {
  const completedSet = new Set(args.completedLessonIds);
  const eligible = new Set<string>(completedSet);
  if (args.activeLessonId) eligible.add(args.activeLessonId);
  const completed = [...completedSet].filter((l) => l !== args.activeLessonId);
  return { activeLessonId: args.activeLessonId ?? null, completed, eligible };
}
