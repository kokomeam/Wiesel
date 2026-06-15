"use client";

/**
 * One quiz question (sortable). All content edits are full-replace
 * UPDATE_QUIZ_QUESTION patches; difficulty uses CHANGE_DIFFICULTY, deletion
 * DELETE_QUIZ_QUESTION. Multiple-choice marks one correct answer (radio),
 * multi-select marks a set (checkboxes).
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripVertical, Lightbulb, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { aiAttrs } from "@/lib/course/aiAttributes";
import {
  deleteQuestionPatch,
  updateQuestionPatch,
} from "@/lib/course/commands";
import { newId } from "@/lib/course/factories";
import { useEditorStore } from "@/lib/course/store";
import type { QuizQuestion } from "@/lib/course/types";
import { InlineText, InlineTextArea } from "../InlineText";

const kindLabel: Record<QuizQuestion["kind"], string> = {
  multiple_choice: "Multiple choice",
  multi_select: "Multiple select",
  true_false: "True / False",
  short_answer: "Short answer",
};

type ChoiceQuestion = Extract<QuizQuestion, { kind: "multiple_choice" | "multi_select" }>;

function ChoiceEditor({
  question,
  onReplace,
}: {
  question: ChoiceQuestion;
  onReplace: (q: QuizQuestion) => void;
}) {
  const multi = question.kind === "multi_select";

  const isCorrect = (id: string) =>
    question.kind === "multi_select"
      ? question.correctChoiceIds.includes(id)
      : question.correctChoiceId === id;

  function toggleCorrect(id: string) {
    if (question.kind === "multi_select") {
      const set = question.correctChoiceIds.includes(id)
        ? question.correctChoiceIds.filter((c) => c !== id)
        : [...question.correctChoiceIds, id];
      onReplace({ ...question, correctChoiceIds: set });
    } else {
      onReplace({ ...question, correctChoiceId: id });
    }
  }

  function setText(id: string, text: string) {
    onReplace({
      ...question,
      choices: question.choices.map((c) => (c.id === id ? { ...c, text } : c)),
    });
  }

  function removeChoice(id: string) {
    const choices = question.choices.filter((c) => c.id !== id);
    if (question.kind === "multi_select") {
      onReplace({
        ...question,
        choices,
        correctChoiceIds: question.correctChoiceIds.filter((c) => c !== id),
      });
    } else {
      onReplace({
        ...question,
        choices,
        correctChoiceId: question.correctChoiceId === id ? "" : question.correctChoiceId,
      });
    }
  }

  return (
    <ul className="mt-2.5 space-y-1.5">
      {question.choices.map((choice) => {
        const correct = isCorrect(choice.id);
        return (
          <li key={choice.id} className="group/choice flex items-center gap-2.5">
            <button
              type="button"
              title={correct ? "Correct answer" : "Mark as correct"}
              aria-label={correct ? "Correct answer" : "Mark as correct answer"}
              aria-pressed={correct}
              onClick={(e) => {
                e.stopPropagation();
                toggleCorrect(choice.id);
              }}
              className={cn(
                "grid size-4 shrink-0 place-items-center border transition-colors",
                multi ? "rounded" : "rounded-full",
                correct ? "border-brand-500 bg-brand-500" : "border-stone-300 hover:border-brand-400"
              )}
            >
              {correct &&
                (multi ? (
                  <Check className="size-2.5 text-white" />
                ) : (
                  <span className="size-1.5 rounded-full bg-white" />
                ))}
            </button>
            <InlineText
              value={choice.text}
              aria-label={`Choice: ${choice.text || "empty"}`}
              onCommit={(text) => setText(choice.id, text)}
              className={cn("text-sm", correct ? "font-medium text-stone-800" : "text-stone-600")}
            />
            {question.choices.length > 2 && (
              <button
                type="button"
                aria-label="Remove choice"
                onClick={(e) => {
                  e.stopPropagation();
                  removeChoice(choice.id);
                }}
                className="shrink-0 text-stone-300 opacity-0 transition-opacity hover:text-rose-500 group-hover/choice:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            )}
          </li>
        );
      })}
      <li>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onReplace({
              ...question,
              choices: [...question.choices, { id: newId("c"), text: "" }],
            });
          }}
          className="ml-6 text-xs text-stone-400 transition-colors hover:text-brand-600"
        >
          + choice
        </button>
      </li>
    </ul>
  );
}

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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: question.id });

  function replace(next: QuizQuestion) {
    apply(updateQuestionPatch(quizId, question.id, next), "human");
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...aiAttrs({
        component: "quiz-question",
        type: "quiz_question",
        id: question.id,
        parentId: quizId,
        order: index,
        label: `Question ${index + 1}: ${kindLabel[question.kind]}`,
      })}
      className={cn(
        "group/q relative py-4 pl-6 first:pt-1 last:pb-1",
        isDragging && "z-10 opacity-80"
      )}
    >
      <span
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder question ${index + 1}`}
        className="absolute left-0 top-5 cursor-grab touch-none text-stone-300 opacity-0 transition-opacity hover:text-stone-500 group-hover/q:opacity-100"
      >
        <GripVertical className="size-3.5" />
      </span>

      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-stone-400">Q{index + 1}</span>
        <Badge tone="slate">{kindLabel[question.kind]}</Badge>
        <button
          type="button"
          title="Delete question"
          aria-label={`Delete question ${index + 1}`}
          onClick={(e) => {
            e.stopPropagation();
            apply(deleteQuestionPatch(quizId, question.id), "human");
          }}
          className="ml-auto grid size-6 place-items-center rounded-md text-stone-300 transition-colors hover:bg-rose-50 hover:text-rose-600"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <InlineTextArea
        value={question.prompt}
        aria-label={`Question ${index + 1} prompt`}
        placeholder="Question prompt…"
        onCommit={(prompt) => replace({ ...question, prompt })}
        className="text-sm font-medium text-stone-800"
      />

      {(question.kind === "multiple_choice" || question.kind === "multi_select") && (
        <ChoiceEditor question={question} onReplace={replace} />
      )}

      {question.kind === "true_false" && (
        <div className="mt-2.5 flex gap-1.5">
          {([true, false] as const).map((v) => (
            <button
              key={String(v)}
              type="button"
              aria-pressed={question.correctAnswer === v}
              onClick={(e) => {
                e.stopPropagation();
                replace({ ...question, correctAnswer: v });
              }}
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
        <div className="mt-2.5 space-y-1.5">
          <div className="flex items-center gap-2 rounded-lg bg-stone-50 px-3 py-2">
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
          {(question.acceptedAnswers ?? []).map((ans, i) => (
            <div
              key={i}
              className="group/ans flex items-center gap-2 rounded-lg bg-stone-50/70 px-3 py-1.5"
            >
              <span className="text-[11px] font-medium text-stone-400">or</span>
              <InlineText
                value={ans}
                aria-label={`Accepted answer ${i + 1}`}
                placeholder="Also accept…"
                onCommit={(v) => {
                  const next = [...(question.acceptedAnswers ?? [])];
                  next[i] = v;
                  replace({ ...question, acceptedAnswers: next.filter((a) => a.trim()) });
                }}
                className="text-sm text-stone-600"
              />
              <button
                type="button"
                aria-label={`Remove accepted answer ${i + 1}`}
                onClick={(e) => {
                  e.stopPropagation();
                  replace({
                    ...question,
                    acceptedAnswers: (question.acceptedAnswers ?? []).filter((_, j) => j !== i),
                  });
                }}
                className="shrink-0 text-stone-300 opacity-0 transition-opacity hover:text-rose-500 group-hover/ans:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              replace({
                ...question,
                acceptedAnswers: [...(question.acceptedAnswers ?? []), ""],
              });
            }}
            className="text-xs text-stone-400 transition-colors hover:text-brand-600"
          >
            + accepted answer
          </button>
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
