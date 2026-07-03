"use client";

/**
 * Distraction-free, presentation-like fullscreen for an imported deck. Dark
 * stage, the current page centered + contained, minimal overlay controls, and
 * full keyboard nav (←/→/Home/End to move, Esc to exit).
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DeckImportPageView } from "@/lib/course/imports/deckImportTypes";

export function ImportedDeckFullscreen({
  pages,
  index,
  onIndex,
  onClose,
  title,
}: {
  pages: DeckImportPageView[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  title?: string;
}) {
  const clamp = (i: number) => Math.max(0, Math.min(pages.length - 1, i));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        onIndex(clamp(index + 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        onIndex(clamp(index - 1));
      } else if (e.key === "Home") onIndex(0);
      else if (e.key === "End") onIndex(pages.length - 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, pages.length, onIndex, onClose]);

  const page = pages[index];
  const src = page?.imageUrl ?? page?.thumbnailUrl ?? null;

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex flex-col bg-stone-950/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title ? `${title} — fullscreen` : "Slide deck — fullscreen"}
    >
      <header className="flex items-center justify-between px-5 py-3 text-stone-300">
        <span className="truncate text-sm font-medium">{title ?? "Slide deck"}</span>
        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums text-stone-400">
            {index + 1} / {pages.length}
          </span>
          <button
            type="button"
            aria-label="Exit fullscreen"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-stone-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="size-5" />
          </button>
        </div>
      </header>

      <div className="relative flex flex-1 items-center justify-center px-4 pb-6 sm:px-16">
        {src ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={src}
            alt={`Slide ${page?.pageNumber ?? index + 1}`}
            className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
          />
        ) : (
          <div className="grid aspect-video w-full max-w-3xl place-items-center rounded-md bg-stone-900 text-sm text-stone-500">
            This page isn&apos;t available.
          </div>
        )}

        <NavButton side="left" disabled={index === 0} onClick={() => onIndex(clamp(index - 1))} />
        <NavButton side="right" disabled={index === pages.length - 1} onClick={() => onIndex(clamp(index + 1))} />
      </div>
    </div>,
    document.body
  );
}

function NavButton({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous slide" : "Next slide"}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white backdrop-blur transition-all hover:bg-white/20 disabled:opacity-0",
        side === "left" ? "left-3 sm:left-5" : "right-3 sm:right-5"
      )}
    >
      <Icon className="size-6" />
    </button>
  );
}
