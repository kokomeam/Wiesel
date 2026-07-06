/**
 * Server-side quiz attempt pipeline — the ONLY place attempts are written and
 * the only consumer of quiz_answer_keys (via the service-role client; the
 * table has zero RLS policies, so no request-scoped client can ever read it).
 *
 * Flow: verify the block is a quiz in the given publication's snapshot → load
 * that publication's keys → grade (pure, lib/learn/grading.ts) → record the
 * attempt + per-question responses → recompute lesson progress. The client's
 * payload contributes ONLY the raw answers; score/correctness are computed
 * here. Authors previewing their own course get a graded result but nothing
 * recorded (their attempts would pollute learner analytics).
 *
 * Attempt numbers are 1-based per (user, block) across ALL versions (block
 * ids are stable across republishes). The unique index backstops the
 * max+1 read: on a rare double-submit race the insert retries once.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { emitServerEvent } from "@/lib/analytics/serverEmit";
import {
  QuizBlockAnswerKeysSchema,
  type PublicationSnapshot,
} from "@/lib/course/publish/schemas";
import { LearnError } from "./errors";
import { gradeQuiz } from "./grading";
import { recomputeLessonProgress } from "./progressService";
import type { QuizGradeResult, QuizSubmissionRequest } from "./schemas";

type DB = SupabaseClient<Database>;

interface QuizBlockLocation {
  lessonId: string;
  questionCount: number;
}

function locateQuizBlock(
  snapshot: PublicationSnapshot,
  blockId: string
): QuizBlockLocation | null {
  for (const courseModule of snapshot.modules) {
    for (const lesson of courseModule.lessons) {
      const block = lesson.blocks.find((b) => b.id === blockId);
      if (block) {
        if (block.type !== "quiz") return null;
        return { lessonId: lesson.id, questionCount: block.questions.length };
      }
    }
  }
  return null;
}

/** Clamp a client-reported ISO start time to [now-24h, now]. */
export function clampStartedAt(startedAt: string | undefined, now: Date): string {
  const nowMs = now.getTime();
  const parsed = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (Number.isNaN(parsed)) return now.toISOString();
  const clamped = Math.min(nowMs, Math.max(parsed, nowMs - 24 * 60 * 60 * 1000));
  return new Date(clamped).toISOString();
}

export interface SubmitQuizArgs {
  userId: string;
  /** Verified by the caller: "student" records the attempt; "author" previews. */
  role: "student" | "author";
  courseId: string;
  publication: { id: string; version: number; snapshot: PublicationSnapshot };
  request: QuizSubmissionRequest;
}

export async function submitQuizAttempt(
  admin: DB,
  args: SubmitQuizArgs
): Promise<QuizGradeResult> {
  const { userId, courseId, publication, request } = args;

  const location = locateQuizBlock(publication.snapshot, request.blockId);
  if (!location) {
    throw new LearnError("not_found", "That quiz isn't part of this publication.");
  }
  if (location.questionCount === 0) {
    throw new LearnError("invalid_request", "This quiz has no questions.");
  }

  const keyRow = await admin
    .from("quiz_answer_keys")
    .select("keys")
    .eq("publication_id", publication.id)
    .eq("block_id", request.blockId)
    .maybeSingle();
  if (keyRow.error) throw keyRow.error;
  if (!keyRow.data) {
    throw new LearnError("server_error", "Answer keys are missing for this quiz.");
  }
  const keys = QuizBlockAnswerKeysSchema.parse(keyRow.data.keys);

  const grade = gradeQuiz(keys, request.responses);

  if (args.role === "author") {
    return {
      attemptId: null,
      attemptNumber: null,
      score: grade.score,
      maxScore: grade.maxScore,
      questions: grade.perQuestion,
    };
  }

  const now = new Date();
  const startedAt = clampStartedAt(request.startedAt, now);

  let attemptId: string | null = null;
  let attemptNumber = 0;
  for (let tries = 0; tries < 2 && attemptId === null; tries += 1) {
    const prev = await admin
      .from("quiz_attempts")
      .select("attempt_number")
      .eq("user_id", userId)
      .eq("block_id", request.blockId)
      .order("attempt_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prev.error) throw prev.error;
    attemptNumber = (prev.data?.attempt_number ?? 0) + 1;
    const inserted = await admin
      .from("quiz_attempts")
      .insert({
        publication_id: publication.id,
        version: publication.version,
        course_id: courseId,
        block_id: request.blockId,
        user_id: userId,
        attempt_number: attemptNumber,
        score: grade.score,
        max_score: grade.maxScore,
        started_at: startedAt,
        submitted_at: now.toISOString(),
      })
      .select("id")
      .single();
    if (inserted.error) {
      // 23505 = unique violation (attempt-number race) → re-read and retry once.
      if (inserted.error.code === "23505") continue;
      throw inserted.error;
    }
    attemptId = inserted.data.id;
  }
  if (attemptId === null) {
    throw new LearnError("conflict", "Could not record the attempt — please retry.");
  }

  // Only ANSWERED questions get response rows (the table records responses;
  // an unanswered question is the absence of one — it still counts against
  // the attempt's score above).
  const responsesByQuestion = new Map(request.responses.map((r) => [r.questionId, r]));
  const responseRows = grade.perQuestion
    .filter((q) => q.answered && responsesByQuestion.has(q.questionId))
    .map((q) => ({
      attempt_id: attemptId as string,
      question_id: q.questionId,
      response: responsesByQuestion.get(q.questionId) as unknown as Json,
      correct: q.correct,
      time_ms: request.timeMsByQuestion?.[q.questionId] ?? null,
    }));
  if (responseRows.length > 0) {
    const responses = await admin.from("question_responses").insert(responseRows);
    if (responses.error) throw responses.error;
  }

  // Server-emitted analytics event (hybrid model): fires the moment the
  // attempt row exists, keyed by the attempt id — a retry can't double-count
  // and a closed tab can't lose it. Never throws.
  await emitServerEvent(
    admin,
    userId,
    {
      publicationId: publication.id,
      version: publication.version,
      courseId,
      lessonId: location.lessonId,
    },
    { eventType: "quiz_submitted", blockId: request.blockId, attemptId },
    attemptId
  );

  const progress = await recomputeLessonProgress(
    admin,
    {
      userId,
      courseId,
      publicationId: publication.id,
      version: publication.version,
      snapshot: publication.snapshot,
    },
    location.lessonId
  );

  return {
    attemptId,
    attemptNumber,
    score: grade.score,
    maxScore: grade.maxScore,
    questions: grade.perQuestion,
    progress,
  };
}
