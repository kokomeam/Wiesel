/**
 * THE manual-publish notice (PRD §11/§17.3) — one component, one sentence,
 * used by the editor, the queue, the empty state, and the timing helper so
 * the language rules stay enforceable in one place. verify-social.ts greps
 * the feature UI for the banned phrases; this is the only sanctioned wording.
 */

import { Info } from "lucide-react";
import { MANUAL_PUBLISH_NOTICE } from "@/lib/marketing/social/constants";
import { cn } from "@/lib/cn";

export function ManualPublishNotice({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3.5 py-2.5 text-xs text-sky-900",
        className
      )}
    >
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>{MANUAL_PUBLISH_NOTICE}</span>
    </div>
  );
}
