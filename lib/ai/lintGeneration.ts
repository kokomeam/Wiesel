/**
 * Deterministic generation QUALITY linter — SOFT warnings only (no model, no DB).
 *
 * Runs after hard validation passes. It surfaces calm, optional suggestions the
 * creator may act on — a thin slide, a missing speaker note, an example-planned
 * slide that carries no example, a quiz short of its planned length. None of these
 * block finalization; they reveal polish, not correctness (correctness is
 * validation.ts). The count also drives the optional light-review trigger.
 */

import { findLesson } from "@/lib/course/queries";
import type {
  CourseDocument,
  HomeworkBlock,
  QuizBlock,
  Slide,
  SlideDeckBlock,
} from "@/lib/course/types";
import type { LessonOutline, PlannedSlide } from "./outline";
import { density, slideTextLength } from "./slideDiagnostics";

export interface LintWarning {
  code: string;
  message: string;
  slideId?: string;
}

/** Layouts that inherently carry a concrete worked example. */
const EXAMPLE_LAYOUTS = new Set(["concept_example", "process_steps", "code_walkthrough_steps"]);

function slideLayoutId(s: Slide): string {
  return s.template?.layoutId ?? s.layout;
}

export function lintLessonGeneration(
  doc: CourseDocument,
  lessonId: string,
  outline: LessonOutline
): LintWarning[] {
  const lesson = findLesson(doc, lessonId)?.lesson;
  if (!lesson) return [];
  const blocks = lesson.blocks;
  const decks = blocks.filter((b): b is SlideDeckBlock => b.type === "slide_deck");
  const slides = decks.flatMap((d) => d.slides);
  const specById = new Map<string, PlannedSlide>(outline.slides.map((s) => [s.id, s]));

  const warnings: LintWarning[] = [];
  const layoutTally = new Map<string, number>();

  for (const s of slides) {
    const layout = slideLayoutId(s);
    layoutTally.set(layout, (layoutTally.get(layout) ?? 0) + 1);

    const len = slideTextLength(s);
    const d = density(len);
    if (d === "low") warnings.push({ code: "THIN_SLIDE", message: "Slide is thin — could teach more.", slideId: s.id });
    else if (d === "high") warnings.push({ code: "DENSE_SLIDE", message: "Slide is text-heavy — consider splitting it.", slideId: s.id });
    if (!s.speakerNotes?.trim()) warnings.push({ code: "NO_SPEAKER_NOTES", message: "Slide has no speaker notes.", slideId: s.id });

    const spec = s.ai?.specId ? specById.get(s.ai.specId) : undefined;
    if (spec) {
      const wantsExample = spec.role === "worked_example" || spec.depth === "example";
      if (wantsExample && !EXAMPLE_LAYOUTS.has(layout)) {
        warnings.push({ code: "NO_EXAMPLE", message: `Slide was planned as a worked example but its ${layout} layout shows no concrete example.`, slideId: s.id });
      }
      const wantsCode = spec.role === "code_walkthrough" || spec.layout === "code_walkthrough_steps";
      if (wantsCode && layout !== "code_walkthrough_steps") {
        warnings.push({ code: "NO_CODE", message: "Slide was planned as a code walkthrough but carries no code.", slideId: s.id });
      }
    }
  }

  // Layout variety: ≥4 slides where one layout dominates.
  if (slides.length >= 4) {
    const top = Math.max(...layoutTally.values());
    if (top / slides.length > 0.6) {
      warnings.push({ code: "LOW_LAYOUT_VARIETY", message: "Most slides share one layout — vary them for pacing." });
    }
  }

  // Conceptual-check planned but no knowledge-check block exists.
  const wantsCheck = outline.slides.some((s) => s.role === "conceptual_check" || s.role === "mini_practice");
  const hasQuiz = blocks.some((b) => b.type === "quiz");
  if (wantsCheck && !hasQuiz && !outline.quizPlan) {
    warnings.push({ code: "NO_CHECK_BLOCK", message: "The plan includes a check/practice slide but the lesson has no knowledge-check block." });
  }

  // Quiz shorter than planned.
  if (outline.quizPlan) {
    const quiz = blocks.find((b): b is QuizBlock => b.type === "quiz");
    if (quiz && quiz.questions.length < outline.quizPlan.questionCount) {
      warnings.push({ code: "QUIZ_TOO_SHORT", message: `Knowledge check has ${quiz.questions.length} question(s); the plan asked for ${outline.quizPlan.questionCount}.` });
    }
  }

  // Homework missing a worked solution / rubric when one was planned.
  if (outline.homeworkPlan) {
    const hw = blocks.find((b): b is HomeworkBlock => b.type === "homework");
    if (hw) {
      const hasSolution = hw.exercises.some((e) => e.solution?.trim());
      const hasRubric = (hw.rubric?.length ?? 0) > 0;
      if (!hasSolution && !hasRubric) {
        warnings.push({ code: "HOMEWORK_NO_SOLUTION", message: "Practice has no worked solution or rubric — consider adding one." });
      }
    }
  }

  return warnings;
}
