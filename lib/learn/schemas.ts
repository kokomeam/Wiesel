/**
 * Zod contracts for the student learning runtime (Milestone 2). Single source
 * of truth for every /api/learn payload — types are INFERRED, never duplicated.
 *
 * Trust boundary reminder: the client only ever reports WHAT THE LEARNER DID
 * (answers picked, slides seen, video position). Scores, correctness, progress
 * status/pct, and completion are all computed SERVER-SIDE (lib/learn/grading.ts
 * + lib/learn/completion.ts) — nothing in these request shapes is trusted as a
 * grade or a completion claim.
 */

import { z } from "zod";

/* ─────────────────────────── Quiz submissions ──────────────────────────── */

/** A learner's answer to one question, shaped per question kind. */
export const QuizQuestionResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("multiple_choice"),
    questionId: z.string().min(1),
    choiceId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("multi_select"),
    questionId: z.string().min(1),
    choiceIds: z.array(z.string().min(1)).max(50),
  }),
  z.object({
    kind: z.literal("true_false"),
    questionId: z.string().min(1),
    answer: z.boolean(),
  }),
  z.object({
    kind: z.literal("short_answer"),
    questionId: z.string().min(1),
    text: z.string().max(2000),
  }),
]);
export type QuizQuestionResponse = z.infer<typeof QuizQuestionResponseSchema>;

export const QuizSubmissionRequestSchema = z.object({
  publicationId: z.string().min(1),
  blockId: z.string().min(1),
  responses: z.array(QuizQuestionResponseSchema).max(200),
  /** Client-reported start time (ISO). The server clamps it to [now-24h, now]. */
  startedAt: z.string().optional(),
  /** Per-question think time (Milestone 3 instruments this; optional now). */
  timeMsByQuestion: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export type QuizSubmissionRequest = z.infer<typeof QuizSubmissionRequestSchema>;

/** Per-question outcome returned to the learner: correctness + the authored
 *  explanation — NEVER the correct answer itself (retakes are unlimited, so
 *  returning the key would defeat the check). */
export const QuestionGradeSchema = z.object({
  questionId: z.string(),
  answered: z.boolean(),
  correct: z.boolean(),
  explanation: z.string().optional(),
});
export type QuestionGrade = z.infer<typeof QuestionGradeSchema>;

export const LessonProgressSnapshotSchema = z.object({
  lessonId: z.string(),
  status: z.enum(["not_started", "in_progress", "completed"]),
  pct: z.number().min(0).max(100),
  courseCompleted: z.boolean(),
});
export type LessonProgressSnapshot = z.infer<typeof LessonProgressSnapshotSchema>;

export const QuizGradeResultSchema = z.object({
  /** Null when the grader ran but nothing was recorded (author preview). */
  attemptId: z.string().nullable(),
  attemptNumber: z.number().int().min(1).nullable(),
  score: z.number().int().min(0),
  maxScore: z.number().int().min(1),
  questions: z.array(QuestionGradeSchema),
  /** Progress after the attempt (absent for author preview). */
  progress: LessonProgressSnapshotSchema.optional(),
});
export type QuizGradeResult = z.infer<typeof QuizGradeResultSchema>;

/* ────────────────────────── Homework submissions ───────────────────────── */

export const HomeworkSubmissionRequestSchema = z
  .object({
    publicationId: z.string().min(1),
    blockId: z.string().min(1),
    text: z.string().trim().max(20000).default(""),
    /** Storage object paths already uploaded to course-assets. The server
     *  additionally enforces they sit under the caller's own uid folder. */
    filePaths: z.array(z.string().min(1).max(500)).max(10).default([]),
  })
  .refine((v) => v.text.length > 0 || v.filePaths.length > 0, {
    message: "A submission needs text or at least one file.",
  });
export type HomeworkSubmissionRequest = z.infer<typeof HomeworkSubmissionRequestSchema>;

/* ─────────────────────────────── Progress ──────────────────────────────── */

/**
 * Server-merged trackable state stored in learn_progress.progress_state.
 * All fields optional so a legacy/empty jsonb parses cleanly.
 */
export const ProgressStateSchema = z.object({
  /** deck blockId → slide ids the learner has viewed. */
  viewedSlides: z.record(z.string(), z.array(z.string())).optional(),
  /** video blockId → furthest playback percent reached (0–100). */
  videoPct: z.record(z.string(), z.number().min(0).max(100)).optional(),
  /** Blocks viewed to the end (imported decks paged through). */
  viewedBlocks: z.array(z.string()).optional(),
  /** Explicit "mark complete" for lessons with no trackable content. */
  markedComplete: z.boolean().optional(),
});
export type ProgressState = z.infer<typeof ProgressStateSchema>;

/** What the learner DID — never what it's worth. */
export const ProgressActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("lesson_opened"), lessonId: z.string().min(1) }),
  z.object({
    action: z.literal("slides_viewed"),
    lessonId: z.string().min(1),
    blockId: z.string().min(1),
    slideIds: z.array(z.string().min(1)).min(1).max(500),
  }),
  z.object({
    action: z.literal("video_progress"),
    lessonId: z.string().min(1),
    blockId: z.string().min(1),
    pct: z.number().min(0).max(100),
  }),
  z.object({
    action: z.literal("block_viewed"),
    lessonId: z.string().min(1),
    blockId: z.string().min(1),
  }),
  z.object({ action: z.literal("mark_complete"), lessonId: z.string().min(1) }),
]);
export type ProgressAction = z.infer<typeof ProgressActionSchema>;

export const ProgressRequestSchema = z.object({
  courseId: z.string().min(1),
  action: ProgressActionSchema,
});
export type ProgressRequest = z.infer<typeof ProgressRequestSchema>;

/* ─────────────────────────────── Enrollment ────────────────────────────── */

export const EnrollRequestSchema = z.object({
  courseId: z.string().min(1),
  /** M-D clip attribution: the /l/{code} short-link ref that brought this
   *  learner here (rides the URL → EnrollButton → here; optional, additive). */
  refCode: z.string().max(20).optional(),
});
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;
