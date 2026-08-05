/**
 * Concept-graph editor store (TUTOR-1 Wave 5, P5.2 · step 1). Standalone zustand
 * — DELIBERATELY NOT lib/editor/uiStore or lib/editor/dragStore: the tutor route
 * has its OWN bundle budget and importing the editor stores would pull the ~590 KB
 * slide-editor graph into it. This module has ZERO dependency on lib/course/* and
 * lib/editor/*; the transient drag frame is coalesced by a LOCAL FrameCoalescer
 * (reimplemented below, ~15 lines) so nothing is imported from dragStore.
 *
 * State:
 *   - selection: the currently-focused node OR edge (drives the detail drawer).
 *   - viewport.zoom: clamped 0.5..3 (the canvas owns fit-scale via ResizeObserver;
 *     the store owns only the user zoom multiplier, mirroring uiStore's split).
 *   - collapsedModules: a Set of module ids the creator has collapsed.
 *   - searchFocus: the current graph search string (empty = no filter).
 *   - drag: a TRANSIENT pan/drag frame (canvas → store, coalesced to one write per
 *     animation frame). Positions are layout-derived, so dragging a node PANS/
 *     SELECTS — it never persists coordinates (there are none to persist).
 *
 * No Math.random / Date.now anywhere (SSR + reduced-motion safe).
 */

import { create } from "zustand";

/* ------------------------------ zoom clamp ------------------------------- */

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 1.25;

/** Clamp + round a zoom to the 0.5..3 range (2 dp — matches uiStore.clampZoom so
 *  the canvas math stays identical). Pure — golden-tested by the verify script. */
export function clampZoom(z: number): number {
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100;
}

/* --------------------------- frame coalescer ----------------------------- */

/** A per-frame batcher: many push()es within one animation frame collapse to a
 *  single write() on the next frame. flush() writes the pending value synchronously
 *  (used on pointerup so the gesture endpoint isn't dropped); cancel() drops it.
 *  Reimplemented here (do NOT import lib/editor/dragStore) so this store carries no
 *  editor dependency. Falls back to a microtask when rAF is unavailable (SSR). */
export interface FrameCoalescer<T> {
  push(value: T): void;
  flush(): void;
  cancel(): void;
}

export function createFrameCoalescer<T>(write: (value: T) => void): FrameCoalescer<T> {
  let pending: { value: T } | null = null;
  let rafId: number | null = null;
  const schedule =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
  const unschedule =
    typeof cancelAnimationFrame === "function"
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  const run = () => {
    rafId = null;
    if (pending) {
      const v = pending.value;
      pending = null;
      write(v);
    }
  };
  return {
    push(value) {
      pending = { value };
      if (rafId === null) rafId = schedule(run) as number;
    },
    flush() {
      if (rafId !== null) {
        unschedule(rafId);
        rafId = null;
      }
      if (pending) {
        const v = pending.value;
        pending = null;
        write(v);
      }
    },
    cancel() {
      if (rafId !== null) {
        unschedule(rafId);
        rafId = null;
      }
      pending = null;
    },
  };
}

/* -------------------------------- store ---------------------------------- */

export type GraphSelection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: null; id: null };

/** A transient drag frame: the logical (unscaled) pointer position + the id being
 *  dragged. Positions are layout-derived — this NEVER persists; it drives the live
 *  pan highlight only. */
export interface GraphDragFrame {
  nodeId: string;
  x: number;
  y: number;
}

interface GraphEditorState {
  selection: GraphSelection;
  zoom: number;
  collapsedModules: Set<string>;
  searchFocus: string;
  /** the live drag frame (one store write per animation frame), or null. */
  drag: GraphDragFrame | null;

  selectNode(id: string): void;
  selectEdge(id: string): void;
  clearSelection(): void;
  setZoom(z: number): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  toggleModule(id: string): void;
  setSearchFocus(q: string): void;
  setDragFrame(frame: GraphDragFrame | null): void;
}

const NO_SELECTION: GraphSelection = { kind: null, id: null };

export const useGraphEditorStore = create<GraphEditorState>((set) => ({
  selection: NO_SELECTION,
  zoom: 1,
  collapsedModules: new Set<string>(),
  searchFocus: "",
  drag: null,

  selectNode: (id) => set({ selection: { kind: "node", id } }),
  selectEdge: (id) => set({ selection: { kind: "edge", id } }),
  clearSelection: () => set({ selection: NO_SELECTION }),

  setZoom: (z) => set({ zoom: clampZoom(z) }),
  zoomIn: () => set((s) => ({ zoom: clampZoom(s.zoom * ZOOM_STEP) })),
  zoomOut: () => set((s) => ({ zoom: clampZoom(s.zoom / ZOOM_STEP) })),
  resetZoom: () => set({ zoom: 1 }),

  toggleModule: (id) =>
    set((s) => {
      // Return a NEW Set so subscribers re-render (a mutated Set has referential
      // identity and zustand would skip the notify).
      const next = new Set(s.collapsedModules);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { collapsedModules: next };
    }),

  setSearchFocus: (q) => set({ searchFocus: q }),
  setDragFrame: (frame) => set({ drag: frame }),
}));
