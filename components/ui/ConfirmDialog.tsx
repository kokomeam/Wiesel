"use client";

/**
 * A small, accessible confirmation modal — the single gate in front of every
 * destructive action (deleting a module or a lesson), used by BOTH the manual
 * delete affordances (via the confirm store) and the agent's pause-to-confirm
 * flow. Portal + overlay; Escape / overlay-click / Cancel all dismiss; focus
 * lands on the SAFE button (Cancel) so a stray Enter never deletes anything.
 *
 * Enter/exit are CSS transitions (@starting-style via Tailwind's `starting:`
 * variant + a delayed unmount for the exit) instead of framer-motion — this
 * component mounts in the (app) layout, and the dep was riding into every
 * route's bundle for one fade (PERF-1 §A4). The globals.css reduced-motion
 * guard zeroes the transition durations, so `prefers-reduced-motion` still
 * collapses both phases to instant.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";

/** Exit-transition length — keep in sync with the duration-* classes below. */
const EXIT_MS = 200;

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body copy — string or rich node. */
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" paints the confirm button red (the default for deletes). */
  tone?: "danger" | "default";
  /** Disables the buttons while the action is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Stay mounted through the exit transition (the AnimatePresence replacement):
  // opening mounts immediately (derived state during render — no effect); an
  // effect schedules the unmount after the close fade finishes.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open || !mounted) return;
    const t = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  // Esc dismisses; focus the safe (Cancel) button when the dialog opens.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => cancelRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open, busy, onCancel]);

  if (typeof document === "undefined" || !mounted) return null;

  return createPortal(
    <div
      data-state={open ? "open" : "closed"}
      className={cn(
        "fixed inset-0 z-[100] grid place-items-center p-4 transition-opacity duration-150 ease-out",
        // While the exit fade plays the dialog is still mounted — make sure the
        // invisible overlay can't swallow clicks.
        open ? "opacity-100 starting:opacity-0" : "pointer-events-none opacity-0"
      )}
      role="presentation"
    >
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={() => !busy && onCancel()}
        className="absolute inset-0 cursor-default bg-stone-900/40 backdrop-blur-[2px]"
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-state={open ? "open" : "closed"}
        className={cn(
          "relative w-full max-w-sm rounded-card border border-stone-200/80 bg-white p-5 shadow-overlay",
          "transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
          open
            ? "translate-y-0 scale-100 opacity-100 starting:translate-y-2 starting:scale-95 starting:opacity-0"
            : "translate-y-1.5 scale-[0.97] opacity-0"
        )}
      >
        <div className="flex gap-3.5">
          <span
            className={cn(
              "grid size-9 shrink-0 place-items-center rounded-panel",
              tone === "danger" ? "bg-rose-50 text-rose-600" : "bg-stone-100 text-stone-600"
            )}
          >
            <AlertTriangle className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
            <div className="mt-1 text-secondary text-stone-500">{message}</div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-full px-4 py-2 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold text-white shadow-sm transition-colors disabled:opacity-50",
              tone === "danger"
                ? "bg-rose-600 hover:bg-rose-700 shadow-rose-600/25"
                : "bg-stone-900 hover:bg-stone-800"
            )}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
