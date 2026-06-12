"use client";

/**
 * Curated theme swatches plus a native color input — no color-picker
 * dependency. Used for text color, fills, borders, and solid backgrounds.
 */

import { cn } from "@/lib/cn";

export function ColorSwatchPicker({
  value,
  palette,
  onChange,
  allowClear,
  label,
}: {
  value: string | undefined;
  palette: string[];
  onChange: (color: string | undefined) => void;
  /** Offer a "default" swatch that clears the override. */
  allowClear?: boolean;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {allowClear && (
        <button
          type="button"
          title="Theme default"
          aria-label="Use theme default color"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onChange(undefined)}
          className={cn(
            "relative size-6 rounded-md border border-stone-200 bg-white",
            value === undefined && "ring-2 ring-brand-400 ring-offset-1"
          )}
        >
          <span className="absolute left-1/2 top-1/2 h-px w-3.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-rose-400" />
        </button>
      )}
      {palette.map((color) => (
        <button
          key={color}
          type="button"
          title={color}
          aria-label={`Color ${color}`}
          // keep focus (and a live text selection) where it is
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => onChange(color)}
          className={cn(
            "size-6 rounded-md border border-stone-200/70",
            value?.toLowerCase() === color.toLowerCase() &&
              "ring-2 ring-brand-400 ring-offset-1"
          )}
          style={{ backgroundColor: color }}
        />
      ))}
      <label
        className="relative size-6 cursor-pointer overflow-hidden rounded-md border border-stone-200"
        title="Custom color"
      >
        <span
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "conic-gradient(#f43f5e, #f59e0b, #10b981, #0ea5e9, #7c3aed, #f43f5e)",
          }}
        />
        <input
          type="color"
          value={value ?? "#404040"}
          aria-label={`${label}: custom color`}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}
