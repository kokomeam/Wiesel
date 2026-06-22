"use client";

/**
 * Live-render re-sync: during an AI agent run the agent persists each authored
 * slide batch to the DB as it lands (server-side, per turn). This debounced helper
 * re-loads the course doc through the browser Supabase client and swaps it into the
 * editor via `syncLiveDoc` — so the deck fills in LIVE as the agent works, without
 * a full re-hydrate (undo / selection / the paused autosave stay intact).
 *
 * Triggered from two places (both debounced into one re-load): the agent's own SSE
 * mutating events, and Supabase Realtime inserts on the staging table. Idempotent
 * and safe to call repeatedly; a stale course (the user navigated away) is ignored.
 */

import { createClient } from "@/lib/supabase/client";
import { loadCourseDoc } from "@/lib/course/persistenceSync";
import { useEditorStore } from "@/lib/course/store";

let timer: ReturnType<typeof setTimeout> | null = null;
let client: ReturnType<typeof createClient> | null = null;
let running = false;
let again = false;

async function run() {
  if (running) {
    again = true; // a trigger landed mid-load — re-run once after this finishes
    return;
  }
  running = true;
  try {
    const courseId = useEditorStore.getState().courseId;
    if (!courseId) return;
    client ??= createClient();
    const doc = await loadCourseDoc(client, courseId);
    // Only apply if we're still on the same course AND a run is active (otherwise
    // the authoritative end-of-run refresh owns the state).
    const st = useEditorStore.getState();
    if (doc && st.courseId === courseId && st.agentRunActive) st.syncLiveDoc(doc);
  } catch {
    /* a transient read failure is harmless — the end-of-run refresh corrects it */
  } finally {
    running = false;
    if (again) {
      again = false;
      void run();
    }
  }
}

/** Schedule a live re-sync (trailing-debounced). */
export function scheduleLiveSync(delayMs = 850): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, delayMs);
}

/** Cancel a pending live re-sync (the run ended; the authoritative refresh takes over). */
export function cancelLiveSync(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
