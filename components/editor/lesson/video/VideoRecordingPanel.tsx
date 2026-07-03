"use client";

/** Step 3 of the studio: the live recording surface. Deliberately calm — a big
 *  timer, a REC dot, and just Pause / Stop / Discard. */

import { Pause, Play, RotateCcw, Square } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDuration, modeMeta } from "@/lib/video/recorderConfig";
import type { UseVideoRecorder } from "./useVideoRecorder";
import { CountdownOverlay } from "./CountdownOverlay";
import { StreamVideo } from "./StreamVideo";

export function VideoRecordingPanel({
  recorder,
  onDiscard,
}: {
  recorder: UseVideoRecorder;
  onDiscard: () => void;
}) {
  const mode = recorder.mode;
  if (!mode) return null;
  const meta = modeMeta(mode);
  const paused = recorder.phase === "paused";
  const counting = recorder.phase === "countdown";

  const bubblePos = recorder.bubblePosition;
  const bubbleClass = cn(
    "absolute aspect-video w-1/4 overflow-hidden rounded-lg border-2 border-white/80 shadow-lg",
    bubblePos === "bottom-right" && "bottom-3 right-3",
    bubblePos === "bottom-left" && "bottom-3 left-3",
    bubblePos === "top-right" && "top-3 right-3",
    bubblePos === "top-left" && "top-3 left-3"
  );

  return (
    <div className="space-y-4">
      <div className="relative aspect-video overflow-hidden rounded-2xl bg-stone-950 ring-1 ring-stone-200">
        {meta.needsScreen ? (
          <>
            <StreamVideo stream={recorder.screenStream} className="object-contain" />
            {mode === "screen_camera" && recorder.cameraStream && (
              <div className={bubbleClass}>
                <StreamVideo stream={recorder.cameraStream} mirrored />
              </div>
            )}
          </>
        ) : (
          <StreamVideo stream={recorder.cameraStream} mirrored className="object-cover" />
        )}

        {counting && recorder.countdownValue != null && (
          <CountdownOverlay value={recorder.countdownValue} />
        )}

        {/* REC + timer */}
        {!counting && (
          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-stone-950/60 px-3 py-1.5 backdrop-blur">
            <span
              className={cn(
                "size-2.5 rounded-full",
                paused ? "bg-amber-400" : "animate-pulse bg-rose-500"
              )}
            />
            <span className="font-mono text-sm tabular-nums text-white">
              {formatDuration(recorder.elapsedSeconds)}
            </span>
            {paused && <span className="text-[11px] font-medium text-amber-300">Paused</span>}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-stone-500">
          {counting ? "Get ready…" : `Recording ${meta.label.toLowerCase()}`}
        </p>
        {!counting && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDiscard}
              title="Discard and start over"
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              <RotateCcw className="size-3.5" />
              Discard
            </button>
            {recorder.canPause &&
              (paused ? (
                <button
                  type="button"
                  onClick={recorder.resumeRecording}
                  className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-stone-700 transition-colors hover:bg-stone-50"
                >
                  <Play className="size-3.5" />
                  Resume
                </button>
              ) : (
                <button
                  type="button"
                  onClick={recorder.pauseRecording}
                  className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-stone-700 transition-colors hover:bg-stone-50"
                >
                  <Pause className="size-3.5" />
                  Pause
                </button>
              ))}
            <button
              type="button"
              onClick={recorder.stopRecording}
              className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-700"
            >
              <Square className="size-3 fill-current" />
              Stop
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
