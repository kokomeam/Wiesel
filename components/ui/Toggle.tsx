"use client";

import { cn } from "@/lib/cn";

/**
 * An accessible switch (role="switch") for on/off settings — replaces bare
 * checkboxes where the semantics are enable/disable rather than multi-select.
 */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  className,
  "data-testid": testId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 ease-out-brand",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-1",
        checked ? "bg-brand-600" : "bg-stone-300",
        disabled && "opacity-50",
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-4 transform rounded-full bg-white shadow-card transition-transform duration-150 ease-out-brand",
          checked ? "translate-x-4.5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}
