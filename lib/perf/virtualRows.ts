"use client";

/**
 * Dependency-free list windowing (PERF-1 D2, AC-PERF-12 — diagnosis A5 §6:
 * unvirtualized unbounded client lists). The repo bans new deps (TanStack
 * Virtual is not available), so this is the shared primitive: a PURE window
 * calculation (`computeWindow`, unit-tested in scripts/verify-virtual.ts)
 * plus a small hook (`useVirtualRows`) that owns the DOM wiring — a passive,
 * rAF-coalesced scroll listener, a ResizeObserver for the viewport, and
 * scroll RESTORATION (sessionStorage keyed by a caller id, re-applied on
 * mount as a DOM write so back-nav lands where the user left the list).
 *
 * CONSTRAINT — fixed item size only: every row must occupy exactly `itemSize`
 * px along the scroll axis (include any inter-row gap IN the row). The pads
 * are plain paddings derived from `index × itemSize`, so a variable-height
 * row would desynchronize the scrollbar from the content. Lists with
 * variable-height rows should use rendering containment (`.cv-row` in
 * app/globals.css) instead of this hook.
 */

import { useCallback, useEffect, useState } from "react";

export interface WindowInput {
  /** Scroll position along the windowed axis (scrollTop / scrollLeft). */
  scrollOffset: number;
  /** Visible extent of the scroll container along that axis, in px. */
  viewport: number;
  /** Fixed per-item extent in px (gap included) — see the module contract. */
  itemSize: number;
  /** Total number of items in the list. */
  count: number;
  /** Extra items rendered on each side of the visible range. Default 4. */
  overscan?: number;
}

export interface WindowRange {
  /** First rendered index (inclusive). */
  start: number;
  /** Last rendered index (exclusive) — render `items.slice(start, end)`. */
  end: number;
  /** Leading spacer in px (`start × itemSize`). */
  padStart: number;
  /** Trailing spacer in px (`(count − end) × itemSize`). */
  padEnd: number;
}

const EMPTY_RANGE: WindowRange = { start: 0, end: 0, padStart: 0, padEnd: 0 };

/**
 * Pure fixed-size window math, orientation-agnostic (feed scrollTop/
 * clientHeight for vertical lists, scrollLeft/clientWidth for horizontal).
 * Invariant: padStart + (end − start) × itemSize + padEnd === count × itemSize.
 */
export function computeWindow(input: WindowInput): WindowRange {
  const { itemSize, count } = input;
  if (count <= 0 || itemSize <= 0) return EMPTY_RANGE;

  const overscan = Math.max(0, Math.floor(input.overscan ?? 4));
  const viewport = Math.max(0, input.viewport);
  const total = count * itemSize;
  const maxOffset = Math.max(0, total - viewport);
  const offset = Math.min(Math.max(0, input.scrollOffset), maxOffset);

  const firstVisible = Math.min(count - 1, Math.floor(offset / itemSize));
  // At least one item stays rendered even while the viewport is unmeasured.
  const lastVisible = Math.min(
    count,
    Math.max(firstVisible + 1, Math.ceil((offset + viewport) / itemSize))
  );

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, lastVisible + overscan);
  return {
    start,
    end,
    padStart: start * itemSize,
    padEnd: (count - end) * itemSize,
  };
}

/** Serialize a scroll offset for sessionStorage (pure — round-trip tested). */
export function packScrollOffset(offset: number): string {
  return String(Math.max(0, Math.round(offset)));
}

/** Parse a stored offset; anything unusable (null/garbage/negative) → 0. */
export function unpackScrollOffset(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

const storageKey = (id: string) => `vrows:${id}`;

export interface VirtualRowsOptions {
  /** Stable per-list id — the sessionStorage scroll-restoration key. */
  restoreId: string;
  count: number;
  /** Fixed per-item extent in px (gap included). */
  itemSize: number;
  overscan?: number;
  /** Window along scrollLeft/clientWidth instead of scrollTop/clientHeight. */
  horizontal?: boolean;
  /** Assumed viewport until the container is measured. Keeps the server
   *  render and the first client render identical (no hydration mismatch);
   *  pass the container's max-height. Default 480. */
  initialViewport?: number;
}

export interface VirtualRowsResult extends WindowRange {
  /** Callback ref for the scroll container (it must own the scrolling). */
  containerRef: (el: HTMLElement | null) => void;
}

export function useVirtualRows(options: VirtualRowsOptions): VirtualRowsResult {
  const {
    restoreId,
    count,
    itemSize,
    overscan,
    horizontal = false,
    initialViewport = 480,
  } = options;

  // The element rides in state (not a ref) so attaching the container re-runs
  // the wiring effect; deterministic initial state keeps hydration clean.
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [viewport, setViewport] = useState(initialViewport);

  useEffect(() => {
    if (!el) return;
    const key = storageKey(restoreId);
    const readOffset = () => (horizontal ? el.scrollLeft : el.scrollTop);

    // Passive + rAF-coalesced: scroll can fire >250×/s; state (and the
    // restoration stamp) advance at most once per frame.
    let frame: number | null = null;
    const onScroll = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const offset = readOffset();
        setScrollOffset(offset);
        try {
          sessionStorage.setItem(key, packScrollOffset(offset));
        } catch {
          // Storage unavailable (private mode) — restoration degrades quietly.
        }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });

    const observer = new ResizeObserver(() => {
      // Fires async after observe() — never setState in the effect body.
      const measured = horizontal ? el.clientWidth : el.clientHeight;
      setViewport((prev) => (prev === measured ? prev : measured));
    });
    observer.observe(el);

    // Scroll restoration (AC-PERF-12): a DOM write, not a setState — the
    // resulting scroll event feeds the offset back through the listener.
    let restored = 0;
    try {
      restored = unpackScrollOffset(sessionStorage.getItem(key));
    } catch {
      // Ignore — start at the top.
    }
    if (restored > 0) {
      el.scrollTo(horizontal ? { left: restored } : { top: restored });
    }

    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [el, restoreId, horizontal]);

  const containerRef = useCallback((node: HTMLElement | null) => setEl(node), []);

  return {
    containerRef,
    ...computeWindow({ scrollOffset, viewport, itemSize, count, overscan }),
  };
}
