"use client";

/**
 * Filmstrip of true mini-previews (SlideStage in thumbnail mode). Selecting
 * a thumbnail drives both the canvas and the inspector. Hover exposes
 * duplicate/delete; the strip itself can be collapsed from SlideDeckEditor.
 */

import { memo } from "react";
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
import type { Slide } from "@/lib/course/types";
import { SlideStage } from "../slide/SlideStage";

/* The reducer deep-clones the whole doc per patch, so slide object identity
 * changes even for untouched slides — plain memo would never hit. Compare
 * structurally instead, caching the JSON per slide object (WeakMap) so each
 * snapshot is stringified at most once. Skipping a thumbnail re-render also
 * skips its lintSlide pass. */
const slideJsonCache = new WeakMap<Slide, string>();
function jsonOf(slide: Slide): string {
  let s = slideJsonCache.get(slide);
  if (s === undefined) {
    s = JSON.stringify(slide);
    slideJsonCache.set(slide, s);
  }
  return s;
}

const Thumbnail = memo(
  function Thumbnail({
    slide,
    index,
    deckId,
    lessonId,
    active,
    onSelect,
  }: {
    slide: Slide;
    index: number;
    deckId: string;
    lessonId: string;
    active: boolean;
    onSelect: (slideId: string) => void;
  }) {
    const apply = useEditorStore((s) => s.apply);
    const hintCount = lintSlide(slide, {
      blockId: deckId,
      speakerNotesFor,
      altTextFor,
    }).length;
    return (
      <div className="group/thumb relative shrink-0">
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
          <SlideStage slide={slide} blockId={deckId} lessonId={lessonId} mode="thumbnail" />
        </button>
        <span className="absolute bottom-1 left-1.5 rounded bg-white/85 px-1 text-[9px] font-medium text-stone-500">
          {index + 1}
        </span>
        {hintCount > 0 && (
          <span
            className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-amber-400"
            title={`${hintCount} quality suggestion${hintCount > 1 ? "s" : ""}`}
          />
        )}
        <div className="absolute -top-1.5 right-1/2 z-10 flex translate-x-1/2 gap-0.5 opacity-0 transition-opacity group-hover/thumb:opacity-100">
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
    prev.lessonId === next.lessonId &&
    (prev.slide === next.slide || jsonOf(prev.slide) === jsonOf(next.slide))
);

export function SlideThumbnailStrip({
  slides,
  deckId,
  lessonId,
  activeId,
  onSelect,
}: {
  slides: Slide[];
  deckId: string;
  lessonId: string;
  activeId: string | undefined;
  onSelect: (slideId: string) => void;
}) {
  const apply = useEditorStore((s) => s.apply);
  const themeId = slides[0]?.style.theme.id;

  return (
    <div className="flex items-stretch gap-2 overflow-x-auto p-1 scrollbar-thin">
      {slides.map((slide, i) => (
        <Thumbnail
          key={slide.id}
          slide={slide}
          index={i}
          deckId={deckId}
          lessonId={lessonId}
          active={slide.id === activeId}
          onSelect={onSelect}
        />
      ))}
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
