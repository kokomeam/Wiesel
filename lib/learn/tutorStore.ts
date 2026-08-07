"use client";

/**
 * TUTOR-1 Wave 4 — the LEARNER tutor UI store (Contract 1). This is the ONE
 * bus between the lesson PAGE tree (players, LearnLessonView) and the LAYOUT
 * tree (TutorFrame, TutorMount): a lesson interaction sets `ambient` here; the
 * sidebar reads it; a citation click writes `citationRequest` here; the player
 * reads it and jumps. Neither tree can import the other's components, so a
 * shared zustand store is the seam.
 *
 * ZOD-FREE + editor-free by house rule: this file imports NOTHING from
 * lib/editor/*, lib/analytics/events.ts, lib/tutor/runtime/*, or any zod
 * schema. The persist recipe mirrors lib/editor/uiStore.ts (skipHydration +
 * partialize + an explicit rehydrate helper) but shares no code with it.
 *
 * Persisted (one static key, per-learner map so signed-out/switched users
 * never leak panel state across each other): byUser[userId] = { open, width,
 * scrollPos }. Everything else is TRANSIENT (session-only, never persisted) —
 * including the A3-4 `sessionAttempts` tally: a refresh clears attempts (the
 * conservative direction for the escape-hatch gate, deliberate).
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Docked-panel width clamps (px). Drag persists within this range. */
export const TUTOR_MIN_WIDTH = 300;
export const TUTOR_MAX_WIDTH = 520;
export const TUTOR_DEFAULT_WIDTH = 384;

function clampWidth(w: number): number {
  return Math.min(TUTOR_MAX_WIDTH, Math.max(TUTOR_MIN_WIDTH, Math.round(w)));
}

/** Per-learner persisted panel slice. */
export interface TutorUserSlice {
  open: boolean;
  width: number;
  scrollPos: number;
}

const DEFAULT_USER_SLICE: TutorUserSlice = {
  open: false,
  width: TUTOR_DEFAULT_WIDTH,
  scrollPos: 0,
};

/** The learner's live lesson context — the sidebar grounds its turns on this.
 *  Only `courseId` is guaranteed non-null (TutorMount sets it on mount); the
 *  rest fill in as the learner opens a lesson and interacts with blocks. */
export interface TutorAmbient {
  courseId: string | null;
  publicationId: string | null;
  version: number | null;
  lessonId: string | null;
  blockId: string | null;
  slideId: string | null;
  positionPct: number | null;
  quizActive: boolean | null;
}

const EMPTY_AMBIENT: TutorAmbient = {
  courseId: null,
  publicationId: null,
  version: null,
  lessonId: null,
  blockId: null,
  slideId: null,
  positionPct: null,
  quizActive: null,
};

/** A sidebar → player jump request. `nonce` bumps on every request so a repeat
 *  jump to the same target still fires the player-side effect. */
export interface CitationRequest {
  lessonId: string;
  blockId: string;
  slideId: string | null;
  nonce: number;
}

/** A3-4 · one learner's SESSION-scoped practice-attempt tally. `nodeIds` are
 *  the distinct practice nodes attempted (deduped); `count` is total attempts
 *  (a null-node attempt bumps count only). NEVER persisted — excluded from the
 *  partialize allowlist below, so a refresh clears attempts (conservative:
 *  the escape hatch re-locks until the learner tries again). */
export interface TutorSessionAttempts {
  nodeIds: string[];
  count: number;
}

interface TutorState {
  /** Persisted, per-learner. */
  byUser: Record<string, TutorUserSlice>;

  /** Transient (never persisted). */
  ambient: TutorAmbient;
  citationRequest: CitationRequest | null;
  seed: string | null;
  suggestionDot: boolean;
  sessionAttempts: Record<string, TutorSessionAttempts>;

  /** Read the effective slice for a user (defaults when absent). */
  userSlice: (userId: string) => TutorUserSlice;
  setUserSlice: (userId: string, patch: Partial<TutorUserSlice>) => void;
  setAmbient: (partial: Partial<TutorAmbient>) => void;
  requestCitation: (target: { lessonId: string; blockId: string; slideId: string | null }) => void;
  consumeCitation: () => void;
  seedComposer: (s: string) => void;
  consumeSeed: () => void;
  setSuggestionDot: (b: boolean) => void;
  /** A3-4 · record one practice attempt for a learner (nodeId null = an
   *  attempt with no node attribution — bumps the count only). */
  recordSessionAttempt: (userId: string, nodeId: string | null) => void;
}

export const useTutorStore = create<TutorState>()(
  persist(
    (set, get) => ({
      byUser: {},

      ambient: { ...EMPTY_AMBIENT },
      citationRequest: null,
      seed: null,
      suggestionDot: false,
      sessionAttempts: {},

      userSlice: (userId) => get().byUser[userId] ?? DEFAULT_USER_SLICE,

      setUserSlice: (userId, patch) =>
        set((s) => {
          const prev = s.byUser[userId] ?? DEFAULT_USER_SLICE;
          const next: TutorUserSlice = {
            open: patch.open ?? prev.open,
            width: patch.width !== undefined ? clampWidth(patch.width) : prev.width,
            scrollPos: patch.scrollPos ?? prev.scrollPos,
          };
          return { byUser: { ...s.byUser, [userId]: next } };
        }),

      setAmbient: (partial) => set((s) => ({ ambient: { ...s.ambient, ...partial } })),

      requestCitation: (target) =>
        set((s) => ({
          citationRequest: {
            lessonId: target.lessonId,
            blockId: target.blockId,
            slideId: target.slideId,
            nonce: (s.citationRequest?.nonce ?? 0) + 1,
          },
        })),

      consumeCitation: () => set({ citationRequest: null }),

      seedComposer: (s) => set({ seed: s }),
      consumeSeed: () => set({ seed: null }),

      setSuggestionDot: (b) => set({ suggestionDot: b }),

      recordSessionAttempt: (userId, nodeId) =>
        set((s) => {
          const prev = s.sessionAttempts[userId] ?? { nodeIds: [], count: 0 };
          const nodeIds =
            nodeId !== null && !prev.nodeIds.includes(nodeId)
              ? [...prev.nodeIds, nodeId]
              : prev.nodeIds;
          return {
            sessionAttempts: {
              ...s.sessionAttempts,
              [userId]: { nodeIds, count: prev.count + 1 },
            },
          };
        }),
    }),
    {
      name: "wisesel.tutor.ui",
      skipHydration: true,
      // Persist ONLY the per-learner panel map — ambient/citation/seed AND the
      // A3-4 sessionAttempts tally are session-scoped and must never survive a
      // reload (attempts clearing on refresh is the conservative direction).
      partialize: (s) => ({ byUser: s.byUser }),
    }
  )
);

/** Rehydrate the persisted slice from localStorage. Called once by TutorMount's
 *  hydrator effect (never at SSR / first paint — skipHydration prevents a
 *  mismatch). Safe to call more than once. */
export function hydrateTutorStore(): void {
  void useTutorStore.persist.rehydrate();
}
