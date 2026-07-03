/**
 * Learner access checks. Two roles can open lesson content:
 *   student — has an active/completed enrollment in the course
 *   author  — always previews their own published course
 * Works with the request-scoped client (RLS lets a user read their own
 * enrollments, and the courses row only resolves for its author because
 * courses.visibility stays 'private') — so these checks need no admin client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

export type EnrollmentRow = Database["public"]["Tables"]["enrollments"]["Row"];

export type LearnerAccess =
  | { role: "author" }
  | { role: "student"; enrollment: EnrollmentRow }
  | null;

export async function getEnrollment(
  supabase: DB,
  userId: string,
  courseId: string
): Promise<EnrollmentRow | null> {
  const { data, error } = await supabase
    .from("enrollments")
    .select("*")
    .eq("course_id", courseId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getLearnerAccess(
  supabase: DB,
  userId: string,
  courseId: string
): Promise<LearnerAccess> {
  const [enrollment, authored] = await Promise.all([
    getEnrollment(supabase, userId, courseId),
    supabase
      .from("courses")
      .select("id")
      .eq("id", courseId)
      .eq("author_id", userId)
      .maybeSingle(),
  ]);
  if (authored.error) throw authored.error;
  if (authored.data) return { role: "author" };
  if (enrollment && (enrollment.status === "active" || enrollment.status === "completed")) {
    return { role: "student", enrollment };
  }
  return null;
}
