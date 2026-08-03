"use client";

/**
 * The preview-then-decide card (M-C) — renders EXACTLY what ships:
 *  - the final composed text, byte-identical to the publish() title (the
 *    server builds it with the SAME composePublishText the workflow uses —
 *    AC-MC.2 asserts identity in the suite);
 *  - the first comment, with the per-platform support state (amendment 4:
 *    LinkedIn proven; YouTube "may be skipped" until proven live);
 *  - the destination account (avatar + handle + platform badge);
 *  - the fire time in the CREATOR'S timezone with the UTC offset shown;
 *  - the burned clip playable inline for video posts.
 * Approve consumes this card's single-use token server-side; Skip declines.
 * There is deliberately NO approve-all anywhere on this surface.
 */

import Image from "next/image";
import { useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useApprovalSync } from "@/lib/marketing/approvalSync";

export interface PublishCardPayload {
  approvalId: string;
  token: string | null;
  tokenExpiresAt: string | null;
  finalText: string;
  firstComment: string | null;
  firstCommentSupport: "proven" | "unverified";
  platform: string;
  platformLabel: string;
  accountName: string | null;
  accountHandle: string | null;
  avatarUrl: string | null;
  proposedScheduledFor: string | null;
  videoUrl: string | null;
  requestedBy: "creator" | "agent";
}

function fireTimeLine(iso: string | null): string {
  if (!iso) return "Immediately after approval";
  const d = new Date(iso);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = d.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offset = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${local} (${tz}, ${offset})`;
}

export function PublishApprovalCard({
  card,
  focused,
  onApprove,
  onReject,
}: {
  card: PublishCardPayload;
  focused?: boolean;
  onApprove: (token: string, scheduledFor: string | null) => Promise<{ ok: boolean; reason?: string }>;
  onReject: (approvalId: string) => Promise<{ ok: boolean }>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<"approved" | "skipped" | null>(null);
  // M-AG cross-surface sync: the same card can render in the chat transcript,
  // the review page, and other tabs at once — whichever copy resolves,
  // every other copy collapses (the token consume already guards correctness;
  // this heals the stale-card window). First writer wins in the store.
  const synced = useApprovalSync((s) => s.publishCards[card.approvalId]);
  const markPublishCardResolved = useApprovalSync((s) => s.markPublishCardResolved);
  const fireLine = useMemo(() => fireTimeLine(card.proposedScheduledFor), [card.proposedScheduledFor]);

  function approve() {
    if (!card.token) {
      setError("This card's approval window expired — reload the page for a fresh card.");
      return;
    }
    const token = card.token;
    startTransition(async () => {
      const res = await onApprove(token, card.proposedScheduledFor);
      if (res.ok) {
        setResolved("approved");
        markPublishCardResolved(card.approvalId, { decision: "approved", followUp: null });
      } else setError(`Could not approve: ${res.reason ?? "unknown"}. Reload for a fresh card.`);
    });
  }

  function reject() {
    startTransition(async () => {
      const res = await onReject(card.approvalId);
      if (res.ok) {
        setResolved("skipped");
        markPublishCardResolved(card.approvalId, { decision: "skipped", followUp: null });
      } else setError("Could not record the decision — try again.");
    });
  }

  const effective = resolved ?? synced?.decision ?? null;
  if (effective) {
    return (
      <div className="rounded-2xl border border-stone-200/80 bg-stone-50 px-5 py-4 text-sm text-stone-500">
        {effective === "approved"
          ? card.proposedScheduledFor
            ? "Approved — scheduled. It appears in the scheduled list below."
            : "Approved — publishing now. Track it in the list below."
          : effective === "skipped"
            ? "Skipped — the post stays in Ready."
            : "Handled on another surface — see the publish review page for the outcome."}
      </div>
    );
  }

  return (
    <div
      data-publish-card={card.approvalId}
      className={cn(
        "rounded-2xl border bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]",
        focused ? "border-orange-300 ring-2 ring-orange-200" : "border-stone-200/80"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {card.avatarUrl ? (
            <Image
              src={card.avatarUrl}
              alt=""
              width={40}
              height={40}
              unoptimized
              className="size-10 rounded-full border border-stone-200 object-cover"
            />
          ) : (
            <div className="flex size-10 items-center justify-center rounded-full bg-stone-100 text-sm font-semibold text-stone-500">
              {card.platformLabel.slice(0, 2)}
            </div>
          )}
          <div>
            <p className="text-sm font-semibold text-stone-900">
              {card.accountName ?? "Connected account"}
              {card.accountHandle ? (
                <span className="ml-1.5 font-normal text-stone-500">{card.accountHandle}</span>
              ) : null}
            </p>
            <p className="text-xs text-stone-500">
              Publish to <Badge tone="slate">{card.platformLabel}</Badge>
              {card.requestedBy === "agent" ? " · proposed by the assistant" : ""}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50/60 px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-wider text-stone-400">
          Exactly what ships
        </p>
        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-stone-800">
          {card.finalText}
        </p>
      </div>

      {card.firstComment && (
        <div className="mt-3 rounded-xl border border-stone-200 px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-wider text-stone-400">First comment</p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-stone-700">{card.firstComment}</p>
          {card.firstCommentSupport === "unverified" && (
            <p className="mt-1.5 text-[11px] text-amber-700">
              May be skipped on {card.platformLabel} — first-comment delivery there is not yet
              verified.
            </p>
          )}
        </div>
      )}

      {card.videoUrl && (
        <div className="mt-3 overflow-hidden rounded-xl border border-stone-200 bg-black">
          {/* captions are burned into the clip itself (the H-1..H-6 text system) */}
          <video src={card.videoUrl} controls playsInline className="max-h-80 w-full" />
        </div>
      )}

      <p className="mt-3 text-xs text-stone-600">
        <span className="font-medium text-stone-800">Fire time:</span> {fireLine}
      </p>

      {error && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {error}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Button size="sm" onClick={approve} disabled={pending}>
          {card.proposedScheduledFor ? "Approve & schedule" : "Approve & publish"}
        </Button>
        <Button size="sm" variant="outline" onClick={reject} disabled={pending}>
          Skip
        </Button>
      </div>
    </div>
  );
}
