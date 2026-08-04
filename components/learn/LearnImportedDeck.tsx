"use client";

/**
 * Student viewer for imported decks (PPT/PDF rendered to page images). Pages
 * arrive as short-lived signed URLs from /api/learn/deck/[id] — fetched
 * LAZILY on mount when no initial view is provided (PERF-1 C1: the signed
 * page URLs are OFF the lesson page's critical path); when they expire
 * mid-session an image error triggers a refetch through the same machinery.
 * Reaching the last page reports the deck as viewed (its completion signal —
 * binary, paged-to-the-end).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ImportedDeckBlock } from "@/lib/course/types";
import type { DeckImportView } from "@/lib/course/imports/deckImportTypes";
import { Skeleton } from "@/components/ui/Skeleton";

export function LearnImportedDeck({
  block,
  initialView,
  onDeckViewed,
  onPageChange,
}: {
  block: ImportedDeckBlock;
  initialView: DeckImportView | null;
  /** Fired once, when the learner reaches the final page. */
  onDeckViewed?: () => void;
  /** TUTOR-1 W4: fired on every landed page index (the tutor bus reads the
   *  ambient page). Additive; unwired ⇒ no behavior change. */
  onPageChange?: (index: number) => void;
}) {
  const [view, setView] = useState(initialView);
  const [loading, setLoading] = useState(initialView === null);
  const [index, setIndex] = useState(0);
  const viewedRef = useRef(false);
  const onPageChangeRef = useRef(onPageChange);
  useEffect(() => {
    onPageChangeRef.current = onPageChange;
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/learn/deck/${block.deckImportId}`);
      if (!res.ok) return;
      const body = (await res.json()) as { deck?: DeckImportView };
      if (body.deck) setView(body.deck);
    } catch {
      /* keep the stale view; the learner can retry by paging */
    }
  }, [block.deckImportId]);

  // Lazy initial load: the page no longer server-resolves signed URLs.
  // setState happens only inside the promise callbacks (react-hooks rule).
  useEffect(() => {
    if (initialView !== null) return;
    let cancelled = false;
    fetch(`/api/learn/deck/${block.deckImportId}`)
      .then(async (res) =>
        res.ok ? ((await res.json()) as { deck?: DeckImportView }) : null
      )
      .then((body) => {
        if (!cancelled && body?.deck) setView(body.deck);
      })
      .catch(() => {
        /* the unavailable state below explains; paging retries via refresh */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialView, block.deckImportId]);

  const pages = view?.pages ?? [];
  const page = pages[index];

  useEffect(() => {
    if (pages.length > 0 && index === pages.length - 1 && !viewedRef.current) {
      viewedRef.current = true;
      onDeckViewed?.();
    }
  }, [index, pages.length, onDeckViewed]);

  // TUTOR-1 W4: publish the landed page to the tutor bus (additive).
  useEffect(() => {
    onPageChangeRef.current?.(index);
  }, [index]);

  if (!view && loading) {
    return (
      <div
        role="status"
        aria-label="Loading deck"
        className="overflow-hidden rounded-xl border border-stone-200/80 bg-white"
      >
        <Skeleton className="aspect-video w-full rounded-none" />
      </div>
    );
  }

  if (!view || view.status !== "ready" || pages.length === 0) {
    return (
      <p className="rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-6 text-center text-sm text-stone-500">
        This deck isn&apos;t available right now.
      </p>
    );
  }

  const go = (delta: number) =>
    setIndex((i) => Math.max(0, Math.min(pages.length - 1, i + delta)));

  return (
    <div
      role="group"
      aria-label={block.title ? `Deck: ${block.title}` : block.originalFileName}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === " ") {
          event.preventDefault();
          go(1);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          go(-1);
        }
      }}
      className="rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
    >
      <button
        type="button"
        onClick={() => go(1)}
        aria-label="Next page"
        className="block w-full cursor-pointer overflow-hidden rounded-xl border border-stone-200/80 bg-white"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URLs; next/image can't cache these */}
        <img
          src={page?.imageUrl ?? page?.thumbnailUrl ?? ""}
          alt={`Page ${index + 1} of ${block.originalFileName}`}
          className="aspect-video w-full object-contain"
          onError={() => void refresh()}
        />
      </button>
      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={index === 0}
          aria-label="Previous page"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300/80 bg-white text-stone-600 hover:bg-stone-50 disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <div className="flex max-w-[60%] items-center gap-1.5 overflow-x-auto" aria-hidden>
          {pages.map((p, i) => (
            <button
              key={p.pageNumber}
              type="button"
              tabIndex={-1}
              onClick={() => setIndex(i)}
              className={cn(
                "h-1.5 shrink-0 rounded-full transition-all",
                i === index ? "w-6 bg-brand-500" : "w-1.5 bg-stone-300 hover:bg-stone-400"
              )}
            />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs tabular-nums text-stone-400">
            {index + 1} / {pages.length}
          </span>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={index === pages.length - 1}
            aria-label="Next page"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-300/80 bg-white text-stone-600 hover:bg-stone-50 disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
