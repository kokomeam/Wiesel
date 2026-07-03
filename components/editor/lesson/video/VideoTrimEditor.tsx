"use client";

/**
 * Non-destructive trim editor, Apple-Photos style: a filmstrip of thumbnails with
 * a double-ended selection frame you drag to set start/end. Dragging a handle
 * seeks the preview to that exact frame, so you SEE what you're starting/ending on
 * ("preview of how it's being spliced"). Never mutates the video — it only reports
 * trimStartSeconds/trimEndSeconds (undefined at a natural edge) via `onChange`, and
 * only on release (so a drag is one autosave/undo step, not one per pixel).
 *
 * Thumbnails: for a Mux-hosted asset the parent passes `thumbnailAt` (the image
 * API); for a local (pre-upload) clip we capture frames from the video via canvas.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/video/recorderConfig";
import { MIN_TRIM_DURATION_SECONDS, validateTrim } from "@/lib/video/videoStatus";

const FRAME_COUNT = 10;
const round = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

type DragMode = "start" | "end" | "region" | null;

export function VideoTrimEditor({
  src,
  poster,
  durationSeconds,
  trimStart,
  trimEnd,
  onChange,
  thumbnailAt,
}: {
  src: string | null;
  poster?: string | null;
  durationSeconds: number;
  trimStart?: number;
  trimEnd?: number;
  onChange: (start: number | undefined, end: number | undefined) => void;
  /** Build a thumbnail URL for a given time (Mux image API). Absent ⇒ capture
   *  frames from the local <video> via canvas. Memoize it in the parent. */
  thumbnailAt?: (timeSeconds: number) => string;
}) {
  const dur = Math.max(MIN_TRIM_DURATION_SECONDS, durationSeconds || 0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  const [sel, setSel] = useState<{ start: number; end: number }>({
    start: trimStart ?? 0,
    end: trimEnd ?? dur,
  });
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(sel.start);

  // Refs mirror the latest values so the window-level pointer handlers (bound once)
  // never read stale closures. Synced in an effect (React 19 forbids writing refs
  // during render); the pointer handlers only read them asynchronously (in events),
  // by which point the effect has run.
  const selRef = useRef(sel);
  const durRef = useRef(dur);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    selRef.current = sel;
    durRef.current = dur;
    onChangeRef.current = onChange;
  });
  const dragRef = useRef<{ mode: DragMode; grab: number }>({ mode: null, grab: 0 });

  const commit = useCallback((start: number, end: number) => {
    const d = durRef.current;
    onChangeRef.current(start <= 0.01 ? undefined : round(start), end >= d - 0.01 ? undefined : round(end));
  }, []);

  const seekPreview = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(t)) return;
    try {
      v.currentTime = clamp(t, 0, durRef.current);
    } catch {
      /* not seekable yet */
    }
  }, []);

  const timeFromClientX = useCallback((clientX: number) => {
    const el = stripRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const frac = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return clamp(frac, 0, 1) * durRef.current;
  }, []);

  /* ── one set of window pointer handlers (drag can leave the strip) ── */
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d.mode) return;
      e.preventDefault();
      const t = timeFromClientX(e.clientX);
      const cur = selRef.current;
      if (d.mode === "start") {
        const start = clamp(t, 0, cur.end - MIN_TRIM_DURATION_SECONDS);
        setSel({ start, end: cur.end });
        seekPreview(start);
      } else if (d.mode === "end") {
        const end = clamp(t, cur.start + MIN_TRIM_DURATION_SECONDS, durRef.current);
        setSel({ start: cur.start, end });
        seekPreview(end);
      } else {
        const len = cur.end - cur.start;
        const start = clamp(t - d.grab, 0, durRef.current - len);
        setSel({ start, end: start + len });
        seekPreview(start);
      }
    };
    const up = () => {
      const d = dragRef.current;
      if (!d.mode) return;
      dragRef.current = { mode: null, grab: 0 };
      const cur = selRef.current;
      commit(cur.start, cur.end);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [commit, seekPreview, timeFromClientX]);

  const beginDrag = useCallback(
    (mode: Exclude<DragMode, null>, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      videoRef.current?.pause();
      const cur = selRef.current;
      dragRef.current = { mode, grab: mode === "region" ? timeFromClientX(e.clientX) - cur.start : 0 };
      seekPreview(mode === "end" ? cur.end : cur.start);
    },
    [seekPreview, timeFromClientX]
  );

  /* ── keyboard nudge on a focused handle (accessibility) ── */
  const nudge = useCallback(
    (mode: "start" | "end", delta: number) => {
      const cur = selRef.current;
      if (mode === "start") {
        const start = clamp(cur.start + delta, 0, cur.end - MIN_TRIM_DURATION_SECONDS);
        setSel({ start, end: cur.end });
        seekPreview(start);
        commit(start, cur.end);
      } else {
        const end = clamp(cur.end + delta, cur.start + MIN_TRIM_DURATION_SECONDS, durRef.current);
        setSel({ start: cur.start, end });
        seekPreview(end);
        commit(cur.start, end);
      }
    },
    [commit, seekPreview]
  );

  /* ── selection playback (clamped to the window) ── */
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !src) return;
    const onTime = () => {
      setPlayhead(v.currentTime);
      const { end, start } = selRef.current;
      if (v.currentTime >= end - 0.03) {
        v.pause();
        try {
          v.currentTime = end;
        } catch {
          /* ignore */
        }
        setPlayhead(start);
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [src]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      const { start, end } = selRef.current;
      if (v.currentTime < start || v.currentTime >= end - 0.05) v.currentTime = start;
      void v.play();
    } else {
      v.pause();
    }
  }, []);

  /* ── thumbnails ── */
  const frameTime = useCallback((i: number) => ((i + 0.5) / FRAME_COUNT) * dur, [dur]);
  const muxThumbs = useMemo(
    () => (thumbnailAt ? Array.from({ length: FRAME_COUNT }, (_, i) => thumbnailAt(frameTime(i))) : null),
    [thumbnailAt, frameTime]
  );
  const [localThumbs, setLocalThumbs] = useState<string[]>([]);
  useEffect(() => {
    // Capture frames from a local clip (no Mux thumbnail builder). Blob/object
    // URLs are same-origin so the canvas isn't tainted.
    if (thumbnailAt || !src || dur <= 0) return;
    let cancelled = false;
    const video = document.createElement("video");
    video.src = src;
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    const canvas = document.createElement("canvas");
    const frames: string[] = [];
    let idx = 0;
    const seekNext = () => {
      if (cancelled || idx >= FRAME_COUNT) return;
      try {
        video.currentTime = Math.min(((idx + 0.5) / FRAME_COUNT) * dur, dur - 0.05);
      } catch {
        /* ignore */
      }
    };
    const onLoaded = () => {
      const w = video.videoWidth || 160;
      const h = video.videoHeight || 90;
      canvas.width = 160;
      canvas.height = Math.max(1, Math.round((160 * h) / w));
      seekNext();
    };
    const onSeeked = () => {
      const ctx = canvas.getContext("2d");
      try {
        ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL("image/jpeg", 0.6));
      } catch {
        frames.push("");
      }
      idx += 1;
      if (!cancelled) setLocalThumbs([...frames]);
      seekNext();
    };
    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("seeked", onSeeked);
    return () => {
      cancelled = true;
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("seeked", onSeeked);
      video.removeAttribute("src");
      video.load();
    };
  }, [src, thumbnailAt, dur]);
  const thumbs = muxThumbs ?? localThumbs;

  const validation = validateTrim({ trimStartSeconds: sel.start, trimEndSeconds: sel.end, durationSeconds: dur });
  const error = validation.ok ? null : validation.error;

  const startPct = (sel.start / dur) * 100;
  const endPct = (sel.end / dur) * 100;
  const playheadPct = clamp((playhead / dur) * 100, 0, 100);
  const showPlayhead = playing && playhead >= sel.start && playhead <= sel.end;

  return (
    <div className="space-y-3">
      {/* preview */}
      <div className="relative overflow-hidden rounded-xl bg-stone-950">
        {src ? (
          <video
            ref={videoRef}
            src={src}
            poster={poster ?? undefined}
            playsInline
            preload="metadata"
            onClick={togglePlay}
            className="aspect-video w-full object-contain"
          />
        ) : (
          <div className="grid aspect-video w-full place-items-center">
            {poster && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />
            )}
            <p className="relative z-10 text-xs font-medium text-white/80">Preview unavailable</p>
          </div>
        )}
        {src && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            className="absolute bottom-2 left-2 z-10 grid size-8 place-items-center rounded-full bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70"
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
          </button>
        )}
      </div>

      {/* filmstrip + dual-handle selection */}
      <div
        ref={stripRef}
        className="relative h-16 touch-none select-none overflow-hidden rounded-xl bg-stone-900 ring-1 ring-stone-200"
      >
        {/* thumbnails */}
        <div className="absolute inset-0 flex">
          {Array.from({ length: FRAME_COUNT }).map((_, i) => (
            <div
              key={i}
              className="h-full flex-1 bg-stone-800 bg-cover bg-center"
              style={thumbs[i] ? { backgroundImage: `url("${thumbs[i]}")` } : undefined}
            />
          ))}
        </div>

        {/* dimmed regions outside the selection */}
        <div className="absolute inset-y-0 left-0 bg-stone-950/65" style={{ width: `${startPct}%` }} />
        <div className="absolute inset-y-0 right-0 bg-stone-950/65" style={{ width: `${100 - endPct}%` }} />

        {/* selection frame (draggable region) */}
        <div
          role="group"
          aria-label="Trim selection — drag to move"
          onPointerDown={(e) => beginDrag("region", e)}
          className="absolute inset-y-0 cursor-grab border-y-2 border-brand-400 active:cursor-grabbing"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
        />

        {/* playhead */}
        {showPlayhead && (
          <div
            className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-white/90"
            style={{ left: `${playheadPct}%` }}
          />
        )}

        {/* handles */}
        <TrimHandle
          side="start"
          leftPct={startPct}
          label="Trim start"
          valueNow={sel.start}
          max={sel.end - MIN_TRIM_DURATION_SECONDS}
          onPointerDown={(e) => beginDrag("start", e)}
          onNudge={(delta) => nudge("start", delta)}
        />
        <TrimHandle
          side="end"
          leftPct={endPct}
          label="Trim end"
          valueNow={sel.end}
          max={dur}
          onPointerDown={(e) => beginDrag("end", e)}
          onNudge={(delta) => nudge("end", delta)}
        />
      </div>

      {/* time readout under each handle */}
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 font-mono tabular-nums text-stone-600">
          {formatDuration(sel.start)}
          <span className="text-stone-300">→</span>
          {formatDuration(sel.end)}
        </span>
        <span className="text-stone-500">
          Keeps <span className="font-semibold text-stone-800">{formatDuration(Math.max(0, sel.end - sel.start))}</span>{" "}
          of {formatDuration(dur)}
        </span>
      </div>

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => {
            setSel({ start: 0, end: dur });
            commit(0, dur);
          }}
          className="text-xs font-medium text-brand-600 hover:underline"
        >
          Reset trim
        </button>
      </div>

      {error && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 ring-1 ring-inset ring-rose-100">
          {error}
        </p>
      )}
    </div>
  );
}

/** A draggable end handle (the vertical grab bar). role="slider" + arrow keys for
 *  keyboard access; the pointer drag is handled by the parent's window listeners. */
function TrimHandle({
  side,
  leftPct,
  label,
  valueNow,
  max,
  onPointerDown,
  onNudge,
}: {
  side: "start" | "end";
  leftPct: number;
  label: string;
  valueNow: number;
  max: number;
  onPointerDown: (e: React.PointerEvent) => void;
  onNudge: (delta: number) => void;
}) {
  return (
    <button
      type="button"
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(valueNow)}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 5 : 1;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onNudge(-step);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onNudge(step);
        }
      }}
      className={cn(
        "absolute inset-y-0 z-20 flex w-4 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center rounded-md bg-brand-400 text-white shadow-md outline-none ring-brand-300 focus-visible:ring-2",
        side === "start" ? "rounded-r-none" : "rounded-l-none"
      )}
      style={{ left: `${leftPct}%` }}
    >
      <span className="h-5 w-0.5 rounded-full bg-white/90" />
    </button>
  );
}
