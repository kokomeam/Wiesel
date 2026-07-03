"use client";

/**
 * The "ready" experience: an embedded, presentation-like deck viewer — large
 * central slide, vertical thumbnail rail (horizontal on narrow screens),
 * prev/next + keyboard nav, page indicator, fullscreen, and a quiet actions menu
 * (replace / download original / remove). Pure custom image viewer: no browser
 * PDF chrome, no "open in new tab".
 */

import { useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { DECK_ACCEPT_ATTR } from "@/lib/course/imports/deckImportValidation";
import type { DeckImportPageView, DeckImportView } from "@/lib/course/imports/deckImportTypes";
import { useEscapeToClose } from "../QualityHintBadge";
import { ImportedDeckFullscreen } from "./ImportedDeckFullscreen";
import { ImportedDeckRail } from "./ImportedDeckRail";

export function ImportedDeckViewer({
  view,
  onReplace,
  onDownload,
  onRemove,
  onReloadUrls,
}: {
  view: DeckImportView;
  onReplace: (file: File) => void;
  onDownload: () => void;
  onRemove: () => void;
  onReloadUrls: () => void;
}) {
  const pages = view.pages;
  const [index, setIndex] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  useEscapeToClose(menuOpen, () => setMenuOpen(false));

  // Derive the valid active page (the deck may have shrunk after a replace);
  // `index` is only ever read through this clamp, so no sync effect is needed.
  const active = Math.min(index, Math.max(0, pages.length - 1));
  const go = (i: number) => setIndex(Math.max(0, Math.min(pages.length - 1, i)));

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      go(active + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      go(active - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(pages.length - 1);
    } else if (e.key.toLowerCase() === "f") {
      setFullscreen(true);
    }
  }

  if (pages.length === 0) {
    return (
      <div className="grid place-items-center rounded-xl border border-stone-200/80 bg-stone-50 px-6 py-10 text-center text-sm text-stone-500">
        This deck is ready, but no pages were found.
        <button onClick={onReloadUrls} className="mt-2 text-xs font-medium text-brand-600 hover:underline">
          Reload
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="group"
      aria-roledescription="carousel"
      aria-label={`${view.title} — ${pages.length} slides`}
      className="overflow-hidden rounded-xl border border-stone-200/80 bg-white outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
      data-ai-deck-status="ready"
    >
      <input
        ref={replaceInputRef}
        type="file"
        accept={DECK_ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onReplace(f);
          e.target.value = "";
        }}
      />

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 border-b border-stone-100 px-3.5 py-2.5">
        <span className="text-xs font-medium text-stone-500">
          Imported deck · <span className="tabular-nums text-stone-700">{pages.length}</span> slides
        </span>
        <div className="flex items-center gap-0.5">
          <ToolbarButton label="Fullscreen" onClick={() => setFullscreen(true)}>
            <Maximize2 className="size-4" />
          </ToolbarButton>
          <div className="relative">
            <ToolbarButton label="More actions" onClick={() => setMenuOpen((v) => !v)}>
              <MoreHorizontal className="size-4" />
            </ToolbarButton>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" aria-hidden onClick={() => setMenuOpen(false)} />
                <div
                  role="menu"
                  className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-xl border border-stone-200/80 bg-white p-1 shadow-lg"
                >
                <MenuItem
                  icon={Upload}
                  label="Replace file"
                  onClick={() => {
                    setMenuOpen(false);
                    replaceInputRef.current?.click();
                  }}
                />
                <MenuItem
                  icon={Download}
                  label="Download original"
                  onClick={() => {
                    setMenuOpen(false);
                    onDownload();
                  }}
                />
                <MenuItem
                  icon={Trash2}
                  label="Remove deck"
                  destructive
                  onClick={() => {
                    setMenuOpen(false);
                    onRemove();
                  }}
                />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Stage + rail */}
      <div className="flex flex-col gap-3 p-3.5 lg:flex-row">
        <div className="min-w-0 flex-1">
          <DeckStage page={pages[active]} index={active} total={pages.length} onPrev={() => go(active - 1)} onNext={() => go(active + 1)} onReloadUrls={onReloadUrls} />
          {/* Horizontal rail (narrow screens) */}
          <div className="mt-3 lg:hidden">
            <ImportedDeckRail pages={pages} activeIndex={active} onSelect={go} orientation="horizontal" />
          </div>
        </div>
        {/* Vertical rail (wide screens) */}
        <div className="hidden w-36 shrink-0 lg:block">
          <ImportedDeckRail pages={pages} activeIndex={active} onSelect={go} orientation="vertical" />
        </div>
      </div>

      {fullscreen && (
        <ImportedDeckFullscreen
          pages={pages}
          index={active}
          onIndex={go}
          onClose={() => setFullscreen(false)}
          title={view.title}
        />
      )}
    </div>
  );
}

function DeckStage({
  page,
  index,
  total,
  onPrev,
  onNext,
  onReloadUrls,
}: {
  page: DeckImportPageView;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onReloadUrls: () => void;
}) {
  const src = page?.imageUrl ?? page?.thumbnailUrl ?? null;
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(src ? "loading" : "error");

  // Reset load state when the page (or its signed URL) changes.
  const [lastSrc, setLastSrc] = useState(src);
  if (src !== lastSrc) {
    setLastSrc(src);
    setStatus(src ? "loading" : "error");
  }

  return (
    <div className="group relative aspect-video w-full overflow-hidden rounded-lg bg-stone-100 ring-1 ring-stone-200/60">
      {status === "loading" && <div className="absolute inset-0 animate-pulse bg-stone-200/60" />}

      {src && status !== "error" ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={src}
          alt={`Slide ${page.pageNumber}`}
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("error")}
          className={cn(
            "h-full w-full object-contain transition-opacity duration-200",
            status === "loaded" ? "opacity-100" : "opacity-0"
          )}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-center">
          <div className="space-y-1.5">
            <p className="text-xs text-stone-400">This page couldn&apos;t load.</p>
            <button
              onClick={onReloadUrls}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
            >
              <RefreshCw className="size-3" />
              Reload
            </button>
          </div>
        </div>
      )}

      {/* Prev / next */}
      <StageNav side="left" disabled={index === 0} onClick={onPrev} />
      <StageNav side="right" disabled={index === total - 1} onClick={onNext} />

      {/* Page indicator */}
      <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-stone-900/65 px-2.5 py-1 text-[11px] font-medium tabular-nums text-white">
        {index + 1} / {total}
      </span>
    </div>
  );
}

function StageNav({ side, disabled, onClick }: { side: "left" | "right"; disabled: boolean; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous slide" : "Next slide"}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "absolute top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-white/85 text-stone-700 opacity-0 shadow-sm ring-1 ring-stone-200/70 backdrop-blur transition-all hover:bg-white group-hover:opacity-100 focus-visible:opacity-100 disabled:!opacity-0",
        side === "left" ? "left-2" : "right-2"
      )}
    >
      <Icon className="size-5" />
    </button>
  );
}

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
    >
      {children}
    </button>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  destructive,
}: {
  icon: typeof Upload;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs font-medium transition-colors",
        destructive ? "text-rose-600 hover:bg-rose-50" : "text-stone-700 hover:bg-stone-50"
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}
