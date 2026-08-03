"use client";

/**
 * The queue/editor entry point into connected publishing (M-D §2) —
 * health-aware account picker + optional fire time. Requesting opens the
 * SAME PublishApprovalCard (one component, one composition function) in a
 * modal; approval/skip run the SAME M-C server actions. This component
 * creates NOTHING itself — openCardAction → requestPublishCard is the only
 * path touched (AC-MD.2).
 */

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  PublishApprovalCard,
  type PublishCardPayload,
} from "@/components/marketing/publish/PublishApprovalCard";
import {
  approveCardAction,
  openCardAction,
  rejectCardAction,
} from "@/app/(app)/marketing/publish/actions";
import type { PublishState } from "./PublishStates";

const PLATFORM_TO_ACCOUNT: Record<string, string> = {
  linkedin: "linkedin",
  youtube_shorts: "youtube",
};

export function ConnectedScheduler({
  post,
  state,
  onChanged,
  showToast,
}: {
  post: { id: string; platform: string; postType: string };
  state: PublishState | null;
  onChanged: () => void;
  showToast?: (msg: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [accountId, setAccountId] = useState("");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [card, setCard] = useState<PublishCardPayload | null>(null);

  const targetPlatform = PLATFORM_TO_ACCOUNT[post.platform] ?? null;
  const accounts = useMemo(
    () => (state?.accounts ?? []).filter((a) => a.platform === targetPlatform),
    [state, targetPlatform]
  );

  // Not a publishable platform yet (Task 0b): the Phase-1 manual path stays
  // the only affordance — render nothing. (A clip missing its video is
  // refused server-side at card request: clip_missing_video.)
  if (!targetPlatform) return null;
  if (!state || accounts.length === 0) return null;

  const linked = accounts.filter((a) => a.status === "linked");

  function requestCard() {
    startTransition(async () => {
      setNote(null);
      const res = await openCardAction({
        socialPostId: post.id,
        socialAccountId: accountId || linked[0]?.id,
        proposedScheduledFor: when ? new Date(when).toISOString() : null,
      });
      if (!res.ok) {
        setNote(`Refused: ${res.reason.replace(/_/g, " ")}.`);
        return;
      }
      setCard(res.card);
    });
  }

  return (
    <div className="rounded-xl border border-stone-200/80 bg-stone-50/60 px-3.5 py-3">
      <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-800">
        <CalendarClock className="size-3.5 text-brand-700" /> Publish through a connected account
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={accountId || linked[0]?.id || ""}
          onChange={(e) => setAccountId(e.target.value)}
          className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-xs"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id} disabled={a.status !== "linked"}>
              {a.displayName ?? a.handle ?? a.platform}
              {a.status !== "linked" ? " — needs re-linking" : ""}
            </option>
          ))}
        </select>
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-xs"
          title="Optional — empty publishes immediately after you approve the card"
        />
        <Button size="sm" disabled={pending || linked.length === 0} onClick={requestCard}>
          {when ? "Schedule…" : "Publish…"}
        </Button>
      </div>
      {linked.length === 0 && (
        <p className="mt-1.5 text-[11px] text-amber-700">
          This account needs re-linking first —{" "}
          <Link href="/marketing/accounts" className="underline">
            Connected accounts
          </Link>
          .
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-stone-500">
        Nothing publishes here — the next step is a review card showing exactly what ships.
      </p>
      {note && <p className="mt-1.5 text-[11px] text-rose-700">{note}</p>}

      {card && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-900/40 p-6" onClick={() => setCard(null)}>
          <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
            <PublishApprovalCard
              card={card}
              onApprove={async (token, scheduledFor) => {
                const res = await approveCardAction(token, scheduledFor);
                if (res.ok) {
                  showToast?.(
                    res.scheduledFor
                      ? "Scheduled — track it on the post row."
                      : "Approved — publishing now."
                  );
                  onChanged();
                }
                return res;
              }}
              onReject={async (approvalId) => {
                const res = await rejectCardAction(approvalId);
                if (res.ok) {
                  setCard(null);
                  onChanged();
                }
                return res;
              }}
            />
            <div className="mt-2 text-center">
              <button type="button" className="text-xs text-stone-300 hover:text-white" onClick={() => setCard(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
