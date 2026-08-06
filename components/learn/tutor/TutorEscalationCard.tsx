"use client";

/**
 * TUTOR-1 Wave 6 (P6.1) — the escalation CONSENT card, now REAL behind the
 * `escalationsUi` flag (TutorBody gates it). When the tutor raises an escalation
 * this turn, the card shows the learner the EXACT payload that would be shared —
 * their question (EDITABLE), the concept(s) implicated, and the tutor's proposed
 * answer — plus Send / Cancel.
 *
 *   Send   → POST /api/learn/tutor {action:'escalate_consent', consentAction:'send',
 *            candidateId, finalQuestion:<edited>} → the row flips consent_pending →
 *            consented (carrying the edited question). The card shows a "sent —
 *            your instructor will see this in their queue" pending state.
 *   Cancel → POST {consentAction:'cancel'} → the row flips → withdrawn; the card
 *            dismisses.
 *
 * The copy is honest: the instructor sees it in THEIR QUEUE. NO SLA is implied
 * (no "they'll reply within…" — the delivery pace is the instructor's).
 *
 * House rules: warm paper/stone design; NO framer-motion (reduced motion honoured
 * by having no entrance animation); labels + focus on every control; zod-free
 * (props are plain TS). A missing candidateId (a proposal with no persisted row —
 * shouldn't happen once the loop writes one) disables Send with an honest note.
 */

import { useState } from "react";
import { Send, X, Check } from "lucide-react";
import type { TutorEscalationProposal } from "@/lib/learn/tutorClientTypes";

export interface TutorEscalationCardProps {
  proposal: TutorEscalationProposal;
  /** The consent-pending candidate id to target (from the turn payload). */
  candidateId: string | null;
  courseId: string;
  publicationId: string;
  version: number;
  lessonId: string | null;
}

type CardState = "editing" | "sending" | "sent" | "cancelled" | "error";

export function TutorEscalationCard({
  proposal,
  candidateId,
  courseId,
  publicationId,
  version,
  lessonId,
}: TutorEscalationCardProps) {
  // The editable question, seeded from the proposal.
  const [question, setQuestion] = useState(proposal.learnerQuestion);
  const [state, setState] = useState<CardState>("editing");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const canSend = candidateId !== null && question.trim().length > 0 && state === "editing";

  async function post(consentAction: "send" | "cancel"): Promise<{ ok: boolean; message?: string }> {
    try {
      const res = await fetch("/api/learn/tutor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "escalate_consent",
          consentAction,
          candidateId,
          finalQuestion: question.trim(),
          courseId,
          publicationId,
          version,
          lessonId,
        }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!res.ok || !json?.ok) {
        return { ok: false, message: json?.message ?? `The request failed (${res.status}).` };
      }
      return { ok: true };
    } catch {
      return { ok: false, message: "Couldn't reach the server — check your connection." };
    }
  }

  async function onSend() {
    if (!canSend) return;
    setState("sending");
    setErrorMsg(null);
    const r = await post("send");
    if (r.ok) {
      setState("sent");
    } else {
      setState("error");
      setErrorMsg(r.message ?? null);
    }
  }

  async function onCancel() {
    // Optimistic dismiss — a failed cancel still hides the card locally (the row
    // stays consent_pending server-side, harmless; nothing was shared).
    setState("cancelled");
    void post("cancel");
  }

  if (state === "cancelled") return null;

  if (state === "sent") {
    return (
      <div
        data-ai-tool="tutor-escalation"
        role="status"
        className="mt-2 rounded-2xl border border-emerald-300/70 bg-emerald-50/60 p-3 text-sm"
      >
        <p className="flex items-center gap-1.5 font-medium text-emerald-800">
          <Check className="size-4" aria-hidden />
          Sent to your instructor
        </p>
        <p className="mt-1 leading-relaxed text-stone-600">
          Your instructor will see this in their queue.
        </p>
      </div>
    );
  }

  return (
    <div
      data-ai-tool="tutor-escalation"
      className="mt-2 rounded-2xl border border-amber-300/70 bg-amber-50/60 p-3 text-sm"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
        Ask your instructor
      </p>
      <p className="mt-1.5 leading-relaxed text-stone-700">
        This looks like a good one for your instructor. Review what would be shared —
        edit your question if you like — then send it to their queue.
      </p>

      <div className="mt-2 space-y-2 rounded-xl border border-amber-200/70 bg-white/70 p-2.5 text-stone-600">
        <div>
          <label
            htmlFor="tutor-escalation-question"
            className="mb-1 block font-medium text-stone-800"
          >
            Your question
          </label>
          <textarea
            id="tutor-escalation-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={state !== "editing"}
            rows={2}
            data-ai-tool="tutor-escalation-question"
            className="w-full resize-none rounded-lg border border-stone-200/80 bg-white px-2.5 py-1.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-500/20 disabled:bg-stone-50"
          />
        </div>

        {proposal.nodeIds.length > 0 ? (
          <p className="text-xs">
            <span className="font-medium text-stone-800">Concepts:</span>{" "}
            {proposal.nodeIds.join(", ")}
          </p>
        ) : null}

        {proposal.proposedAnswer ? (
          <p className="text-xs">
            <span className="font-medium text-stone-800">Tutor&apos;s take (shared too):</span>{" "}
            {proposal.proposedAnswer}
          </p>
        ) : null}
      </div>

      {state === "error" && errorMsg ? (
        <p role="alert" className="mt-2 text-xs font-medium text-rose-700">
          {errorMsg}
        </p>
      ) : null}

      {candidateId === null ? (
        <p className="mt-2 text-xs text-stone-500">
          This escalation couldn&apos;t be prepared for sharing. Ask the tutor again.
        </p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          data-ai-tool="tutor-escalation-send"
          aria-label="Send this question to your instructor"
          className="inline-flex items-center gap-1.5 rounded-full brand-gradient px-3.5 py-1.5 text-xs font-medium text-white shadow-sm shadow-brand-600/25 transition-all hover:opacity-95 active:scale-95 disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          <Send className="size-3.5" aria-hidden />
          {state === "sending" ? "Sending…" : "Send to instructor"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={state === "sending"}
          data-ai-tool="tutor-escalation-cancel"
          aria-label="Cancel — don't share this with your instructor"
          className="inline-flex items-center gap-1.5 rounded-full border border-stone-300/80 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          <X className="size-3.5" aria-hidden />
          Cancel
        </button>
      </div>
    </div>
  );
}

export default TutorEscalationCard;
