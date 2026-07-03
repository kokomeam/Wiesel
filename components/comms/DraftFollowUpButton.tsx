"use client";

/**
 * The Stuck queue's "Draft follow-up" (Milestone 6) — finally wired. Opens the
 * composer prefilled with a DETERMINISTIC template (no model call; the agent
 * path is where model-drafted messages come from). Disabled with an honest
 * tooltip when the learner opted out — and the send seam re-checks that
 * server-side regardless.
 */

import { useState } from "react";
import { MailPlus } from "lucide-react";
import { cn } from "@/lib/cn";
import { MessageComposer, type ComposerSeed } from "./MessageComposer";

export function DraftFollowUpButton({
  seed,
  optedOut,
}: {
  seed: ComposerSeed;
  optedOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={optedOut}
        title={
          optedOut
            ? "This learner has opted out of course emails."
            : "Draft a personal check-in from a template — you edit and approve before anything sends."
        }
        data-ai-tool="comms-draft-followup"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors",
          optedOut
            ? "cursor-not-allowed border-stone-200 bg-stone-50 text-stone-400"
            : "border-stone-200 bg-white text-stone-700 hover:border-brand-200 hover:bg-brand-50/50 hover:text-brand-700"
        )}
      >
        <MailPlus className="size-4" aria-hidden />
        Draft follow-up
      </button>
      {open ? <MessageComposer seed={seed} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
