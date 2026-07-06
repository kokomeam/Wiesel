"use client";

/**
 * The autonomy settings surface — mode picker + the auto-mode policy form.
 * Lives on the Marketing hub (course-scoped, like everything the gate does).
 *
 * The form can only ever NARROW what auto mode does: hard-denied tools render
 * disabled ("always needs you"), the server strips them again regardless, and
 * an unconfigured field fails closed in the policy engine — so saving a
 * half-filled form yields LESS autonomy, never more.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock, ShieldCheck } from "lucide-react";
import {
  updateAutonomySettingsAction,
  type ActionResult,
} from "@/app/(app)/marketing/actions";
import {
  AUTO_APPROVABLE_TOOLS,
  HARD_DENY_TOOLS,
  type AutonomySettings as Settings,
} from "@/lib/marketing/autonomy";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

const MODES: { value: "manual" | "assisted" | "auto"; title: string; blurb: string }[] = [
  {
    value: "manual",
    title: "Manual",
    blurb: "Every action that reaches a real person waits for your approval card. No exceptions.",
  },
  {
    value: "assisted",
    title: "Assisted",
    blurb:
      "Approval cards for everything outward — but the agent asks a clarifying question first when targeting is ambiguous, and test emails to your own address just send.",
  },
  {
    value: "auto",
    title: "Auto",
    blurb:
      "Actions you explicitly opt in below may run without a card — inside your caps, your hours, and never the first send to a new segment. Everything else still gets a card.",
  },
];

const TOOL_LABELS: Record<string, string> = {
  publish_landing_page: "Publish a landing page",
  unpublish_landing_page: "Unpublish a landing page",
  activate_sequence: "Activate a sequence",
  enroll_segment_in_sequence: "Enroll a segment",
  send_broadcast: "Send a broadcast",
  send_test_email: "Send a test email",
  send_consent_confirmation: "Send one consent confirmation",
};

const HARD_DENY_LABELS: Record<string, string> = {
  launch_campaign: "Launch a campaign",
  cancel_campaign: "Cancel a campaign",
  send_consent_confirmations: "Bulk consent confirmations",
};

const labelCls = "font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400";

export function AutonomySettings({
  courseId,
  initial,
  onResult,
  embedded = false,
}: {
  courseId: string;
  initial: Settings;
  onResult?: (r: ActionResult) => void;
  /** Rendered inside a CollapsibleCard (hub) — the parent owns the card frame
   *  and the "Agent autonomy" title, so skip both here. */
  embedded?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState(initial.mode);
  const [tools, setTools] = useState<string[]>(initial.policy.autoApproveTools);
  const [maxRecipients, setMaxRecipients] = useState<string>(
    initial.policy.maxRecipients === null ? "" : String(initial.policy.maxRecipients)
  );
  const [hoursEnabled, setHoursEnabled] = useState(initial.policy.allowedHours !== null);
  const [startHour, setStartHour] = useState(initial.policy.allowedHours?.startHour ?? 9);
  const [endHour, setEndHour] = useState(initial.policy.allowedHours?.endHour ?? 17);
  const [timezone, setTimezone] = useState(initial.policy.allowedHours?.timezone ?? "");
  const [firstSendManual, setFirstSendManual] = useState(initial.policy.firstSendToNewSegmentManual);
  const [revertWindow, setRevertWindow] = useState(String(initial.revertWindowHours));
  const [saved, setSaved] = useState(false);
  const [busy, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      const r = await updateAutonomySettingsAction(courseId, {
        mode,
        revertWindowHours: Number(revertWindow) || 24,
        autoApproveTools: tools,
        maxRecipients: maxRecipients.trim() === "" ? null : Math.max(1, Math.round(Number(maxRecipients))),
        allowedHours: hoursEnabled
          ? { startHour, endHour, timezone: timezone.trim() || null }
          : null,
        firstSendToNewSegmentManual: firstSendManual,
      });
      onResult?.(r);
      if (!r.error) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
      router.refresh();
    });

  const Wrapper = embedded ? "div" : "section";
  return (
    <Wrapper
      className={embedded ? undefined : "rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"}
      data-testid="autonomy-settings"
    >
      {!embedded ? (
        <>
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-stone-400" />
            <h3 className="text-sm font-medium text-stone-900">Agent autonomy</h3>
          </div>
          <p className="mt-1 text-xs text-stone-500">
            Governs only actions that reach real people. Drafts and edits always auto-apply with a{" "}
            <span className="text-stone-700">revert window</span>, whatever the mode.
          </p>
        </>
      ) : (
        <p className="text-xs text-stone-500">
          Governs only actions that reach real people. Drafts and edits always auto-apply with a{" "}
          <span className="text-stone-700">revert window</span>, whatever the mode.
        </p>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setMode(m.value)}
            className={cn(
              "rounded-xl border p-3 text-left transition-colors",
              mode === m.value
                ? "border-brand-400 bg-brand-50/60 ring-1 ring-inset ring-brand-200"
                : "border-stone-200 bg-white hover:border-stone-300"
            )}
            aria-pressed={mode === m.value}
          >
            <p className="text-sm font-medium text-stone-900">
              {m.title}
              {m.value === "assisted" ? <span className="ml-1.5 text-[10px] font-normal text-stone-400">recommended</span> : null}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-stone-500">{m.blurb}</p>
          </button>
        ))}
      </div>

      {mode === "auto" ? (
        <div className="mt-4 space-y-4 rounded-xl border border-stone-200 bg-stone-50/60 p-3">
          <div>
            <p className={labelCls}>Auto-approvable actions</p>
            <p className="mt-0.5 text-[11px] text-stone-500">
              Nothing runs without a card until you opt it in here — and it still has to pass every cap below.
            </p>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {[...AUTO_APPROVABLE_TOOLS].map((t) => (
                <label key={t} className="flex items-center gap-2 text-xs text-stone-700">
                  <input
                    type="checkbox"
                    checked={tools.includes(t)}
                    onChange={(e) =>
                      setTools((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))
                    }
                    className="size-3.5 rounded border-stone-300 accent-orange-600"
                  />
                  {TOOL_LABELS[t] ?? t}
                </label>
              ))}
              {[...HARD_DENY_TOOLS].map((t) => (
                <label key={t} className="flex items-center gap-2 text-xs text-stone-400" title="Never auto-approvable">
                  <Lock className="size-3.5" />
                  {HARD_DENY_LABELS[t] ?? t} <span className="text-[10px]">— always needs you</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-stone-600">
              <span className={labelCls}>Max recipients per auto-send</span>
              <input
                type="number"
                min={1}
                placeholder="unset — sends need a card"
                value={maxRecipients}
                onChange={(e) => setMaxRecipients(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-stone-300/80 bg-white px-2 py-1.5 text-sm"
              />
            </label>
            <div className="text-xs text-stone-600">
              <span className={labelCls}>Allowed hours</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={hoursEnabled}
                  onChange={(e) => setHoursEnabled(e.target.checked)}
                  className="size-3.5 rounded border-stone-300 accent-orange-600"
                />
                {hoursEnabled ? (
                  <span className="flex items-center gap-1.5">
                    <select
                      value={startHour}
                      onChange={(e) => setStartHour(Number(e.target.value))}
                      className="rounded-lg border border-stone-300/80 bg-white px-1.5 py-1 text-sm"
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>{`${h}:00`}</option>
                      ))}
                    </select>
                    –
                    <select
                      value={endHour}
                      onChange={(e) => setEndHour(Number(e.target.value))}
                      className="rounded-lg border border-stone-300/80 bg-white px-1.5 py-1 text-sm"
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h + 1} value={h + 1}>{`${h + 1}:00`}</option>
                      ))}
                    </select>
                    <input
                      placeholder="UTC"
                      title="IANA timezone, e.g. America/New_York (empty = UTC)"
                      value={timezone ?? ""}
                      onChange={(e) => setTimezone(e.target.value)}
                      className="w-32 rounded-lg border border-stone-300/80 bg-white px-2 py-1 text-sm"
                    />
                  </span>
                ) : (
                  <span className="text-stone-400">unset — nothing auto-executes</span>
                )}
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-stone-700">
            <input
              type="checkbox"
              checked={firstSendManual}
              onChange={(e) => setFirstSendManual(e.target.checked)}
              className="size-3.5 rounded border-stone-300 accent-orange-600"
            />
            Always review the first send to a segment this course hasn&apos;t emailed before
          </label>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-stone-600">
          <span className={labelCls}>Revert window</span>
          <input
            type="number"
            min={1}
            max={720}
            value={revertWindow}
            onChange={(e) => setRevertWindow(e.target.value)}
            className="w-16 rounded-lg border border-stone-300/80 bg-white px-2 py-1 text-sm"
          />
          hours
        </label>
        <div className="ml-auto flex items-center gap-2">
          {saved ? <span className="text-xs text-emerald-600">Saved</span> : null}
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} Save autonomy settings
          </Button>
        </div>
      </div>
    </Wrapper>
  );
}
