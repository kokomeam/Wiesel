"use client";

/**
 * Borderless inline editors. Local draft while focused; exactly ONE commit
 * (→ one patch) on blur or Enter. Escape cancels. This keeps the patch log
 * readable and means human edits exercise the same patch path as AI edits
 * without per-keystroke noise.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

interface InlineTextProps {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  className?: string;
  "aria-label": string;
  disabled?: boolean;
}

export function InlineText({
  value,
  onCommit,
  placeholder,
  className,
  disabled,
  "aria-label": ariaLabel,
}: InlineTextProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);

  return (
    <input
      type="text"
      value={draft ?? value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      onFocus={() => {
        cancelled.current = false;
        setDraft(value);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (!cancelled.current && draft !== null && draft !== value) {
          onCommit(draft);
        }
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      className={cn(
        "w-full bg-transparent outline-none placeholder:text-stone-300",
        "rounded-md px-1 -mx-1 transition-colors",
        "hover:bg-stone-100/70 focus:bg-white focus:ring-2 focus:ring-brand-200",
        className
      )}
    />
  );
}

interface InlineTextAreaProps extends InlineTextProps {
  minRows?: number;
}

export function InlineTextArea({
  value,
  onCommit,
  placeholder,
  className,
  disabled,
  minRows = 1,
  "aria-label": ariaLabel,
}: InlineTextAreaProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  function autoGrow() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  // Size to content on mount and whenever the value changes from outside
  // (e.g. an AI patch rewrites the text), not just while typing.
  useEffect(autoGrow, [value, draft]);

  return (
    <textarea
      ref={ref}
      value={draft ?? value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      rows={minRows}
      onFocus={() => {
        cancelled.current = false;
        setDraft(value);
        autoGrow();
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        autoGrow();
      }}
      onBlur={() => {
        if (!cancelled.current && draft !== null && draft !== value) {
          onCommit(draft);
        }
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      className={cn(
        "block w-full resize-none bg-transparent outline-none placeholder:text-stone-300",
        "rounded-md px-1 -mx-1 transition-colors",
        "hover:bg-stone-100/70 focus:bg-white focus:ring-2 focus:ring-brand-200",
        className
      )}
    />
  );
}
