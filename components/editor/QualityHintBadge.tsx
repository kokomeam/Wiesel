"use client";

/**
 * Subtle quality-lint indicator. A quiet amber pill with a count; clicking
 * reveals the suggestions — rows with a fix carry a one-click "Fix" button
 * that applies the hint's patches through the normal validated pipeline.
 * Deliberately gentle — these are hints, not errors.
 */

import { useEffect, useState } from "react";
import { Lightbulb, Wand2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useEditorStore } from "@/lib/course/store";
import type { QualityHint } from "@/lib/course/types";

/** Close-on-Escape for lightweight popovers. */
export function useEscapeToClose(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);
}

export function QualityHintBadge({
  hints,
  className,
}: {
  hints: QualityHint[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const applyMany = useEditorStore((s) => s.applyMany);
  useEscapeToClose(open, () => setOpen(false));
  if (hints.length === 0) return null;

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-expanded={open}
        aria-label={`${hints.length} quality suggestion${hints.length > 1 ? "s" : ""}`}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
          "bg-amber-50 text-amber-700 shadow-sm ring-1 ring-amber-100 hover:bg-amber-100"
        )}
      >
        <Lightbulb className="size-3" />
        {hints.length}
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-20"
            aria-hidden
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          {/* z-40: must paint ABOVE the sticky slide toolbar (z-30, later in
              DOM order) or the panel's Fix buttons are unclickable there */}
          <div
            className="absolute right-0 top-7 z-40 w-72 rounded-xl border border-stone-200/80 bg-white p-3 shadow-lg"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
              Suggestions
            </p>
            <ul className="space-y-2.5">
              {hints.map((hint) => (
                <li key={hint.code} className="flex items-start gap-2 text-xs text-stone-600">
                  <span
                    className={cn(
                      "mt-1 size-1.5 shrink-0 rounded-full",
                      hint.severity === "warn" ? "bg-amber-400" : "bg-stone-300"
                    )}
                  />
                  <span className="min-w-0 flex-1">{hint.message}</span>
                  {hint.fix && (
                    <button
                      type="button"
                      title={hint.fix.label}
                      data-ai-tool="quality-fix"
                      data-ai-action="FIX_QUALITY_ISSUE"
                      onClick={(e) => {
                        e.stopPropagation();
                        applyMany(hint.fix!.makePatches(), "human");
                      }}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700 transition-colors hover:bg-brand-100"
                    >
                      <Wand2 className="size-2.5" />
                      Fix
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
