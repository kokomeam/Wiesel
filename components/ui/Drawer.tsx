"use client";

/**
 * A right-hand slide-over drawer — the container for settings surfaces that
 * outgrew inline cards (UI-1 W4.1). Portal + overlay; focus is trapped while
 * open, Escape closes, and focus returns to the opener on close. Registers
 * itself with the overlay store so the agent FAB vacates. Below `sm` it
 * becomes a full-screen sheet.
 *
 * Closing always goes through `onClose` — parents may intercept (e.g. a
 * dirty-state discard guard) by deciding there whether to actually close.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/ease";
import { useOverlayStore } from "@/lib/ui/overlayStore";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  side = "right",
  className,
  "data-testid": testId,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  /** Rendered pinned below the scrollable body (e.g. a StickyActionBar). */
  footer?: React.ReactNode;
  side?: "right" | "left";
  className?: string;
  "data-testid"?: string;
}) {
  const reduce = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const acquire = useOverlayStore((s) => s.acquire);
  const release = useOverlayStore((s) => s.release);

  // Latest-ref for onClose: parents pass inline closures, and the lifecycle
  // effect below must depend ONLY on `open` — re-running it on every parent
  // render would tear down + re-run the focus capture, teleporting focus to
  // the panel mid-interaction (found by the keyboard walkthrough).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Overlay refcount + Escape + focus capture/restore — once per open.
  useEffect(() => {
    if (!open) return;
    acquire();
    openerRef.current = (document.activeElement as HTMLElement) ?? null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
      release();
      openerRef.current?.focus?.();
    };
  }, [open, acquire, release]);

  // Tab cycling stays inside the panel.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50"
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
            onClick={onClose}
            className="absolute inset-0 cursor-default bg-stone-900/25"
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === "string" ? title : undefined}
            tabIndex={-1}
            onKeyDown={trapTab}
            data-testid={testId}
            initial={reduce ? { opacity: 0 } : { x: side === "right" ? 32 : -32, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { x: side === "right" ? 32 : -32, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.2, ease: EASE }}
            className={cn(
              "absolute inset-0 flex flex-col overflow-hidden bg-white outline-none",
              "sm:inset-y-4 sm:w-120 sm:max-w-[calc(100vw-2rem)] sm:rounded-card sm:border sm:border-stone-200/80 sm:shadow-overlay",
              side === "right" ? "sm:left-auto sm:right-4" : "sm:left-4 sm:right-auto",
              className
            )}
          >
            <div className="flex items-center gap-2.5 border-b border-stone-200/80 px-card-pad py-3.5">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-title font-semibold text-stone-900">{title}</h2>
                {subtitle ? <p className="mt-0.5 truncate text-meta text-stone-500">{subtitle}</p> : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="grid size-8 shrink-0 place-items-center rounded-control text-stone-500 transition-colors hover:bg-stone-900/[0.06] hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-card-pad py-4">{children}</div>
            {footer}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
