/**
 * POST /api/learn/quiz — submit a quiz attempt for server-side grading.
 *
 * The client sends ONLY raw answers; grading happens here against the
 * server-only quiz_answer_keys table (service-role client — the table has
 * zero RLS policies). Returns per-question correctness + authored
 * explanations, never the correct answers themselves.
 *
 * The publication is fetched by id with the ADMIN client so a learner who
 * started v1 can still submit after a republish retires v1 ("grade what they
 * saw") — access is verified against the COURSE (enrollment/authorship) via
 * the user-scoped client first.
 */

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLearnerAccess } from "@/lib/learn/access";
import { LearnError } from "@/lib/learn/errors";
import { parsePublicationSnapshot } from "@/lib/learn/resolve";
import { learnErrorResponse, parseBody, requireUser } from "@/lib/learn/routeHelpers";
import { QuizSubmissionRequestSchema } from "@/lib/learn/schemas";
import { submitQuizAttempt } from "@/lib/learn/quizService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, QuizSubmissionRequestSchema);
  if (!body.ok) return body.response;
  const { supabase, user } = auth;

  try {
    const admin = createAdminClient();
    const publication = await admin
      .from("course_publications")
      .select("*")
      .eq("id", body.data.publicationId)
      .maybeSingle();
    if (publication.error) throw publication.error;
    if (!publication.data) throw new LearnError("not_found", "Publication not found.");

    const access = await getLearnerAccess(supabase, user.id, publication.data.course_id);
    if (!access) throw new LearnError("not_enrolled", "Enroll in this course to take quizzes.");

    const result = await submitQuizAttempt(admin, {
      userId: user.id,
      role: access.role,
      courseId: publication.data.course_id,
      publication: {
        id: publication.data.id,
        version: publication.data.version,
        snapshot: parsePublicationSnapshot(publication.data),
      },
      request: body.data,
    });
    return NextResponse.json(result);
  } catch (error) {
    return learnErrorResponse(error);
  }
}
