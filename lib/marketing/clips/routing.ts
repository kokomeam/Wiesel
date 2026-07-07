/**
 * Recording-format → layout routing (amendment FR-2) + the slide-sync fact
 * helpers the routing conditions read. PURE — no IO, no model calls.
 *
 * Formats are FACTS (what the teacher recorded); layouts are DECISIONS (how a
 * candidate/job renders). This module is the ONLY place facts become
 * decisions. The matrix is binding:
 *
 *   camera_only    → face_track                          (always)
 *   screen_camera  → stacked_split                       (always)
 *   screen_only    → slide_short        when slide-sync covers the span
 *                  → screen_action_zoom when action-dense (FR-3)
 *                  → audiogram          when neither
 *
 * Precedence within screen_only is TOP-DOWN: slide_short beats
 * screen_action_zoom beats audiogram; audiogram is NEVER selected when a
 * higher row applies.
 *
 * ⚠ Slide-sync availability (the FR-7(g) audit): the platform has NO
 * slide↔timestamp producer today — the recorder does not capture slide
 * timings, and no table stores them (exhaustively verified 2026-07-08; see
 * docs/clips.md). `loadLessonSlideSync` is the seam a future producer fills;
 * until then it returns null and slide_short routes only where sync data is
 * injected (eval fixtures). Recording a lesson with slide-sync capture is an
 * M-F prerequisite surfaced at the M-A amendment checkpoint.
 */

import type { ClipLayout, RecordingFormat, SlideSyncEntry } from "./schemas";

/* ─────────────────────── slide-sync fact helpers ──────────────────────── */

/** The slide active at time t: the LAST entry with atMs ≤ t (a slide stays
 *  up until the next one). Null before the first entry. */
export function activeSlideAt(entries: SlideSyncEntry[], tMs: number): SlideSyncEntry | null {
  let active: SlideSyncEntry | null = null;
  for (const e of entries) {
    if (e.atMs > tMs) break;
    active = e;
  }
  return active;
}

/**
 * Sync "covers the span" (the FR-2 slide_short condition) when a slide is
 * active for the WHOLE span — i.e. some slide is already up at span start.
 * (Entries after the start only ADD slides; a null at start means the span's
 * opening seconds have no known slide → not slide-drivable.)
 */
export function slideSyncCoversSpan(
  entries: SlideSyncEntry[] | null,
  span: { startMs: number; endMs: number }
): boolean {
  if (!entries || entries.length === 0) return false;
  const sorted = sortedEntries(entries);
  return activeSlideAt(sorted, span.startMs) !== null;
}

/** Ordered slide refs clipped to a span — FR-6's SlideShortSpec input shape
 *  (each ref carries its visible window within the span). */
export function slidesForSpan(
  entries: SlideSyncEntry[],
  span: { startMs: number; endMs: number }
): { slideId: string; atMs: number; endMs: number }[] {
  const sorted = sortedEntries(entries);
  const out: { slideId: string; atMs: number; endMs: number }[] = [];
  for (const [i, e] of sorted.entries()) {
    const visibleUntil = sorted[i + 1]?.atMs ?? Number.POSITIVE_INFINITY;
    const from = Math.max(e.atMs, span.startMs);
    const to = Math.min(visibleUntil, span.endMs);
    if (to > from) out.push({ slideId: e.slideId, atMs: from, endMs: to });
  }
  return out;
}

function sortedEntries(entries: SlideSyncEntry[]): SlideSyncEntry[] {
  return [...entries].sort((a, b) => a.atMs - b.atMs);
}

/** Whether ANY slide is visible inside the span (the FR-4 slide-ref hook
 *  lint's question — looser than full coverage). */
export function hasSlideWithinSpan(
  entries: SlideSyncEntry[] | null,
  span: { startMs: number; endMs: number }
): boolean {
  if (!entries || entries.length === 0) return false;
  return slidesForSpan(entries, span).length > 0;
}

/* ─────────────────────────── the routing matrix ────────────────────────── */

export interface MomentRoutingContext {
  /** FR-2: the lesson has WiseSel slides with sync covering this span. */
  slideSyncCoversSpan: boolean;
  /** FR-3's verdict for this span. */
  actionDense: boolean;
}

/** The binding FR-2 matrix. Exhaustive over RecordingFormat — a new format
 *  fails compilation here, never silently falls through. */
export function resolveClipLayout(format: RecordingFormat, ctx: MomentRoutingContext): ClipLayout {
  switch (format) {
    case "camera_only":
      return "face_track";
    case "screen_camera":
      return "stacked_split";
    case "screen_only":
      if (ctx.slideSyncCoversSpan) return "slide_short";
      if (ctx.actionDense) return "screen_action_zoom";
      return "audiogram";
  }
}

/* ──────────────────── slide-sync producer seam (empty) ─────────────────── */

/**
 * Load a lesson's slide-sync data. NO producer exists on the platform today
 * (FR-7(g) audit finding) — this returns null unconditionally and exists so
 * the selection engine's call site, the routing conditions, and the tests
 * are already wired when the producer (recorder slide-timing capture, an M-F
 * prerequisite) lands. It deliberately takes the lessonId so the future
 * implementation is a body swap, not a signature change.
 */
export async function loadLessonSlideSync(lessonId: string): Promise<SlideSyncEntry[] | null> {
  void lessonId; // the future producer keys on it — signature is the contract
  return null;
}
