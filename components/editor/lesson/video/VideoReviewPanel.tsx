"use client";

/** Step 4 of the studio: review the just-recorded (or just-selected) clip before
 *  uploading. Preview, optional trim, then Save / Replace / Record again. */

import { useState } from "react";
import { RefreshCw, Scissors, UploadCloud, Video, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { formatDuration, formatVideoBytes } from "@/lib/video/recorderConfig";
import { trimmedDurationSeconds } from "@/lib/video/videoStatus";
import { VideoPreviewPlayer } from "./VideoPreviewPlayer";
import { VideoTrimEditor } from "./VideoTrimEditor";

export interface ReviewClip {
  blob: Blob;
  url: string;
  durationSeconds: number;
  source: "recording" | "upload";
}

export function VideoReviewPanel({
  clip,
  trim,
  onTrimChange,
  onSave,
  onRecordAgain,
  onReplace,
  onCancel,
}: {
  clip: ReviewClip;
  trim: { start?: number; end?: number };
  onTrimChange: (start: number | undefined, end: number | undefined) => void;
  onSave: () => void;
  onRecordAgain: () => void;
  onReplace: () => void;
  onCancel: () => void;
}) {
  const [showTrim, setShowTrim] = useState(false);
  const trimmed = trim.start != null || trim.end != null;
  const shownDuration = trimmed
    ? trimmedDurationSeconds({
        trimStartSeconds: trim.start,
        trimEndSeconds: trim.end,
        durationSeconds: clip.durationSeconds,
      })
    : clip.durationSeconds;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold tracking-tight text-stone-900">Review your video</h3>
        <p className="mt-0.5 text-sm text-stone-500">
          {clip.source === "recording" ? "Recorded" : "Selected"} ·{" "}
          {formatDuration(shownDuration)} · {formatVideoBytes(clip.blob.size)}
          {trimmed && " · trimmed"}
        </p>
      </div>

      {showTrim ? (
        <VideoTrimEditor
          src={clip.url}
          durationSeconds={clip.durationSeconds}
          trimStart={trim.start}
          trimEnd={trim.end}
          onChange={onTrimChange}
        />
      ) : (
        <VideoPreviewPlayer
          src={clip.url}
          trimStart={trim.start}
          trimEnd={trim.end}
          className="aspect-video w-full"
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-4">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowTrim((s) => !s)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
              showTrim
                ? "bg-brand-500 text-white shadow-sm hover:bg-brand-600"
                : "text-stone-600 hover:bg-stone-100"
            )}
          >
            <Scissors className="size-3.5" />
            {showTrim ? "Done" : "Trim"}
          </button>
          <button
            type="button"
            onClick={onRecordAgain}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100"
          >
            <RefreshCw className="size-3.5" />
            Record again
          </button>
          <button
            type="button"
            onClick={onReplace}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100"
          >
            <UploadCloud className="size-3.5" />
            Replace
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            <X className="size-3.5" />
            Cancel
          </button>
          <Button size="sm" onClick={onSave}>
            <Video className="size-3.5" />
            Save video
          </Button>
        </div>
      </div>
    </div>
  );
}
