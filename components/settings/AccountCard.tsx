"use client";

/**
 * Account basics: email (read-only), plan chip, and the default-portal
 * preference (profiles.role — a preference, NOT a security boundary; both
 * portals keep their switchers). The radio flips OPTIMISTICALLY and persists
 * in the background (PERF-1 B3); a failed write reverts the radio and shows a
 * transient error toast. Pre-migration tolerance: if profiles.role doesn't
 * exist on the live DB yet (20260708000000 pending), the write is reverted
 * and a quiet amber notice explains instead.
 */

import { useEffect, useState } from "react";
import { CircleAlert, Loader2 } from "lucide-react";
import { isMissingColumnError } from "@/lib/profile/clientProfile";
import { applyValue, confirmValue, failValue, idleValue } from "@/lib/perf/optimistic";
import { Badge } from "@/components/ui/Badge";
import { Card, CardHeader } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { createClient } from "@/lib/supabase/client";

type PortalRole = "creator" | "learner";

const PORTALS: { value: PortalRole; label: string; hint: string }[] = [
  { value: "creator", label: "Creator studio", hint: "Dashboard, studio, and analytics" },
  { value: "learner", label: "Learner home", hint: "Your courses and review queue" },
];

/** Transient rollback toast — same derived-dismiss pattern as the editor's
 *  FlashToast (the effect only schedules the async dismiss; no synchronous
 *  setState in the effect). */
function ErrorFlash({ flash }: { flash: { id: number; message: string } | null }) {
  const [dismissedId, setDismissedId] = useState(0);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setDismissedId(flash.id), 4000);
    return () => clearTimeout(t);
  }, [flash]);
  if (!flash || flash.id <= dismissedId) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center"
      role="alert"
      data-ai-id="settings-flash-toast"
    >
      <div className="flex items-center gap-2 rounded-full bg-stone-900/90 px-4 py-2 text-xs font-medium text-white shadow-lg backdrop-blur">
        <CircleAlert className="size-3.5 text-rose-300" />
        {flash.message}
      </div>
    </div>
  );
}

export function AccountCard({
  userId,
  email,
  plan,
  role,
}: {
  userId: string;
  email: string;
  plan: string;
  role: PortalRole;
}) {
  // OPTIMISTIC portal preference (pure transitions in lib/perf/optimistic.ts):
  // the radio renders `portalState.value` immediately; a failed write rolls
  // back to the last committed role. The op token makes rapid re-flips safe —
  // only the latest in-flight write settles the state.
  const [portalState, setPortalState] = useState(() => idleValue<PortalRole>(role));
  const [legacyNotice, setLegacyNotice] = useState(false);
  const [flash, setFlash] = useState<{ id: number; message: string } | null>(null);
  const portal = portalState.value;

  const setRole = async (next: PortalRole) => {
    if (next === portal) return;
    const { state, op } = applyValue(portalState, next);
    setPortalState(state);
    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ role: next })
      .eq("id", userId);
    if (!updateError) {
      setPortalState((s) => confirmValue(s, op));
      return;
    }
    setPortalState((s) => failValue(s, op, updateError.message));
    if (isMissingColumnError(updateError, ["role"])) {
      setLegacyNotice(true);
    } else {
      setFlash((f) => ({
        id: (f?.id ?? 0) + 1,
        message: "Couldn't save your default portal — reverted.",
      }));
    }
  };

  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  const planTone = plan === "pro" || plan === "expert" ? "brand" : "slate";

  return (
    <Card>
      <CardHeader
        title="Account"
        subtitle="Sign-in details and where you land after signing in"
        action={<Badge tone={planTone}>{planLabel}</Badge>}
      />
      <div className="space-y-5 p-5">
        <div>
          <p className="text-sm font-medium text-stone-700">Email</p>
          <p className="mt-1 text-sm text-stone-500">{email}</p>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-stone-700">Default portal</legend>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-stone-400">
            Where you land after sign-in.
            {portalState.inFlight && <Loader2 className="size-3 animate-spin" />}
          </p>
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
            {PORTALS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-3 transition-colors",
                  portal === option.value
                    ? "border-brand-300 bg-brand-50/50"
                    : "border-stone-200 hover:border-stone-300"
                )}
              >
                <input
                  type="radio"
                  name="default-portal"
                  value={option.value}
                  checked={portal === option.value}
                  onChange={() => void setRole(option.value)}
                  className="mt-0.5 accent-orange-600"
                />
                <span>
                  <span className="block text-sm font-medium text-stone-800">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-stone-400">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {legacyNotice && (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
              The default-portal preference will unlock once the pending database
              migration is applied.
            </p>
          )}
          {portalState.error && !legacyNotice && (
            <p className="mt-3 text-xs text-rose-600">{portalState.error}</p>
          )}
        </fieldset>
      </div>
      <ErrorFlash flash={flash} />
    </Card>
  );
}
