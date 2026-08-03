"use client";

/**
 * Connected-publishing state UI for the queue (M-D) — ALLOWLISTED for
 * publish/schedule vocabulary (the contextual language split; every other
 * file under components/marketing/social keeps Phase-1 wording, fenced).
 *
 *  - PublishStateChip: per-post manifest/approval state with iconography;
 *    scheduled shows the fire time + a live countdown (computed on render,
 *    refreshed on focus/visibilitychange — deliberately NO polling loop).
 *  - Held reasons render human-readably with what self-heals them.
 *  - failed → Retry (the A2 approval-linked clone — no new card);
 *    platform_failed → "edit & re-approve" copy (edit voids → fresh card).
 *  - voided → "changed since approval" + re-card CTA.
 *  - posted_api → platform link-out + the manifest history drawer.
 */

import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  History,
  PauseCircle,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  cancelManifestAction,
  manifestHistoryAction,
  rescheduleManifestAction,
  retryManifestAction,
} from "@/app/(app)/marketing/publish/actions";

export interface PublishManifestSummary {
  id: string;
  postId: string;
  accountId: string;
  platform: string;
  status: string;
  scheduledFor: string | null;
  holdReason: string | null;
  postUrl: string | null;
  approvalId: string;
  attempt: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PublishApprovalSummary {
  id: string;
  postId: string;
  accountId: string;
  platform: string;
  kind: string;
  requestedBy: string;
  proposedScheduledFor: string | null;
  parentApprovalId: string | null;
  createdAt: string;
}

export interface PublishState {
  manifests: PublishManifestSummary[];
  approvals: PublishApprovalSummary[];
  accounts: { id: string; platform: string; status: string; displayName: string | null; handle: string | null }[];
}

export const HOLD_REASON_COPY: Record<string, { label: string; heals: string }> = {
  quota_exceeded: {
    label: "Held — this month's upload allowance is used up",
    heals: "resumes automatically when the allowance resets next month",
  },
  send_window: {
    label: "Held — outside the send window",
    heals: "fires when the window next opens",
  },
  account_not_linked: {
    label: "Held — the account needs re-linking",
    heals: "resumes after you re-link it on Connected accounts",
  },
  source_superseded: {
    label: "Held — the source lesson was re-recorded",
    heals: "render a fresh clip from the new take, then approve a new card",
  },
};

function countdownLabel(targetIso: string, nowMs: number): string {
  const ms = new Date(targetIso).getTime() - nowMs;
  if (ms <= 0) return "due now";
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rem = mins % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${rem}m`;
  return `in ${Math.max(1, rem)}m`;
}

function subscribeWake(cb: () => void): () => void {
  window.addEventListener("focus", cb);
  document.addEventListener("visibilitychange", cb);
  return () => {
    window.removeEventListener("focus", cb);
    document.removeEventListener("visibilitychange", cb);
  };
}

/** The live-but-not-polling countdown: an external-store read of the clock
 *  (the repo's useSyncExternalStore convention for impure reads in render),
 *  re-sampled when the tab regains focus/visibility. No polling loop. */
export function useCountdown(targetIso: string | null): string | null {
  return useSyncExternalStore(
    subscribeWake,
    () => (targetIso ? countdownLabel(targetIso, Date.now()) : null),
    () => null
  );
}

/** The newest manifest is the post's operative one. */
export function operativeManifest(state: PublishState | null, postId: string): PublishManifestSummary | null {
  if (!state) return null;
  const mine = state.manifests
    .filter((m) => m.postId === postId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return mine[0] ?? null;
}

export function PublishStateChip({
  postId,
  state,
  onChanged,
  onRecard,
}: {
  postId: string;
  state: PublishState | null;
  onChanged: () => void;
  onRecard?: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [reschedule, setReschedule] = useState(false);
  const [when, setWhen] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const m = operativeManifest(state, postId);
  const countdown = useCountdown(m?.status === "queued" && m.scheduledFor ? m.scheduledFor : null);
  const openApproval = state?.approvals.find((a) => a.postId === postId);

  if (!m && !openApproval) return null;

  if (!m && openApproval) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-700">
        <CalendarClock className="size-3.5" /> A review card is waiting on the Publish review page.
      </div>
    );
  }
  if (!m) return null;

  const chip = (() => {
    switch (m.status) {
      case "queued":
        return m.scheduledFor ? (
          <span className="inline-flex items-center gap-1.5 text-sky-700">
            <CalendarClock className="size-3.5" />
            Scheduled · {new Date(m.scheduledFor).toLocaleString()} ({countdown})
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sky-700">
            <CalendarClock className="size-3.5" /> Publishing shortly…
          </span>
        );
      case "held": {
        const copy = HOLD_REASON_COPY[m.holdReason ?? ""] ?? {
          label: `Held (${m.holdReason ?? "unknown"})`,
          heals: "",
        };
        return (
          <span className="inline-flex items-center gap-1.5 text-amber-700">
            <PauseCircle className="size-3.5" />
            {copy.label}
            {copy.heals ? <span className="text-stone-500">— {copy.heals}</span> : null}
          </span>
        );
      }
      case "submitting":
      case "submitted":
      case "verifying":
        return (
          <span className="inline-flex items-center gap-1.5 text-sky-700">
            <RotateCcw className="size-3.5 animate-spin [animation-duration:3s]" /> Publishing…
          </span>
        );
      case "live":
        return (
          <span className="inline-flex items-center gap-1.5 text-emerald-700">
            <CheckCircle2 className="size-3.5" /> Live via connected account
          </span>
        );
      case "failed":
        return (
          <span className="inline-flex items-center gap-1.5 text-rose-700">
            <AlertTriangle className="size-3.5" />
            Publish failed{m.lastError ? ` — ${m.lastError.slice(0, 90)}` : ""}
          </span>
        );
      case "platform_failed":
        return (
          <span className="inline-flex items-center gap-1.5 text-rose-700">
            <XCircle className="size-3.5" />
            {`${m.platform === "linkedin" ? "LinkedIn" : "The platform"} rejected it${m.lastError ? ` — ${m.lastError.slice(0, 70)}` : ""}. Edit the post and approve a fresh card.`}
          </span>
        );
      case "voided":
        return (
          <span className="inline-flex items-center gap-1.5 text-stone-500">
            <XCircle className="size-3.5" /> Changed since approval — review it again.
          </span>
        );
      case "cancelled":
        return (
          <span className="inline-flex items-center gap-1.5 text-stone-500">
            <XCircle className="size-3.5" /> Schedule cancelled.
          </span>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="mt-2 space-y-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        {chip}
        {m.status === "live" && m.postUrl && (
          <a
            href={m.postUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-brand-700 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="size-3" /> View on platform
          </a>
        )}
        {(m.status === "live" || m.attempt > 0 || m.status === "failed" || m.status === "platform_failed") && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-stone-500 hover:text-stone-800"
            onClick={(e) => {
              e.stopPropagation();
              setDrawer(true);
            }}
          >
            <History className="size-3" /> History
          </button>
        )}
      </div>
      {note && <p className="text-rose-700">{note}</p>}
      {(m.status === "queued" || m.status === "held") && (
        <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
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
          {reschedule && (
            <>
              <input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className="rounded-lg border border-stone-300 px-2 py-1 text-[11px]"
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
            </>
          )}
        </div>
      )}
      {m.status === "failed" && (
        <div onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const res = await retryManifestAction(m.id);
                if (!res.ok)
                  setNote(
                    res.reason === "needs_fresh_card"
                      ? "The post changed since approval — request a fresh card."
                      : `Could not retry (${res.reason}).`
                  );
                onChanged();
              })
            }
          >
            <RotateCcw className="size-3" /> Retry — no new card needed
          </Button>
        </div>
      )}
      {m.status === "voided" && onRecard && (
        <div onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="outline" disabled={pending} onClick={onRecard}>
            Review & approve again
          </Button>
        </div>
      )}
      {drawer && <ManifestHistoryDrawer postId={postId} onClose={() => setDrawer(false)} />}
    </div>
  );
}

/* ───────────────────── manifest history drawer ───────────────────────── */

interface HistoryData {
  manifests: {
    id: string;
    status: string;
    platform: string;
    approvalId: string;
    scheduledFor: string | null;
    holdReason: string | null;
    postUrl: string | null;
    platformPostId: string | null;
    providerRequestId: string | null;
    attempt: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
  approvals: {
    id: string;
    kind: string;
    requestedBy: string;
    parentApprovalId: string | null;
    consumedAt: string | null;
    declinedAt: string | null;
    voidedAt: string | null;
    createdAt: string;
  }[];
}

export function ManifestHistoryDrawer({ postId, onClose }: { postId: string; onClose: () => void }) {
  const [data, setData] = useState<HistoryData | null>(null);
  useEffect(() => {
    void manifestHistoryAction(postId).then(setData);
  }, [postId]);
  const approvalById = new Map((data?.approvals ?? []).map((a) => [a.id, a]));
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-stone-900/30" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto border-l border-stone-200 bg-white p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-stone-900">Publish history</h3>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {!data && <p className="mt-4 text-xs text-stone-500">Loading…</p>}
        {data && data.manifests.length === 0 && (
          <p className="mt-4 text-xs text-stone-500">No publish attempts yet.</p>
        )}
        <div className="mt-4 space-y-3">
          {data?.manifests.map((m) => {
            const approval = approvalById.get(m.approvalId);
            const lineage =
              approval?.kind === "retry"
                ? `retry of a card approval${approval.parentApprovalId ? ` (${approval.parentApprovalId.slice(0, 8)}…)` : ""}`
                : `card approval, requested by ${approval?.requestedBy ?? "creator"}`;
            return (
              <div key={m.id} className="rounded-xl border border-stone-200 px-3.5 py-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-stone-800">{m.status.replace("_", " ")}</span>
                  <span className="text-stone-400">{new Date(m.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-stone-500">Approved via {lineage}</p>
                {m.scheduledFor && <p className="mt-0.5 text-stone-500">Fire time: {new Date(m.scheduledFor).toLocaleString()}</p>}
                {m.attempt > 0 && <p className="mt-0.5 text-stone-500">Attempts: {m.attempt}</p>}
                {m.lastError && <p className="mt-0.5 text-rose-700">{m.lastError.slice(0, 160)}</p>}
                {(m.platformPostId || m.providerRequestId) && (
                  <p className="mt-0.5 break-all text-stone-400">
                    {m.platformPostId ? `ref ${m.platformPostId}` : `request ${m.providerRequestId}`}
                  </p>
                )}
                {m.postUrl && (
                  <a href={m.postUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-brand-700 hover:underline">
                    <ExternalLink className="size-3" /> View on platform
                  </a>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── dev banner (AC-MD.7) ─────────────────────── */

/** Renders ONLY what the dev-status route returns — the banner text never
 *  ships in a client bundle (prod returns show:false with no message). */
export function DevInngestBanner() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void fetch("/api/marketing/publish/dev-status")
      .then((r) => r.json())
      .then((d: { show?: boolean; message?: string }) => {
        if (d.show && d.message) setMessage(d.message);
      })
      .catch(() => {});
  }, []);
  if (!message) return null;
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
      {message}
    </div>
  );
}
