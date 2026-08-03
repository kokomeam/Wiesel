"use client";

/**
 * Transient gesture state for the slide canvas: per-member frames while a
 * move/resize is live, plus active snap guide lines and the marquee rect.
 *
 * Deliberately a SEPARATE store from uiStore — uiStore is wrapped in
 * zustand's persist middleware, which serializes to localStorage on every
 * set(); pointermove-frequency writes belong in a plain store. Nothing here
 * is ever persisted and no patches are emitted until pointerup.
 */

import { create } from "zustand";
import type { Frame } from "@/lib/course/slide/geometry";
import type { LineGeometry } from "@/lib/course/types";

/** A live gesture frame; line/arrow endpoint drags also reshape `points`. */
export type TransientFrame = Frame & { points?: LineGeometry };

export interface GuideLine {
  axis: "v" | "h";
  /** Position on the cross axis (logical px). */
  pos: number;
  /** Span along the guide (logical px). */
  from: number;
  to: number;
  /** Measurement chip (equal-gap guides show the gap in px). */
  label?: string;
}

export interface DragSession {
  blockId: string;
  slideId: string;
  /** Transient frames for every element participating in the gesture. */
  frames: Record<string, TransientFrame>;
  guides: GuideLine[];
}

export interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DragState {
  session: DragSession | null;
  marquee: MarqueeRect | null;
  setSession: (session: DragSession | null) => void;
  updateSession: (frames: Record<string, TransientFrame>, guides: GuideLine[]) => void;
  setMarquee: (rect: MarqueeRect | null) => void;
}

export const useDragStore = create<DragState>()((set) => ({
  session: null,
  marquee: null,
  setSession: (session) => set({ session }),
  updateSession: (frames, guides) =>
    set((s) => (s.session ? { session: { ...s.session, frames, guides } } : s)),
  setMarquee: (rect) => set({ marquee: rect }),
}));

/* ────────────────────── pointermove write coalescing ─────────────────────
 * Raw pointermove fires >250/s on gaming mice while the screen paints at
 * 60–120 Hz — writing the drag store per event re-renders every subscribed
 * element several times per frame for frames that never paint (diagnosis
 * A5 §6). Gestures push their latest computed payload here; ONE store write
 * lands per animation frame (latest wins). `flush()` on pointer-up writes
 * synchronously so the committed patch reads the exact final position —
 * one-undo-per-gesture semantics are untouched. */

export interface FrameCoalescer<T> {
  /** Record the latest payload; schedules one write on the next frame. */
  push(value: T): void;
  /** Write any pending payload NOW (pointer-up) so commits read exact state. */
  flush(): void;
  /** Drop any pending payload without writing (unmount mid-gesture). */
  cancel(): void;
}

export function createFrameCoalescer<T>(write: (value: T) => void): FrameCoalescer<T> {
  let pending: { value: T } | null = null;
  let rafId: number | null = null;
  const run = () => {
    rafId = null;
    if (pending) {
      const { value } = pending;
      pending = null;
      write(value);
    }
  };
  return {
    push(value) {
      pending = { value };
      if (rafId === null) rafId = requestAnimationFrame(run);
    },
    flush() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      run();
    },
    cancel() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      pending = null;
    },
  };
}
