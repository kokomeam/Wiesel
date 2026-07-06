/**
 * Publishing payload schemas — Zod is the single source of truth here; every
 * type is INFERRED (unlike lib/course/schemas.ts, which pins hand-written
 * interfaces). Covers: the immutable publication SNAPSHOT (the exact document
 * students receive), the server-only quiz ANSWER KEYS stripped out of it, the
 * publish PRE-FLIGHT report, the republish DIFF summary, and the publication
 * summary the API returns.
 *
 * Security invariant: `PublishedQuizQuestionSchema` members are STRICT objects
 * — a question that still carries `correctChoiceId` / `correctAnswer` /
 * `expectedAnswer` / `acceptedAnswers` / `explanation` FAILS validation, so an
 * unstripped snapshot can never even parse.
 */

import { z } from "zod";
import type { LessonBlock, QuizBlock } from "@/lib/course/types";
import {
  baseBlockShape,
  CoursePlanSchema,
  CourseThemeSchema,
  LessonBlockSchema,
  QuizSettingsSchema,
} from "@/lib/course/schemas";

export const PublicationVisibilitySchema = z.enum(["public", "unlisted"]);
export type PublicationVisibility = z.infer<typeof PublicationVisibilitySchema>;

export const PublicationStatusSchema = z.enum(["live", "unpublished"]);
export type PublicationStatus = z.infer<typeof PublicationStatusSchema>;

/* ─────────────────── Published (answer-free) quiz shape ────────────────── */

const publishedQuestionBase = {
  id: z.string(),
  prompt: z.string(),
  objectiveId: z.string().optional(),
};

const publishedChoice = z.strictObject({ id: z.string(), text: z.string() });

/** What a learner's client may see of a quiz question. STRICT: any leftover
 *  answer/explanation key is a validation error, not silently stripped. */
export const PublishedQuizQuestionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...publishedQuestionBase,
    kind: z.literal("multiple_choice"),
    choices: z.array(publishedChoice),
  }),
  z.strictObject({
    ...publishedQuestionBase,
    kind: z.literal("multi_select"),
    choices: z.array(publishedChoice),
  }),
  z.strictObject({
    ...publishedQuestionBase,
    kind: z.literal("true_false"),
  }),
  z.strictObject({
    ...publishedQuestionBase,
    kind: z.literal("short_answer"),
  }),
]);
export type PublishedQuizQuestion = z.infer<typeof PublishedQuizQuestionSchema>;

export const PublishedQuizBlockSchema = z.object({
  ...baseBlockShape,
  type: z.literal("quiz"),
  settings: QuizSettingsSchema.optional(),
  questions: z.array(PublishedQuizQuestionSchema),
});
export type PublishedQuizBlock = z.infer<typeof PublishedQuizBlockSchema>;

/** A snapshot block: any draft block type except quiz, whose published shape
 *  is the answer-free `PublishedQuizBlock`. */
export type PublishedLessonBlock = Exclude<LessonBlock, QuizBlock> | PublishedQuizBlock;

/** Runtime union built from the existing LessonBlockSchema members with the
 *  quiz member swapped for the published one (single source of truth for the
 *  other 8 block types). The cast pins the inferred static type. */
const nonQuizBlockOptions = LessonBlockSchema.options.filter(
  (option) => option.shape.type.value !== "quiz"
);
export const PublishedLessonBlockSchema = z.discriminatedUnion("type", [
  PublishedQuizBlockSchema,
  ...nonQuizBlockOptions,
] as never) as unknown as z.ZodType<PublishedLessonBlock>;

/* ─────────────────────────── Snapshot document ─────────────────────────── */

export const PublishedLessonSchema = z.object({
  id: z.string(),
  type: z.literal("lesson"),
  title: z.string(),
  objective: z.string().optional(),
  order: z.number().int(),
  estimatedMinutes: z.number().optional(),
  blocks: z.array(PublishedLessonBlockSchema),
});
export type PublishedLesson = z.infer<typeof PublishedLessonSchema>;

export const PublishedModuleSchema = z.object({
  id: z.string(),
  type: z.literal("module"),
  title: z.string(),
  description: z.string().optional(),
  order: z.number().int(),
  lessons: z.array(PublishedLessonSchema),
});
export type PublishedModule = z.infer<typeof PublishedModuleSchema>;

/**
 * The immutable, fully denormalized document written to
 * course_publications.snapshot. Node ids ARE the draft row ids (stable across
 * versions). Deliberately carries NO volatile metadata (timestamps ride on the
 * row) so the content hash only moves when content does.
 */
export const PublicationSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  course: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    audience: z.string().optional(),
    level: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    plan: CoursePlanSchema,
    theme: CourseThemeSchema,
  }),
  modules: z.array(PublishedModuleSchema),
});
export type PublicationSnapshot = z.infer<typeof PublicationSnapshotSchema>;

/* ───────────────────────────── Answer keys ─────────────────────────────── */

/** Per-question grading key — exactly the fields stripped from the snapshot. */
export const AnswerKeyEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("multiple_choice"),
    questionId: z.string(),
    correctChoiceId: z.string(),
    explanation: z.string().optional(),
  }),
  z.object({
    kind: z.literal("multi_select"),
    questionId: z.string(),
    correctChoiceIds: z.array(z.string()),
    explanation: z.string().optional(),
  }),
  z.object({
    kind: z.literal("true_false"),
    questionId: z.string(),
    correctAnswer: z.boolean(),
    explanation: z.string().optional(),
  }),
  z.object({
    kind: z.literal("short_answer"),
    questionId: z.string(),
    expectedAnswer: z.string(),
    acceptedAnswers: z.array(z.string()).optional(),
    explanation: z.string().optional(),
  }),
]);
export type AnswerKeyEntry = z.infer<typeof AnswerKeyEntrySchema>;

/** One quiz block's keys (the `keys` jsonb of a quiz_answer_keys row). */
export const QuizBlockAnswerKeysSchema = z.object({
  questions: z.array(AnswerKeyEntrySchema),
});
export type QuizBlockAnswerKeys = z.infer<typeof QuizBlockAnswerKeysSchema>;

/** Everything publish_course inserts into quiz_answer_keys. */
export const PublicationAnswerKeysSchema = z.array(
  z.object({ blockId: z.string(), keys: QuizBlockAnswerKeysSchema })
);
export type PublicationAnswerKeys = z.infer<typeof PublicationAnswerKeysSchema>;

/* ───────────────────────── Pre-flight report ───────────────────────────── */

export const PreflightIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  /** Where in the course tree the issue sits (best-effort locators). */
  where: z
    .object({
      moduleId: z.string().optional(),
      lessonId: z.string().optional(),
      blockId: z.string().optional(),
      slideId: z.string().optional(),
      questionId: z.string().optional(),
    })
    .optional(),
});
export type PreflightIssue = z.infer<typeof PreflightIssueSchema>;

export const PreflightReportSchema = z.object({
  /** True when there are no ERRORS (warnings are overridable). */
  ok: z.boolean(),
  errors: z.array(PreflightIssueSchema),
  warnings: z.array(PreflightIssueSchema),
  counts: z.object({
    modules: z.number().int(),
    lessons: z.number().int(),
    blocks: z.number().int(),
    slides: z.number().int(),
  }),
});
export type PreflightReport = z.infer<typeof PreflightReportSchema>;

/* ─────────────────────────── Diff + summaries ──────────────────────────── */

const diffCounts = z.object({
  added: z.number().int(),
  changed: z.number().int(),
  removed: z.number().int(),
});

export const PublishDiffSummarySchema = z.object({
  firstPublish: z.boolean(),
  lessons: diffCounts,
  blocks: diffCounts,
});
export type PublishDiffSummary = z.infer<typeof PublishDiffSummarySchema>;

/** Publication metadata the API returns (never the snapshot body). */
export const PublicationSummarySchema = z.object({
  id: z.string(),
  courseId: z.string(),
  version: z.number().int(),
  slug: z.string(),
  previousSlugs: z.array(z.string()),
  visibility: PublicationVisibilitySchema,
  status: PublicationStatusSchema,
  contentHash: z.string(),
  publishedAt: z.string(),
});
export type PublicationSummary = z.infer<typeof PublicationSummarySchema>;

/* ─────────────────────────── API request bodies ────────────────────────── */

export const PublishRequestSchema = z.object({
  courseId: z.string().min(1),
  /** First publish only (republish inherits the course's slug). */
  slug: z.string().optional(),
  visibility: PublicationVisibilitySchema.optional(),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export const PublicationSettingsUpdateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("unpublish") }),
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("set_slug"), slug: z.string().min(1) }),
  z.object({ action: z.literal("set_visibility"), visibility: PublicationVisibilitySchema }),
]);
export type PublicationSettingsUpdate = z.infer<typeof PublicationSettingsUpdateSchema>;

export const PatchPublicationRequestSchema = z.object({
  courseId: z.string().min(1),
  update: PublicationSettingsUpdateSchema,
});
export type PatchPublicationRequest = z.infer<typeof PatchPublicationRequestSchema>;

/** What publish_course's jsonb return parses to. */
export const PublishRpcResultSchema = z.object({
  id: z.string(),
  courseId: z.string(),
  version: z.number().int(),
  slug: z.string(),
  visibility: PublicationVisibilitySchema,
  status: PublicationStatusSchema,
  contentHash: z.string(),
  publishedAt: z.string(),
});
export type PublishRpcResult = z.infer<typeof PublishRpcResultSchema>;
