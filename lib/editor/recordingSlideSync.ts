/**
 * Slide-sync capture (M-R, D-2) — the module-singleton bridge between the
 * video recorder and slide navigation. While a recording session is active,
 * whatever surface changes the visible slide calls `reportSlideShown`; the
 * session collects `{slideId, atMs}` on the RECORDED timeline (the recorder
 * supplies a clock closure that already excludes paused stretches).
 *
 * Consumers: the recorder attaches the entries to its result; the studio
 * modal persists them as `recording.slideSync` (the same jsonb home as
 * `recording.mode`); the clips pipeline reads them through
 * `loadLessonSlideSync` — satisfying the EXACT SlideSyncEntry contract the
 * M-A amendment defined (one shape, producer to consumer).
 *
 * Emitters wired today:
 *   - the editor store's selection (useVideoRecorder subscribes while
 *     recording — presenting from the studio via the minimized REC pill)
 *   - the learner slide player (LearnSlideDeck reports the visible slide —
 *     presenting from a same-tab preview)
 * A different-tab presentation is a different JS context and cannot be
 * captured (documented in docs/clips.md).
 *
 * PURE-testable: no browser APIs; the clock is injected.
 */

export interface SlideSyncCaptureEntry {
  slideId: string;
  atMs: number;
}

let active: {
  recordedMs: () => number;
  entries: SlideSyncCaptureEntry[];
} | null = null;

/** Start a capture session. `recordedMs` returns the RECORDED-timeline
 *  position (pauses excluded); values clamp at 0. */
export function beginSlideSyncCapture(recordedMs: () => number): void {
  active = { recordedMs, entries: [] };
}

/** Report the slide currently on screen. No-op outside a session; consecutive
 *  duplicates collapse (re-selecting the same slide is not an advance). */
export function reportSlideShown(slideId: string): void {
  if (!active || !slideId) return;
  const last = active.entries[active.entries.length - 1];
  if (last?.slideId === slideId) return;
  active.entries.push({ slideId, atMs: Math.max(0, Math.round(active.recordedMs())) });
}

/** End the session and take its entries (ascending by construction). */
export function endSlideSyncCapture(): SlideSyncCaptureEntry[] {
  const session = active;
  active = null;
  return session?.entries ?? [];
}

/** Drop the session without keeping anything (discard/teardown paths). */
export function abortSlideSyncCapture(): void {
  active = null;
}

export function isSlideSyncCapturing(): boolean {
  return active !== null;
}

/* ───────────────────── selection → slideId (pure) ─────────────────────── */

/** Extract the visible slide id from an editor-store selection (the shape
 *  lib/course/store.ts `Selection` uses) — the store-subscription emitter's
 *  pure half, table-tested without a browser. */
export function slideIdFromSelection(sel: {
  kind: string;
  id?: string;
  slideId?: string;
}): string | null {
  if (sel.kind === "slide" && sel.id) return sel.id;
  if ((sel.kind === "element" || sel.kind === "elements") && sel.slideId) return sel.slideId;
  return null;
}
