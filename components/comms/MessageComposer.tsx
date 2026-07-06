"use client";

/**
 * Learner-message composer (Milestone 6): edit → approve → send, always with a
 * human in the loop. Creates a draft (or edits an existing one), and only the
 * explicit "Approve & send" button reaches the send seam — which re-checks the
 * learner's opt-out server-side regardless of what this UI shows.
 */

import { useState } from "react";
import { Send, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { EmailBlock, EmailBody } from "@/lib/comms/types";

export interface ComposerSeed {
  messageId?: string; // present = editing an existing draft
  courseId: string;
  userId: string;
  learnerName: string;
  findingId?: string | null;
  subject: string;
  body: EmailBody;
}

export function MessageComposer({
  seed,
  onClose,
  onSaved,
}: {
  seed: ComposerSeed;
  onClose: () => void;
  /** Fires after a successful save/send so callers can refresh their lists. */
  onSaved?: (status: "draft" | "sent") => void;
}) {
  const [subject, setSubject] = useState(seed.subject);
  const [body, setBody] = useState<EmailBody>(seed.body);
  const [busy, setBusy] = useState<null | "save" | "send">(null);
  const [error, setError] = useState<string | null>(null);

  function setParagraph(index: number, text: string) {
    setBody((prev) => prev.map((b, i) => (i === index && b.kind === "paragraph" ? { ...b, text } : b)));
  }

  async function persistDraft(): Promise<string | null> {
    if (seed.messageId) {
      const res = await fetch(`/api/comms/messages/${seed.messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't save");
      return seed.messageId;
    }
    const res = await fetch("/api/comms/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        courseId: seed.courseId,
        userId: seed.userId,
        findingId: seed.findingId ?? null,
        subject,
        body,
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Couldn't save");
    const payload = (await res.json()) as { message: { id: string } };
    return payload.message.id;
  }

  async function handle(action: "save" | "send") {
    setBusy(action);
    setError(null);
    try {
      const id = await persistDraft();
      if (action === "send" && id) {
        const res = await fetch(`/api/comms/messages/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve_send" }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(
            payload?.error === "opted_out"
              ? "This learner has opted out of course emails — the message stays a draft."
              : (payload?.error ?? "Send failed")
          );
        }
        onSaved?.("sent");
      } else {
        onSaved?.("draft");
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`Message to ${seed.learnerName}`}>
      <div className="absolute inset-0 bg-stone-900/30 backdrop-blur-[1px]" onClick={() => busy === null && onClose()} />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-stone-200 bg-white shadow-[0_24px_60px_rgba(68,48,28,0.18)]">
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-stone-900">Message to {seed.learnerName}</h2>
            <p className="text-xs text-stone-400">Sent from your name · learner can opt out anytime</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-7 place-items-center rounded-lg text-stone-400 hover:bg-stone-100"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.15em] text-stone-400">Subject</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-800 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200/60"
            />
          </label>
          {body.map((block: EmailBlock, i) =>
            block.kind === "paragraph" ? (
              <textarea
                key={i}
                value={block.text}
                rows={Math.min(5, Math.max(2, Math.ceil(block.text.length / 70)))}
                onChange={(e) => setParagraph(i, e.target.value)}
                className="w-full resize-y rounded-lg border border-stone-200 px-3 py-2 text-sm leading-relaxed text-stone-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200/60"
              />
            ) : block.kind === "button" ? (
              <p key={i} className="flex items-center gap-2 text-xs text-stone-400">
                <span className="brand-gradient rounded-full px-3 py-1 text-[11px] font-semibold text-white">
                  {block.label}
                </span>
                links to the course
              </p>
            ) : (
              <p key={i} className="text-sm font-semibold text-stone-800">{block.text}</p>
            )
          )}
          <p className="text-[11px] text-stone-400">
            An unsubscribe link is added automatically to every email.
          </p>
          {error ? <p className="text-xs font-medium text-rose-600">{error}</p> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-stone-100 px-5 py-3">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void handle("save")}
            className="rounded-full border border-stone-200 px-4 py-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-50 disabled:opacity-50"
          >
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            disabled={busy !== null || subject.trim().length === 0}
            onClick={() => void handle("send")}
            className={cn(
              "brand-gradient inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-brand-600/25 transition-opacity hover:opacity-95",
              (busy !== null || subject.trim().length === 0) && "opacity-60"
            )}
          >
            <Send className="size-3.5" />
            {busy === "send" ? "Sending…" : "Approve & send"}
          </button>
        </div>
      </div>
    </div>
  );
}
