"use client";

/**
 * The reopen affordance for a collapsed side panel: a slim full-height rail
 * with a vertical label. The whole rail is the button — collapsed panels are
 * never hidden states users have to hunt for.
 */

import { PanelLeft, PanelRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { toolAttrs } from "@/lib/course/aiAttributes";

export function CollapsedRail({
  label,
  side,
  onExpand,
}: {
  label: string;
  side: "left" | "right";
  onExpand: () => void;
}) {
  const Icon = side === "left" ? PanelLeft : PanelRight;
  return (
    <button
      type="button"
      {...toolAttrs({
        tool: `expand-${label.toLowerCase()}`,
        action: "TOGGLE_PANEL",
        targetType: "panel",
        label: `Show the ${label} panel`,
      })}
      onClick={onExpand}
      className={cn(
        "group flex w-9 shrink-0 flex-col items-center gap-2.5 bg-white py-4 transition-colors hover:bg-brand-50/60",
        side === "left" ? "border-r border-stone-200" : "border-l border-stone-200"
      )}
    >
      <Icon className="size-3.5 text-stone-300 transition-colors group-hover:text-brand-600" />
      <span
        className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 transition-colors group-hover:text-brand-700"
        style={{ writingMode: "vertical-rl" }}
      >
        {label}
      </span>
    </button>
  );
}
