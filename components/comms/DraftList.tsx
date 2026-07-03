"use client";

/**
 * The learner-message review list (Milestone 6) — the "agent review panel"
 * half of the approval UI. Fetches the course's messages, shows drafts first,
 * and opens the composer for edit → approve → send.
 */

import { useCallback, useEffect, useState } from "react";
import { Mail, PencilLine } from "lucide-react";
import { cn } from "@/lib/cn";
import { EmailBodySchema, type EmailBody } from "@/lib/comms/types";
import { MessageComposer, type ComposerSeed } from "./MessageComposer";

interface MessageRow {
  id: string;
  course_id: string;
  user_id: string;
  finding_id: string | null;
  subject: string;
  body: unknown;
  status: "draft" | "approved" | "sent" | "failed";
  sent_at: string | null;
  created_at: string;
}

const STATUS_TONE: Record<MessageRow["status"], string> = {
  draft: "bg-amber-100 text-amber-700",
  approved: "bg-sky-100 text-sky-700",
  sent: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
};

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
  const [editing, setEditing] = useState<ComposerSeed | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/comms/messages?courseId=${courseId}`);
    if (!res.ok) return;
    const payload = (await res.json()) as { messages: MessageRow[] };
    setMessages(payload.messages);
  }, [courseId]);

  useEffect(() => {
    // Deferred a tick (the useVideoAsset pattern) so no setState is reachable
    // synchronously from the effect body (react-hooks/set-state-in-effect).
    const t = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(t);
  }, [refresh]);

  if (messages === null) {
    return <p className="px-1 py-2 text-xs text-stone-400">Loading messages…</p>;
  }
  if (messages.length === 0) {
    return compact ? null : (
      <p className="px-1 py-2 text-xs text-stone-400">No learner messages yet.</p>
    );
  }

  const ordered = [...messages].sort((a, b) =>
    a.status === b.status ? 0 : a.status === "draft" ? -1 : 1
  );

  return (
    <div className="space-y-1.5">
      {ordered.map((m) => {
        const name = learnerNames[m.user_id] ?? "Learner";
        const editable = m.status === "draft" || m.status === "failed";
        return (
          <div
            key={m.id}
            className="flex items-center gap-2 rounded-lg border border-stone-200/80 bg-white px-2.5 py-2"
          >
            <Mail className="size-3.5 shrink-0 text-stone-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-stone-800">{m.subject}</p>
              <p className="truncate text-[11px] text-stone-400">to {name}</p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                STATUS_TONE[m.status]
              )}
            >
              {m.status}
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
                  });
                }}
                className="grid size-6 shrink-0 place-items-center rounded-md text-stone-400 hover:bg-brand-50 hover:text-brand-600"
              >
                <PencilLine className="size-3.5" />
              </button>
            ) : null}
          </div>
        );
      })}
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
