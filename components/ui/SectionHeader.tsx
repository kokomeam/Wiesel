"use client";

import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * A section heading row: optional icon · title · badge · optional info
 * popover (the home for standing explainer copy that used to squat inside
 * card bodies — UI-1 W3.1) · right-aligned action slot.
 */
export function SectionHeader({
  icon: Icon,
  title,
  badge,
  info,
  action,
  as: Comp = "h2",
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  badge?: React.ReactNode;
  /** Explainer copy shown in a click-toggled popover behind an ⓘ button. */
  info?: React.ReactNode;
  action?: React.ReactNode;
  as?: "h2" | "h3";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {Icon ? <Icon className="size-4 shrink-0 text-stone-500" /> : null}
      <Comp className="min-w-0 truncate text-body font-semibold text-stone-900">{title}</Comp>
      {badge}
      {info ? (
        <div ref={wrapRef} className="relative flex">
          <button
            type="button"
            aria-label="About this section"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="grid size-6 place-items-center rounded-full text-stone-500 transition-colors hover:bg-stone-900/[0.06] hover:text-stone-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            <Info className="size-3.5" />
          </button>
          {open ? (
            <div
              role="note"
              className="absolute left-0 top-8 z-30 w-64 rounded-panel border border-stone-200/80 bg-white p-3 text-secondary text-stone-600 shadow-overlay"
            >
              {info}
            </div>
          ) : null}
        </div>
      ) : null}
      <span className="min-w-0 flex-1" />
      {action}
    </div>
  );
}
