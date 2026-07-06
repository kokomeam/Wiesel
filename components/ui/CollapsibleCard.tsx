"use client";

/**
 * A disclosure card — the Card treatment with a click-to-collapse header.
 * Controlled: the parent owns `open` (e.g. bound to a persisted UI store) so
 * disclosure state can survive reloads without this primitive knowing how.
 * The header is one real <button> (full-row hit target, aria-expanded); an
 * optional `action` slot renders OUTSIDE the button so nested controls stay
 * valid HTML.
 */

import { useId } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export function CollapsibleCard({
  title,
  subtitle,
  badge,
  action,
  open,
  onToggle,
  children,
  className,
  bodyClassName,
}: {
  title: React.ReactNode;
  /** Small muted line under the title (shown open or closed). */
  subtitle?: React.ReactNode;
  /** Inline chip next to the title — visible while collapsed, so the header
   *  still answers "what's in here / what state is it in". */
  badge?: React.ReactNode;
  /** Rendered right-aligned, outside the toggle button. */
  action?: React.ReactNode;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const bodyId = useId();
  return (
    <section
      className={cn(
        "rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]",
        className
      )}
    >
      <div className={cn("flex items-center gap-2 px-4", open ? "border-b border-stone-100" : "")}>
        <button
          type="button"
          onClick={() => onToggle(!open)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex min-w-0 flex-1 items-center gap-2 py-3 text-left"
        >
          <ChevronDown
            className={cn("size-4 shrink-0 text-stone-400 transition-transform", !open && "-rotate-90")}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-stone-900">{title}</span>
              {badge}
            </span>
            {subtitle ? <span className="mt-0.5 block text-xs text-stone-500">{subtitle}</span> : null}
          </span>
        </button>
        {action ? <span className="shrink-0">{action}</span> : null}
      </div>
      <div id={bodyId} hidden={!open} className={cn("px-4 pb-4 pt-3", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}
