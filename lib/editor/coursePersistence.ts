"use client";

/**
 * Client-side course persistence: debounced, autosave-style sync of the
 * editor's `CourseDocument` to the normalized Postgres tables, through the
 * browser Supabase client (RLS scopes everything to the signed-in author).
 *
 * Strategy — debounced full-snapshot reconcile (AUDIT.md #1):
 *   1. update the `courses` row (only the author-owned columns)
 *   2. upsert modules → lessons → blocks  (parents before children)
 *   3. delete orphans blocks → lessons → modules  (children before parents)
 * Idempotent and safe to repeat; the editor already carries stable UUID ids
 * that ARE the rows' primary keys, so there is no diffing to do.
 */

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { reconcileCourseDoc } from "@/lib/course/persistenceSync";
import { useEditorStore } from "@/lib/course/store";
import type { CourseDocument } from "@/lib/course/types";

const SAVE_DEBOUNCE_MS = 1000;
const MAX_RETRIES = 2;

/**
 * One full reconcile. Thin wrapper over the shared, client-agnostic
 * `reconcileCourseDoc` (the server-side AI agent uses the same function), so
 * human autosave and AI edits persist through one identical path. The optional
 * `signal` lets the hook abort an in-flight save (e.g. when Reject fires).
 */
export async function saveCourseDoc(
  supabase: ReturnType<typeof createClient>,
  doc: CourseDocument,
  ownerId: string,
  signal?: AbortSignal
): Promise<string | null> {
  return reconcileCourseDoc(supabase, doc, ownerId, signal);
}

/**
 * Autosave hook: mounts in the studio shell, watches the document, and
 * debounce-saves changes. Coalesces edits made during an in-flight save so
 * the latest state always wins, and reports progress via the store's
 * `saveStatus` (shown in the header).
 */
export function useCoursePersistence(ownerId: string) {
  const doc = useEditorStore((s) => s.doc);
  const courseId = useEditorStore((s) => s.courseId);
  const setSaveStatus = useEditorStore((s) => s.setSaveStatus);
  const autosaveSuspended = useEditorStore((s) => s.autosaveSuspended);

  // One browser client for the editor's lifetime (lazy, render-safe).
  const [supabase] = useState(() => createClient());

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const pending = useRef<CourseDocument | null>(null);
  const controller = useRef<AbortController | null>(null);
  // Skip the first doc value after hydrate — it's the loaded state, not an edit.
  const primed = useRef(false);

  // The moment autosave is suspended (a Reject in progress), cancel the pending
  // timer AND abort any in-flight save so a stale write can't clobber the revert.
  useEffect(() => {
    if (autosaveSuspended) {
      if (timer.current) clearTimeout(timer.current);
      controller.current?.abort();
    }
  }, [autosaveSuspended]);

  useEffect(() => {
    if (!courseId) return;
    if (!primed.current) {
      primed.current = true;
      return;
    }
    const store = useEditorStore.getState();
    if (store.autosaveSuspended) return; // paused (Reject)
    if (store.consumeAutosaveSkip()) return; // the reverted doc — already server state

    async function flush(next: CourseDocument, attempt = 0) {
      if (useEditorStore.getState().autosaveSuspended) return;
      saving.current = true;
      setSaveStatus("saving");
      const ctrl = new AbortController();
      controller.current = ctrl;
      let error: string | null = null;
      try {
        error = await saveCourseDoc(supabase, next, ownerId, ctrl.signal);
      } catch (e) {
        if (ctrl.signal.aborted) {
          saving.current = false; // aborted by a Reject — drop silently
          return;
        }
        error = e instanceof Error ? e.message : "save failed";
      }
      saving.current = false;
      if (controller.current === ctrl) controller.current = null;

      if (pending.current) {
        const queued = pending.current;
        pending.current = null;
        void flush(queued); // a newer edit landed mid-save — save it too
        return;
      }
      if (error) {
        // Transient fetch failures lose work if dropped — retry with backoff
        // before surfacing, so a blip doesn't silently eat the edit.
        if (attempt < MAX_RETRIES && !useEditorStore.getState().autosaveSuspended) {
          setTimeout(() => void flush(next, attempt + 1), 600 * (attempt + 1));
          return;
        }
        setSaveStatus("error");
        console.error(`Course autosave failed (after ${attempt + 1} tries):`, error);
        return;
      }
      setSaveStatus("saved", new Date().toISOString());
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (useEditorStore.getState().autosaveSuspended) return;
      if (saving.current) {
        pending.current = doc; // coalesce — flushed when the current save ends
      } else {
        void flush(doc);
      }
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [doc, courseId, ownerId, setSaveStatus, supabase]);
}
