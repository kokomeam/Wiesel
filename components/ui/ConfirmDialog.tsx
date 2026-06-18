"use client";

/**
 * A small, accessible confirmation modal — the single gate in front of every
 * destructive action (deleting a module or a lesson), used by BOTH the manual
 * delete affordances (via the confirm store) and the agent's pause-to-confirm
 * flow. Portal + overlay; Escape / overlay-click / Cancel all dismiss; focus
 * lands on the SAFE button (Cancel) so a stray Enter never deletes anything.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/ease";

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
  const reduce = useReducedMotion();
  const cancelRef = useRef<HTMLButtonElement>(null);

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

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] grid place-items-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.15 }}
          role="presentation"
        >
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => !busy && onCancel()}
            className="absolute inset-0 cursor-default bg-stone-900/40 backdrop-blur-[2px]"
          />
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-label={title}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
            transition={{ duration: reduce ? 0 : 0.18, ease: EASE }}
            className="relative w-full max-w-sm rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_20px_60px_rgba(28,25,23,0.22)]"
          >
            <div className="flex gap-3.5">
              <span
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-xl",
                  tone === "danger" ? "bg-rose-50 text-rose-600" : "bg-stone-100 text-stone-600"
                )}
              >
                <AlertTriangle className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
                <div className="mt-1 text-[13px] leading-relaxed text-stone-500">{message}</div>
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
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
