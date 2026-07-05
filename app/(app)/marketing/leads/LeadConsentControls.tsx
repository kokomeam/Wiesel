"use client";

/**
 * The consent-request controls that make double opt-in DISCOVERABLE:
 *  - ConsentApprovalStrip — pending consent-send approvals as full ApprovalCards,
 *    resolvable RIGHT HERE (previously only on the Marketing hub, three pages
 *    away).
 *  - SendConsentButton — one bulk request per list (one approval covers the
 *    batch). The returned approval card renders IN PLACE under the button —
 *    request → approve is one surface, not a scroll to a banner.
 * Both route the same gate as everything else — no side doors. Bulk consent
 * sends are hard-denied from auto-approval: the card appears in every mode.
 */

import { useState, useTransition } from "react";
import { Loader2, MailQuestion } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ApprovalCard } from "@/components/marketing/ApprovalCard";
import type { PendingActionPayload } from "../actions";
import { requestConsentConfirmationsAction } from "../campaignActions";

export function ConsentApprovalStrip({ approvals }: { approvals: PendingActionPayload[] }) {
  const [outcome, setOutcome] = useState<{ text: string; error: boolean } | null>(null);
  if (approvals.length === 0 && !outcome) return null;
  return (
    <div className="space-y-2">
      {approvals.map((a) => (
        <ApprovalCard key={a.actionId} pending={a} onResult={(r) => setOutcome({ text: r.message, error: !!r.error })} />
      ))}
      {outcome && (
        <p
          className={
            outcome.error
              ? "rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-900"
              : "rounded-xl bg-emerald-50 px-4 py-2.5 text-xs text-emerald-800"
          }
        >
          {outcome.error ? "Send failed (the approval is still pending — fix the cause and approve again): " : ""}
          {outcome.text}
        </p>
      )}
    </div>
  );
}

export function SendConsentButton({
  courseId,
  listId,
  awaiting,
}: {
  courseId: string;
  listId: string;
  awaiting: number;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [card, setCard] = useState<PendingActionPayload | null>(null);

  if (awaiting === 0 && !card) return null;
  return (
    <div className="flex w-full flex-col items-end gap-2">
      {awaiting > 0 && !card ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setMessage(null);
              try {
                const r = await requestConsentConfirmationsAction(courseId, listId);
                if (r.pending) setCard(r.pending);
                else setMessage(r.message);
              } catch (e) {
                setMessage(e instanceof Error ? e.message : String(e));
              }
            })
          }
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <MailQuestion className="size-3.5" />}
          Ask {awaiting} contact{awaiting === 1 ? "" : "s"} to confirm
        </Button>
      ) : null}
      {card ? (
        <div className="w-full">
          <ApprovalCard
            pending={card}
            compact
            onResult={(r) => setMessage(r.message)}
            onResolved={() => setCard(null)}
          />
        </div>
      ) : null}
      {message && <p className="max-w-64 text-right text-[11px] text-stone-500">{message}</p>}
    </div>
  );
}
