"use client";

/**
 * A quiet activity-log row — reversible actions that auto-executed (revertable
 * for a window, dismissible always) and irreversible actions the autonomy
 * policy executed (audited, never revertable). Deliberately recessive: no
 * elevation, no colored panel, no primary button — the pending-approval cards
 * next to these carry the visual weight.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Undo2 } from "lucide-react";
import {
  acceptStagedAction,
  rejectStagedAction,
  type ActionResult,
} from "@/app/(app)/marketing/actions";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

export interface ActivityEntryVM {
  id: string;
  actionKind: string;
  summary: string;
  requestedBy: "user" | "agent";
  /** Computed SERVER-side (no client clock → no hydration drift). */
  canRevert: boolean;
  /** e.g. "23h left" — precomputed server-side for the same reason. */
  revertWindowLabel: string | null;
  /** True for an irreversible action the autonomy policy executed. */
  autoExecuted: boolean;
  /** The policy engine's one-line reason (autonomy entries only). */
  autoReason: string | null;
}

export function ActivityLogEntry({ entry, onResult }: { entry: ActivityEntryVM; onResult?: (r: ActionResult) => void }) {
  const router = useRouter();
  const [gone, setGone] = useState<"reverted" | "dismissed" | null>(null);
  const [busy, startTransition] = useTransition();

  if (gone) {
    return (
      <div className="py-1.5 text-xs text-stone-400">
        {gone === "reverted" ? "Reverted — the change was rolled back." : null}
      </div>
    );
  }

  const run = (kind: "revert" | "dismiss") =>
    startTransition(async () => {
      const r = kind === "revert" ? await rejectStagedAction(entry.id) : await acceptStagedAction(entry.id);
      onResult?.(r);
      if (!r.error) setGone(kind === "revert" ? "reverted" : "dismissed");
      router.refresh();
    });

  // Stacked layout (label+actions row, then the summary) so the row works in
  // the hub's narrow rail as well as a wide column — the old one-line flex
  // squeezed the summary to a word per line beside the buttons.
  return (
    <div className="border-b border-stone-100 py-2 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">
          {entry.actionKind.replace(/_/g, " ")}
          {entry.requestedBy === "agent" && !entry.autoExecuted ? " · agent" : ""}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {entry.autoExecuted ? <Badge tone="sky">auto · policy</Badge> : null}
          {busy ? <Loader2 className="size-3 animate-spin text-stone-400" /> : null}
          {!entry.autoExecuted && entry.canRevert ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run("revert")}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-stone-500 hover:bg-stone-900/[0.06] hover:text-stone-800"
              title={entry.revertWindowLabel ?? undefined}
            >
              <Undo2 className="size-3" /> Revert{entry.revertWindowLabel ? ` · ${entry.revertWindowLabel}` : ""}
            </button>
          ) : null}
          {!entry.autoExecuted ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => run("dismiss")}
              className="rounded-full px-2 py-0.5 text-xs text-stone-400 hover:bg-stone-900/[0.06] hover:text-stone-600"
            >
              Dismiss
            </button>
          ) : null}
        </div>
      </div>
      <p className={cn("mt-1 text-xs leading-relaxed text-stone-500")}>
        {entry.summary}
        {entry.autoReason ? <span className="block text-[11px] text-stone-400">{entry.autoReason}</span> : null}
      </p>
    </div>
  );
}
