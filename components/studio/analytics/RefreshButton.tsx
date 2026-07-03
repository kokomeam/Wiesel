"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";

/** The dev/manual "refresh now" — calls the author-gated
 *  refresh_course_analytics RPC via a server action, then the page re-reads
 *  the fresh rollups. The nightly pg_cron job does the same automatically. */
export function RefreshButton({ action }: { action: () => Promise<void> }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      data-ai-tool="analytics-refresh"
      onClick={() =>
        startTransition(async () => {
          await action();
        })
      }
      className="inline-flex h-9 items-center gap-2 rounded-full border border-stone-200 bg-white px-4 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:opacity-60"
    >
      <RefreshCw className={cn("size-4 text-stone-400", pending && "animate-spin")} aria-hidden />
      {pending ? "Refreshing…" : "Refresh data"}
    </button>
  );
}
