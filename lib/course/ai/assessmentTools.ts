/**
 * Assessment AI tool surface.
 *
 * Typed, pure wrappers over the SAME operations layer (commands.ts) the editor
 * UI calls, plus one read-only course-context reader. When the real LLM lands
 * behind ai/mockClient.ts, the model emits these tool calls and receives
 * identical, Zod-validated CoursePatches — so human and AI edits share one path.
 *
 * NOTHING here is wired to the model yet: this is the signature surface + a
 * descriptor manifest, ready to plug into mockClient.ts in the LLM step.
 */

import {
  addQuestionPatch,
  addRubricCriterionPatch,
  reorderQuestionPatch,
  setRubricPatch,
  updateQuestionPatch,
} from "../commands";
import { createBlock, createQuestion } from "../factories";
import type { CoursePatch } from "../patches";
import { findLesson } from "../queries";
import type {
  BlockType,
  CourseDocument,
  DeliverableType,
  QuestionKind,
  QuizQuestion,
  QuizSettings,
  RubricCriterion,
} from "../types";

/* ───────────────────────────── quiz tools ─────────────────────────────── */

export function create_quiz_block(
  lessonId: string,
  opts?: {
    title?: string;
    questionKinds?: QuestionKind[];
    settings?: QuizSettings;
    atIndex?: number;
  }
): CoursePatch[] {
  const block = createBlock("quiz");
  if (block.type !== "quiz") throw new Error("unreachable");
  if (opts?.title) block.title = opts.title;
  if (opts?.settings) block.settings = { ...block.settings, ...opts.settings };
  if (opts?.questionKinds?.length) {
    block.questions = opts.questionKinds.map((k) => createQuestion(k));
  }
  return [{ action: "ADD_BLOCK", lessonId, block, atIndex: opts?.atIndex }];
}

export function add_question(blockId: string, kind: QuestionKind): CoursePatch {
  return addQuestionPatch(blockId, kind);
}

export function update_question(blockId: string, question: QuizQuestion): CoursePatch {
  return updateQuestionPatch(blockId, question.id, question);
}

/** Reorder to match `orderedIds`. Front-to-back single moves compose to the
 *  target permutation; applyMany lands them as ONE undo step. */
export function reorder_questions(blockId: string, orderedIds: string[]): CoursePatch[] {
  return orderedIds.map((id, i) => reorderQuestionPatch(blockId, id, i));
}

/* ─────────────────────────── homework tools ───────────────────────────── */

export function create_homework_block(
  lessonId: string,
  opts?: {
    title?: string;
    instructions?: string;
    deliverableType?: DeliverableType;
    points?: number;
    estimatedMinutes?: number;
    atIndex?: number;
  }
): CoursePatch[] {
  const block = createBlock("homework");
  if (block.type !== "homework") throw new Error("unreachable");
  if (opts?.title) block.title = opts.title;
  if (opts?.instructions) block.instructions = opts.instructions;
  if (opts?.deliverableType) block.deliverableType = opts.deliverableType;
  if (opts?.points !== undefined) block.points = opts.points;
  if (opts?.estimatedMinutes !== undefined) block.estimatedMinutes = opts.estimatedMinutes;
  return [{ action: "ADD_BLOCK", lessonId, block, atIndex: opts?.atIndex }];
}

export function set_rubric(blockId: string, rubric: RubricCriterion[]): CoursePatch {
  return setRubricPatch(blockId, rubric);
}

export function add_rubric_criterion(blockId: string, name?: string): CoursePatch {
  return addRubricCriterionPatch(blockId, name);
}

/* ─────────────────── get_course_context (read-only) ───────────────────── */

export interface BlockContext {
  type: BlockType;
  title?: string;
  summary: string;
}
export interface CourseContext {
  lessonTitle: string;
  objective?: string;
  blocks: BlockContext[];
  /** Concepts the lesson already teaches — assessments should align to these. */
  coveredConcepts: string[];
}

/** Read-only summary of a lesson's blocks so generated assessments align to
 *  what was actually taught. Pure read over the document. */
export function get_course_context(
  doc: CourseDocument,
  lessonId: string
): CourseContext | null {
  const hit = findLesson(doc, lessonId);
  if (!hit) return null;
  const { lesson } = hit;
  const concepts = new Set<string>();

  const blocks: BlockContext[] = lesson.blocks.map((block) => {
    block.ai.semanticTags.forEach((t) => concepts.add(t));
    let summary = "";
    switch (block.type) {
      case "slide_deck": {
        const headings = block.slides
          .map((s) => s.elements.find((el) => el.type === "heading"))
          .map((el) => (el && el.type === "heading" ? el.text : undefined))
          .filter((t): t is string => Boolean(t));
        headings.forEach((h) => concepts.add(h));
        summary = `${block.slides.length} slides — ${headings.join("; ") || "untitled"}`;
        break;
      }
      case "lecture_text": {
        const ideas = block.paragraphs
          .filter((p) => p.kind === "key_idea")
          .map((p) => p.text);
        summary = ideas.length
          ? `Key ideas: ${ideas.join(" ")}`
          : `${block.paragraphs.length} paragraphs`;
        break;
      }
      case "example":
        summary = `Worked example — takeaway: ${block.takeaway}`;
        break;
      case "quiz":
        summary = `${block.questions.length} question(s)`;
        break;
      case "homework":
        summary = `${block.exercises.length} exercise(s)`;
        break;
      case "exercise":
        summary = block.prompt.slice(0, 140);
        break;
      case "resource":
        summary = `${block.links.length} link(s)`;
        break;
    }
    return { type: block.type, title: block.title, summary };
  });

  return {
    lessonTitle: lesson.title,
    objective: lesson.objective,
    blocks,
    coveredConcepts: [...concepts],
  };
}

/* ─────────────── descriptor manifest (wired into mockClient later) ─────── */

export interface AssessmentToolSpec {
  name: string;
  description: string;
  /** Read-only tools return context, not patches. */
  readOnly?: boolean;
}

export const ASSESSMENT_TOOLS: AssessmentToolSpec[] = [
  { name: "create_quiz_block", description: "Add a quiz to a lesson, optionally seeding question kinds and settings." },
  { name: "add_question", description: "Append a question of a given kind to a quiz." },
  { name: "update_question", description: "Replace a quiz question (stem, options, correct answer, points, explanation)." },
  { name: "reorder_questions", description: "Reorder a quiz's questions to a given id ordering." },
  { name: "create_homework_block", description: "Add a homework assignment to a lesson with instructions and deliverable type." },
  { name: "set_rubric", description: "Replace a homework block's leveled grading rubric." },
  { name: "add_rubric_criterion", description: "Add one leveled criterion to a homework rubric." },
  { name: "get_course_context", description: "Read sibling lesson blocks so assessments align to what was taught.", readOnly: true },
];
