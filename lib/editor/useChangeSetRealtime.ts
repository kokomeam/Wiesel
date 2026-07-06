"use client";

/**
 * Supabase Realtime bridge for live rendering: subscribe to INSERTs on the staging
 * table (`change_set_items`) for the active course, and re-sync the editor from the
 * DB the moment a newly-staged block lands — so the deck fills in as the agent
 * works (in tandem with the SSE-driven `scheduleLiveSync`, both debounced into one
 * re-load). The live-sync helper only applies while an agent run is active, so this
 * never disturbs the editor at rest.
 *
 * Defensive: if the table isn't in the `supabase_realtime` publication (the
 * migration hasn't been applied), the channel simply never fires — the SSE live
 * sync + the authoritative end-of-run refresh still deliver the changes. RLS scopes
 * received rows to the author, so this exposes nothing new.
 */

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { scheduleLiveSync } from "./liveSync";

export function useChangeSetRealtime(courseId: string | null): void {
  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    const supabase = createClient();
    const channel = supabase
      .channel(`change-set-items:${courseId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "change_set_items", filter: `course_id=eq.${courseId}` },
        () => {
          if (!cancelled) scheduleLiveSync();
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [courseId]);
}
