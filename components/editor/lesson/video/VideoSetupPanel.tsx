"use client";

/** Step 2 of the studio: configure devices + capture, preview the camera/screen,
 *  then Start. Only the controls relevant to the chosen mode are shown. */

import { AlertCircle, Camera, Mic, MonitorUp } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { CAMERA_BUBBLE_POSITIONS, COUNTDOWN_OPTIONS, modeMeta } from "@/lib/video/recorderConfig";
import type { UseVideoRecorder } from "./useVideoRecorder";
import { DeviceSelect } from "./DeviceSelect";
import { MicLevelMeter } from "./MicLevelMeter";
import { StreamVideo } from "./StreamVideo";

export function VideoSetupPanel({
  recorder,
  onBack,
}: {
  recorder: UseVideoRecorder;
  onBack: () => void;
}) {
  const mode = recorder.mode;
  if (!mode) return null;
  const meta = modeMeta(mode);

  const bubblePos = recorder.bubblePosition;
  const bubbleClass = cn(
    "absolute w-1/4 overflow-hidden rounded-lg border-2 border-white/80 shadow-lg",
    bubblePos === "bottom-right" && "bottom-3 right-3",
    bubblePos === "bottom-left" && "bottom-3 left-3",
    bubblePos === "top-right" && "top-3 right-3",
    bubblePos === "top-left" && "top-3 left-3"
  );

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold tracking-tight text-stone-900">{meta.label}</h3>
        <p className="mt-0.5 text-sm text-stone-500">
          Check your camera, mic, and what you&apos;re sharing, then start recording.
        </p>
      </div>

      {recorder.error && (
        <p className="flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2.5 text-xs text-rose-600 ring-1 ring-inset ring-rose-100">
          <AlertCircle className="mt-px size-4 shrink-0" />
          <span>{recorder.error.message}</span>
        </p>
      )}

      <div className="grid gap-5 md:grid-cols-[1.4fr_1fr]">
        {/* preview */}
        <div className="relative aspect-video overflow-hidden rounded-2xl bg-stone-950 ring-1 ring-stone-200">
          {meta.needsScreen && !recorder.hasScreen ? (
            <div className="absolute inset-0 grid place-items-center">
              <div className="text-center">
                <span className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-white/10 text-white">
                  <MonitorUp className="size-5" />
                </span>
                <Button size="sm" variant="secondary" onClick={() => void recorder.pickScreen()}>
                  Choose screen to share
                </Button>
                <p className="mt-2 text-[11px] text-white/50">Pick a screen, window, or tab</p>
              </div>
            </div>
          ) : meta.needsScreen ? (
            <>
              <StreamVideo stream={recorder.screenStream} className="object-contain" />
              {mode === "screen_camera" && recorder.cameraStream && (
                <div className={cn(bubbleClass, "aspect-video")}>
                  <StreamVideo stream={recorder.cameraStream} mirrored />
                </div>
              )}
              <button
                type="button"
                onClick={() => void recorder.pickScreen()}
                className="absolute right-2 top-2 rounded-full bg-stone-950/60 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur transition-colors hover:bg-stone-950/80"
              >
                Change screen
              </button>
            </>
          ) : (
            <StreamVideo stream={recorder.cameraStream} mirrored className="object-cover" />
          )}
        </div>

        {/* controls */}
        <div className="space-y-4">
          {meta.needsCamera && (
            <DeviceSelect
              label="Camera"
              icon={<Camera className="size-3" />}
              value={recorder.selectedCameraId}
              devices={recorder.cameras}
              onChange={(id) => void recorder.selectCamera(id)}
              fallbackLabel="Camera"
            />
          )}

          <div className="space-y-2">
            <DeviceSelect
              label="Microphone"
              icon={<Mic className="size-3" />}
              value={recorder.selectedMicId}
              devices={recorder.microphones}
              onChange={(id) => void recorder.selectMic(id)}
              disabled={!recorder.includeMic}
              fallbackLabel="Microphone"
            />
            <MicLevelMeter level={recorder.micLevel} active={recorder.includeMic} />
            <label className="flex items-center gap-2 text-xs text-stone-600">
              <input
                type="checkbox"
                checked={recorder.includeMic}
                onChange={(e) => recorder.setIncludeMic(e.target.checked)}
                className="size-3.5 accent-brand-500"
              />
              Record microphone audio
            </label>
          </div>

          {mode === "screen_camera" && (
            <div>
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                Camera bubble
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {CAMERA_BUBBLE_POSITIONS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => recorder.setBubblePosition(p.id)}
                    className={cn(
                      "rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors",
                      bubblePos === p.id
                        ? "border-brand-300 bg-brand-50 text-brand-700"
                        : "border-stone-200 text-stone-600 hover:border-stone-300"
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {meta.needsScreen && (
            <label className="flex items-center gap-2 text-xs text-stone-600">
              <input
                type="checkbox"
                checked={recorder.includeSystemAudio}
                onChange={(e) => recorder.setIncludeSystemAudio(e.target.checked)}
                className="size-3.5 accent-brand-500"
              />
              Include screen audio (if shared)
            </label>
          )}

          <div>
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-stone-400">
              Countdown
            </span>
            <div className="flex gap-1.5">
              {COUNTDOWN_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => recorder.setCountdownSeconds(n)}
                  className={cn(
                    "flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors",
                    recorder.countdownSeconds === n
                      ? "border-brand-300 bg-brand-50 text-brand-700"
                      : "border-stone-200 text-stone-600 hover:border-stone-300"
                  )}
                >
                  {n === 0 ? "Off" : `${n}s`}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-stone-100 pt-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button size="sm" onClick={recorder.startRecording} disabled={!recorder.ready}>
          Start recording
        </Button>
      </div>
    </div>
  );
}
