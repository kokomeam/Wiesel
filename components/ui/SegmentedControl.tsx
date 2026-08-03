"use client";

import { useRef } from "react";
import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Small inline chip (e.g. "Recommended") — renders whole, never truncated. */
  badge?: React.ReactNode;
}

/**
 * A radiogroup rendered as equal segments in a pill track. Roving tabindex +
 * arrow-key selection; the selected segment lifts on the card shadow.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  className,
  "data-testid": testId,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  "aria-label": string;
  className?: string;
  "data-testid"?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, delta: number) => {
    const next = (from + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        "flex w-full gap-1 rounded-full bg-stone-100 p-1 ring-1 ring-inset ring-stone-200",
        className
      )}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={cn(
              "inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3 text-body font-medium transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
              // A badge-bearing segment sizes to its content so neither the
              // label nor the badge ever truncates (AC-W4.2); the others flex.
              o.badge ? "flex-none" : "min-w-0 flex-1",
              // stone-600 (not 500) — the stone-100 track needs the darker
              // step for AA contrast (stone-500 is 4.38:1 there).
              selected ? "bg-white text-stone-900 shadow-card" : "text-stone-600 hover:text-stone-900"
            )}
          >
            <span className={o.badge ? "shrink-0" : "truncate"}>{o.label}</span>
            {o.badge}
          </button>
        );
      })}
    </div>
  );
}
