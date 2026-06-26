/**
 * Content-writer tools — one per authored block type. Each takes a SIMPLE
 * content spec, builds a full schema-valid block (blockBuilders.ts), and
 * commits it via SET_BLOCK_CONTENT (targeting an existing block) or ADD_BLOCK
 * (creating a new one) — always inside the validated CoursePatch pipeline.
 *
 * Quality + low-stakes rules are baked into every description and schema: the
 * schemas literally cannot express a score, timer, difficulty, or due date.
 */

import { z } from "zod";
import { findBlock, findLesson } from "@/lib/course/queries";
import type { CoursePatch } from "@/lib/course/patches";
import type { LessonBlock } from "@/lib/course/types";
import {
  buildHomeworkBlock,
  buildLectureBlock,
  buildQuizBlock,
  buildSlideDeckBlock,
} from "./blockBuilders";
import { LAYOUT_IDS, SlideContentEntrySchema, validateSlideContent } from "./slideContent";
import { defineTool, ToolError, type Tool, type ToolContext, type ToolOutcome } from "./types";

/** Commit a freshly-built block: overwrite an existing block (same type) or add
 *  a new one to the target lesson. */
function commitBlock(
  ctx: ToolContext,
  target: { blockId: string | null; lessonId: string | null },
  block: LessonBlock,
  verb: string
): ToolOutcome {
  if (target.blockId) {
    const hit = findBlock(ctx.doc, target.blockId);
    if (!hit) throw new ToolError(`Block ${target.blockId} not found`);
    if (hit.block.type !== block.type) {
      throw new ToolError(
        `Block ${target.blockId} is a ${hit.block.type}, not a ${block.type} — create a new block instead.`
      );
    }
    const patch: CoursePatch = { action: "SET_BLOCK_CONTENT", blockId: target.blockId, block };
    return {
      summary: `${verb} in "${hit.block.title ?? hit.block.type}"`,
      patches: [patch],
      data: { blockId: target.blockId, lessonId: hit.lesson.id, blockType: block.type },
    };
  }
  const lessonId = target.lessonId ?? ctx.lessonId;
  if (!findLesson(ctx.doc, lessonId)) throw new ToolError(`Lesson ${lessonId} not found`);
  const patch: CoursePatch = { action: "ADD_BLOCK", lessonId, block };
  return {
    summary: `${verb} (new ${block.type.replace("_", " ")})`,
    patches: [patch],
    data: { blockId: block.id, lessonId, blockType: block.type },
  };
}

const targetShape = {
  blockId: z
    .string()
    .nullable()
    .describe("Existing block to overwrite. Null = create a new block."),
  lessonId: z
    .string()
    .nullable()
    .describe("Lesson for a NEW block. Null = the current lesson. Ignored when blockId is set."),
  title: z.string().nullable(),
};

/* ─────────────────────────── write_slide_deck ─────────────────────────── */

const writeSlideDeck = defineTool({
  name: "write_slide_deck",
  description:
    "Generate a complete, FRESH slide deck. For each slide pick a `layout` from the catalog that fits its content, then fill that layout's slots by `role`. Keep slides minimal + professional (few words; one idea per slide), vary layouts across the deck, and put emphasis (bold/italic) in text slots as runs — never markdown. To EDIT an existing deck, use add_slide / update_slide / set_slide_layout instead (they target one slide without disturbing the rest).",
  params: z.object({
    ...targetShape,
    slides: z
      .array(
        z.object({
          layout: z.enum(LAYOUT_IDS as [string, ...string[]]),
          content: z.array(SlideContentEntrySchema),
          notes: z.string().nullable(),
        })
      )
      .describe("Ordered slides. Favor a clear arc: intro → core ideas → recap."),
  }),
  execute(args, ctx) {
    const errors = args.slides.flatMap((s, i) =>
      validateSlideContent(s.layout, s.content).map((e) => `Slide ${i + 1}: ${e}`)
    );
    if (errors.length) throw new ToolError(errors.join(" "));
    const themeId = ctx.doc.theme.slideDefaults.themeId;
    const block = buildSlideDeckBlock({ title: args.title, slides: args.slides }, themeId);
    return commitBlock(ctx, args, block, `Wrote a ${args.slides.length}-slide deck`);
  },
});

/* ───────────────────────────── write_quiz ─────────────────────────────── */

export const questionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("multiple_choice"),
    prompt: z.string(),
    explanation: z.string(),
    choices: z.array(z.string()),
    correctIndex: z.number().int(),
  }),
  z.object({
    kind: z.literal("multi_select"),
    prompt: z.string(),
    explanation: z.string(),
    choices: z.array(z.string()),
    correctIndexes: z.array(z.number().int()),
  }),
  z.object({
    kind: z.literal("true_false"),
    prompt: z.string(),
    explanation: z.string(),
    correctAnswer: z.boolean(),
  }),
  z.object({
    kind: z.literal("short_answer"),
    prompt: z.string(),
    explanation: z.string(),
    expectedAnswer: z.string(),
    acceptedAnswers: z.array(z.string()).nullable(),
  }),
]);

const writeQuiz = defineTool({
  name: "write_quiz",
  description:
    "Write a LOW-STAKES knowledge check: a small, consistent number of questions (typically 3–5) that confirm understanding of what the lesson teaches. Every question MUST include a short `explanation` shown as instant feedback. There are NO scores, passing marks, timers, attempts, difficulty levels, or points — these are formative checks, never a grade.",
  params: z.object({
    ...targetShape,
    questions: z.array(questionSchema),
  }),
  execute(args, ctx) {
    const block = buildQuizBlock({ title: args.title, questions: args.questions });
    return commitBlock(ctx, args, block, `Wrote a ${args.questions.length}-question check`);
  },
});

/* ─────────────────────────── write_homework ───────────────────────────── */

const writeHomework = defineTool({
  name: "write_homework",
  description:
    "Write a practice assignment: clear instructions plus one or more exercises, and optionally a qualitative rubric (levels are descriptive, never scored) and/or a worked solution. Practice only — there are NO points, grades, or due dates.",
  params: z.object({
    ...targetShape,
    instructions: z.string(),
    deliverableType: z
      .enum(["none", "text_response", "file_upload", "external_link"])
      .describe("How a learner optionally submits work. 'none' = self-paced practice."),
    estimatedMinutes: z.number().int().nullable(),
    exercises: z.array(
      z.object({
        title: z.string(),
        prompt: z.string(),
        hint: z.string().nullable(),
        solution: z.string().nullable(),
      })
    ),
    rubric: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().nullable(),
          levels: z.array(
            z.object({ label: z.string(), description: z.string().nullable() })
          ),
        })
      )
      .nullable(),
  }),
  execute(args, ctx) {
    const block = buildHomeworkBlock({
      title: args.title,
      instructions: args.instructions,
      deliverableType: args.deliverableType,
      estimatedMinutes: args.estimatedMinutes,
      exercises: args.exercises,
      rubric: args.rubric,
    });
    return commitBlock(ctx, args, block, `Wrote a practice set (${args.exercises.length} exercise(s))`);
  },
});

/* ───────────────────────── write_lecture_text ─────────────────────────── */

const writeLectureText = defineTool({
  name: "write_lecture_text",
  description:
    "Write clear, well-structured lecture prose grounded in the course outcomes, level, and teaching tone. Use `key_idea` paragraphs for the main takeaways and `aside` for optional tangents. Match the requested tone.",
  params: z.object({
    ...targetShape,
    tone: z.enum(["beginner", "concise", "detailed", "socratic"]),
    paragraphs: z.array(
      z.object({
        kind: z.enum(["paragraph", "key_idea", "aside"]),
        text: z.string(),
      })
    ),
  }),
  execute(args, ctx) {
    const block = buildLectureBlock({
      title: args.title,
      tone: args.tone,
      paragraphs: args.paragraphs,
    });
    return commitBlock(ctx, args, block, `Wrote lecture text (${args.paragraphs.length} paragraph(s))`);
  },
});

export const writerTools: Tool[] = [writeSlideDeck, writeQuiz, writeHomework, writeLectureText];
