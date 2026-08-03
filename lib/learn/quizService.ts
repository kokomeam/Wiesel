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
import { buildResponseSummary, gradeQuiz } from "./grading";
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

  // Only ANSWERED questions get response + detail rows (an unanswered question
  // is the absence of a row — it still counts against the attempt's score
  // above). response_summary carries the learner's SELECTIONS only — never any
  // answer-key material.
  const responsesByQuestion = new Map(request.responses.map((r) => [r.questionId, r]));
  const answered = grade.perQuestion.filter(
    (q) => q.answered && responsesByQuestion.has(q.questionId)
  );
  const responsePayload = answered.map((q) => {
    const response = responsesByQuestion.get(q.questionId)!;
    return {
      question_id: q.questionId,
      response: response as unknown as Json,
      correct: q.correct,
      time_ms: request.timeMsByQuestion?.[q.questionId] ?? null,
    };
  });
  const detailPayload = answered.map((q) => {
    const response = responsesByQuestion.get(q.questionId)!;
    return {
      question_id: q.questionId,
      correct: q.correct,
      response_summary: buildResponseSummary(response),
    };
  });

  // ONE transaction: attempt (attempt_number computed in SQL, per (user, block)
  // across all versions, with a bounded retry) + response rows + strict-regime
  // detail rows. Idempotent on replay of the same attempt id.
  const recorded = await admin.rpc("record_quiz_attempt", {
    p_attempt: {
      publication_id: publication.id,
      version: publication.version,
      course_id: courseId,
      block_id: request.blockId,
      user_id: userId,
      score: grade.score,
      max_score: grade.maxScore,
      started_at: startedAt,
      submitted_at: now.toISOString(),
    } as unknown as Json,
    p_responses: responsePayload as unknown as Json,
    p_detail: detailPayload as unknown as Json,
  });
  if (recorded.error) throw recorded.error;
  const recordedResult = recorded.data as { attempt_id: string; attempt_number: number } | null;
  if (!recordedResult) {
    throw new LearnError("conflict", "Could not record the attempt — please retry.");
  }
  const attemptId = recordedResult.attempt_id;
  const attemptNumber = recordedResult.attempt_number;

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
