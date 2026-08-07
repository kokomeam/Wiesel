"use client";

/**
 * TUTOR-1 A3 Wave 4 — the sequenceTask card (Class A, formative).
 *
 * An ordering task: a prompt + a list of items the learner reorders into the
 * correct sequence. Items are presented in a deterministic NON-authored order
 * (`shuffleDeterministic` seeded from the cardId — stable across re-renders, never
 * the answer order, never Math.random in render). The answer key (`correctOrder`)
 * rides the card; on submit it scores LOCALLY via `scoreSequenceCard`, reveals
 * correct/partial/incorrect with the correct order, POSTs `tool_evidence`
 * (best-effort), and records a session attempt (A3-4 gate).
 *
 * A11y (A3-25 automated-a11y-clean): reordering is via per-item "Move up" / "Move
 * down" buttons with aria-labels — fully keyboard- AND screen-reader-operable and
 * dependency-free (a drag library is banned / no new dep). The list is an
 * `<ol>` so position is conveyed structurally; each Move button is disabled at the
 * ends. No positive tabindex; no Date.now/Math.random in render.
 *
 * House style: warm paper/stone, rounded-2xl, matching PracticeCard; NO
 * framer-motion. Zod-free.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useTutorStore } from "@/lib/learn/tutorStore";
import {
  hashSeed,
  scoreSequenceCard,
  shuffleDeterministic,
  type TutorAssessmentCard,
} from "@/lib/learn/tutorClientTypes";
import { postToolEvidence } from "@/lib/learn/tutorEvidence";

type SequenceCard = Extract<TutorAssessmentCard, { toolName: "sequenceTask" }>;

export function TutorSequenceCard({
  card,
  courseId,
  publicationId,
  version,
  lessonId,
  userId,
}: {
  card: SequenceCard;
  courseId: string;
  publicationId: string;
  version: number;
  lessonId: string | null;
  userId: string;
}) {
  const recordSessionAttempt = useTutorStore((s) => s.recordSessionAttempt);

  // The initial presentation order: a deterministic shuffle of the item ids,
  // seeded from the cardId so it's stable across re-renders / reloads and never
  // reveals the authored order. Lazy useState init = computed once, no
  // clock/random in render.
  const [order, setOrder] = useState<string[]>(() =>
    shuffleDeterministic(
      card.items.map((it) => it.id),
      hashSeed(card.cardId),
    ),
  );
  const [graded, setGraded] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof scoreSequenceCard> | null>(null);

  // id → item text, for rendering the reordered list.
  const textById = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of card.items) m.set(it.id, it.text);
    return m;
  }, [card.items]);

  // Mount → submit latency, captured in a mount effect (never in render).
  const mountedAtRef = useRef<number | null>(null);
  useEffect(() => {
    mountedAtRef.current = now();
  }, []);
  const latencyMs = useCallback((): number | null => {
    const started = mountedAtRef.current;
    return started === null ? null : Math.max(0, Math.round(now() - started));
  }, []);

  const move = useCallback(
    (index: number, dir: -1 | 1) => {
      if (graded) return;
      setOrder((prev) => {
        const target = index + dir;
        if (target < 0 || target >= prev.length) return prev;
        const next = prev.slice();
        const tmp = next[index];
        next[index] = next[target];
        next[target] = tmp;
        return next;
      });
    },
    [graded],
  );

  const submit = useCallback(() => {
    if (graded) return;
    const scored = scoreSequenceCard(card, order);
    setResult(scored);
    setGraded(true);

    recordSessionAttempt(userId, card.conceptSlug);
    postToolEvidence({
      courseId,
      publicationId,
      version,
      lessonId,
      cardId: card.cardId,
      toolName: "sequenceTask",
      conceptSlug: card.conceptSlug,
      outcome: scored.outcome,
      initiation: card.initiation,
      latencyMs: latencyMs(),
    });
  }, [
    graded,
    card,
    order,
    recordSessionAttempt,
    userId,
    courseId,
    publicationId,
    version,
    lessonId,
    latencyMs,
  ]);

  const verdictLabel =
    result?.outcome === "demonstrated"
      ? "Correct order"
      : result?.outcome === "partial"
        ? "Partly right"
        : "Not quite";
  const verdictClass =
    result?.outcome === "demonstrated"
      ? "text-emerald-700"
      : result?.outcome === "partial"
        ? "text-amber-700"
        : "text-rose-700";

  return (
    <div
      data-ai-tool="tutor-sequence-card"
      className="w-[92%] rounded-2xl border border-stone-200/80 bg-white p-3 text-sm shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
    >
      <p className="font-medium text-stone-800">{card.prompt}</p>
      <p className="mt-0.5 text-[11px] text-stone-400">Put these in the right order</p>

      <ol className="mt-2.5 space-y-1.5">
        {order.map((id, i) => (
          <li
            key={id}
            className="flex items-center gap-2 rounded-xl border border-stone-200/80 bg-white px-2.5 py-1.5"
          >
            <span aria-hidden className="text-[11px] font-medium text-stone-400">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 text-stone-700">{textById.get(id) ?? id}</span>
            {!graded ? (
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move "${textById.get(id) ?? id}" up`}
                  className="grid size-6 place-items-center rounded-lg border border-stone-200/80 text-stone-500 transition-colors hover:border-stone-300 hover:text-stone-700 disabled:opacity-30 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                >
                  <ArrowUp className="size-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move "${textById.get(id) ?? id}" down`}
                  className="grid size-6 place-items-center rounded-lg border border-stone-200/80 text-stone-500 transition-colors hover:border-stone-300 hover:text-stone-700 disabled:opacity-30 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                >
                  <ArrowDown className="size-3.5" aria-hidden />
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {!graded ? (
        <button
          type="button"
          onClick={submit}
          className="mt-2.5 rounded-full bg-stone-900 px-3.5 py-1 text-xs font-medium text-white transition-colors hover:bg-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          Check order
        </button>
      ) : null}

      {graded && result ? (
        <div className="mt-2.5 space-y-1.5" role="status">
          <p className={`text-xs font-medium ${verdictClass}`}>{verdictLabel}</p>
          {result.outcome !== "demonstrated" ? (
            <div className="text-xs leading-relaxed text-stone-600">
              <span className="text-stone-500">The correct order is:</span>
              <ol className="mt-1 space-y-0.5">
                {card.correctOrder.map((id, i) => (
                  <li key={id} className="flex gap-1.5">
                    <span aria-hidden className="text-stone-400">
                      {i + 1}.
                    </span>
                    <span>{textById.get(id) ?? id}</span>
                  </li>
                ))}
              </ol>
            </div>
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

export default TutorSequenceCard;
