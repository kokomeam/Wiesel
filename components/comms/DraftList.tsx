"use client";

/**
 * The learner-message review list (Milestone 6) — the "agent review panel"
 * half of the approval UI. Fetches the course's messages, shows drafts first,
 * and opens the composer for edit → approve → send.
 *
 * M7: rows show the DELIVERY status once sent (delivered/opened/clicked or
 * bounced/complained — advanced by the Resend webhook), and a suppressed
 * learner (hard bounce / complaint) is labeled here + the composer replaces
 * its send button with the suppressed notice. The send seam re-checks both
 * opt-out and suppression server-side regardless of what this UI shows.
 *
 * PERF-1 D2: the fetch is bounded (the API returns the 200 newest — a review
 * inbox, not an archive) and the list is WINDOWED via useVirtualRows (fixed
 * ROW_PX rows inside a max-h scroll container), so render cost stays
 * viewport-sized regardless of message volume (diagnosis A5 §6).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Mail, PencilLine, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { useVirtualRows } from "@/lib/perf/virtualRows";
import {
  EmailBodySchema,
  type DeliveryStatus,
  type EmailBody,
  type SuppressionReason,
} from "@/lib/comms/types";
import { MessageComposer, type ComposerSeed } from "./MessageComposer";

interface MessageRow {
  id: string;
  course_id: string;
  user_id: string;
  finding_id: string | null;
  subject: string;
  body: unknown;
  status: "draft" | "approved" | "sent" | "failed";
  delivery_status?: DeliveryStatus;
  sent_at: string | null;
  created_at: string;
}

const STATUS_TONE: Record<string, string> = {
  draft: "bg-amber-100 text-amber-700",
  approved: "bg-sky-100 text-sky-700",
  sent: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
  delivered: "bg-sky-100 text-sky-700",
  opened: "bg-emerald-100 text-emerald-700",
  clicked: "bg-emerald-100 text-emerald-700",
  bounced: "bg-rose-100 text-rose-700",
  complained: "bg-rose-100 text-rose-700",
};

/** One chip per row: the delivery state once it advances past 'sent',
 *  otherwise the send-flow status. */
export function messageChip(row: Pick<MessageRow, "status" | "delivery_status">): string {
  if (
    row.status === "sent" &&
    row.delivery_status &&
    row.delivery_status !== "none" &&
    row.delivery_status !== "sent"
  ) {
    return row.delivery_status;
  }
  return row.status;
}

export const SUPPRESSION_LABEL: Record<SuppressionReason, string> = {
  hard_bounce: "bounced",
  complaint: "complained",
};

/* PERF-1 D2 (AC-PERF-12, diagnosis A5 §6 "comms DraftList — unbounded fetch",
 * A6 #23): rows are FIXED-size so the list windows through useVirtualRows —
 * only the viewport (+overscan) renders no matter how many messages the
 * course has accumulated. 52 px card + 6 px gap; content already truncates. */
const ROW_PX = 58;
const LIST_MAX_PX = 320; // must match the container's max-h-80

export function DraftList({
  courseId,
  learnerNames = {},
  compact = false,
}: {
  courseId: string;
  /** userId → display name (the caller's roster knowledge; falls back to "Learner"). */
  learnerNames?: Record<string, string>;
  compact?: boolean;
}) {
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [suppressions, setSuppressions] = useState<Record<string, SuppressionReason>>({});
  const [editing, setEditing] = useState<ComposerSeed | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/comms/messages?courseId=${courseId}`);
    if (!res.ok) return;
    const payload = (await res.json()) as {
      messages: MessageRow[];
      suppressions?: Record<string, SuppressionReason>;
    };
    setMessages(payload.messages);
    setSuppressions(payload.suppressions ?? {});
  }, [courseId]);

  useEffect(() => {
    // Deferred a tick (the useVideoAsset pattern) so no setState is reachable
    // synchronously from the effect body (react-hooks/set-state-in-effect).
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  // Hoisted out of render (A5 §6: the list used to re-sort per render).
  const ordered = useMemo(
    () =>
      [...(messages ?? [])].sort((a, b) =>
        a.status === b.status ? 0 : a.status === "draft" ? -1 : 1
      ),
    [messages]
  );

  const { containerRef, start, end, padStart, padEnd } = useVirtualRows({
    restoreId: `comms-drafts:${courseId}`,
    count: ordered.length,
    itemSize: ROW_PX,
    initialViewport: LIST_MAX_PX,
  });

  if (messages === null) {
    return <p className="px-1 py-2 text-xs text-stone-400">Loading messages…</p>;
  }
  if (messages.length === 0) {
    return compact ? null : (
      <p className="px-1 py-2 text-xs text-stone-400">No learner messages yet.</p>
    );
  }

  return (
    <div className="space-y-1.5">
      <div
        ref={containerRef}
        className="scrollbar-thin max-h-80 overflow-y-auto overscroll-contain"
      >
        <div style={{ paddingTop: padStart, paddingBottom: padEnd }}>
          {ordered.slice(start, end).map((m) => {
            const name = learnerNames[m.user_id] ?? "Learner";
            const editable = m.status === "draft" || m.status === "failed";
            const suppressed = suppressions[m.user_id];
            const chip = messageChip(m);
            return (
              <div key={m.id} style={{ height: ROW_PX }} className="pb-1.5">
                <div className="flex h-full items-center gap-2 rounded-lg border border-stone-200/80 bg-white px-2.5">
                  <Mail className="size-3.5 shrink-0 text-stone-400" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-stone-800">{m.subject}</p>
                    <p className="truncate text-[11px] text-stone-400">to {name}</p>
                  </div>
                  {suppressed ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700"
                      title={`This learner's address ${SUPPRESSION_LABEL[suppressed]} — sending is disabled to protect deliverability.`}
                    >
                      <ShieldAlert className="size-3" aria-hidden />
                      suppressed: {SUPPRESSION_LABEL[suppressed]}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      STATUS_TONE[chip] ?? "bg-stone-100 text-stone-600"
                    )}
                  >
                    {chip}
                  </span>
                  {editable ? (
                    <button
                      type="button"
                      aria-label={`Review the message to ${name}`}
                      data-ai-tool="comms-review-draft"
                      onClick={() => {
                        const parsed = EmailBodySchema.safeParse(m.body);
                        setEditing({
                          messageId: m.id,
                          courseId,
                          userId: m.user_id,
                          learnerName: name,
                          findingId: m.finding_id,
                          subject: m.subject,
                          body: parsed.success ? (parsed.data as EmailBody) : [],
                          suppressedReason: suppressed ?? null,
                        });
                      }}
                      className="grid size-6 shrink-0 place-items-center rounded-md text-stone-400 hover:bg-brand-50 hover:text-brand-600"
                    >
                      <PencilLine className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {editing ? (
        <MessageComposer
          seed={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
    </div>
  );
}
