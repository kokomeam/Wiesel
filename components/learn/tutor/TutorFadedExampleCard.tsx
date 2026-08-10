"use client";

/**
 * TUTOR-1 A3 Wave 5 — the fadedExample card (Class A, formative).
 *
 * A worked-example practice with backward FADING: the model authors the COMPLETE
 * worked example (every step + its answer), and the RUNTIME decides how much to
 * blank from the learner's decayed mastery (A3-16 — never the model, never turn
 * count; fixed at authoring). A NON-blanked step renders worked (its text + its
 * answer inline, muted); a BLANKED step renders a labelled input the learner fills
 * (the step text is the prompt/goal).
 *
 * On submit it grades each blank LOCALLY (`scoreFadedCard` — trim/lowercase vs the
 * step's answer): all blanks right → demonstrated · some → partial · none →
 * not_demonstrated; a fully-worked card (fadeLevel 0, zero blanks) → demonstrated
 * on acknowledge. Then it reveals each blank's correct answer (green/rose), POSTs
 * `tool_evidence` with the card's `fadeLevel` (best-effort), and records a session
 * attempt so the A3-4 escape-hatch gate counts it.
 *
 * A11y (A3-25): every blank is a labelled `<input>` (its `<label>` is the step
 * text). No positive tabindex; NO framer-motion; no Date.now/Math.random in render
 * (latency captured in a mount effect). House style: warm paper/stone, rounded-2xl,
 * matching the other formative cards. Zod-free.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTutorStore } from "@/lib/learn/tutorStore";
import {
  scoreFadedCard,
  type TutorAssessmentCard,
} from "@/lib/learn/tutorClientTypes";
import { postToolEvidence } from "@/lib/learn/tutorEvidence";

type FadedCard = Extract<TutorAssessmentCard, { toolName: "fadedExample" }>;

/** A learner-friendly caption for the fade level (never the raw number in prose;
 *  the "N of 3" ordinal rides in an aria/muted caption). */
function fadeLabel(fadeLevel: number): string {
  if (fadeLevel <= 0) return "Worked example";
  if (fadeLevel === 1) return "Guided";
  if (fadeLevel === 2) return "Mostly on your own";
  return "On your own";
}

export function TutorFadedExampleCard({
  card,
  courseId,
  publicationId,
  version,
  lessonId,
  userId,
}: {
  card: FadedCard;
  courseId: string;
  publicationId: string;
  version: number;
  lessonId: string | null;
  userId: string;
}) {
  const recordSessionAttempt = useTutorStore((s) => s.recordSessionAttempt);

  // Filled inputs keyed by the step INDEX (only blanked steps get an input).
  const [filled, setFilled] = useState<Record<number, string>>({});
  const [graded, setGraded] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof scoreFadedCard> | null>(null);

  // Mount → submit latency, captured in a mount effect (never in render).
  const mountedAtRef = useRef<number | null>(null);
  useEffect(() => {
    mountedAtRef.current = now();
  }, []);
  const latencyMs = useCallback((): number | null => {
    const started = mountedAtRef.current;
    return started === null ? null : Math.max(0, Math.round(now() - started));
  }, []);

  const blankCount = useMemo(
    () => card.steps.reduce((n, s) => (s.blanked ? n + 1 : n), 0),
    [card.steps],
  );

  const submit = useCallback(() => {
    if (graded) return;
    const scored = scoreFadedCard(card, filled);
    setResult(scored);
    setGraded(true);

    recordSessionAttempt(userId, card.conceptSlug);
    postToolEvidence({
      courseId,
      publicationId,
      version,
      lessonId,
      cardId: card.cardId,
      toolName: "fadedExample",
      conceptSlug: card.conceptSlug,
      outcome: scored.outcome,
      fadeLevel: card.fadeLevel,
      initiation: card.initiation,
      latencyMs: latencyMs(),
    });
  }, [
    graded,
    card,
    filled,
    recordSessionAttempt,
    userId,
    courseId,
    publicationId,
    version,
    lessonId,
    latencyMs,
  ]);

  // The submit label + affordance depends on whether there's anything to fill.
  const acknowledgeOnly = blankCount === 0;
  const submitLabel = acknowledgeOnly ? "Got it" : "Check";

  return (
    <div
      data-ai-tool="tutor-faded-example-card"
      className="w-[92%] rounded-2xl border border-stone-200/80 bg-white p-3 text-sm shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-medium text-stone-800">{card.problem}</p>
        <span className="shrink-0 whitespace-nowrap text-[11px] text-stone-500">
          {fadeLabel(card.fadeLevel)}
          <span className="sr-only"> — step level {card.fadeLevel} of 3</span>
        </span>
      </div>

      <ol className="mt-2.5 space-y-2">
        {card.steps.map((step, i) => {
          if (!step.blanked) {
            // A worked step — text + its answer inline, muted (nothing to grade).
            return (
              <li key={i} className="rounded-xl border border-stone-200/80 bg-stone-50/60 px-2.5 py-1.5">
                <p className="text-stone-700">
                  <span aria-hidden className="mr-1.5 text-[11px] font-medium text-stone-500">
                    {i + 1}
                  </span>
                  {step.text}
                </p>
                {step.answer ? (
                  <p className="mt-0.5 pl-4 text-xs text-stone-500">{step.answer}</p>
                ) : null}
              </li>
            );
          }
          // A blanked step — a labelled input (the step text is the goal/prompt).
          const inputId = `faded-${card.cardId}-${i}`;
          const value = filled[i] ?? "";
          const correct = graded && normEq(value, step.answer);
          return (
            <li key={i} className="rounded-xl border border-stone-200/80 bg-white px-2.5 py-1.5">
              <label htmlFor={inputId} className="block text-stone-700">
                <span aria-hidden className="mr-1.5 text-[11px] font-medium text-stone-500">
                  {i + 1}
                </span>
                {step.text}
              </label>
              <input
                id={inputId}
                value={value}
                disabled={graded}
                onChange={(e) =>
                  setFilled((prev) => ({ ...prev, [i]: e.target.value }))
                }
                placeholder="Your step…"
                className={[
                  "mt-1 w-full rounded-lg border px-2.5 py-1 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-stone-50",
                  graded
                    ? correct
                      ? "border-emerald-300 bg-emerald-50"
                      : "border-rose-300 bg-rose-50"
                    : "border-stone-200/80 focus:border-brand-300",
                ].join(" ")}
              />
              {graded && !correct ? (
                <p className="mt-1 pl-1 text-xs text-stone-600">
                  <span className="text-stone-500">Answer: </span>
                  {step.answer}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>

      {!graded ? (
        <button
          type="button"
          onClick={submit}
          className="mt-2.5 rounded-full bg-stone-900 px-3.5 py-1 text-xs font-medium text-white transition-colors hover:bg-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          {submitLabel}
        </button>
      ) : null}

      {graded && result ? (
        <div className="mt-2.5" role="status">
          <p
            className={
              result.outcome === "demonstrated"
                ? "text-xs font-medium text-emerald-700"
                : result.outcome === "partial"
                  ? "text-xs font-medium text-amber-700"
                  : "text-xs font-medium text-rose-700"
            }
          >
            {acknowledgeOnly
              ? "Nice — walk through it once more if it helps"
              : result.outcome === "demonstrated"
                ? "Nice — every step is right"
                : result.outcome === "partial"
                  ? `${result.correctCount} of ${result.blankCount} right`
                  : "Not quite — the answers are shown above"}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** trim/lowercase equality — mirrors scoreFadedCard's per-blank comparison. */
function normEq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim().length > 0;
}

/** Monotonic-ish clock for latency; event-handler only (never called in render). */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export default TutorFadedExampleCard;
