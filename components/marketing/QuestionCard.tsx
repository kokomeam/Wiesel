"use client";

/**
 * The clarifying-question card — the agent (or the gate, on its behalf) asked
 * ONE specific multiple-choice question and the run is paused on the answer.
 * Sky-toned: visually a question, not a red governance gate. Answering
 * resumes the agent; for a gate-raised question on the creator's OWN action
 * the answer re-runs the tool and the resulting approval card renders right
 * here in the question's place.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, HelpCircle, Loader2, PenLine, X } from "lucide-react";
import {
  answerQuestionAction,
  dismissQuestionAction,
  type ActionResult,
  type PendingActionPayload,
} from "@/app/(app)/marketing/actions";
import { ApprovalCard } from "@/components/marketing/ApprovalCard";
import { cn } from "@/lib/cn";

export interface QuestionCardOption {
  label: string;
  value: string;
  description: string | null;
}

export interface QuestionCardProps {
  questionId: string;
  question: string;
  options: QuestionCardOption[];
  /** Denser paddings for the chat column. */
  compact?: boolean;
  onResult?: (r: ActionResult) => void;
  onAnswered?: (value: string) => void;
}

export function QuestionCard({ questionId, question, options, compact, onResult, onAnswered }: QuestionCardProps) {
  const router = useRouter();
  const [freeText, setFreeText] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [answered, setAnswered] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [followUp, setFollowUp] = useState<PendingActionPayload | null>(null);
  const [busy, startTransition] = useTransition();

  // A gate-raised question on the creator's own action resolves into the
  // real approval card — render it in place.
  if (followUp) {
    return <ApprovalCard pending={followUp} compact={compact} onResult={onResult} />;
  }

  if (dismissed) {
    return <div className="py-1.5 text-xs text-stone-400">Question dismissed.</div>;
  }
  if (answered) {
    return (
      <div className="py-1.5 text-xs text-stone-500">
        <span className="font-medium text-stone-600">Answered</span> — {answered}
      </div>
    );
  }

  const answer = (value: string, label: string) =>
    startTransition(async () => {
      // "__other__" carries the typed answer as the free text — the agent gets
      // it verbatim and acts on it instead of an option value.
      const text = value === "__other__" ? label : freeText.trim() || undefined;
      const r = await answerQuestionAction(questionId, value, text);
      onResult?.(r);
      if (!r.error) {
        if (r.pending) setFollowUp(r.pending);
        setAnswered(label);
        onAnswered?.(value);
      }
      router.refresh();
    });

  const dismiss = () =>
    startTransition(async () => {
      const r = await dismissQuestionAction(questionId);
      onResult?.(r);
      if (!r.error) setDismissed(true);
      router.refresh();
    });

  return (
    <div
      className={cn(
        "rounded-2xl border border-sky-200 bg-sky-50/60 shadow-[0_1px_2px_rgba(68,48,28,0.05)]",
        compact ? "p-3" : "p-4"
      )}
      data-testid="question-card"
    >
      <div className="flex items-start gap-2.5">
        <HelpCircle className="mt-0.5 size-4 shrink-0 text-sky-500" />
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium text-stone-800">{question}</p>
            <button
              type="button"
              onClick={dismiss}
              disabled={busy}
              className="rounded-full p-1 text-stone-400 hover:bg-stone-900/[0.06] hover:text-stone-600"
              aria-label="Dismiss question"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                disabled={busy}
                onClick={() => answer(o.value, o.label)}
                className="flex flex-col items-start rounded-xl border border-stone-200 bg-white px-3 py-2 text-left transition-colors hover:border-sky-300 hover:bg-sky-50 disabled:opacity-50"
              >
                <span className="text-sm text-stone-800">{o.label}</span>
                {o.description ? <span className="text-xs text-stone-500">{o.description}</span> : null}
              </button>
            ))}
            {/* the escape hatch — answer in your own words / redirect the agent */}
            {otherOpen ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (otherText.trim()) answer("__other__", otherText.trim());
                }}
                className="flex items-start gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2"
              >
                <textarea
                  autoFocus
                  rows={2}
                  className="min-h-9 flex-1 resize-y bg-transparent text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none"
                  placeholder="Type your own answer — or tell the agent to do something else entirely"
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (otherText.trim()) answer("__other__", otherText.trim());
                    }
                  }}
                  disabled={busy}
                />
                <button
                  type="submit"
                  disabled={busy || !otherText.trim()}
                  className="brand-gradient grid size-7 shrink-0 place-items-center rounded-lg text-white disabled:opacity-50"
                  aria-label="Send answer"
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
                </button>
              </form>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setOtherOpen(true)}
                className="flex items-center gap-2 rounded-xl border border-dashed border-stone-300 bg-white/60 px-3 py-2 text-left text-sm text-stone-500 transition-colors hover:border-sky-300 hover:bg-sky-50 hover:text-stone-700 disabled:opacity-50"
              >
                <PenLine className="size-3.5" /> Something else…
              </button>
            )}
          </div>
          {!otherOpen ? (
            <div className="flex items-center gap-2">
              <input
                className="block w-full rounded-lg border border-stone-200 bg-white/70 px-2 py-1.5 text-xs text-stone-600 placeholder:text-stone-400"
                placeholder="Add context with your choice (optional)"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                disabled={busy}
              />
              {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin text-stone-400" /> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
