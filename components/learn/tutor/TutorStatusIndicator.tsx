"use client";

/**
 * TUTOR-1 Amendment A2 (§6) — the standalone streamed-turn STATUS INDICATOR.
 *
 * A quiet, warm-editorial phrase that names WHAT is happening (sent / thinking /
 * composing), never a data source — the copy table lives in phraseFor below. It
 * is a pure render of the phase the hook hands down — the hook owns the 400ms
 * per-phase floor, so status kinds arrive already de-jittered and THIS COMPONENT
 * HOLDS NO TIMERS AT ALL (A2-15: the status-UI suite asserts over this file's
 * source that no scheduling API and no motion library are present). The dot pulse
 * is CSS-only (Tailwind `animate-pulse` + staggered delays, mirroring the
 * TutorBody thinking-row precedent) and freezes entirely under reduced motion.
 *
 * Accessibility (A2-17): the phrase lives in a role="status" + aria-live="polite"
 * + aria-atomic="true" container so each phase change is announced ONCE, and the
 * visible text IS the announced text (no aria-label divergence).
 */

/** The phase this indicator renders. `tool` is a [FWD] reserved variant — unused
 *  in A2, it renders its label verbatim when a later amendment surfaces a paused
 *  tool step; the copy for the three live phases is fixed (§6/§7 table). */
export type TutorStatusPhase =
  | { kind: "sent" }
  | { kind: "thinking" }
  | { kind: "composing" }
  | { kind: "tool"; label: string };

/** The §6/§7 copy — sentence case, no terminal punctuation, never names a data
 *  source. `tool` renders the provided label verbatim (a [FWD] path). */
function phraseFor(phase: TutorStatusPhase): string {
  switch (phase.kind) {
    case "sent":
      return "Sending your question";
    case "thinking":
      return "Working through it";
    case "composing":
      return "Writing your answer";
    case "tool":
      return phase.label;
  }
}

export function TutorStatusIndicator({
  phase,
  reduce,
}: {
  phase: TutorStatusPhase;
  reduce: boolean;
}): React.JSX.Element {
  const phrase = phraseFor(phase);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-ai-component="tutor-status-indicator"
      className="flex items-center gap-2 text-xs text-stone-600"
    >
      <span>{phrase}</span>
      {/* The three-dot pulse animates ONLY with motion allowed (A2-18); under
          reduced motion the phrase stands alone — no animation, no ellipsis. */}
      {reduce ? null : (
        <span aria-hidden className="flex items-center gap-1">
          <span className="size-1.5 animate-pulse rounded-full bg-stone-400" />
          <span className="size-1.5 animate-pulse rounded-full bg-stone-400 [animation-delay:150ms]" />
          <span className="size-1.5 animate-pulse rounded-full bg-stone-400 [animation-delay:300ms]" />
        </span>
      )}
    </div>
  );
}

export default TutorStatusIndicator;
