"use client";

/**
 * Collapsible wrapper for TEXT lesson blocks (lecture / example / exercise /
 * resource) in the learner runtime. The header is a full-width accordion
 * button (WAI-ARIA pattern: heading > button) and the content collapses via
 * CSS grid-template-rows 0fr/1fr — the children STAY MOUNTED either way.
 *
 * ⚠ Do NOT wrap interactive/tracked blocks (slide decks, video, quiz,
 * homework, imported decks) in this: their analytics + progress reporting
 * depend on mount/unmount lifecycle and continuous visibility. Text blocks
 * only. Reduced motion is handled by the global prefers-reduced-motion CSS
 * guard (it kills the grid transition).
 */

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export function CollapsibleBlock({
  chip,
  eyebrow,
  title,
  ariaLabel,
  children,
}: {
  /** The block-type icon chip (decorative). */
  chip: React.ReactNode;
  /** Mono uppercase type label, e.g. "Reading". */
  eyebrow: string;
  title: string | null;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const contentId = useId();

  return (
    <section aria-label={ariaLabel}>
      <h2 className="mb-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((v) => !v)}
          className="group flex w-full items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          {chip}
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-[11px] uppercase tracking-[0.18em] text-stone-500">
              {eyebrow}
            </span>
            {title ? (
              <span className="block text-lg leading-snug [font-family:var(--font-display)] font-light text-stone-900">
                {title}
              </span>
            ) : null}
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-stone-400 transition-transform duration-200 group-hover:text-stone-600",
              !open && "-rotate-90"
            )}
            aria-hidden
          />
        </button>
      </h2>
      {/* 0fr/1fr grid collapse — content stays in the DOM; `inert` keeps
          hidden links/reveals out of the tab order while collapsed. */}
      <div
        id={contentId}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </section>
  );
}
