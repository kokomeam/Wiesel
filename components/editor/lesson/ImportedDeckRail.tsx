"use client";

/**
 * Thumbnail rail for the imported-deck viewer. Vertical alongside the stage on
 * wide screens, horizontal below it on narrow ones. Each thumb lazy-loads its
 * signed image and degrades to a numbered placeholder if the asset is missing.
 */

import { useState } from "react";
import { cn } from "@/lib/cn";
import type { DeckImportPageView } from "@/lib/course/imports/deckImportTypes";

export function ImportedDeckRail({
  pages,
  activeIndex,
  onSelect,
  orientation = "vertical",
}: {
  pages: DeckImportPageView[];
  activeIndex: number;
  onSelect: (index: number) => void;
  orientation?: "vertical" | "horizontal";
}) {
  const vertical = orientation === "vertical";
  return (
    <div
      role="tablist"
      aria-label="Slides"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      className={cn(
        "gap-2 scrollbar-thin",
        vertical
          ? "flex max-h-[420px] flex-col overflow-y-auto pr-1"
          : "flex overflow-x-auto pb-1"
      )}
    >
      {pages.map((page, i) => (
        <button
          key={page.pageNumber}
          role="tab"
          aria-selected={i === activeIndex}
          aria-label={`Slide ${page.pageNumber}`}
          onClick={() => onSelect(i)}
          className={cn(
            "group relative shrink-0 overflow-hidden rounded-md border bg-white transition-all",
            vertical ? "w-full" : "w-28",
            i === activeIndex
              ? "border-brand-400 ring-2 ring-brand-200/70"
              : "border-stone-200/80 hover:border-stone-300"
          )}
        >
          <span className="block aspect-video w-full">
            <DeckThumb page={page} />
          </span>
          <span
            className={cn(
              "absolute left-1 top-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
              i === activeIndex ? "bg-brand-500 text-white" : "bg-stone-900/55 text-white"
            )}
          >
            {page.pageNumber}
          </span>
        </button>
      ))}
    </div>
  );
}

function DeckThumb({ page }: { page: DeckImportPageView }) {
  const src = page.thumbnailUrl ?? page.imageUrl;
  const [state, setState] = useState<"loading" | "loaded" | "error">(src ? "loading" : "error");

  if (!src || state === "error") {
    return (
      <span className="grid h-full w-full place-items-center bg-stone-100 text-[10px] font-medium text-stone-400">
        {page.pageNumber}
      </span>
    );
  }
  return (
    <>
      {state === "loading" && <span className="absolute inset-0 animate-pulse bg-stone-100" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        loading="lazy"
        onLoad={() => setState("loaded")}
        onError={() => setState("error")}
        className={cn(
          "h-full w-full object-cover transition-opacity",
          state === "loaded" ? "opacity-100" : "opacity-0"
        )}
      />
    </>
  );
}
