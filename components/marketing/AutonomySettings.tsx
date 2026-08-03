"use client";

/**
 * The autonomy settings drawer (UI-1 Wave 4) — mode as a SegmentedControl
 * with one line of description for the selected mode (+ a compare-modes
 * popover), permissions as grouped single-column Toggle rows, hard-locked
 * actions in their own "Always asks you" group, guardrails as FieldGroups,
 * and a sticky save bar with dirty detection, a discard guard, and the
 * DEV-2 optimistic save (conflict → re-read, re-apply once, inform).
 *
 * The form can only ever NARROW what auto mode does: hard-denied tools have
 * no toggle, the server strips them again regardless, and an unconfigured
 * field fails closed in the policy engine — so saving a half-filled form
 * yields LESS autonomy, never more. Copy here must never imply otherwise.
 */

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock } from "lucide-react";
import {
  updateAutonomySettingsAction,
  type ActionResult,
} from "@/app/(app)/marketing/actions";
import {
  AUTO_APPROVABLE_TOOLS,
  HARD_DENY_TOOLS,
  type AutonomyMode,
} from "@/lib/marketing/autonomy";
import type { AutonomySettingsWithMeta } from "@/lib/marketing/autonomyStore";
import { MODE_COMPARISON, MODE_DESCRIPTIONS, MODE_TITLES, modeConsequence } from "@/lib/marketing/autonomyCopy";
import { humanizeToolName, TOOL_CATEGORY_META, type ToolCategory } from "@/lib/marketing/humanize";
import { useAutonomyDrawer } from "@/lib/marketing/autonomyDrawerStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Drawer } from "@/components/ui/Drawer";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { FieldGroup } from "@/components/ui/FieldGroup";
import { Input, Select } from "@/components/ui/Input";
import { ListRow } from "@/components/ui/ListRow";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusChip } from "@/components/ui/StatusChip";
import { StickyActionBar } from "@/components/ui/StickyActionBar";
import { Toggle } from "@/components/ui/Toggle";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

const FALLBACK_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
];

interface FormState {
  mode: AutonomyMode;
  tools: string[];
  maxRecipients: string;
  hoursEnabled: boolean;
  startHour: number;
  endHour: number;
  timezone: string;
  firstSendManual: boolean;
  revertWindow: string;
}

function formFromSettings(s: AutonomySettingsWithMeta): FormState {
  return {
    mode: s.mode,
    tools: [...s.policy.autoApproveTools].sort(),
    maxRecipients: s.policy.maxRecipients === null ? "" : String(s.policy.maxRecipients),
    hoursEnabled: s.policy.allowedHours !== null,
    startHour: s.policy.allowedHours?.startHour ?? 9,
    endHour: s.policy.allowedHours?.endHour ?? 17,
    timezone: s.policy.allowedHours?.timezone ?? "",
    firstSendManual: s.policy.firstSendToNewSegmentManual,
    revertWindow: String(s.revertWindowHours),
  };
}

/** The permission groups, derived from the humanization map's categories so
 *  the grouping can never drift from the labels. */
function permissionGroups(): { label: string; tools: string[] }[] {
  const by = new Map<ToolCategory, string[]>();
  for (const t of AUTO_APPROVABLE_TOOLS) {
    const { category } = humanizeToolName(t);
    if (!category) continue;
    by.set(category, [...(by.get(category) ?? []), t]);
  }
  const order: ToolCategory[] = ["landing", "email", "audience", "publishing"];
  return order
    .filter((c) => (by.get(c) ?? []).length > 0)
    .map((c) => ({ label: TOOL_CATEGORY_META[c].label, tools: by.get(c)! }));
}

function CompareModes() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-meta font-medium text-brand-700 hover:underline"
        data-testid="compare-modes"
      >
        Compare modes
      </button>
      {open ? (
        <div
          role="note"
          className="absolute left-0 top-6 z-30 w-96 max-w-[80vw] overflow-x-auto rounded-panel border border-stone-200/80 bg-white p-3 shadow-overlay"
        >
          <table className="w-full text-meta">
            <thead>
              <tr className="text-left text-stone-500">
                <th className="pb-1 pr-2 font-normal" />
                <th className="pb-1 pr-2 font-medium text-stone-600">Manual</th>
                <th className="pb-1 pr-2 font-medium text-stone-600">Assisted</th>
                <th className="pb-1 font-medium text-stone-600">Auto</th>
              </tr>
            </thead>
            <tbody className="text-stone-600">
              {MODE_COMPARISON.map((r) => (
                <tr key={r.row} className="border-t border-stone-100">
                  <td className="py-1 pr-2 text-stone-500">{r.row}</td>
                  <td className="py-1 pr-2">{r.manual}</td>
                  <td className="py-1 pr-2">{r.assisted}</td>
                  <td className="py-1">{r.auto}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

export function AutonomyDrawer({
  courseId,
  initial,
  onResult,
}: {
  courseId: string;
  initial: AutonomySettingsWithMeta;
  onResult?: (r: ActionResult) => void;
}) {
  const router = useRouter();
  const open = useAutonomyDrawer((s) => s.open);
  const setOpen = useAutonomyDrawer((s) => s.setOpen);

  const [form, setForm] = useState<FormState>(() => formFromSettings(initial));
  // The dirty baseline participates in render → state, not a ref (React 19
  // forbids ref reads during render). The optimistic token is handler-only.
  const [baseline, setBaseline] = useState<FormState>(() => formFromSettings(initial));
  const updatedAtRef = useRef<string | null>(initial.updatedAt);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, startTransition] = useTransition();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const dirty = JSON.stringify({ ...form, tools: [...form.tools].sort() }) !== JSON.stringify(baseline);

  const maxRecipientsError =
    form.maxRecipients.trim() !== "" && (!/^\d+$/.test(form.maxRecipients.trim()) || Number(form.maxRecipients) < 1)
      ? "Enter a whole number of at least 1, or leave it unset."
      : null;
  const revertWindowError =
    !/^\d+$/.test(form.revertWindow.trim()) || Number(form.revertWindow) < 1 || Number(form.revertWindow) > 720
      ? "Between 1 and 720 hours."
      : null;
  const invalid = Boolean(maxRecipientsError || revertWindowError);

  const groups = useMemo(() => permissionGroups(), []);
  const timezones = useMemo(() => {
    try {
      const all = Intl.supportedValuesOf("timeZone");
      return form.timezone && !all.includes(form.timezone) ? [form.timezone, ...all] : all;
    } catch {
      return FALLBACK_TIMEZONES;
    }
  }, [form.timezone]);

  const consequence = modeConsequence(
    { mode: baseline.mode, policy: { ...initial.policy, autoApproveTools: form.tools }, revertWindowHours: initial.revertWindowHours },
    form.mode
  );

  const close = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else setOpen(false);
  };

  const save = () =>
    startTransition(async () => {
      const r = await updateAutonomySettingsAction(courseId, {
        mode: form.mode,
        revertWindowHours: Number(form.revertWindow) || 24,
        autoApproveTools: form.tools,
        maxRecipients: form.maxRecipients.trim() === "" ? null : Math.max(1, Math.round(Number(form.maxRecipients))),
        allowedHours: form.hoursEnabled
          ? { startHour: form.startHour, endHour: form.endHour, timezone: form.timezone.trim() || null }
          : null,
        firstSendToNewSegmentManual: form.firstSendManual,
        expectedUpdatedAt: updatedAtRef.current,
      });
      onResult?.(r);
      if (!r.error) {
        setBaseline({ ...form, tools: [...form.tools].sort() });
        if (r.updatedAt !== undefined) updatedAtRef.current = r.updatedAt;
      }
      router.refresh();
    });

  const toggleRows = (tools: string[]) =>
    tools.map((t) => {
      const id = `autotool-${t}`;
      return (
        <ListRow
          key={t}
          title={<span id={id}>{humanizeToolName(t).label}</span>}
          trailing={
            <Toggle
              checked={form.tools.includes(t)}
              onChange={(next) =>
                set("tools", next ? [...form.tools, t] : form.tools.filter((x) => x !== t))
              }
              aria-labelledby={id}
              data-testid={`toggle-${t}`}
            />
          }
          className="px-0 hover:bg-transparent"
        />
      );
    });

  return (
    <>
      <Drawer
        open={open}
        onClose={close}
        title="Agent autonomy"
        subtitle="How much the agent may do without a card."
        data-testid="autonomy-drawer"
        footer={
          <StickyActionBar
            note={dirty ? "You have unsaved changes" : "Everything saved"}
            data-testid="autonomy-save-bar"
          >
            {dirty ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setForm(baseline)}
                data-testid="autonomy-discard"
              >
                Discard
              </Button>
            ) : null}
            <Button size="sm" onClick={save} disabled={busy || !dirty || invalid} data-testid="autonomy-save">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} Save settings
            </Button>
          </StickyActionBar>
        }
      >
        <div className="space-y-5">
          <p className="text-meta leading-relaxed text-stone-500">
            Governs only actions that reach real people. Drafts and edits always auto-apply with a revert
            window, whatever the mode.
          </p>

          {/* ── mode ── */}
          <div>
            <SegmentedControl<AutonomyMode>
              aria-label="Autonomy mode"
              value={form.mode}
              onChange={(m) => set("mode", m)}
              options={[
                { value: "manual", label: MODE_TITLES.manual },
                {
                  value: "assisted",
                  label: MODE_TITLES.assisted,
                  badge: <StatusChip status="success">Recommended</StatusChip>,
                },
                { value: "auto", label: MODE_TITLES.auto },
              ]}
            />
            <div className="mt-2 flex items-start justify-between gap-3">
              <p className="min-w-0 flex-1 text-meta leading-relaxed text-stone-500" data-testid="mode-description">
                {MODE_DESCRIPTIONS[form.mode]}
              </p>
              <CompareModes />
            </div>
            {consequence ? (
              <p
                className="mt-2 rounded-panel bg-status-pending-bg px-2.5 py-1.5 text-meta leading-relaxed text-status-pending"
                data-testid="mode-consequence"
              >
                {consequence}
              </p>
            ) : null}
          </div>

          {/* ── what can run on its own ── */}
          <div>
            <Eyebrow as="h3">What can run on its own</Eyebrow>
            {form.mode === "auto" ? (
              <>
                <p className="mt-1 text-meta text-stone-500">
                  Nothing runs without a card until you opt it in here — and it still has to pass every
                  guardrail below.
                </p>
                <div className="mt-1 space-y-3">
                  {groups.map((g) => (
                    <div key={g.label}>
                      <p className="text-meta font-medium text-stone-500">{g.label}</p>
                      <div>{toggleRows(g.tools)}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="mt-1 text-meta text-stone-500" data-testid="optin-hint">
                Switch to Auto to opt individual actions in. In {MODE_TITLES[form.mode]} mode, everything
                outward asks you first.
              </p>
            )}
          </div>

          {/* ── always asks you ── */}
          <div>
            <Eyebrow as="h3">Always asks you</Eyebrow>
            <div className="mt-1" data-testid="hard-locked-list">
              {[...HARD_DENY_TOOLS].map((t) => (
                <ListRow
                  key={t}
                  leading={<Lock className="size-3.5 shrink-0 text-stone-500" aria-hidden />}
                  title={<span className="text-stone-500">{humanizeToolName(t).label}</span>}
                  trailing={
                    <span className="shrink-0 text-meta text-stone-500">Always requires your approval</span>
                  }
                  className="px-0 hover:bg-transparent"
                />
              ))}
            </div>
          </div>

          {/* ── guardrails ── */}
          {form.mode === "auto" ? (
            <div>
              <Eyebrow as="h3">Guardrails</Eyebrow>
              <div className="mt-2 space-y-4">
                <FieldGroup
                  label="Max recipients per auto-send"
                  htmlFor="autonomy-max-recipients"
                  help="Unset fails closed — sends still ask first."
                  error={maxRecipientsError}
                >
                  <Input
                    id="autonomy-max-recipients"
                    type="number"
                    min={1}
                    inputMode="numeric"
                    placeholder="Unset — sends still ask first"
                    value={form.maxRecipients}
                    invalid={Boolean(maxRecipientsError)}
                    onChange={(e) => set("maxRecipients", e.target.value)}
                  />
                </FieldGroup>

                <FieldGroup
                  label="Allowed hours"
                  help={form.hoursEnabled ? undefined : "Unset fails closed — nothing auto-executes."}
                >
                  <div className="space-y-2">
                    <div className="flex items-center gap-2.5">
                      <Toggle
                        checked={form.hoursEnabled}
                        onChange={(v) => set("hoursEnabled", v)}
                        aria-label="Limit auto-runs to allowed hours"
                        data-testid="hours-toggle"
                      />
                      {form.hoursEnabled ? (
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                          <Select
                            aria-label="Start hour"
                            value={form.startHour}
                            onChange={(e) => set("startHour", Number(e.target.value))}
                            className="w-auto"
                          >
                            {Array.from({ length: 24 }, (_, h) => (
                              <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
                            ))}
                          </Select>
                          <span className="text-stone-500">–</span>
                          <Select
                            aria-label="End hour"
                            value={form.endHour}
                            onChange={(e) => set("endHour", Number(e.target.value))}
                            className="w-auto"
                          >
                            {Array.from({ length: 24 }, (_, h) => (
                              <option key={h + 1} value={h + 1}>{`${String(h + 1).padStart(2, "0")}:00`}</option>
                            ))}
                          </Select>
                        </div>
                      ) : (
                        <span className="text-meta text-stone-500">Off</span>
                      )}
                    </div>
                    {form.hoursEnabled ? (
                      <Select
                        aria-label="Timezone"
                        value={form.timezone}
                        onChange={(e) => set("timezone", e.target.value)}
                        data-testid="timezone-select"
                      >
                        <option value="">UTC (default)</option>
                        {timezones.map((tz) => (
                          <option key={tz} value={tz}>
                            {tz}
                          </option>
                        ))}
                      </Select>
                    ) : null}
                  </div>
                </FieldGroup>

                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-body text-stone-700" id="first-send-label">
                      First-send review
                    </p>
                    <p className="text-meta text-stone-500">
                      Always review the first send to a segment this course hasn&apos;t emailed before.
                    </p>
                  </div>
                  <Toggle
                    checked={form.firstSendManual}
                    onChange={(v) => set("firstSendManual", v)}
                    aria-labelledby="first-send-label"
                    data-testid="first-send-toggle"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {/* ── revert window (every mode) ── */}
          <FieldGroup
            label="Revert window"
            htmlFor="autonomy-revert-window"
            help="How long drafts and edits stay revertible from Activity."
            error={revertWindowError}
          >
            <div className="flex items-center gap-2">
              <Input
                id="autonomy-revert-window"
                type="number"
                min={1}
                max={720}
                inputMode="numeric"
                value={form.revertWindow}
                invalid={Boolean(revertWindowError)}
                onChange={(e) => set("revertWindow", e.target.value)}
                className={cn("w-24")}
              />
              <span className="text-body text-stone-500">hours</span>
            </div>
          </FieldGroup>
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard unsaved changes?"
        message="Your autonomy edits haven't been saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setForm(baseline);
          setConfirmDiscard(false);
          setOpen(false);
        }}
      />
    </>
  );
}
