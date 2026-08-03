/**
 * POST /api/learn/quiz — submit a quiz attempt for server-side grading.
 *
 * The client sends ONLY raw answers; grading happens here against the
 * server-only quiz_answer_keys table (service-role client — the table has
 * zero RLS policies). Returns per-question correctness + authored
 * explanations, never the correct answers themselves.
 *
 * "Grade what they saw": the publication is fetched BY ID — which is exactly
 * the publication cache's key (PERF-1 C1: the cache reads with the admin
 * client, so a learner who started v1 can still submit after a republish
 * retires v1, byte-identically to the old admin select). Access is verified
 * against the COURSE (enrollment/authorship) via the user-scoped client.
 */

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLearnerAccess } from "@/lib/learn/access";
import { LearnError } from "@/lib/learn/errors";
import { getCachedSnapshot } from "@/lib/learn/publicationCache";
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
    let cached: Awaited<ReturnType<typeof getCachedSnapshot>>;
    try {
      cached = await getCachedSnapshot(body.data.publicationId);
    } catch (err) {
      // The cache throws on an unknown id — the old 404 semantics.
      if (err instanceof Error && err.message.endsWith("not found")) {
        throw new LearnError("not_found", "Publication not found.");
      }
      throw err;
    }

    const access = await getLearnerAccess(supabase, user.id, cached.courseId);
    if (!access) throw new LearnError("not_enrolled", "Enroll in this course to take quizzes.");

    const admin = createAdminClient();
    const result = await submitQuizAttempt(admin, {
      userId: user.id,
      role: access.role,
      courseId: cached.courseId,
      publication: {
        id: body.data.publicationId,
        version: cached.version,
        snapshot: cached.snapshot,
      },
      request: body.data,
    });
    return NextResponse.json(result);
  } catch (error) {
    return learnErrorResponse(error);
  }
}
