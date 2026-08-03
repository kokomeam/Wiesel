"use client";

/**
 * Publish review surface (M-C) — the batch card list (each card individually
 * approved/skipped, keyboard j/k + Enter, NO approve-all affordance), the
 * scheduled/recent manifest list (cancel / reschedule / retry), the
 * unpublish confirm cards, and the "new review card" form.
 */

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PublishApprovalCard, type PublishCardPayload } from "./PublishApprovalCard";
import { UNPUBLISH_HONESTY } from "@/lib/marketing/publish/cardCopy";
import {
  approveCardAction,
  cancelManifestAction,
  rejectCardAction,
  requestCardAction,
  rescheduleManifestAction,
  retryManifestAction,
  unpublishConfirmedAction,
} from "@/app/(app)/marketing/publish/actions";
import { fetchPublishFollowUpAction } from "@/app/(app)/marketing/actions";
import { useApprovalSync } from "@/lib/marketing/approvalSync";

export interface ManifestRowView {
  id: string;
  status: string;
  platform: string;
  postExcerpt: string;
  scheduledFor: string | null;
  holdReason: string | null;
  postUrl: string | null;
  errorMessage: string | null;
}

export interface UnpublishableView {
  postId: string;
  excerpt: string;
  platform: string;
  postUrl: string | null;
  guidance: string;
}

export interface CardFormOption {
  id: string;
  label: string;
}

const MANIFEST_TONE: Record<string, Parameters<typeof Badge>[0]["tone"]> = {
  queued: "slate",
  held: "amber",
  submitting: "amber",
  submitted: "sky",
  verifying: "sky",
  live: "green",
  platform_failed: "rose",
  failed: "rose",
  cancelled: "slate",
  voided: "slate",
};

export function PublishReviewView({
  cards,
  manifests,
  unpublishables,
  postOptions,
  accountOptions,
}: {
  cards: PublishCardPayload[];
  manifests: ManifestRowView[];
  unpublishables: UnpublishableView[];
  postOptions: CardFormOption[];
  accountOptions: CardFormOption[];
}) {
  const router = useRouter();
  const [focusIdx, setFocusIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const attachPublishFollowUp = useApprovalSync((s) => s.attachPublishCardFollowUp);

  // M-AG: a decision HERE on a chat-filed card still narrates in the open
  // chat — the agent's wrap-up rides the sync store (BroadcastChannel across
  // tabs). No-op (null) for cards not filed from a conversation.
  function firePublishFollowUp(approvalId: string) {
    void fetchPublishFollowUpAction(approvalId).then((followUp) => {
      if (followUp) attachPublishFollowUp(approvalId, followUp);
    });
  }

  // Keyboard review: j/k moves focus, Enter approves the FOCUSED card only.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "j") setFocusIdx((i) => Math.min(i + 1, cards.length - 1));
      else if (e.key === "k") setFocusIdx((i) => Math.max(i - 1, 0));
      else if (e.key === "Enter") {
        // The focused card's FIRST button is its own Approve — strictly
        // per-card; there is no approve-all handler on this surface.
        const cardEl = listRef.current?.querySelectorAll("[data-publish-card]")[focusIdx];
        cardEl?.querySelector("button")?.click();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cards.length, focusIdx]);

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-sm font-semibold text-stone-900">
          Waiting for your decision{cards.length ? ` (${cards.length})` : ""}
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          Each card is approved or skipped on its own — j/k to move, Enter to approve the focused
          card. Nothing publishes without a card.
        </p>
        <div ref={listRef} className="mt-3 space-y-4">
          {cards.length === 0 && (
            <div className="rounded-2xl border border-dashed border-stone-300 px-5 py-6 text-sm text-stone-500">
              No cards waiting. Request one below, or ask the assistant to propose a publish plan.
            </div>
          )}
          {cards.map((card, i) => (
            <PublishApprovalCard
              key={card.approvalId}
              card={card}
              focused={i === focusIdx && cards.length > 1}
              onApprove={async (token, scheduledFor) => {
                const res = await approveCardAction(token, scheduledFor);
                if (res.ok) firePublishFollowUp(card.approvalId);
                router.refresh();
                return res;
              }}
              onReject={async (approvalId) => {
                const res = await rejectCardAction(approvalId);
                if (res.ok) firePublishFollowUp(approvalId);
                router.refresh();
                return res;
              }}
            />
          ))}
        </div>
      </section>

      <NewCardForm postOptions={postOptions} accountOptions={accountOptions} />

      <section>
        <h2 className="text-sm font-semibold text-stone-900">Scheduled & recent</h2>
        <div className="mt-3 space-y-2">
          {manifests.length === 0 && (
            <p className="text-sm text-stone-500">Nothing scheduled or recently published.</p>
          )}
          {manifests.map((m) => (
            <ManifestRow key={m.id} m={m} onChanged={() => router.refresh()} />
          ))}
        </div>
      </section>

      {unpublishables.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-stone-900">Published via connected accounts</h2>
          <div className="mt-3 space-y-3">
            {unpublishables.map((u) => (
              <UnpublishConfirmCard key={u.postId} u={u} onChanged={() => router.refresh()} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ManifestRow({ m, onChanged }: { m: ManifestRowView; onChanged: () => void }) {
  const [pending, startTransition] = useTransition();
  const [reschedule, setReschedule] = useState(false);
  const [when, setWhen] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const cancellable = m.status === "queued" || m.status === "held";

  return (
    <div className="rounded-xl border border-stone-200/80 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={MANIFEST_TONE[m.status] ?? "slate"} dot>
          {m.status.replace("_", " ")}
        </Badge>
        <span className="font-medium text-stone-800">{m.platform}</span>
        <span className="truncate text-stone-500">{m.postExcerpt}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-stone-500">
        {m.scheduledFor && <span>Fires {new Date(m.scheduledFor).toLocaleString()}</span>}
        {m.holdReason && <span className="text-amber-700">Held: {m.holdReason.replace(/_/g, " ")}</span>}
        {m.errorMessage && <span className="text-rose-700">{m.errorMessage}</span>}
        {m.postUrl && (
          <a href={m.postUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
            View on platform
          </a>
        )}
      </div>
      {note && <p className="mt-1.5 text-xs text-rose-700">{note}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {cancellable && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const res = await cancelManifestAction(m.id);
                  if (!res.cancelled) setNote(`Could not cancel (${res.reason}).`);
                  onChanged();
                })
              }
            >
              Cancel
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setReschedule((v) => !v)}>
              Reschedule
            </Button>
          </>
        )}
        {m.status === "failed" && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const res = await retryManifestAction(m.id);
                if (!res.ok) setNote(res.reason === "needs_fresh_card" ? "The post changed — request a fresh card." : `Could not retry (${res.reason}).`);
                onChanged();
              })
            }
          >
            Retry (no new card needed)
          </Button>
        )}
      </div>
      {reschedule && cancellable && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="rounded-lg border border-stone-300 px-2 py-1 text-xs"
          />
          <Button
            size="sm"
            disabled={pending || !when}
            onClick={() =>
              startTransition(async () => {
                const res = await rescheduleManifestAction(m.id, new Date(when).toISOString());
                if (!res.ok) setNote(`Could not reschedule (${res.reason}).`);
                setReschedule(false);
                onChanged();
              })
            }
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

function UnpublishConfirmCard({ u, onChanged }: { u: UnpublishableView; onChanged: () => void }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="rounded-2xl border border-stone-200/80 bg-white px-5 py-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="green" dot>
          Live on {u.platform}
        </Badge>
        <span className="truncate text-stone-600">{u.excerpt}</span>
        {u.postUrl && (
          <a href={u.postUrl} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline">
            View on platform
          </a>
        )}
      </div>
      {!confirming ? (
        <Button size="sm" variant="outline" className="mt-3" onClick={() => setConfirming(true)}>
          Unpublish in WiseSel…
        </Button>
      ) : (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-xs leading-relaxed text-amber-900">{UNPUBLISH_HONESTY}</p>
          <p className="mt-2 text-xs leading-relaxed text-stone-700">
            <span className="font-medium">To remove it on the platform:</span> {u.guidance}
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await unpublishConfirmedAction(u.postId);
                  onChanged();
                })
              }
            >
              Mark unpublished in WiseSel
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Keep as is
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function NewCardForm({
  postOptions,
  accountOptions,
}: {
  postOptions: CardFormOption[];
  accountOptions: CardFormOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [postId, setPostId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState<string | null>(null);
  if (postOptions.length === 0 || accountOptions.length === 0) return null;
  return (
    <section className="rounded-2xl border border-stone-200/80 bg-stone-50/50 px-5 py-4">
      <h2 className="text-sm font-semibold text-stone-900">New review card</h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={postId}
          onChange={(e) => setPostId(e.target.value)}
          className="max-w-64 rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-xs"
        >
          <option value="">Choose a post…</option>
          {postOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-xs"
        >
          <option value="">Choose an account…</option>
          {accountOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-xs"
          title="Optional fire time — empty publishes immediately after approval"
        />
        <Button
          size="sm"
          disabled={pending || !postId || !accountId}
          onClick={() =>
            startTransition(async () => {
              const res = await requestCardAction({
                socialPostId: postId,
                socialAccountId: accountId,
                proposedScheduledFor: when ? new Date(when).toISOString() : null,
              });
              setNote(res.ok ? null : `Refused: ${res.reason.replace(/_/g, " ")}.`);
              router.refresh();
            })
          }
        >
          Request card
        </Button>
      </div>
      {note && <p className="mt-2 text-xs text-rose-700">{note}</p>}
    </section>
  );
}
