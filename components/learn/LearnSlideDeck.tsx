"use client";

/**
 * Student slide-deck player: the store-free SlideView (the same read-only
 * renderer filmstrip thumbnails use — no editing chrome, no editor stores or
 * patch/schema machinery in the bundle; PERF-1 D1) inside a keyboard/click
 * navigable frame. Every slide the learner lands on is reported (debounced)
 * so the "all slides viewed" completion rule can be computed server-side.
 *
 * M10: a low-friction per-slide reaction control (helpful / confusing) under
 * the deck. Each tap emits an APPEND-ONLY `slide_feedback` event through the
 * same batching SDK as everything else — the rollup takes the latest per
 * (user, slide), so the control reads as a toggle (state seeded server-side
 * from `my_slide_feedback`, then tracked locally). The optional note reveals
 * only on tap-to-elaborate and sends with the current reaction.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { reportSlideShown } from "@/lib/editor/recordingSlideSync";
import { ChevronLeft, ChevronRight, MessageSquarePlus, ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { SlideDwellTracker } from "@/lib/analytics/dwell";
import { FEEDBACK_COMMENT_MAX_CHARS } from "@/lib/analytics/eventConstants";
import type { SlideDeckBlock } from "@/lib/course/types";
import { planLookahead } from "@/lib/learn/lookahead";
import { SlideView } from "@/components/editor/slide/SlideView";
import { useAnalytics } from "./AnalyticsProvider";

/* ─────────────────── Slide-asset lookahead (PERF-1 C5) ─────────────────── */

/** URLs already handed to a warm chain this session — never re-request. */
const warmedUrls = new Set<string>();

/** navigator.connection is non-standard (absent in Safari/Firefox + TS DOM). */
interface ConnectionLike {
  saveData?: boolean;
  effectiveType?: string;
}

/** HARD GATE: never spend a constrained connection's bytes on lookahead. */
function connectionAllowsLookahead(): boolean {
  if (typeof navigator === "undefined") return false;
  const conn = (navigator as Navigator & { connection?: ConnectionLike }).connection;
  if (!conn) return true;
  if (conn.saveData) return false;
  return conn.effectiveType !== "2g" && conn.effectiveType !== "slow-2g";
}

function warmImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    // Cache warm only — must never compete with the visible slide's fetches.
    (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = "low";
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

/** Warm `urls` into the browser cache: session-deduped, max 2 in flight,
 *  each chain strictly sequential. No DOM insertion — new Image() only. */
function warmUrls(urls: string[]): void {
  const queue = urls.filter((url) => !warmedUrls.has(url));
  for (const url of queue) warmedUrls.add(url);
  const chain = async () => {
    // Both chains drain the ONE shared queue — each url fetched exactly once.
    for (let url = queue.shift(); url; url = queue.shift()) {
      await warmImage(url);
    }
  };
  const total = queue.length;
  if (total > 0) void chain();
  if (total > 1) void chain();
}

export type SlideReaction = "helpful" | "confusing";
export type SlideFeedbackMap = Record<string, { reaction: SlideReaction; comment?: string | null }>;

export function LearnSlideDeck({
  block,
  onSlidesViewed,
  onSlideChange,
  navRequest = null,
  feedbackEnabled = false,
  initialFeedback = {},
}: {
  block: SlideDeckBlock;
  /** Called with newly viewed slide ids (already deduped + debounced). */
  onSlidesViewed?: (slideIds: string[]) => void;
  /** TUTOR-1 W4: fired on every landed slide (id + index) — the tutor bus
   *  reads the ambient slide. Additive; unwired ⇒ no behavior change. */
  onSlideChange?: (slideId: string, index: number) => void;
  /** TUTOR-1 W4: a jump REQUEST (not a controlled index) — the tutor "cite"
   *  action bumps `nonce` to move the deck to `index`. Keyboard nav untouched. */
  navRequest?: { index: number; nonce: number } | null;
  /** true for enrolled students only — author previews get no control. */
  feedbackEnabled?: boolean;
  /** slideId → the learner's latest reaction (server-loaded). */
  initialFeedback?: SlideFeedbackMap;
}) {
  const slides = block.slides;
  const [index, setIndex] = useState(0);
  const slide = slides[index];
  // slideId → the learner's current reaction (seeded from the server, then
  // tracked locally so the control reads as a toggle).
  const [feedback, setFeedback] = useState<SlideFeedbackMap>(initialFeedback);

  // Visibility-aware dwell: one slide_viewed event per continuous view, with
  // hidden-tab time excluded (lib/analytics/dwell.ts). No-op outside a
  // student AnalyticsProvider.
  const { track } = useAnalytics();
  const trackRef = useRef(track);
  const onSlideChangeRef = useRef(onSlideChange);
  useEffect(() => {
    trackRef.current = track;
    onSlideChangeRef.current = onSlideChange;
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
    // M-R (D-2): while a same-tab studio recording is running, the visible
    // slide feeds the slide-sync capture (no-op outside a session).
    if (id) reportSlideShown(id);
    // TUTOR-1 W4: publish the landed slide to the tutor bus (additive).
    if (id) onSlideChangeRef.current?.(id, index);
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

  // Lookahead (C5): while the learner reads slide N, warm N+1/N+2's image
  // assets into the browser cache so an image slide never cold-fetches its
  // full-res PNG on advance. `feedbackEnabled` is the enrolled-student-only
  // signal (author previews get none) — the same preview split analytics uses.
  useEffect(() => {
    if (!feedbackEnabled || !connectionAllowsLookahead()) return;
    warmUrls(planLookahead(slides, index));
  }, [index, slides, feedbackEnabled]);

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

  // TUTOR-1 W4: a citation jump from the tutor sidebar. Applied via the
  // React-blessed "adjust state when a prop changes" pattern (setState during
  // render, not in an effect) so a repeat request to the same slide (new nonce)
  // still moves the deck without a cascading-render effect. The target is
  // clamped so a stale index (e.g. from a prior version) can't crash.
  const [appliedNavNonce, setAppliedNavNonce] = useState<number | null>(null);
  if (navRequest != null && navRequest.nonce !== appliedNavNonce) {
    setAppliedNavNonce(navRequest.nonce);
    setIndex(Math.max(0, Math.min(slides.length - 1, navRequest.index)));
  }

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
        <SlideView slide={slide} />
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

      {feedbackEnabled ? (
        <SlideFeedbackControl
          key={slide.id}
          blockId={block.id}
          slideId={slide.id}
          initial={feedback[slide.id] ?? null}
          onReact={(reaction, comment) => {
            setFeedback((prev) => ({ ...prev, [slide.id]: { reaction, comment } }));
            trackRef.current({
              eventType: "slide_feedback",
              blockId: block.id,
              slideId: slide.id,
              reaction,
              comment: comment ?? null,
            });
          }}
        />
      ) : null}
    </div>
  );
}

/* ─────────────────── Per-slide reaction control (M10) ──────────────────── */

function SlideFeedbackControl({
  blockId,
  slideId,
  initial,
  onReact,
}: {
  blockId: string;
  slideId: string;
  initial: { reaction: SlideReaction; comment?: string | null } | null;
  onReact: (reaction: SlideReaction, comment?: string | null) => void;
}) {
  const [reaction, setReaction] = useState<SlideReaction | null>(initial?.reaction ?? null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteSent, setNoteSent] = useState(false);

  function react(next: SlideReaction) {
    if (next === reaction) return; // already reflects state — nothing new to say
    setReaction(next);
    onReact(next);
  }

  function sendNote() {
    const trimmed = note.trim().slice(0, FEEDBACK_COMMENT_MAX_CHARS);
    if (!reaction || trimmed.length === 0) return;
    onReact(reaction, trimmed);
    setNoteSent(true);
    setNoteOpen(false);
    setNote("");
  }

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 text-xs text-stone-400"
      data-ai-id={`slide-feedback-${blockId}`}
    >
      <span>Was this slide helpful?</span>
      <button
        type="button"
        aria-label="Mark this slide helpful"
        aria-pressed={reaction === "helpful"}
        onClick={() => react("helpful")}
        data-ai-tool="slide-feedback-helpful"
        className={cn(
          "grid size-7 place-items-center rounded-full border transition-colors",
          reaction === "helpful"
            ? "border-emerald-300 bg-emerald-50 text-emerald-600"
            : "border-stone-200 bg-white text-stone-400 hover:border-emerald-200 hover:text-emerald-500"
        )}
      >
        <ThumbsUp className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Mark this slide confusing"
        aria-pressed={reaction === "confusing"}
        onClick={() => react("confusing")}
        data-ai-tool="slide-feedback-confusing"
        className={cn(
          "grid size-7 place-items-center rounded-full border transition-colors",
          reaction === "confusing"
            ? "border-rose-300 bg-rose-50 text-rose-600"
            : "border-stone-200 bg-white text-stone-400 hover:border-rose-200 hover:text-rose-500"
        )}
      >
        <ThumbsDown className="size-3.5" aria-hidden />
      </button>
      {/* The note field reveals only on tap-to-elaborate (and only once a
          reaction exists — a comment always rides a reaction). */}
      {reaction !== null && !noteOpen && !noteSent ? (
        <button
          type="button"
          onClick={() => setNoteOpen(true)}
          className="inline-flex items-center gap-1 font-medium text-stone-400 underline-offset-2 hover:text-stone-600 hover:underline"
          data-ai-tool="slide-feedback-note"
        >
          <MessageSquarePlus className="size-3.5" aria-hidden />
          Add a note
        </button>
      ) : null}
      {noteSent ? <span className="text-emerald-600">Noted — thanks!</span> : null}
      {noteOpen ? (
        <span className="flex w-full items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, FEEDBACK_COMMENT_MAX_CHARS))}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendNote();
            }}
            placeholder="What's unclear (or great) here?"
            aria-label={`Note about slide ${slideId}`}
            className="h-8 min-w-0 flex-1 rounded-full border border-stone-200 px-3 text-xs text-stone-700 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200/60"
          />
          <button
            type="button"
            onClick={sendNote}
            disabled={note.trim().length === 0}
            className="rounded-full border border-stone-200 bg-white px-3 py-1.5 font-medium text-stone-600 hover:bg-stone-50 disabled:opacity-40"
          >
            Send
          </button>
        </span>
      ) : null}
    </div>
  );
}
