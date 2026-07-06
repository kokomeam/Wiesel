"use client";

/**
 * Campaign + sequence lifecycle controls — the ONE component family for
 * pausing/resuming/cancelling running email operations, wherever they're
 * shown (hub campaign card, campaign list rows, sequences list, sequence
 * detail). The builder header uses the same server actions.
 *
 * Semantics (mirrors the tool layer exactly):
 *   Pause   — reversible, executes immediately; queued sends are HELD.
 *   Resume  — reversible; held sends continue on schedule.
 *   Cancel… — irreversible, hard-denied from auto-approval: ALWAYS renders an
 *             approval card in place, in every autonomy mode.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play, X } from "lucide-react";
import {
  cancelCampaignRequestAction,
  pauseCampaignAction,
  pauseSequenceAction,
  resumeCampaignAction,
  resumeSequenceAction,
} from "@/app/(app)/marketing/campaignActions";
import type { PendingActionPayload } from "@/app/(app)/marketing/actions";
import { ApprovalCard } from "@/components/marketing/ApprovalCard";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

function Note({ note }: { note: { text: string; error: boolean } | null }) {
  if (!note) return null;
  return (
    <p className={cn("w-full text-xs", note.error ? "text-red-700" : "text-stone-500")}>{note.text}</p>
  );
}

/** Pause / Resume / Cancel for a campaign. Renders nothing when the status has
 *  no applicable control (draft, completed, cancelled). */
export function CampaignLifecycleControls({
  campaignId,
  status,
  showCancel = true,
}: {
  campaignId: string;
  status: string;
  /** The list rows keep Cancel behind the builder; the hub card shows it. */
  showCancel?: boolean;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [card, setCard] = useState<PendingActionPayload | null>(null);

  const pausable = status === "active" || status === "sending";
  const resumable = status === "paused";
  const cancellable =
    showCancel && ["active", "sending", "paused"].includes(status);
  if (!pausable && !resumable && !cancellable) return null;

  return (
    <>
      <span className="flex shrink-0 items-center gap-1.5">
        {busy ? <Loader2 className="size-3.5 animate-spin text-stone-400" /> : null}
        {pausable ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="Hold every queued send — resume any time, nothing is lost"
            onClick={() =>
              startTransition(async () => {
                await pauseCampaignAction(campaignId);
                setNote({ text: "Paused — queued sends are held until you resume.", error: false });
                router.refresh();
              })
            }
          >
            <Pause className="size-3.5" /> Pause
          </Button>
        ) : null}
        {resumable ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="Held sends continue on their schedule"
            onClick={() =>
              startTransition(async () => {
                await resumeCampaignAction(campaignId);
                setNote({ text: "Resumed — held sends continue on their schedule.", error: false });
                router.refresh();
              })
            }
          >
            <Play className="size-3.5" /> Resume
          </Button>
        ) : null}
        {cancellable ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title="Permanently stop every queued send — needs your approval"
            onClick={() =>
              startTransition(async () => {
                const r = await cancelCampaignRequestAction(campaignId);
                if (r.pending) setCard(r.pending);
                else setNote({ text: r.message, error: false });
                router.refresh();
              })
            }
          >
            <X className="size-3.5" /> Cancel…
          </Button>
        ) : null}
      </span>
      <Note note={note} />
      {card ? (
        <div className="w-full">
          <ApprovalCard
            pending={card}
            onResult={(r) => setNote({ text: r.message, error: !!r.error })}
            onResolved={() => setCard(null)}
          />
        </div>
      ) : null}
    </>
  );
}

/** Pause / Resume for ONE sequence (both reversible — no approval card). */
export function SequenceLifecycleControls({
  sequenceId,
  status,
}: {
  sequenceId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  if (status !== "active" && status !== "paused") return null;

  const run = (fn: () => Promise<{ message: string; error?: boolean }>) =>
    startTransition(async () => {
      const r = await fn();
      setNote({ text: r.message, error: !!r.error });
      router.refresh();
    });

  return (
    <>
      <span className="flex shrink-0 items-center gap-1.5">
        {busy ? <Loader2 className="size-3.5 animate-spin text-stone-400" /> : null}
        {status === "active" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="Hold this sequence's queued sends — resume any time"
            onClick={() => run(() => pauseSequenceAction(sequenceId))}
          >
            <Pause className="size-3.5" /> Pause
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="Held sends continue on their schedule"
            onClick={() => run(() => resumeSequenceAction(sequenceId))}
          >
            <Play className="size-3.5" /> Resume
          </Button>
        )}
      </span>
      <Note note={note} />
    </>
  );
}
