"use client";

/**
 * Small assessment form controls shared by the quiz/homework builders.
 * Number fields commit once on blur/Enter (one patch), matching InlineText.
 * All clickable controls stopPropagation so they don't re-select the block
 * via BlockFrame's onClick.
 */

import { useState } from "react";
import { cn } from "@/lib/cn";

export function NumberField({
  value,
  onCommit,
  placeholder,
  min = 0,
  suffix,
  className,
  "aria-label": ariaLabel,
}: {
  value: number | null | undefined;
  onCommit: (value: number | null) => void;
  placeholder?: string;
  min?: number;
  suffix?: string;
  className?: string;
  "aria-label": string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value == null ? "" : String(value));

  function commit() {
    if (draft === null) return;
    const trimmed = draft.trim();
    if (trimmed === "") onCommit(null);
    else {
      const n = Number(trimmed);
      if (Number.isFinite(n)) onCommit(Math.max(min, n));
    }
    setDraft(null);
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2 py-1 focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-200/60",
        className
      )}
    >
      <input
        type="number"
        inputMode="numeric"
        min={min}
        value={shown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onClick={(e) => e.stopPropagation()}
        onFocus={() => setDraft(shown)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
        className="w-12 bg-transparent text-xs text-stone-800 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      {suffix && <span className="text-[11px] text-stone-400">{suffix}</span>}
    </span>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-lg bg-stone-100 p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={(e) => {
            e.stopPropagation();
            onChange(o.value);
          }}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === o.value
              ? "bg-white text-stone-800 shadow-sm"
              : "text-stone-500 hover:text-stone-700"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        "relative h-4 w-7 shrink-0 rounded-full transition-colors",
        checked ? "bg-brand-500" : "bg-stone-300"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-3.5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}
