"use client";

/** Funnel-stage chip — color-coded AND text-labeled (a11y: never color alone). */

import { cn } from "@/lib/cn";
import type { FunnelStage } from "@/lib/marketing/social/constants";

const STAGE_CLS: Record<FunnelStage, string> = {
  tofu: "bg-sky-50 text-sky-700 ring-sky-200",
  mofu: "bg-violet-50 text-violet-700 ring-violet-200",
  bofu: "bg-brand-50 text-brand-700 ring-brand-200",
};

export function StageChip({
  stage,
  suffix = "",
  className,
}: {
  stage: FunnelStage;
  suffix?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ring-1 ring-inset",
        STAGE_CLS[stage],
        className
      )}
    >
      {stage}
      {suffix}
    </span>
  );
}
