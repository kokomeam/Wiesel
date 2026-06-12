"use client";

/**
 * Slide deck block: filmstrip (collapsible), toolbar, the active slide's
 * stage, and the speaker-notes well.
 */

import { useState } from "react";
import { ChevronRight, StickyNote } from "lucide-react";
import { cn } from "@/lib/cn";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { updateSpeakerNotesPatch } from "@/lib/course/commands";
import { lintSlide } from "@/lib/course/lint";
import { altTextFor, speakerNotesFor } from "@/lib/course/ai/templates";
import { useEditorStore } from "@/lib/course/store";
import { useUIStore } from "@/lib/editor/uiStore";
import type { SlideDeckBlock } from "@/lib/course/types";
import { InlineTextArea } from "../InlineText";
import { QualityHintBadge } from "../QualityHintBadge";
import { SlideStage } from "../slide/SlideStage";
import { SlideToolbar } from "../slide/SlideToolbar";
import { SlideThumbnailStrip } from "./SlideThumbnailStrip";

export function SlideDeckEditor({
  block,
  lessonId,
}: {
  block: SlideDeckBlock;
  lessonId: string;
}) {
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const apply = useEditorStore((s) => s.apply);
  const filmstripCollapsed = useUIStore((s) => s.collapsed.filmstrip);
  const toggleFilmstrip = useUIStore((s) => s.togglePanel);
  const [localActiveId, setLocalActiveId] = useState(block.slides[0]?.id);

  const selectionSlideId =
    selection.kind === "slide" && selection.blockId === block.id
      ? selection.id
      : selection.kind === "element" && selection.blockId === block.id
        ? selection.slideId
        : undefined;
  const activeId = selectionSlideId ?? localActiveId;
  const activeSlide = block.slides.find((s) => s.id === activeId) ?? block.slides[0];
  const activeIndex = activeSlide
    ? block.slides.findIndex((s) => s.id === activeSlide.id)
    : -1;

  function selectSlide(slideId: string) {
    setLocalActiveId(slideId);
    select({ kind: "slide", id: slideId, blockId: block.id, lessonId });
  }

  const activeHints = activeSlide
    ? lintSlide(activeSlide, { blockId: block.id, speakerNotesFor, altTextFor })
    : [];

  return (
    <div className="space-y-3">
      {filmstripCollapsed ? (
        <button
          type="button"
          {...toolAttrs({
            tool: "expand-filmstrip",
            action: "TOGGLE_PANEL",
            targetType: "panel",
            label: `Show slide filmstrip (${block.slides.length} slides)`,
          })}
          onClick={() => toggleFilmstrip("filmstrip")}
          className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-200 hover:text-stone-800"
        >
          <ChevronRight className="size-3" />
          Slides ({block.slides.length})
          {activeIndex >= 0 && (
            <span className="text-stone-400">· {activeIndex + 1} selected</span>
          )}
        </button>
      ) : (
        <div>
          <SlideThumbnailStrip
            slides={block.slides}
            deckId={block.id}
            lessonId={lessonId}
            activeId={activeSlide?.id}
            onSelect={selectSlide}
          />
          <button
            type="button"
            {...toolAttrs({
              tool: "collapse-filmstrip",
              action: "TOGGLE_PANEL",
              targetType: "panel",
              label: "Hide slide filmstrip",
            })}
            onClick={() => toggleFilmstrip("filmstrip")}
            className="mt-0.5 text-[11px] font-medium text-stone-300 transition-colors hover:text-stone-500"
          >
            Hide slides
          </button>
        </div>
      )}

      {activeSlide ? (
        <>
          <SlideToolbar block={block} slide={activeSlide} lessonId={lessonId} />
          <div className="relative">
            <QualityHintBadge
              hints={activeHints}
              className="absolute right-2 top-2 z-20"
            />
            <SlideStage
              slide={activeSlide}
              blockId={block.id}
              lessonId={lessonId}
              mode="edit"
            />
          </div>
          <div className="flex items-start gap-2 rounded-xl bg-stone-50 px-3 py-2.5">
            <StickyNote className="mt-0.5 size-3.5 shrink-0 text-stone-400" />
            <InlineTextArea
              value={activeSlide.speakerNotes ?? ""}
              aria-label="Speaker notes"
              placeholder="Speaker notes — what will you say on this slide?"
              onCommit={(speakerNotes) =>
                apply(
                  updateSpeakerNotesPatch(block.id, activeSlide.id, speakerNotes),
                  "human"
                )
              }
              className="text-xs text-stone-500"
            />
          </div>
        </>
      ) : (
        <div
          className={cn(
            "grid aspect-video place-items-center rounded-xl bg-stone-50 text-sm text-stone-400"
          )}
        >
          No slides yet — add one above.
        </div>
      )}
    </div>
  );
}
