/**
 * Pure builders that turn the agent's SIMPLE content specs into full,
 * schema-valid LessonBlocks.
 *
 * The agent describes content semantically (a slide's heading + a few bullets,
 * a question's prompt + choices); these builders own the studio-quality
 * mechanics the agent shouldn't micromanage — slide layout + positioning,
 * stable ids, AI metadata, theme. Output is always valid against
 * LessonBlockSchema, and — by construction — carries NONE of the removed
 * gradebook fields (there is nowhere to put a score, timer, difficulty, or
 * due date).
 */

import { createBlock, createParagraph, newId } from "@/lib/course/factories";
import type {
  HomeworkBlock,
  LectureTextBlock,
  LectureTone,
  QuizBlock,
  QuizQuestion,
  SlideDeckBlock,
  SlideThemeId,
} from "@/lib/course/types";
import { buildSlide, type SlideContentEntry } from "./slideContent";

/* ───────────────────────────── slide deck ─────────────────────────────── */

export interface SlideSpec {
  /** A layout id from the shared SLIDE_LAYOUTS registry. */
  layout: string;
  /** Slot assignments by role (validated against the layout). */
  content: SlideContentEntry[];
  notes?: string | null;
}

export function buildSlideDeckBlock(
  spec: { title?: string | null; slides: SlideSpec[] },
  themeId: SlideThemeId
): SlideDeckBlock {
  const block = createBlock("slide_deck") as SlideDeckBlock;
  if (spec.title) block.title = spec.title;
  block.slides = spec.slides.map((s, i) => {
    const slide = buildSlide(s.layout, s.content, themeId);
    slide.order = i;
    if (s.notes && s.notes.trim()) slide.speakerNotes = s.notes.trim();
    return slide;
  });
  return block;
}

/* ──────────────────────────── lecture text ────────────────────────────── */

export interface ParagraphSpec {
  kind: "paragraph" | "key_idea" | "aside";
  text: string;
}

export function buildLectureBlock(spec: {
  title?: string | null;
  tone: LectureTone;
  paragraphs: ParagraphSpec[];
}): LectureTextBlock {
  const block = createBlock("lecture_text") as LectureTextBlock;
  if (spec.title) block.title = spec.title;
  block.tone = spec.tone;
  block.paragraphs = spec.paragraphs.map((p) => createParagraph(p.text, p.kind));
  return block;
}

/* ─────────────────────────────── quiz ─────────────────────────────────── */

export type QuestionSpec =
  | {
      kind: "multiple_choice";
      prompt: string;
      explanation: string;
      choices: string[];
      correctIndex: number;
    }
  | {
      kind: "multi_select";
      prompt: string;
      explanation: string;
      choices: string[];
      correctIndexes: number[];
    }
  | {
      kind: "true_false";
      prompt: string;
      explanation: string;
      correctAnswer: boolean;
    }
  | {
      kind: "short_answer";
      prompt: string;
      explanation: string;
      expectedAnswer: string;
      acceptedAnswers?: string[] | null;
    };

function buildQuestion(spec: QuestionSpec): QuizQuestion {
  const base = { id: newId("q"), prompt: spec.prompt, explanation: spec.explanation };
  switch (spec.kind) {
    case "multiple_choice": {
      const choices = spec.choices.map((text) => ({ id: newId("c"), text }));
      const idx = Math.min(Math.max(spec.correctIndex, 0), choices.length - 1);
      return { ...base, kind: "multiple_choice", choices, correctChoiceId: choices[idx]?.id ?? "" };
    }
    case "multi_select": {
      const choices = spec.choices.map((text) => ({ id: newId("c"), text }));
      const correctChoiceIds = spec.correctIndexes
        .filter((i) => i >= 0 && i < choices.length)
        .map((i) => choices[i].id);
      return { ...base, kind: "multi_select", choices, correctChoiceIds };
    }
    case "true_false":
      return { ...base, kind: "true_false", correctAnswer: spec.correctAnswer };
    case "short_answer":
      return {
        ...base,
        kind: "short_answer",
        expectedAnswer: spec.expectedAnswer,
        ...(spec.acceptedAnswers && spec.acceptedAnswers.length
          ? { acceptedAnswers: spec.acceptedAnswers }
          : {}),
      };
  }
}

export function buildQuizBlock(spec: {
  title?: string | null;
  questions: QuestionSpec[];
}): QuizBlock {
  const block = createBlock("quiz") as QuizBlock;
  if (spec.title) block.title = spec.title;
  block.questions = spec.questions.map(buildQuestion);
  return block;
}

/* ───────────────────────────── homework ───────────────────────────────── */

export interface ExerciseSpec {
  title: string;
  prompt: string;
  hint?: string | null;
  solution?: string | null;
}
export interface RubricCriterionSpec {
  name: string;
  description?: string | null;
  /** Qualitative levels (label + optional description). No points — ever. */
  levels: { label: string; description?: string | null }[];
}

export function buildHomeworkBlock(spec: {
  title?: string | null;
  instructions: string;
  deliverableType: HomeworkBlock["deliverableType"];
  estimatedMinutes?: number | null;
  exercises: ExerciseSpec[];
  rubric?: RubricCriterionSpec[] | null;
}): HomeworkBlock {
  const block = createBlock("homework") as HomeworkBlock;
  if (spec.title) block.title = spec.title;
  block.instructions = spec.instructions;
  block.deliverableType = spec.deliverableType;
  if (spec.estimatedMinutes != null) block.estimatedMinutes = spec.estimatedMinutes;
  block.exercises = spec.exercises.map((e) => ({
    id: newId("ex"),
    title: e.title,
    prompt: e.prompt,
    ...(e.hint ? { hint: e.hint } : {}),
    ...(e.solution ? { solution: e.solution } : {}),
  }));
  if (spec.rubric && spec.rubric.length) {
    block.rubric = spec.rubric.map((c) => ({
      id: newId("rub"),
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      levels: c.levels.map((l) => ({
        id: newId("lvl"),
        label: l.label,
        ...(l.description ? { description: l.description } : {}),
      })),
    }));
  }
  return block;
}
