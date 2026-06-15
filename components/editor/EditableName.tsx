"use client";

/**
 * Click-to-edit name field with a discoverability affordance: a faint pencil
 * sits next to the text on hover (and hides while editing), so it's obvious
 * the name is editable. The input auto-sizes to its content (a hidden sizer
 * in a 1×1 grid cell), so the pencil always hugs the text and there's no
 * layout jump between idle and focused.
 *
 * Same commit contract as InlineText: one local draft while focused, exactly
 * ONE onCommit (→ one patch) on blur or Enter, Escape cancels.
 *
 * `prefix` renders a non-editable label before the editable text — used for
 * the "Module N:" convention, where only the name after the colon is the
 * user's to change.
 */

import { useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/cn";

export function EditableName({
  value,
  onCommit,
  placeholder,
  prefix,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  /** Non-editable text shown before the editable name (e.g. "Module 1:"). */
  prefix?: string;
  /** Typography classes — applied to the prefix, sizer, and input alike so
   *  measurement and rendering stay pixel-identical. */
  className?: string;
  "aria-label": string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const cancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = draft ?? value;

  return (
    <span className="group/edit inline-flex max-w-full items-baseline gap-1.5">
      {prefix && (
        <span
          aria-hidden
          onMouseDown={(e) => {
            // clicking the prefix should still drop the caret into the name
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className={cn("shrink-0 cursor-text select-none", className)}
        >
          {prefix}
        </span>
      )}

      {/* auto-width: the invisible sizer sets the cell width, the input fills it */}
      <span className="relative inline-grid min-w-0 max-w-full items-baseline">
        <span
          aria-hidden
          className={cn(
            "invisible col-start-1 row-start-1 whitespace-pre pr-0.5",
            className
          )}
        >
          {shown || placeholder || " "}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={shown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          onFocus={() => {
            cancelled.current = false;
            setFocused(true);
            setDraft(value);
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (!cancelled.current && draft !== null && draft !== value) {
              onCommit(draft);
            }
            setDraft(null);
            setFocused(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
          className={cn(
            "col-start-1 row-start-1 min-w-0 rounded-md bg-transparent outline-none transition-colors",
            "placeholder:text-stone-300 hover:bg-stone-100/70 focus:bg-white focus:ring-2 focus:ring-brand-200",
            className
          )}
        />
      </span>

      <Pencil
        aria-hidden
        className={cn(
          "pointer-events-none size-[0.82em] shrink-0 self-center text-current transition-opacity duration-150",
          focused ? "opacity-0" : "opacity-0 group-hover/edit:opacity-40"
        )}
      />
    </span>
  );
}
