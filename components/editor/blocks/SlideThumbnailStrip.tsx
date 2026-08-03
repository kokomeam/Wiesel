"use client";

/**
 * Filmstrip of true mini-previews (the store-free SlideView — thumbnails
 * carry no per-element store subscriptions, so selection changes and drags
 * never re-render them; A5 §4). Selecting a thumbnail drives both the canvas
 * and the inspector. Hover exposes duplicate/delete; the strip itself can be
 * collapsed from SlideDeckEditor.
 *
 * PERF (A5 §1.1, §5): the strip is windowed horizontally (fixed 152 px pitch,
 * visible ± 2 via the shared useVirtualRows) so a long deck mounts ~a dozen
 * stages instead of all of them, and lint runs synchronously ONLY for the
 * active slide — off-screen thumbs aren't mounted at all and visible inactive
 * thumbs lint in an idle callback (cancelled on unmount), so a keystroke in
 * the active slide never pays a whole-deck lint pass.
 */

import { memo, useEffect, useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { aiAttrs } from "@/lib/course/aiAttributes";
import {
  addSlidePatch,
  deleteSlidePatch,
  duplicateSlidePatch,
} from "@/lib/course/commands";
import { lintSlide } from "@/lib/course/lint";
import { altTextFor, speakerNotesFor } from "@/lib/course/ai/templates";
import { useEditorStore } from "@/lib/course/store";
import { useVirtualRows } from "@/lib/perf/virtualRows";
import type { Slide } from "@/lib/course/types";
import { SlideView } from "../slide/SlideView";

/** Thumbnail pitch along the scroll axis: w-36 (144) + the pr-2 gap (8).
 *  useVirtualRows requires the gap INSIDE the item. */
const THUMB_PITCH_PX = 152;

/* The reducer deep-clones the whole doc per patch, so slide object identity
 * changes even for untouched slides — plain memo would never hit. Compare
 * structurally instead, caching the JSON per slide object (WeakMap) so each
 * snapshot is stringified at most once. Windowing bounds the cost: only the
 * ~visible slides are mounted, so a keystroke restringifies a dozen slides,
 * not the whole deck (A5 §5). */
const slideJsonCache = new WeakMap<Slide, string>();
function jsonOf(slide: Slide): string {
  let s = slideJsonCache.get(slide);
  if (s === undefined) {
    s = JSON.stringify(slide);
    slideJsonCache.set(slide, s);
  }
  return s;
}

/** requestIdleCallback with a setTimeout fallback (Safari). */
function scheduleIdle(cb: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(cb, { timeout: 500 });
    return () => cancelIdleCallback(id);
  }
  const id = window.setTimeout(cb, 120);
  return () => window.clearTimeout(id);
}

const Thumbnail = memo(
  function Thumbnail({
    slide,
    index,
    deckId,
    active,
    onSelect,
  }: {
    slide: Slide;
    index: number;
    deckId: string;
    active: boolean;
    onSelect: (slideId: string) => void;
  }) {
    const apply = useEditorStore((s) => s.apply);
    // Inactive thumbs lint off the interaction path; the ACTIVE slide lints
    // synchronously below so its badge is never a frame behind an edit.
    const [idleHints, setIdleHints] = useState(0);
    useEffect(() => {
      if (active) return;
      return scheduleIdle(() => {
        setIdleHints(
          lintSlide(slide, { blockId: deckId, speakerNotesFor, altTextFor }).length
        );
      });
    }, [slide, deckId, active]);
    const hintCount = active
      ? lintSlide(slide, { blockId: deckId, speakerNotesFor, altTextFor }).length
      : idleHints;
    return (
      <div className="group/thumb relative shrink-0 pr-2">
        <button
          type="button"
          {...aiAttrs({
            component: "slide-thumbnail",
            type: "slide",
            id: slide.id,
            parentId: deckId,
            order: index,
            label: `Slide ${index + 1}${slide.title ? `: ${slide.title}` : ""}`,
            interactive: true,
          })}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(slide.id);
          }}
          className={cn(
            "block w-36 overflow-hidden rounded-lg bg-white ring-1 transition-all",
            active ? "ring-2 ring-brand-400" : "ring-stone-200 hover:ring-stone-300"
          )}
        >
          <SlideView slide={slide} />
        </button>
        <span className="absolute bottom-1 left-1.5 rounded bg-white/85 px-1 text-[9px] font-medium text-stone-500">
          {index + 1}
        </span>
        {hintCount > 0 && (
          <span
            className="absolute right-3.5 top-1.5 size-1.5 rounded-full bg-amber-400"
            title={`${hintCount} quality suggestion${hintCount > 1 ? "s" : ""}`}
          />
        )}
        {/* centered on the 144px thumb (the root is 152px wide incl. the gap) */}
        <div className="absolute -top-1.5 left-[72px] z-10 flex -translate-x-1/2 gap-0.5 opacity-0 transition-opacity group-hover/thumb:opacity-100">
          <button
            type="button"
            title="Duplicate slide"
            aria-label={`Duplicate slide ${index + 1}`}
            onClick={(e) => {
              e.stopPropagation();
              apply(duplicateSlidePatch(deckId, slide), "human");
            }}
            className="grid size-5 place-items-center rounded-md border border-stone-200 bg-white text-stone-400 shadow-sm hover:text-brand-600"
          >
            <Copy className="size-2.5" />
          </button>
          <button
            type="button"
            title="Delete slide"
            aria-label={`Delete slide ${index + 1}`}
            onClick={(e) => {
              e.stopPropagation();
              apply(deleteSlidePatch(deckId, slide.id), "human");
            }}
            className="grid size-5 place-items-center rounded-md border border-stone-200 bg-white text-stone-400 shadow-sm hover:text-rose-600"
          >
            <Trash2 className="size-2.5" />
          </button>
        </div>
      </div>
    );
  },
  // onSelect is excluded on purpose: it closes only over stable ids/setters.
  (prev, next) =>
    prev.index === next.index &&
    prev.active === next.active &&
    prev.deckId === next.deckId &&
    (prev.slide === next.slide || jsonOf(prev.slide) === jsonOf(next.slide))
);

export function SlideThumbnailStrip({
  slides,
  deckId,
  activeId,
  onSelect,
}: {
  slides: Slide[];
  deckId: string;
  activeId: string | undefined;
  onSelect: (slideId: string) => void;
}) {
  const apply = useEditorStore((s) => s.apply);
  const themeId = slides[0]?.style.theme.id;
  const { containerRef, start, end, padStart, padEnd } = useVirtualRows({
    restoreId: `filmstrip:${deckId}`,
    count: slides.length,
    itemSize: THUMB_PITCH_PX,
    overscan: 2,
    horizontal: true,
    initialViewport: 800,
  });

  return (
    <div ref={containerRef} className="flex items-stretch overflow-x-auto p-1 scrollbar-thin">
      {padStart > 0 && <div aria-hidden className="shrink-0" style={{ width: padStart }} />}
      {slides.slice(start, end).map((slide, i) => (
        <Thumbnail
          key={slide.id}
          slide={slide}
          index={start + i}
          deckId={deckId}
          active={slide.id === activeId}
          onSelect={onSelect}
        />
      ))}
      {padEnd > 0 && <div aria-hidden className="shrink-0" style={{ width: padEnd }} />}
      <button
        type="button"
        aria-label="Add slide"
        data-ai-tool="add-slide"
        data-ai-action="ADD_SLIDE"
        data-ai-target-type="slide_deck"
        onClick={(e) => {
          e.stopPropagation();
          apply(addSlidePatch(deckId, "title_bullets", themeId), "human");
        }}
        className="grid aspect-video w-36 shrink-0 place-items-center self-center rounded-lg border border-dashed border-stone-300 text-stone-400 transition-colors hover:border-brand-300 hover:text-brand-600"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}
