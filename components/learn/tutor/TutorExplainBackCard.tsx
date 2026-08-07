"use client";

/**
 * TUTOR-1 A3 Wave 5 — the explainBack card (Class A, SERVER-graded — A3-17).
 *
 * The ONE new interaction shape whose grading is server-side: the learner writes a
 * free-text self-explanation, and the route's `explain_back_grade` action grades
 * PRESENCE of each rubric idea (never wording) with a pooled model call, records
 * the tutor_evidence itself, and returns per-criterion results. This card AWAITS
 * that graded response (NOT fire-and-forget), then renders each criterion as a
 * met ✓ / not-yet ○ row with the model's note — and NO pass/fail verdict text
 * (A3-17: the learner sees criterion-level presence only, never an overall grade).
 *
 * A model failure (`{ ok:false }`) shows a plain "couldn't grade that — try again"
 * retry (never a fabricated result). On a graded result it records a session
 * attempt (A3-4 gate). The button is disabled while grading, showing a calm
 * "reading your explanation…" pending state.
 *
 * A11y (A3-25): the explanation is a labelled `<textarea>`; the criterion markers
 * carry text alternatives (the ✓/○ glyph is aria-hidden, "met"/"not yet" is
 * sr-only). No positive tabindex; NO framer-motion; no Date.now/Math.random in
 * render. House style: warm paper/stone, rounded-2xl. Zod-free.
 */

import { useCallback, useState } from "react";
import { useTutorStore } from "@/lib/learn/tutorStore";
import {
  explainBackCriteriaView,
  type ExplainBackCriterionView,
  type TutorAssessmentCard,
} from "@/lib/learn/tutorClientTypes";
import { gradeExplainBack } from "@/lib/learn/tutorEvidence";

type ExplainBackCard = Extract<TutorAssessmentCard, { toolName: "explainBack" }>;

type Phase =
  | { kind: "editing" }
  | { kind: "grading" }
  | { kind: "graded"; rows: ExplainBackCriterionView[] }
  | { kind: "failed" };

export function TutorExplainBackCard({
  card,
  courseId,
  publicationId,
  version,
  lessonId,
  userId,
}: {
  card: ExplainBackCard;
  courseId: string;
  publicationId: string;
  version: number;
  lessonId: string | null;
  userId: string;
}) {
  const recordSessionAttempt = useTutorStore((s) => s.recordSessionAttempt);

  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });

  const submit = useCallback(() => {
    if (phase.kind === "grading" || !text.trim()) return;
    setPhase({ kind: "grading" });
    // The grade is AWAITED (server-side) — unlike the other cards. The route
    // records the evidence itself from its own grade, so no outcome is sent here.
    void gradeExplainBack({
      courseId,
      publicationId,
      version,
      lessonId,
      cardId: card.cardId,
      conceptSlug: card.conceptSlug,
      text: text.trim(),
      rubric: card.rubric,
      initiation: card.initiation,
    }).then((result) => {
      if (!result.ok) {
        setPhase({ kind: "failed" });
        return;
      }
      recordSessionAttempt(userId, card.conceptSlug);
      setPhase({ kind: "graded", rows: explainBackCriteriaView(result.criteria) });
    });
  }, [
    phase.kind,
    text,
    card,
    courseId,
    publicationId,
    version,
    lessonId,
    recordSessionAttempt,
    userId,
  ]);

  const retry = useCallback(() => {
    setPhase({ kind: "editing" });
  }, []);

  const grading = phase.kind === "grading";
  const inputId = `explain-${card.cardId}`;

  return (
    <div
      data-ai-tool="tutor-explain-back-card"
      className="w-[92%] rounded-2xl border border-stone-200/80 bg-white p-3 text-sm shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
    >
      <label htmlFor={inputId} className="block font-medium text-stone-800">
        {card.prompt}
      </label>

      {/* The explanation textarea — locked once a grade is in flight / returned. */}
      <textarea
        id={inputId}
        value={text}
        disabled={phase.kind === "grading" || phase.kind === "graded"}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Explain it in your own words…"
        className="mt-1.5 w-full resize-none rounded-xl border border-stone-200/80 bg-white px-2.5 py-1.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-stone-50"
      />

      {/* EDITING / GRADING — the Explain button + a calm pending line. */}
      {phase.kind === "editing" || phase.kind === "grading" ? (
        <div className="mt-2">
          <button
            type="button"
            disabled={grading || !text.trim()}
            onClick={submit}
            className="rounded-full bg-stone-900 px-3.5 py-1 text-xs font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            Explain
          </button>
          {grading ? (
            <p role="status" className="mt-1.5 text-[11px] text-stone-400">
              Reading your explanation…
            </p>
          ) : null}
        </div>
      ) : null}

      {/* GRADED — per-criterion met/not-yet rows + notes. NO pass/fail verdict. */}
      {phase.kind === "graded" ? (
        <ul className="mt-2.5 space-y-1.5" role="status">
          {phase.rows.map((row, i) => (
            <li key={i} className="flex gap-2">
              <span
                aria-hidden
                className={[
                  "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold",
                  row.met ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-400",
                ].join(" ")}
              >
                {row.met ? "✓" : "○"}
              </span>
              <span className="sr-only">{row.met ? "met: " : "not yet: "}</span>
              <span className="min-w-0 flex-1">
                <span className={row.met ? "text-stone-700" : "text-stone-600"}>
                  {row.criterion}
                </span>
                {row.note ? (
                  <span className="mt-0.5 block text-xs leading-relaxed text-stone-500">
                    {row.note}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* FAILED — a plain retry; never a fabricated grade. */}
      {phase.kind === "failed" ? (
        <div className="mt-2" role="alert">
          <p className="text-xs text-stone-600">Couldn&apos;t grade that — try again.</p>
          <button
            type="button"
            onClick={retry}
            className="mt-1.5 rounded-full border border-stone-300/80 bg-white px-3.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default TutorExplainBackCard;
