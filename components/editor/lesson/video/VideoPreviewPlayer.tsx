"use client";

/**
 * A video preview that honors a NON-DESTRUCTIVE trim by presenting the window
 * [trimStart, trimEnd] AS the whole clip. Instead of native controls (which show
 * the full source timeline and just pause partway through — making a trim look
 * broken), it renders a branded control bar whose scrubber, elapsed time, and total
 * duration are all window-relative. Playback is clamped to the window: it starts at
 * trimStart and ends (or loops) at trimEnd, so to the viewer the clip simply is that
 * length. `src` may be a Mux MP4 URL or a local object URL; when null (MP4 still
 * preparing, or disabled) it shows the poster + `emptyMessage` instead of crashing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Captions, CaptionsOff, Maximize2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/cn";
import { activeCaption, type CaptionCue } from "@/lib/video/captions";
import { formatDuration } from "@/lib/video/recorderConfig";

export function VideoPreviewPlayer({
  src,
  poster,
  trimStart,
  trimEnd,
  loop = false,
  controls = true,
  autoPlay = false,
  muted = false,
  className,
  emptyMessage = "Preparing preview…",
  captions,
  captionsDefaultOn = false,
  onLoadedMetadata,
  onProgressPct,
}: {
  src: string | null;
  poster?: string | null;
  trimStart?: number;
  trimEnd?: number;
  loop?: boolean;
  controls?: boolean;
  autoPlay?: boolean;
  muted?: boolean;
  className?: string;
  emptyMessage?: string;
  /** Parsed caption cues (absolute source time). When present a CC toggle appears
   *  and the active cue renders as an overlay — respecting the trim window since
   *  playback time is clamped to it. */
  captions?: CaptionCue[] | null;
  captionsDefaultOn?: boolean;
  onLoadedMetadata?: (durationSeconds: number) => void;
  /** Window-relative playback position as 0–100, fired on timeupdate. The
   *  student runtime reports this for the ≥90% completion rule; callers should
   *  pass a stable (useCallback) reference. */
  onProgressPct?: (pct: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Window bounds. `end` is unknown until metadata loads (unless trimEnd is set).
  const start = Math.max(0, trimStart ?? 0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const end = trimEnd ?? mediaDuration ?? null;
  const windowLength = end != null ? Math.max(0, end - start) : 0;

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(start); // absolute time
  const [isMuted, setIsMuted] = useState(muted);
  const hasCaptions = Boolean(captions && captions.length > 0);
  const [captionsOn, setCaptionsOn] = useState(captionsDefaultOn);
  const activeCue = useMemo(
    () => (hasCaptions && captionsOn ? activeCaption(captions as CaptionCue[], current) : null),
    [hasCaptions, captionsOn, captions, current]
  );

  // Keep the video's playback clamped to [start, end] and mirror its state.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !src) return;

    const seekToStart = () => {
      if (Math.abs(v.currentTime - start) > 0.05 && v.currentTime < start) {
        try {
          v.currentTime = start;
        } catch {
          /* not seekable yet */
        }
      }
    };
    const onLoaded = () => {
      setMediaDuration(Number.isFinite(v.duration) ? v.duration : null);
      seekToStart();
      onLoadedMetadata?.(v.duration);
    };
    const onTime = () => {
      setCurrent(v.currentTime);
      if (onProgressPct && end != null && end > start) {
        const pct = ((v.currentTime - start) / (end - start)) * 100;
        onProgressPct(Math.max(0, Math.min(100, pct)));
      }
      if (end != null && v.currentTime >= end - 0.03) {
        if (loop) {
          try {
            v.currentTime = start;
            void v.play();
          } catch {
            /* ignore */
          }
        } else {
          v.pause();
          // Rest exactly at the window end so the bar reads "full".
          try {
            v.currentTime = end;
          } catch {
            /* ignore */
          }
        }
      }
    };
    const onSeeked = () => {
      if (v.currentTime < start - 0.05) {
        try {
          v.currentTime = start;
        } catch {
          /* ignore */
        }
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);

    if (v.readyState >= 1) onLoaded();
    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [src, start, end, loop, onLoadedMetadata, onProgressPct]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      // If we're parked at the window end, restart from the window start.
      if (end != null && v.currentTime >= end - 0.05) {
        try {
          v.currentTime = start;
        } catch {
          /* ignore */
        }
      }
      void v.play();
    } else {
      v.pause();
    }
  }, [start, end]);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  const onScrub = useCallback(
    (relative: number) => {
      const v = videoRef.current;
      if (!v) return;
      try {
        v.currentTime = start + Math.max(0, Math.min(relative, windowLength));
      } catch {
        /* ignore */
      }
    },
    [start, windowLength]
  );

  if (!src) {
    return (
      <div className={cn("relative overflow-hidden rounded-xl bg-stone-950", className)}>
        <div className="relative flex aspect-video w-full items-center justify-center">
          {poster && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />
          )}
          <p className="relative z-10 text-xs font-medium text-white/80">{emptyMessage}</p>
        </div>
      </div>
    );
  }

  const relative = Math.max(0, Math.min(current - start, windowLength || Infinity));

  return (
    <div ref={containerRef} className={cn("group relative overflow-hidden rounded-xl bg-stone-950", className)}>
      <video
        ref={videoRef}
        src={src}
        poster={poster ?? undefined}
        autoPlay={autoPlay}
        muted={isMuted}
        playsInline
        preload="metadata"
        onClick={controls ? togglePlay : undefined}
        className="h-full w-full bg-stone-950 object-contain"
      />

      {activeCue && (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4 transition-all",
            controls ? "bottom-12" : "bottom-4"
          )}
        >
          <span className="max-w-[90%] rounded-md bg-black/70 px-2.5 py-1 text-center text-sm font-medium leading-snug text-white shadow-sm backdrop-blur-sm sm:text-base">
            {activeCue}
          </span>
        </div>
      )}

      {controls && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 via-black/25 to-transparent px-3 pb-2.5 pt-8 opacity-100 transition-opacity">
          <div className="pointer-events-auto flex items-center gap-2.5 text-white">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-white/15 text-white backdrop-blur transition-colors hover:bg-white/25"
            >
              {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
            </button>

            <span className="shrink-0 font-mono text-[11px] tabular-nums text-white/90">
              {formatDuration(relative)}
            </span>

            <ScrubBar
              value={relative}
              max={windowLength}
              onScrub={onScrub}
              disabled={windowLength <= 0}
            />

            <span className="shrink-0 font-mono text-[11px] tabular-nums text-white/70">
              {formatDuration(windowLength)}
            </span>

            {hasCaptions && (
              <button
                type="button"
                onClick={() => setCaptionsOn((c) => !c)}
                aria-label={captionsOn ? "Hide captions" : "Show captions"}
                aria-pressed={captionsOn}
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full transition-colors hover:bg-white/15",
                  captionsOn ? "text-white" : "text-white/60"
                )}
              >
                {captionsOn ? <Captions className="size-4" /> : <CaptionsOff className="size-4" />}
              </button>
            )}
            <button
              type="button"
              onClick={toggleMute}
              aria-label={isMuted ? "Unmute" : "Mute"}
              className="grid size-7 shrink-0 place-items-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white"
            >
              {isMuted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label="Fullscreen"
              className="grid size-7 shrink-0 place-items-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white"
            >
              <Maximize2 className="size-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A thin seek bar mapped to the trimmed window [0, windowLength]. */
function ScrubBar({
  value,
  max,
  onScrub,
  disabled,
}: {
  value: number;
  max: number;
  onScrub: (relative: number) => void;
  disabled: boolean;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="relative flex-1">
      <div className="h-1 w-full overflow-hidden rounded-full bg-white/25">
        <div className="h-full rounded-full bg-brand-400" style={{ width: `${pct}%` }} />
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(max, 0.1)}
        step={0.05}
        value={Math.min(value, max)}
        disabled={disabled}
        aria-label="Seek"
        onChange={(e) => onScrub(Number(e.target.value))}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
      />
    </div>
  );
}
