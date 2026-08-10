"use client";

/**
 * TUTOR-1 A3 Wave 4 — the checkUnderstanding card (Class A, formative).
 *
 * A retrieval check: a stem + 3–4 options the learner picks ONE of. The answer
 * key rides the card (formative, low-stakes → the client grades locally, the
 * practiceItems precedent). On submit it grades via `scoreCheckUnderstanding`,
 * reveals the picked option's FEEDBACK (which names the reasoning / misconception,
 * never "the answer is X" — §3), POSTs `tool_evidence` (best-effort), and records
 * a session attempt so the A3-4 escape-hatch gate counts it.
 *
 * A11y (A3-25 automated-a11y-clean): the options are a `role="radiogroup"` of
 * `role="radio"` buttons with a single tab stop and arrow-key roving selection
 * (the native radio interaction pattern, dependency-free). An optional
 * sure/unsure confidence read is a SECOND radiogroup shown BEFORE reveal when
 * `collectConfidence`. No positive tabindex; no Date.now/Math.random in render
 * (latency is measured in the submit handler from a mount timestamp).
 *
 * House style: warm paper/stone, rounded-2xl, matching PracticeCard; NO
 * framer-motion. Zod-free.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTutorStore } from "@/lib/learn/tutorStore";
import {
  scoreCheckUnderstanding,
  type TutorAssessmentCard,
} from "@/lib/learn/tutorClientTypes";
import { postToolEvidence } from "@/lib/learn/tutorEvidence";

type CheckCard = Extract<TutorAssessmentCard, { toolName: "checkUnderstanding" }>;

type Confidence = "sure" | "unsure";

export function TutorCheckUnderstandingCard({
  card,
  courseId,
  publicationId,
  version,
  lessonId,
  userId,
}: {
  card: CheckCard;
  courseId: string;
  publicationId: string;
  version: number;
  lessonId: string | null;
  userId: string;
}) {
  const recordSessionAttempt = useTutorStore((s) => s.recordSessionAttempt);

  const [selected, setSelected] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [graded, setGraded] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof scoreCheckUnderstanding> | null>(null);

  // Mount time → submit-time latency. Captured in a mount EFFECT (never in
  // render — React 19 purity / the no-clock-in-render house rule); null until the
  // effect runs, so an ultra-fast submit degrades to null latency, never negative.
  const mountedAtRef = useRef<number | null>(null);
  useEffect(() => {
    mountedAtRef.current = now();
  }, []);

  const optionIds = useMemo(() => card.options.map((o) => o.id), [card.options]);

  const latencyMs = useCallback((): number | null => {
    const started = mountedAtRef.current;
    return started === null ? null : Math.max(0, Math.round(now() - started));
  }, []);

  const submit = useCallback(() => {
    if (graded || selected === null) return;
    const scored = scoreCheckUnderstanding(card, selected);
    setResult(scored);
    setGraded(true);

    recordSessionAttempt(userId, card.conceptSlug);
    postToolEvidence({
      courseId,
      publicationId,
      version,
      lessonId,
      cardId: card.cardId,
      toolName: "checkUnderstanding",
      conceptSlug: card.conceptSlug,
      outcome: scored.outcome,
      misconceptionId: scored.misconceptionId,
      confidence: card.collectConfidence ? confidence : null,
      initiation: card.initiation,
      latencyMs: latencyMs(),
    });
  }, [
    graded,
    selected,
    card,
    confidence,
    recordSessionAttempt,
    userId,
    courseId,
    publicationId,
    version,
    lessonId,
    latencyMs,
  ]);

  // Arrow-key roving over the options (native radiogroup semantics).
  const onOptionKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      if (graded) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        setSelected(optionIds[(index + 1) % optionIds.length]);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        setSelected(optionIds[(index - 1 + optionIds.length) % optionIds.length]);
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setSelected(optionIds[index]);
      }
    },
    [graded, optionIds],
  );

  const canSubmit =
    !graded && selected !== null && (!card.collectConfidence || confidence !== null);

  return (
    <div
      data-ai-tool="tutor-check-understanding-card"
      className="w-[92%] rounded-2xl border border-stone-200/80 bg-white p-3 text-sm shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
    >
      <p className="font-medium text-stone-800">{card.stem}</p>

      {/* Options — a single-tab-stop radiogroup with arrow-key roving. */}
      <div
        role="radiogroup"
        aria-label="Answer choices"
        className="mt-2.5 space-y-1.5"
      >
        {card.options.map((opt, i) => {
          const isSel = selected === opt.id;
          const isKey = graded && opt.correct;
          const isWrongPick = graded && isSel && !opt.correct;
          // Roving tabindex: the selected option is the tab stop; if none
          // selected yet, the first option is (native radiogroup behaviour).
          const isTabStop = selected === null ? i === 0 : isSel;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={isSel}
              disabled={graded}
              tabIndex={isTabStop ? 0 : -1}
              onClick={() => !graded && setSelected(opt.id)}
              onKeyDown={(e) => onOptionKeyDown(e, i)}
              className={[
                "block w-full rounded-xl border px-3 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:cursor-default",
                isKey
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                  : isWrongPick
                    ? "border-rose-300 bg-rose-50 text-rose-800"
                    : isSel
                      ? "border-brand-300 bg-brand-50 text-brand-800"
                      : "border-stone-200/80 bg-white text-stone-700 hover:border-stone-300",
              ].join(" ")}
            >
              {opt.text}
            </button>
          );
        })}
      </div>

      {/* Confidence read — BEFORE reveal only, when the card asks for it. */}
      {card.collectConfidence && !graded ? (
        <div className="mt-3">
          <p className="mb-1.5 text-[11px] text-stone-500">How sure are you?</p>
          <div role="radiogroup" aria-label="Confidence" className="flex gap-2">
            {(["sure", "unsure"] as const).map((c, i) => {
              const isSel = confidence === c;
              const isTabStop = confidence === null ? i === 0 : isSel;
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={isSel}
                  tabIndex={isTabStop ? 0 : -1}
                  onClick={() => setConfidence(c)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "ArrowDown") {
                      e.preventDefault();
                      setConfidence(c === "sure" ? "unsure" : "sure");
                    } else if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      setConfidence(c);
                    }
                  }}
                  className={[
                    "rounded-full border px-3 py-0.5 text-[11px] font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
                    isSel
                      ? "border-brand-300 bg-brand-50 text-brand-700"
                      : "border-stone-200/80 bg-white text-stone-600 hover:border-stone-300",
                  ].join(" ")}
                >
                  {c === "sure" ? "Sure" : "Not sure"}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {!graded ? (
        <button
          type="button"
          disabled={!canSubmit}
          onClick={submit}
          className="mt-2.5 rounded-full bg-stone-900 px-3.5 py-1 text-xs font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          Check
        </button>
      ) : null}

      {/* Reveal — the picked option's feedback (names the reasoning, never
          "the answer is X"). Tone follows the outcome. */}
      {graded && result ? (
        <div className="mt-2.5 space-y-1.5" role="status">
          <p
            className={
              result.outcome === "demonstrated"
                ? "text-xs font-medium text-emerald-700"
                : "text-xs font-medium text-rose-700"
            }
          >
            {result.outcome === "demonstrated" ? "Nice — that's right" : "Not quite"}
          </p>
          {result.feedback ? (
            <p className="text-xs leading-relaxed text-stone-600">{result.feedback}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Monotonic-ish clock for latency; event-handler only (never called in render). */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export default TutorCheckUnderstandingCard;
