"use client";

/**
 * Quiz taking. Questions come from the SNAPSHOT (answer keys were stripped at
 * publish time — there is nothing to cheat from in this payload), the learner
 * picks answers locally, and submission goes to /api/learn/quiz where the
 * server grades against the server-only key table. The response carries
 * per-question correctness + authored explanations, never the correct answer.
 * Unlimited attempts; each "Try again" clears the form and the next submit
 * records attempt N+1.
 */

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, RotateCcw, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PublishedQuizBlock, PublishedQuizQuestion } from "@/lib/course/publish/schemas";
import type {
  LessonProgressSnapshot,
  QuestionGrade,
  QuizGradeResult,
  QuizQuestionResponse,
} from "@/lib/learn/schemas";
import { useAnalytics } from "./AnalyticsProvider";

type Draft = Record<string, QuizQuestionResponse>;

function draftResponses(questions: PublishedQuizQuestion[], draft: Draft): QuizQuestionResponse[] {
  return questions.map((q) => draft[q.id]).filter((r): r is QuizQuestionResponse => Boolean(r));
}

export function LearnQuiz({
  block,
  publicationId,
  priorAttempts,
  onGraded,
}: {
  block: PublishedQuizBlock;
  publicationId: string;
  /** The learner's attempt count so far (server-derived, shown as context). */
  priorAttempts: number;
  onGraded?: (progress: LessonProgressSnapshot | undefined) => void;
}) {
  const [draft, setDraft] = useState<Draft>({});
  const [startedAt] = useState(() => new Date().toISOString());
  // quiz_started pairs with startedAt (quiz_submitted is server-emitted with
  // the real attempt id — no client emit on submit).
  const { track } = useAnalytics();
  useEffect(() => {
    track({ eventType: "quiz_started", blockId: block.id });
  }, [track, block.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QuizGradeResult | null>(null);
  const gradeByQuestion = useMemo(
    () => new Map((result?.questions ?? []).map((q) => [q.questionId, q])),
    [result]
  );

  const questions = block.questions;
  const answeredCount = questions.filter((q) => draft[q.id]).length;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/learn/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicationId,
          blockId: block.id,
          responses: draftResponses(questions, draft),
          startedAt,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Couldn't submit — please try again.");
      }
      const graded = (await res.json()) as QuizGradeResult;
      setResult(graded);
      onGraded?.(graded.progress);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't submit — please try again.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setDraft({});
    setResult(null);
    setError(null);
  }

  const graded = result !== null;

  return (
    <div data-ai-tool="learn-quiz">
      <ol className="space-y-6">
        {questions.map((question, qi) => (
          <li key={question.id}>
            <p className="text-[15px] font-medium text-stone-800">
              <span className="mr-2 text-stone-400">{qi + 1}.</span>
              {question.prompt}
            </p>
            <div className="mt-3">
              <QuestionInput
                question={question}
                value={draft[question.id]}
                disabled={graded || busy}
                onChange={(response) =>
                  setDraft((d) => ({ ...d, [question.id]: response }))
                }
              />
            </div>
            {graded ? <GradeLine grade={gradeByQuestion.get(question.id)} /> : null}
          </li>
        ))}
      </ol>

      <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-stone-100 pt-4">
        {graded && result ? (
          <>
            <p className="text-sm font-medium text-stone-800">
              Score: {result.score}/{result.maxScore}
              {result.attemptNumber ? (
                <span className="ml-2 font-normal text-stone-400">
                  attempt {result.attemptNumber}
                </span>
              ) : (
                <span className="ml-2 font-normal text-stone-400">preview — not recorded</span>
              )}
            </p>
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-1.5 rounded-full border border-stone-300/80 bg-white px-3.5 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Try again
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || answeredCount === 0}
              data-ai-tool="learn-quiz-submit"
              className={cn(
                "brand-gradient rounded-full px-5 py-2 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95 disabled:pointer-events-none disabled:opacity-50"
              )}
            >
              {busy ? "Checking…" : "Check my answers"}
            </button>
            <span className="text-xs text-stone-400">
              {answeredCount}/{questions.length} answered
              {priorAttempts > 0 ? ` · ${priorAttempts} previous ${priorAttempts === 1 ? "attempt" : "attempts"}` : ""}
            </span>
          </>
        )}
        {error ? <p className="text-xs text-rose-600">{error}</p> : null}
      </div>
    </div>
  );
}

function GradeLine({ grade }: { grade: QuestionGrade | undefined }) {
  if (!grade) return null;
  return (
    <div
      className={cn(
        "mt-3 flex items-start gap-2 rounded-xl px-4 py-3 text-sm",
        grade.correct
          ? "border border-emerald-100 bg-emerald-50/70 text-emerald-800"
          : "border border-rose-100 bg-rose-50/70 text-rose-800"
      )}
    >
      {grade.correct ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      )}
      <span>
        <span className="font-medium">
          {grade.correct ? "Correct" : grade.answered ? "Not quite" : "Unanswered"}
        </span>
        {grade.explanation ? (
          <span className="mt-0.5 block text-[13px] leading-relaxed opacity-90">
            {grade.explanation}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function choiceButtonClasses(selected: boolean, disabled: boolean): string {
  return cn(
    "flex w-full items-center gap-3 rounded-xl border px-4 py-2.5 text-left text-sm transition-colors",
    selected
      ? "border-brand-300 bg-brand-50/70 text-stone-900"
      : "border-stone-200/80 bg-white text-stone-700 hover:border-stone-300",
    disabled && "pointer-events-none opacity-70"
  );
}

function QuestionInput({
  question,
  value,
  disabled,
  onChange,
}: {
  question: PublishedQuizQuestion;
  value: QuizQuestionResponse | undefined;
  disabled: boolean;
  onChange: (response: QuizQuestionResponse) => void;
}) {
  switch (question.kind) {
    case "multiple_choice":
      return (
        <div className="space-y-2" role="radiogroup">
          {question.choices.map((choice) => {
            const selected =
              value?.kind === "multiple_choice" && value.choiceId === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() =>
                  onChange({ kind: "multiple_choice", questionId: question.id, choiceId: choice.id })
                }
                className={choiceButtonClasses(selected, disabled)}
              >
                <span
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 rounded-full border",
                    selected ? "border-brand-500 bg-brand-500" : "border-stone-300"
                  )}
                  aria-hidden
                />
                {choice.text}
              </button>
            );
          })}
        </div>
      );
    case "multi_select": {
      const picked = value?.kind === "multi_select" ? new Set(value.choiceIds) : new Set<string>();
      return (
        <div className="space-y-2">
          <p className="text-xs text-stone-400">Select all that apply</p>
          {question.choices.map((choice) => {
            const selected = picked.has(choice.id);
            return (
              <button
                key={choice.id}
                type="button"
                role="checkbox"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => {
                  const next = new Set(picked);
                  if (selected) next.delete(choice.id);
                  else next.add(choice.id);
                  onChange({
                    kind: "multi_select",
                    questionId: question.id,
                    choiceIds: [...next],
                  });
                }}
                className={choiceButtonClasses(selected, disabled)}
              >
                <span
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 rounded border",
                    selected ? "border-brand-500 bg-brand-500" : "border-stone-300"
                  )}
                  aria-hidden
                />
                {choice.text}
              </button>
            );
          })}
        </div>
      );
    }
    case "true_false":
      return (
        <div className="flex gap-2" role="radiogroup">
          {([true, false] as const).map((option) => {
            const selected = value?.kind === "true_false" && value.answer === option;
            return (
              <button
                key={String(option)}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() =>
                  onChange({ kind: "true_false", questionId: question.id, answer: option })
                }
                className={cn(choiceButtonClasses(selected, disabled), "w-auto px-6")}
              >
                {option ? "True" : "False"}
              </button>
            );
          })}
        </div>
      );
    case "short_answer":
      return (
        <input
          type="text"
          value={value?.kind === "short_answer" ? value.text : ""}
          disabled={disabled}
          placeholder="Type your answer…"
          onChange={(event) =>
            onChange({ kind: "short_answer", questionId: question.id, text: event.target.value })
          }
          className="w-full rounded-xl border border-stone-200/80 bg-white px-4 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
      );
  }
}
