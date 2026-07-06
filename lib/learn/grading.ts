/**
 * PURE server-side quiz grading — the ONLY place a learner response meets an
 * answer key. Keys come from the server-only quiz_answer_keys table (RLS: zero
 * policies); this module never runs in the browser with real keys.
 *
 * Grading rules (fixed, documented):
 *   multiple_choice — the picked choice id must equal correctChoiceId.
 *   multi_select    — the picked SET must equal the correct set exactly
 *                     (order-insensitive, duplicates ignored).
 *   true_false      — boolean equality.
 *   short_answer    — normalized (trim, lowercase, collapse whitespace) match
 *                     against expectedAnswer or any acceptedAnswers entry.
 *   Unanswered questions are wrong. A response whose kind doesn't match the
 *   key's kind counts as answered-but-wrong (a tampered client, not a skip).
 *   Responses to unknown question ids are ignored. maxScore = key count.
 */

import type { AnswerKeyEntry, QuizBlockAnswerKeys } from "@/lib/course/publish/schemas";
import type { QuestionGrade, QuizQuestionResponse } from "./schemas";

export function normalizeShortAnswer(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const id of setA) if (!setB.has(id)) return false;
  return true;
}

/** Grade one response against its key. `undefined` response = unanswered. */
export function gradeQuestion(
  key: AnswerKeyEntry,
  response: QuizQuestionResponse | undefined
): { answered: boolean; correct: boolean } {
  if (!response) return { answered: false, correct: false };
  if (response.kind !== key.kind) return { answered: true, correct: false };
  switch (key.kind) {
    case "multiple_choice":
      return {
        answered: true,
        correct:
          response.kind === "multiple_choice" && response.choiceId === key.correctChoiceId,
      };
    case "multi_select":
      return {
        answered: true,
        correct:
          response.kind === "multi_select" && sameSet(response.choiceIds, key.correctChoiceIds),
      };
    case "true_false":
      return {
        answered: true,
        correct: response.kind === "true_false" && response.answer === key.correctAnswer,
      };
    case "short_answer": {
      if (response.kind !== "short_answer") return { answered: true, correct: false };
      const given = normalizeShortAnswer(response.text);
      if (given.length === 0) return { answered: false, correct: false };
      const accepted = [key.expectedAnswer, ...(key.acceptedAnswers ?? [])].map(
        normalizeShortAnswer
      );
      return { answered: true, correct: accepted.includes(given) };
    }
  }
}

export interface QuizGrade {
  score: number;
  maxScore: number;
  perQuestion: QuestionGrade[];
}

/** Grade a full submission. Question order follows the KEY order (the snapshot
 *  order), not the response order, so results align with the rendered quiz. */
export function gradeQuiz(
  keys: QuizBlockAnswerKeys,
  responses: readonly QuizQuestionResponse[]
): QuizGrade {
  const byQuestion = new Map<string, QuizQuestionResponse>();
  for (const response of responses) {
    // First response per question wins; a duplicate is a client bug, not a retry.
    if (!byQuestion.has(response.questionId)) byQuestion.set(response.questionId, response);
  }
  const perQuestion: QuestionGrade[] = keys.questions.map((key) => {
    const { answered, correct } = gradeQuestion(key, byQuestion.get(key.questionId));
    return {
      questionId: key.questionId,
      answered,
      correct,
      ...(key.explanation ? { explanation: key.explanation } : {}),
    };
  });
  return {
    score: perQuestion.filter((q) => q.correct).length,
    maxScore: keys.questions.length,
    perQuestion,
  };
}
