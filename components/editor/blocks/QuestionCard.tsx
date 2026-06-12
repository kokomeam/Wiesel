"use client";

/**
 * One quiz question. All content edits are full-replace UPDATE_QUIZ_QUESTION
 * patches; difficulty uses CHANGE_DIFFICULTY. The correct answer is marked
 * with a radio-style toggle.
 */

import { Lightbulb } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { aiAttrs } from "@/lib/course/aiAttributes";
import {
  changeDifficultyPatch,
  updateQuestionPatch,
} from "@/lib/course/commands";
import { newId } from "@/lib/course/factories";
import { useEditorStore } from "@/lib/course/store";
import type { QuizDifficulty, QuizQuestion } from "@/lib/course/types";
import { InlineText, InlineTextArea } from "../InlineText";

const kindLabel: Record<QuizQuestion["kind"], string> = {
  multiple_choice: "Multiple choice",
  true_false: "True / False",
  short_answer: "Short answer",
};

const difficulties: QuizDifficulty[] = ["easy", "medium", "hard"];
const difficultyActive: Record<QuizDifficulty, string> = {
  easy: "bg-emerald-50 text-emerald-700",
  medium: "bg-amber-50 text-amber-700",
  hard: "bg-rose-50 text-rose-700",
};

export function QuestionCard({
  question,
  quizId,
  index,
}: {
  question: QuizQuestion;
  quizId: string;
  index: number;
}) {
  const apply = useEditorStore((s) => s.apply);

  function replace(next: QuizQuestion) {
    apply(updateQuestionPatch(quizId, question.id, next), "human");
  }

  return (
    <div
      {...aiAttrs({
        component: "quiz-question",
        type: "quiz_question",
        id: question.id,
        parentId: quizId,
        order: index,
        label: `Question ${index + 1}: ${kindLabel[question.kind]}`,
      })}
      className="py-4 first:pt-1 last:pb-1"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-stone-400">Q{index + 1}</span>
        <Badge tone="slate">{kindLabel[question.kind]}</Badge>
        <div className="ml-auto flex items-center gap-0.5">
          {difficulties.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={question.difficulty === d}
              onClick={() => apply(changeDifficultyPatch(quizId, d, question.id), "human")}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium capitalize transition-colors",
                question.difficulty === d
                  ? difficultyActive[d]
                  : "text-stone-400 hover:bg-stone-100"
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <InlineTextArea
        value={question.prompt}
        aria-label={`Question ${index + 1} prompt`}
        placeholder="Question prompt…"
        onCommit={(prompt) => replace({ ...question, prompt })}
        className="text-sm font-medium text-stone-800"
      />

      {question.kind === "multiple_choice" && (
        <ul className="mt-2.5 space-y-1.5">
          {question.choices.map((choice) => {
            const correct = choice.id === question.correctChoiceId;
            return (
              <li key={choice.id} className="flex items-center gap-2.5">
                <button
                  type="button"
                  title={correct ? "Correct answer" : "Mark as correct"}
                  aria-label={correct ? "Correct answer" : "Mark as correct answer"}
                  onClick={() => replace({ ...question, correctChoiceId: choice.id })}
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                    correct
                      ? "border-brand-500 bg-brand-500"
                      : "border-stone-300 hover:border-brand-400"
                  )}
                >
                  {correct && <span className="size-1.5 rounded-full bg-white" />}
                </button>
                <InlineText
                  value={choice.text}
                  aria-label={`Choice: ${choice.text || "empty"}`}
                  onCommit={(text) =>
                    replace({
                      ...question,
                      choices: question.choices.map((c) =>
                        c.id === choice.id ? { ...c, text } : c
                      ),
                    })
                  }
                  className={cn(
                    "text-sm",
                    correct ? "font-medium text-stone-800" : "text-stone-600"
                  )}
                />
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() =>
                replace({
                  ...question,
                  choices: [...question.choices, { id: newId("c"), text: "" }],
                })
              }
              className="ml-6 text-xs text-stone-400 transition-colors hover:text-brand-600"
            >
              + choice
            </button>
          </li>
        </ul>
      )}

      {question.kind === "true_false" && (
        <div className="mt-2.5 flex gap-1.5">
          {([true, false] as const).map((v) => (
            <button
              key={String(v)}
              type="button"
              aria-pressed={question.correctAnswer === v}
              onClick={() => replace({ ...question, correctAnswer: v })}
              className={cn(
                "rounded-lg px-3 py-1 text-xs font-medium transition-colors",
                question.correctAnswer === v
                  ? "bg-brand-50 text-brand-700 ring-1 ring-brand-200"
                  : "bg-stone-50 text-stone-500 hover:bg-stone-100"
              )}
            >
              {v ? "True" : "False"}
            </button>
          ))}
        </div>
      )}

      {question.kind === "short_answer" && (
        <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-stone-50 px-3 py-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
            Answer
          </span>
          <InlineText
            value={question.expectedAnswer}
            aria-label="Expected answer"
            placeholder="Expected answer…"
            onCommit={(expectedAnswer) => replace({ ...question, expectedAnswer })}
            className="text-sm text-stone-700"
          />
        </div>
      )}

      <div className="mt-2.5 flex items-start gap-2">
        <Lightbulb className="mt-1 size-3.5 shrink-0 text-stone-300" />
        <InlineTextArea
          value={question.explanation ?? ""}
          aria-label="Answer explanation"
          placeholder="Explanation shown after answering…"
          onCommit={(explanation) => replace({ ...question, explanation })}
          className="text-xs text-stone-500"
        />
      </div>
    </div>
  );
}
