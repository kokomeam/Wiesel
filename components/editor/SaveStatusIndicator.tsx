"use client";

/**
 * Small ambient autosave indicator, pinned to the bottom-right corner just
 * above the AI button. Reflects the store's `saveStatus`:
 *   saving → spinner · saved → check (auto-hides after a moment) · error →
 *   persistent "Couldn't save" with a Retry that re-runs the full reconcile.
 * Idle (before the first save) renders nothing.
 */

import { useEffect, useState } from "react";
import { Check, CloudOff, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { useEditorStore } from "@/lib/course/store";
import { saveCourseDoc } from "@/lib/editor/coursePersistence";
import { createClient } from "@/lib/supabase/client";

const base =
  "fixed bottom-20 right-4 z-40 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-[0_4px_14px_rgba(28,25,23,0.08)] backdrop-blur";

export function SaveStatusIndicator({ ownerId }: { ownerId: string }) {
  const status = useEditorStore((s) => s.saveStatus);
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const setSaveStatus = useEditorStore((s) => s.setSaveStatus);
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);

  // Auto-hide the "saved" chip a moment after each successful save. Keyed by
  // lastSavedAt so a fresh save re-shows it. (Only the timeout sets state, so
  // this never triggers a setState-in-effect.)
  useEffect(() => {
    if (status !== "saved") return;
    const key = lastSavedAt ?? "saved";
    const t = setTimeout(() => setHiddenKey(key), 2500);
    return () => clearTimeout(t);
  }, [status, lastSavedAt]);

  async function retry() {
    setSaveStatus("saving");
    const error = await saveCourseDoc(createClient(), useEditorStore.getState().doc, ownerId);
    setSaveStatus(error ? "error" : "saved", new Date().toISOString());
  }

  if (status === "idle") return null;

  if (status === "saving") {
    return (
      <div className={cn(base, "border-stone-200/80 bg-white/95 text-stone-500")} role="status">
        <Loader2 className="size-3.5 animate-spin" />
        Saving…
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className={cn(base, "border-rose-200 bg-rose-50/95 text-rose-700")} role="status">
        <CloudOff className="size-3.5" />
        Couldn&rsquo;t save
        <button
          type="button"
          onClick={retry}
          className="ml-1 inline-flex items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 text-rose-700 transition-colors hover:bg-white"
        >
          <RefreshCw className="size-3" />
          Retry
        </button>
      </div>
    );
  }

  // saved
  if (hiddenKey === (lastSavedAt ?? "saved")) return null;
  return (
    <div className={cn(base, "border-stone-200/80 bg-white/95 text-stone-500")} role="status">
      <Check className="size-3.5 text-emerald-500" />
      Saved
    </div>
  );
}
