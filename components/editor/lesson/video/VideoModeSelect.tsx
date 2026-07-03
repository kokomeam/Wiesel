"use client";

/** Step 1 of the studio: choose one of exactly three recording modes, or upload
 *  an existing file instead (a quiet secondary path — no long mode list). */

import { Camera, MonitorUp, UploadCloud, Video } from "lucide-react";
import type { VideoRecordingMode } from "@/lib/course/types";
import { RECORDING_MODES } from "@/lib/video/recorderConfig";

const MODE_ICON: Record<VideoRecordingMode, typeof Video> = {
  screen_camera: Video,
  camera_only: Camera,
  screen_only: MonitorUp,
};

export function VideoModeSelect({
  onPickMode,
  onUploadFile,
}: {
  onPickMode: (mode: VideoRecordingMode) => void;
  onUploadFile: () => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold tracking-tight text-stone-900">Create video lesson</h3>
        <p className="mt-0.5 text-sm text-stone-500">
          Record a lesson with your camera, screen, or both.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {RECORDING_MODES.map((m) => {
          const Icon = MODE_ICON[m.id];
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onPickMode(m.id)}
              className="group flex flex-col items-start gap-3 rounded-2xl border border-stone-200 bg-white p-4 text-left transition-all hover:border-brand-300 hover:shadow-[0_2px_12px_rgba(16,24,40,0.06)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
            >
              <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-100">
                <Icon className="size-5" />
              </span>
              <span className="space-y-1">
                <span className="block text-sm font-semibold text-stone-900">{m.label}</span>
                <span className="block text-xs leading-relaxed text-stone-500">{m.description}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-center">
        <button
          type="button"
          onClick={onUploadFile}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-stone-500 transition-colors hover:text-brand-600"
        >
          <UploadCloud className="size-3.5" />
          or upload an existing video file
        </button>
      </div>
    </div>
  );
}
