"use client";

/**
 * TUTOR-1 Wave 4 — the escalation consent card. Rendered ONLY when the server
 * flag `escalationsUi` is true (TutorBody gates it); statically imported but
 * dormant behind that flag until Wave 6 flips it on. Until then the consent
 * affordance is DISABLED and labelled honestly — the instructor delivery queue
 * ships in Wave 6, so nothing is sent from here yet.
 *
 * Deliberately tiny + self-contained: it takes only the proposal and shows the
 * learner what would be shared, plus the disabled affordance. No POST, no store
 * write — Wave 6 wires the consent path.
 */

import { Send } from "lucide-react";
import type { TutorEscalationProposal } from "@/lib/learn/tutorClientTypes";

export function TutorEscalationCard({ proposal }: { proposal: TutorEscalationProposal }) {
  return (
    <div
      data-ai-tool="tutor-escalation"
      className="mt-2 rounded-2xl border border-amber-300/70 bg-amber-50/60 p-3 text-sm"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-amber-700">
        Ask your instructor
      </p>
      <p className="mt-1.5 leading-relaxed text-stone-700">
        This looks like a good one for your instructor. Here&apos;s what the tutor
        would share with them:
      </p>
      <div className="mt-2 space-y-1.5 rounded-xl border border-amber-200/70 bg-white/70 p-2.5 text-stone-600">
        <p>
          <span className="font-medium text-stone-800">Your question:</span>{" "}
          {proposal.learnerQuestion}
        </p>
        {proposal.proposedAnswer ? (
          <p>
            <span className="font-medium text-stone-800">Tutor&apos;s take:</span>{" "}
            {proposal.proposedAnswer}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="Sharing with your instructor arrives soon"
        className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-stone-300/80 bg-white px-3 py-1.5 text-xs font-medium text-stone-400"
      >
        <Send className="size-3.5" aria-hidden />
        Sharing with your instructor arrives soon
      </button>
    </div>
  );
}

export default TutorEscalationCard;
