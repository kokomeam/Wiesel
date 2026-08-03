"use client";

/**
 * M-AG: publish review cards INLINE in the agent chat — a render surface for
 * the SAME PublishApprovalCard, resolved by the SAME server actions the
 * review page uses (approve consumes the same single-use token; skip
 * declines). This file can CREATE nothing — cards arrive already filed by the
 * governance tools, and the review page (/marketing/publish) stays their
 * durable home if the chat closes. Per-card decisions only; there is no
 * approve-all here or anywhere.
 *
 * After a decision on an agent-filed card, the agent's wrap-up is fetched in
 * the background (fetchPublishFollowUpAction — the decision is derived from
 * the approval ROW, never trusted from the client) and lands on the sync
 * store; AgentPanel replays it into the transcript.
 */

import Link from "next/link";
import { PublishApprovalCard, type PublishCardPayload } from "./PublishApprovalCard";
import { approveCardAction, rejectCardAction } from "@/app/(app)/marketing/publish/actions";
import { fetchPublishFollowUpAction } from "@/app/(app)/marketing/actions";
import { useApprovalSync } from "@/lib/marketing/approvalSync";

/** Publish-vocabulary strings the agent panel renders live HERE — the
 *  contextual language allowlist covers components/marketing/publish/, and
 *  the panel imports these instead of carrying the words itself. */
export const PUBLISH_CHAT_SUGGESTIONS: readonly string[] = [
  "Plan this week's posts across my accounts",
  "Schedule my newest clip to LinkedIn",
];

export const PUBLISH_CAPABILITY_BLURB =
  "With a connected account I can also line up LinkedIn/YouTube posts — every publish waits on a review card you approve.";

export function ChatPublishCards({ cards }: { cards: PublishCardPayload[] }) {
  const attachFollowUp = useApprovalSync((s) => s.attachPublishCardFollowUp);

  function fireFollowUp(approvalId: string) {
    void fetchPublishFollowUpAction(approvalId).then((followUp) => {
      if (followUp) attachFollowUp(approvalId, followUp);
    });
  }

  if (!cards.length) return null;
  return (
    <div className="space-y-3" data-chat-publish-cards>
      <p className="px-1 font-mono text-[10px] uppercase tracking-wider text-stone-400">
        Publish review — decide each card; nothing ships without your approval
      </p>
      {cards.map((card) => (
        <PublishApprovalCard
          key={card.approvalId}
          card={card}
          onApprove={async (token, scheduledFor) => {
            const res = await approveCardAction(token, scheduledFor);
            if (res.ok) fireFollowUp(card.approvalId);
            return res;
          }}
          onReject={async (approvalId) => {
            const res = await rejectCardAction(approvalId);
            if (res.ok) fireFollowUp(card.approvalId);
            return res;
          }}
        />
      ))}
      <p className="px-1 text-[11px] text-stone-400">
        These cards also wait on the{" "}
        <Link href="/marketing/publish" className="underline hover:text-stone-600">
          publish review page
        </Link>{" "}
        if you close this chat.
      </p>
    </div>
  );
}
