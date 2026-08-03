"use client";

/**
 * The rail's autonomy resident (UI-1 W2.4/W4.1): a one-line status pill —
 * "Agent autonomy · Auto — 5 actions opted in" — computed from the settings
 * the page already loads. Opens the settings Drawer via the shared store so
 * other surfaces (e.g. an Activity entry's "Change autonomy settings") can
 * open the same drawer.
 */

import { ChevronRight, ShieldCheck } from "lucide-react";
import type { ActionResult } from "@/app/(app)/marketing/actions";
import type { AutonomySettingsWithMeta } from "@/lib/marketing/autonomyStore";
import { useAutonomyDrawer } from "@/lib/marketing/autonomyDrawerStore";
import { AutonomyDrawer } from "@/components/marketing/AutonomySettings";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { IconTile } from "@/components/ui/IconTile";
import { MODE_TITLES } from "@/lib/marketing/autonomyCopy";

function summaryLine(s: AutonomySettingsWithMeta): string {
  if (s.mode === "auto") {
    const n = s.policy.autoApproveTools.length;
    return n === 0
      ? "Auto — nothing opted in yet, everything still asks"
      : `Auto — ${n} action${n === 1 ? "" : "s"} opted in`;
  }
  if (s.mode === "manual") return "Manual — every outward action asks you";
  return "Assisted — asks before anything outward";
}

export function AutonomyPill({
  courseId,
  autonomy,
  onResult,
}: {
  courseId: string;
  autonomy: AutonomySettingsWithMeta;
  onResult?: (r: ActionResult) => void;
}) {
  const setOpen = useAutonomyDrawer((s) => s.setOpen);
  return (
    <>
      <Card>
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="autonomy-pill"
          className="flex w-full items-center gap-3 rounded-card p-4 text-left transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          <IconTile icon={ShieldCheck} tone="neutral" size="sm" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-body font-semibold text-stone-900">Agent autonomy</span>
              <Badge tone={autonomy.mode === "auto" ? "brand" : "slate"}>{MODE_TITLES[autonomy.mode]}</Badge>
            </span>
            <span className="mt-0.5 block truncate text-meta text-stone-500">{summaryLine(autonomy)}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-stone-300" />
        </button>
      </Card>

      <AutonomyDrawer courseId={courseId} initial={autonomy} onResult={onResult} />
    </>
  );
}
