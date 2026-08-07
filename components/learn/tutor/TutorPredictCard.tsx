"use client";

/**
 * TUTOR-1 A3 Wave 5 — the predictThenReveal card (Class A, formative).
 *
 * The learner COMMITS a prediction BEFORE anything is revealed — that commit-
 * before-reveal is the whole point, so nothing (outcome, reveal, near-miss
 * feedback) is shown until they press "Commit prediction". On commit it grades
 * LOCALLY (`scorePredictCard` — the accepted/near-miss keys ride the card, the
 * practiceItems precedent): an accepted answer → demonstrated; else the first
 * matched near-miss names its misconception + feedback; else a plain miss. Then it
 * reveals the outcome, the near-miss feedback (when matched), and the
 * `revealExplanation`, POSTs `tool_evidence` with the matched misconceptionId
 * (best-effort), and records a session attempt (A3-4 gate).
 *
 * A11y (A3-25): the prediction is a single labelled `<input>`. No positive
 * tabindex; NO framer-motion; no Date.now/Math.random in render (latency captured
 * in a mount effect). House style: warm paper/stone, rounded-2xl. Zod-free.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTutorStore } from "@/lib/learn/tutorStore";
import {
  scorePredictCard,
  type TutorAssessmentCard,
} from "@/lib/learn/tutorClientTypes";
import { postToolEvidence } from "@/lib/learn/tutorEvidence";

type PredictCard = Extract<TutorAssessmentCard, { toolName: "predictThenReveal" }>;

export function TutorPredictCard({
  card,
  courseId,
  publicationId,
  version,
  lessonId,
  userId,
}: {
  card: PredictCard;
  courseId: string;
  publicationId: string;
  version: number;
  lessonId: string | null;
  userId: string;
}) {
  const recordSessionAttempt = useTutorStore((s) => s.recordSessionAttempt);

  const [prediction, setPrediction] = useState("");
  const [committed, setCommitted] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof scorePredictCard> | null>(null);

  // Mount → commit latency, captured in a mount effect (never in render).
  const mountedAtRef = useRef<number | null>(null);
  useEffect(() => {
    mountedAtRef.current = now();
  }, []);
  const latencyMs = useCallback((): number | null => {
    const started = mountedAtRef.current;
    return started === null ? null : Math.max(0, Math.round(now() - started));
  }, []);

  const commit = useCallback(() => {
    if (committed || !prediction.trim()) return;
    const scored = scorePredictCard(card, prediction);
    setResult(scored);
    setCommitted(true);

    recordSessionAttempt(userId, card.conceptSlug);
    postToolEvidence({
      courseId,
      publicationId,
      version,
      lessonId,
      cardId: card.cardId,
      toolName: "predictThenReveal",
      conceptSlug: card.conceptSlug,
      outcome: scored.outcome,
      misconceptionId: scored.misconceptionId,
      initiation: card.initiation,
      latencyMs: latencyMs(),
    });
  }, [
    committed,
    prediction,
    card,
    recordSessionAttempt,
    userId,
    courseId,
    publicationId,
    version,
    lessonId,
    latencyMs,
  ]);

  const inputId = `predict-${card.cardId}`;

  return (
    <div
      data-ai-tool="tutor-predict-card"
      className="w-[92%] rounded-2xl border border-stone-200/80 bg-white p-3 text-sm shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
    >
      <p className="text-stone-700">{card.setup}</p>
      <label htmlFor={inputId} className="mt-2 block font-medium text-stone-800">
        {card.prompt}
      </label>

      {/* BEFORE commit — the prediction input only; nothing is revealed. */}
      {!committed ? (
        <div className="mt-1.5">
          <input
            id={inputId}
            value={prediction}
            onChange={(e) => setPrediction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            placeholder="Your prediction…"
            className="w-full rounded-lg border border-stone-200/80 bg-white px-2.5 py-1.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
          <button
            type="button"
            disabled={!prediction.trim()}
            onClick={commit}
            className="mt-2 rounded-full bg-stone-900 px-3.5 py-1 text-xs font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            Commit prediction
          </button>
          <p className="mt-1.5 text-[11px] text-stone-400">
            Commit your guess before you see the answer
          </p>
        </div>
      ) : (
        // AFTER commit — echo the committed prediction, then reveal.
        <div className="mt-1.5">
          <p className="rounded-lg border border-stone-200/80 bg-stone-50/60 px-2.5 py-1.5 text-stone-700">
            <span className="text-[11px] text-stone-400">You predicted: </span>
            {prediction.trim()}
          </p>

          {result ? (
            <div className="mt-2.5 space-y-1.5" role="status">
              <p
                className={
                  result.outcome === "demonstrated"
                    ? "text-xs font-medium text-emerald-700"
                    : "text-xs font-medium text-rose-700"
                }
              >
                {result.outcome === "demonstrated" ? "Nice — you called it" : "Not quite"}
              </p>
              {result.matched === "nearMiss" && result.feedback ? (
                <p className="text-xs leading-relaxed text-stone-600">{result.feedback}</p>
              ) : null}
              <div className="border-t border-stone-100 pt-2 text-xs leading-relaxed text-stone-700">
                <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-stone-400">
                  What actually happens
                </span>
                {card.revealExplanation}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Monotonic-ish clock for latency; event-handler only (never called in render). */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export default TutorPredictCard;
