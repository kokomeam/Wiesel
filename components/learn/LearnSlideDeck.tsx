"use client";

/**
 * Student slide-deck player: the editor's SlideStage in its read-only
 * `mode="thumbnail"` (the same path filmstrip thumbnails use — no editing
 * chrome, no store writes) inside a keyboard/click navigable frame.
 * Every slide the learner lands on is reported (debounced) so the
 * "all slides viewed" completion rule can be computed server-side.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { SlideDwellTracker } from "@/lib/analytics/dwell";
import type { SlideDeckBlock } from "@/lib/course/types";
import { SlideStage } from "@/components/editor/slide/SlideStage";
import { useAnalytics } from "./AnalyticsProvider";

export function LearnSlideDeck({
  block,
  lessonId,
  onSlidesViewed,
}: {
  block: SlideDeckBlock;
  lessonId: string;
  /** Called with newly viewed slide ids (already deduped + debounced). */
  onSlidesViewed?: (slideIds: string[]) => void;
}) {
  const slides = block.slides;
  const [index, setIndex] = useState(0);
  const slide = slides[index];

  // Visibility-aware dwell: one slide_viewed event per continuous view, with
  // hidden-tab time excluded (lib/analytics/dwell.ts). No-op outside a
  // student AnalyticsProvider.
  const { track } = useAnalytics();
  const trackRef = useRef(track);
  useEffect(() => {
    trackRef.current = track;
  });
  const [dwell] = useState(
    () =>
      new SlideDwellTracker({
        now: () => Date.now(),
        isVisible: () =>
          typeof document === "undefined" || document.visibilityState === "visible",
      })
  );
  useEffect(() => {
    const prev = dwell.end();
    if (prev && prev.dwellMs > 0) {
      trackRef.current({
        eventType: "slide_viewed",
        blockId: block.id,
        slideId: prev.slideId,
        dwellMs: prev.dwellMs,
      });
    }
    const id = slides[index]?.id;
    if (id) dwell.start(id);
  }, [index, slides, block.id, dwell]);
  useEffect(() => {
    const onVisibility = () => dwell.handleVisibilityChange();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      // Unmount: the slide currently on screen gets its dwell too.
      const last = dwell.end();
      if (last && last.dwellMs > 0) {
        trackRef.current({
          eventType: "slide_viewed",
          blockId: block.id,
          slideId: last.slideId,
          dwellMs: last.dwellMs,
        });
      }
    };
  }, [dwell, block.id]);

  // Report viewed slides, debounced, only ids not yet reported.
  const reportedRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    timerRef.current = null;
    const batch = [...pendingRef.current];
    pendingRef.current = new Set();
    if (batch.length > 0) onSlidesViewed?.(batch);
  }, [onSlidesViewed]);

  useEffect(() => {
    const id = slides[index]?.id;
    if (!id || reportedRef.current.has(id)) return;
    reportedRef.current.add(id);
    pendingRef.current.add(id);
    if (timerRef.current) clearTimeout(timerRef.current);
    // Last slide flushes immediately so "deck done" lands without waiting.
    timerRef.current = setTimeout(flush, index === slides.length - 1 ? 0 : 1200);
  }, [index, slides, flush]);

  // Unmount-only: whatever is still pending goes out before the lesson closes.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => Math.max(0, Math.min(slides.length - 1, i + delta)));
    },
    [slides.length]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === " " || event.key === "PageDown") {
        event.preventDefault();
        go(1);
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        go(-1);
      }
    },
    [go]
  );

  if (slides.length === 0 || !slide) return null;

  return (
    <div
      role="group"
      aria-label={block.title ? `Slides: ${block.title}` : "Slides"}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 rounded-2xl"
    >
      <button
        type="button"
        onClick={() => go(1)}
        aria-label="Next slide"
        className="block w-full cursor-pointer overflow-hidden rounded-xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
      >
        <SlideStage slide={slide} blockId={block.id} lessonId={lessonId} mode="thumbnail" />
      </button>

      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={index === 0}
          aria-label="Previous slide"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300/80 bg-white text-stone-600 hover:bg-stone-50 disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>

        <div className="flex items-center gap-1.5" aria-hidden>
          {slides.map((s, i) => (
            <button
              key={s.id}
              type="button"
              tabIndex={-1}
              onClick={() => setIndex(i)}
              className={cn(
                "h-1.5 rounded-full transition-all",
                i === index ? "w-6 bg-brand-500" : "w-1.5 bg-stone-300 hover:bg-stone-400"
              )}
            />
          ))}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums text-stone-400">
            {index + 1} / {slides.length}
          </span>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={index === slides.length - 1}
            aria-label="Next slide"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300/80 bg-white text-stone-600 hover:bg-stone-50 disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
