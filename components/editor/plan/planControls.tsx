"use client";

/**
 * Form controls for the Plan page. Text inputs hold a local draft and commit
 * once on blur/Enter (one patch), mirroring the editor's InlineText/NumberField
 * pattern. AddMoreList is the Udemy "add another response" array editor — only
 * non-empty entries are persisted.
 */

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";

const inputBase =
  "w-full rounded-xl border border-stone-200 bg-white px-3.5 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 outline-none transition-colors focus:border-brand-300 focus:ring-2 focus:ring-brand-200/60";

export function PlanTextField({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  maxLength,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  maxLength?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;

  function commit() {
    if (draft === null) return;
    const trimmed = draft.trim();
    if (trimmed !== value) onCommit(trimmed);
    setDraft(null);
  }

  return (
    <input
      type="text"
      value={shown}
      placeholder={placeholder}
      aria-label={ariaLabel}
      maxLength={maxLength}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      className={inputBase}
    />
  );
}

export function PlanTextArea({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  rows = 3,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;

  function commit() {
    if (draft === null) return;
    const trimmed = draft.trim();
    if (trimmed !== value) onCommit(trimmed);
    setDraft(null);
  }

  return (
    <textarea
      rows={rows}
      value={shown}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      className={cn(inputBase, "resize-y leading-relaxed")}
    />
  );
}

export function AddMoreList({
  items,
  onChange,
  placeholder,
  addLabel,
  ariaPrefix,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  addLabel: string;
  ariaPrefix: string;
}) {
  // Local working rows let a freshly-added blank row exist before it's filled;
  // only non-empty entries are persisted to the doc. Remounting (navigating
  // away and back) re-seeds from the persisted items.
  const [rows, setRows] = useState<string[]>(() => (items.length ? items : [""]));

  function persist(next: string[]) {
    setRows(next.length ? next : [""]);
    onChange(next.map((s) => s.trim()).filter(Boolean));
  }

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <PlanTextField
            value={row}
            ariaLabel={`${ariaPrefix} ${i + 1}`}
            placeholder={placeholder}
            onCommit={(v) => persist(rows.map((r, j) => (j === i ? v : r)))}
          />
          {rows.length > 1 && (
            <button
              type="button"
              aria-label={`Remove ${ariaPrefix.toLowerCase()} ${i + 1}`}
              onClick={() => persist(rows.filter((_, j) => j !== i))}
              className="grid size-9 shrink-0 place-items-center rounded-lg text-stone-300 transition-colors hover:bg-rose-50 hover:text-rose-600"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => setRows((r) => [...r, ""])}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-700 transition-colors hover:text-brand-800"
      >
        <Plus className="size-3.5" />
        {addLabel}
      </button>
    </div>
  );
}
