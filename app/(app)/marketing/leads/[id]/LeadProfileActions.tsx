"use client";

/**
 * Lead-profile actions: request the double-opt-in confirmation (irreversible →
 * lands in the approval inbox, since it reaches a real inbox) and remove from
 * lists. Read-only otherwise (Amendment 4a).
 */

import { useState, useTransition } from "react";
import { Loader2, MailQuestion } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { requestConsentConfirmationAction } from "../../campaignActions";

export function LeadProfileActions({
  courseId,
  subscriberId,
  consentStatus,
  confirmationRequested,
}: {
  courseId: string;
  subscriberId: string;
  consentStatus: string;
  confirmationRequested: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  if (consentStatus !== "pending" || confirmationRequested) return null;

  return (
    <div className="mt-3">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            try {
              await requestConsentConfirmationAction(courseId, subscriberId);
              setMessage("Requested — approve the send under “Needs your approval” on the Marketing hub.");
            } catch (e) {
              setMessage(e instanceof Error ? e.message : String(e));
            }
          })
        }
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <MailQuestion className="size-3.5" />}
        Send confirmation request…
      </Button>
      {message && <p className="mt-2 text-xs text-stone-500">{message}</p>}
    </div>
  );
}
