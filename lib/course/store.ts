/**
 * Editor state — one Zustand store.
 *
 * `apply` is the SINGLE mutation entry point for the document: every change,
 * human or AI, is a CoursePatch that gets schema-validated, applied via the
 * pure `applyCoursePatch`, logged, and pushed onto the undo stack.
 *
 * Initial state is an empty PLACEHOLDER course (deterministic, hydration-
 * safe). The studio loads the real course from the database on mount and
 * calls `hydrate` to install it; edits then persist back (debounced) via
 * lib/editor/coursePersistence.ts, which reports progress through
 * `saveStatus`.
 */

"use client";

import { create } from "zustand";
import { newId } from "./factories";
import {
  applyCoursePatch,
  CoursePatchSchema,
  type CoursePatch,
  type PatchResult,
} from "./patches";
import { findLesson, findSlide, firstLessonId, resolveSelection } from "./queries";
import { PLACEHOLDER_COURSE } from "./placeholder";
import type { CourseDocument, Selection } from "./types";

export type PatchSource = "human" | "ai";

/** Persistence lifecycle, surfaced in the editor header. */
export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface PatchLogEntry {
  id: string;
  at: string;
  source: PatchSource;
  summary: string;
  patch: CoursePatch;
}

export interface AIResult {
  ok: boolean;
  summary: string;
}

/**
 * Undo = whole-document snapshots. Measured 2026-06: seed doc ≈ 24 KB JSON
 * (3 slides); a heavy 100-slide course projects to ~780 KB, i.e. ~76 MB at
 * this cap — acceptable until real-scale docs exist. When Supabase-scale
 * courses land, switch to inverse patches instead of raising this further
 * (AUDIT.md #14).
 */
const UNDO_LIMIT = 100;

interface EditorState {
  doc: CourseDocument;
  /** DB id of the course being edited (null until hydrated). */
  courseId: string | null;
  selection: Selection;
  activeLessonId: string;
  patchLog: PatchLogEntry[];
  undoStack: CourseDocument[];
  redoStack: CourseDocument[];
  lastAIResult: AIResult | null;
  saveStatus: SaveStatus;
  /** When the last successful save completed (ISO), for the header. */
  lastSavedAt: string | null;
  /** Autosave is paused (e.g. during a Reject) — the persistence hook skips
   *  scheduling and aborts any in-flight save while true. */
  autosaveSuspended: boolean;
  /** Skip the autosave for exactly ONE upcoming doc change (the reverted doc a
   *  Reject re-hydrates is already the server state — re-saving it is redundant
   *  and races the reject). */
  autosaveSkipOnce: boolean;
  /** Internal: the next hydrate is a Reject refetch (→ resume + skip-once). */
  rejectRefetch: boolean;
  /** True while an AI agent run is streaming. Autosave pauses (the agent persists
   *  server-side; a competing browser full-snapshot would race + can orphan rows)
   *  and the live-render re-sync runs instead. Survives `syncLiveDoc`. */
  agentRunActive: boolean;

  hydrate: (doc: CourseDocument, courseId: string) => void;
  /** Replace the live document from a server re-load DURING an agent run (live
   *  render) — WITHOUT touching undo/redo, courseId, save state, or the run flag.
   *  Distinct from `hydrate`, which is the authoritative full reset. */
  syncLiveDoc: (doc: CourseDocument) => void;
  /** Mark an AI agent run as active/inactive (pauses autosave for its duration). */
  setAgentRunActive: (v: boolean) => void;
  select: (sel: Selection) => void;
  openLesson: (lessonId: string) => void;
  apply: (patch: unknown, source: PatchSource) => PatchResult;
  applyMany: (patches: unknown[], source: PatchSource) => PatchResult;
  undo: () => void;
  redo: () => void;
  setLastAIResult: (result: AIResult | null) => void;
  setSaveStatus: (status: SaveStatus, savedAt?: string) => void;
  /** Pause autosave + flag the imminent reject re-hydrate (called before Reject). */
  suspendAutosaveForReject: () => void;
  /** Resume autosave without a reject re-hydrate (e.g. the reject POST failed). */
  resumeAutosave: () => void;
  /** Read-and-clear the skip-once flag (used by the persistence hook). */
  consumeAutosaveSkip: () => boolean;
}

/** If the selection no longer resolves (node deleted), walk up to something
 *  that exists. Multi-selections shed dead ids instead of collapsing. */
function repairSelection(doc: CourseDocument, sel: Selection): Selection {
  if (sel.kind === "elements") {
    const hit = findSlide(doc, sel.blockId, sel.slideId);
    if (hit) {
      const surviving = sel.ids.filter((id) =>
        hit.slide.elements.some((el) => el.id === id)
      );
      if (surviving.length >= 2) {
        return surviving.length === sel.ids.length ? sel : { ...sel, ids: surviving };
      }
      if (surviving.length === 1) {
        return {
          kind: "element",
          id: surviving[0],
          slideId: sel.slideId,
          blockId: sel.blockId,
          lessonId: sel.lessonId,
          scope: sel.scope,
        };
      }
      return {
        kind: "slide",
        id: sel.slideId,
        blockId: sel.blockId,
        lessonId: sel.lessonId,
      };
    }
    // slide itself is gone — fall through to the lesson fallback
  }
  if (resolveSelection(doc, sel)) return sel;
  const lessonId =
    sel.kind === "block" ||
    sel.kind === "slide" ||
    sel.kind === "element" ||
    sel.kind === "elements"
      ? sel.lessonId
      : undefined;
  if (lessonId && findLesson(doc, lessonId)) return { kind: "lesson", id: lessonId };
  return { kind: "course" };
}

function repairActiveLesson(doc: CourseDocument, lessonId: string): string {
  return findLesson(doc, lessonId) ? lessonId : (firstLessonId(doc) ?? "");
}

export const useEditorStore = create<EditorState>()((set, get) => {
  /** Validate + apply a pre-parsed batch atomically. Shared by apply/applyMany. */
  function commit(patches: CoursePatch[], source: PatchSource): PatchResult {
    const { doc } = get();
    const nowIso = new Date().toISOString();
    let working = doc;
    const summaries: string[] = [];
    for (const patch of patches) {
      const result = applyCoursePatch(working, patch, nowIso);
      if (!result.ok) return result;
      working = result.doc;
      summaries.push(result.summary);
    }
    const summary = summaries.join(" · ");
    set((state) => ({
      doc: working,
      undoStack: [...state.undoStack.slice(-(UNDO_LIMIT - 1)), doc],
      redoStack: [],
      patchLog: [
        ...state.patchLog,
        ...patches.map((patch, i) => ({
          id: newId("patch"),
          at: nowIso,
          source,
          summary: summaries[i],
          patch,
        })),
      ],
      selection: repairSelection(working, state.selection),
      activeLessonId: repairActiveLesson(working, state.activeLessonId),
    }));
    return { ok: true, doc: working, summary };
  }

  return {
    doc: PLACEHOLDER_COURSE,
    courseId: null,
    selection: { kind: "course" },
    activeLessonId: "",
    patchLog: [],
    undoStack: [],
    redoStack: [],
    lastAIResult: null,
    saveStatus: "idle",
    lastSavedAt: null,
    autosaveSuspended: false,
    autosaveSkipOnce: false,
    rejectRefetch: false,
    agentRunActive: false,

    /** Install a freshly loaded course; resets history and save state. A Reject
     *  refetch resumes autosave and skips re-saving the reverted doc. */
    hydrate: (doc, courseId) => {
      const lessonId = firstLessonId(doc) ?? "";
      const fromReject = get().rejectRefetch;
      set({
        doc,
        courseId,
        selection: lessonId ? { kind: "lesson", id: lessonId } : { kind: "course" },
        activeLessonId: lessonId,
        patchLog: [],
        undoStack: [],
        redoStack: [],
        lastAIResult: null,
        saveStatus: "idle",
        lastSavedAt: doc.metadata.updatedAt,
        autosaveSuspended: false,
        autosaveSkipOnce: fromReject,
        rejectRefetch: false,
      });
    },

    /** Live-render re-sync during an agent run: swap in the freshly-persisted doc
     *  without resetting history / save state / the run flag (so undo + the paused
     *  autosave are untouched). Repairs the selection if a referenced node moved. */
    syncLiveDoc: (doc) =>
      set((state) => ({
        doc,
        selection: repairSelection(doc, state.selection),
        activeLessonId: repairActiveLesson(doc, state.activeLessonId),
      })),

    setAgentRunActive: (v) => set({ agentRunActive: v }),

    suspendAutosaveForReject: () => set({ autosaveSuspended: true, rejectRefetch: true }),

    resumeAutosave: () => set({ autosaveSuspended: false, rejectRefetch: false, autosaveSkipOnce: false }),

    consumeAutosaveSkip: () => {
      if (!get().autosaveSkipOnce) return false;
      set({ autosaveSkipOnce: false });
      return true;
    },

    select: (sel) => set({ selection: sel }),

    openLesson: (lessonId) =>
      set({ activeLessonId: lessonId, selection: { kind: "lesson", id: lessonId } }),

    apply: (patch, source) => {
      const parsed = CoursePatchSchema.safeParse(patch);
      if (!parsed.success) {
        return { ok: false, error: `Invalid patch: ${parsed.error.issues[0]?.message ?? "schema mismatch"}` };
      }
      return commit([parsed.data], source);
    },

    applyMany: (patches, source) => {
      const parsedAll: CoursePatch[] = [];
      for (const patch of patches) {
        const parsed = CoursePatchSchema.safeParse(patch);
        if (!parsed.success) {
          return {
            ok: false,
            error: `Invalid patch in batch: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
          };
        }
        parsedAll.push(parsed.data);
      }
      if (parsedAll.length === 0) {
        return { ok: false, error: "No patches to apply" };
      }
      return commit(parsedAll, source);
    },

    undo: () =>
      set((state) => {
        const prev = state.undoStack[state.undoStack.length - 1];
        if (!prev) return state;
        return {
          ...state,
          doc: prev,
          undoStack: state.undoStack.slice(0, -1),
          redoStack: [...state.redoStack, state.doc],
          selection: repairSelection(prev, state.selection),
          activeLessonId: repairActiveLesson(prev, state.activeLessonId),
        };
      }),

    redo: () =>
      set((state) => {
        const next = state.redoStack[state.redoStack.length - 1];
        if (!next) return state;
        return {
          ...state,
          doc: next,
          redoStack: state.redoStack.slice(0, -1),
          undoStack: [...state.undoStack, state.doc],
          selection: repairSelection(next, state.selection),
          activeLessonId: repairActiveLesson(next, state.activeLessonId),
        };
      }),

    setLastAIResult: (result) => set({ lastAIResult: result }),

    setSaveStatus: (status, savedAt) =>
      set(status === "saved" && savedAt ? { saveStatus: status, lastSavedAt: savedAt } : { saveStatus: status }),
  };
});
