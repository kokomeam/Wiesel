/**
 * Assessment helpers — default resolution + scoring math for quiz/homework
 * content. Pure functions (no id generation, no store access), so they are
 * safe to call during render, unlike factories.ts.
 */

import type { QuizQuestion, QuizSettings, RubricCriterion } from "./types";

/** Defaults a quiz uses when its `settings` (or individual fields) are absent. */
export const DEFAULT_QUIZ_SETTINGS: Required<QuizSettings> = {
  timeLimitMinutes: null,
  attemptsAllowed: null,
  shuffleQuestions: false,
  shuffleOptions: false,
  passingScore: 70,
  whenToShowAnswers: "after_submit",
};

/** Settings with defaults filled in (defaults under the block's overrides). */
export function resolveQuizSettings(settings?: QuizSettings): Required<QuizSettings> {
  return { ...DEFAULT_QUIZ_SETTINGS, ...settings };
}

/** A question's score weight; absent = 1. */
export function questionPoints(question: QuizQuestion): number {
  return question.points ?? 1;
}

/** Sum of every question's points. */
export function quizTotalPoints(questions: QuizQuestion[]): number {
  return questions.reduce((sum, q) => sum + questionPoints(q), 0);
}

/** A criterion's max = its highest performance level's points (0 if none). */
export function criterionMaxPoints(criterion: RubricCriterion): number {
  return criterion.levels.reduce((max, level) => Math.max(max, level.points), 0);
}

/** Sum of every criterion's max — the rubric's total possible points. */
export function rubricTotalPoints(rubric: RubricCriterion[] | undefined): number {
  return (rubric ?? []).reduce((sum, c) => sum + criterionMaxPoints(c), 0);
}
