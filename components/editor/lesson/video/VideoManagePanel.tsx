"use client";

/** The "Edit video" surface for a READY video: preview (with captions) +
 *  non-destructive filmstrip trim, a Captions & Transcript section, description,
 *  playback settings, and Replace / Record again / Remove. All edits flow through
 *  the validated UPDATE_VIDEO_LESSON patch (autosave persists them). */

import { useCallback, useMemo, useState } from "react";
import {
  AlertCircle,
  Captions,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCw,
  Scissors,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { updateVideoLessonPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { VideoLessonBlock } from "@/lib/course/types";
import { parseVtt } from "@/lib/video/captions";
import { thumbnailUrl } from "@/lib/video/playbackUrls";
import { formatDuration } from "@/lib/video/recorderConfig";
import { hasTrim, trimmedDurationSeconds } from "@/lib/video/videoStatus";
import type { VideoAssetView } from "@/lib/video/videoTypes";
import { InlineTextArea } from "../../InlineText";
import { VideoPreviewPlayer } from "./VideoPreviewPlayer";
import { VideoTrimEditor } from "./VideoTrimEditor";

const SETTINGS: {
  key: keyof VideoLessonBlock["settings"];
  label: string;
  hint: string;
  comingSoon?: boolean;
}[] = [
  { key: "showControls", label: "Show player controls", hint: "Play, seek, volume, fullscreen." },
  { key: "allowDownload", label: "Allow download", hint: "Let learners save the video." },
  { key: "showTranscript", label: "Captions on by default", hint: "Show captions when the video plays." },
  { key: "showChapters", label: "Chapters", hint: "Section markers.", comingSoon: true },
];

/** Friendly language name from a code (extend as more languages are offered). */
function languageName(code: string | null | undefined): string {
  if (!code) return "captions";
  const map: Record<string, string> = { en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese" };
  return map[code.toLowerCase()] ?? code.toUpperCase();
}

export function VideoManagePanel({
  block,
  view,
  onRefetch,
  onReplace,
  onRecordAgain,
  onRemove,
}: {
  block: VideoLessonBlock;
  view: VideoAssetView | null;
  onRefetch?: () => Promise<VideoAssetView | null>;
  onReplace: () => void;
  onRecordAgain: () => void;
  onRemove: () => void;
}) {
  const apply = useEditorStore((s) => s.apply);
  const [showTrim, setShowTrim] = useState(false);

  const duration = view?.durationSeconds ?? block.asset.durationSeconds ?? 0;
  const src = view?.mp4Url ?? null;
  const poster = view?.thumbnailUrl ?? block.asset.thumbnailUrl ?? null;
  const playbackId = view?.playbackId ?? block.asset.playbackId ?? null;
  const emptyMessage =
    view?.mp4Status === "disabled"
      ? "Preview isn't available for this video."
      : "Preparing high-quality preview…";
  const trimmed = hasTrim(block.edit);
  const shownDuration = trimmed
    ? trimmedDurationSeconds({
        trimStartSeconds: block.edit.trimStartSeconds,
        trimEndSeconds: block.edit.trimEndSeconds,
        durationSeconds: duration,
      })
    : duration;

  const captionCues = useMemo(() => parseVtt(view?.transcriptVtt), [view?.transcriptVtt]);
  const thumbnailAt = useMemo(
    () =>
      playbackId
        ? (t: number) => thumbnailUrl(playbackId, { time: t, width: 160, fitMode: "smartcrop" })
        : undefined,
    [playbackId]
  );

  function patch(p: Parameters<typeof updateVideoLessonPatch>[1]) {
    apply(updateVideoLessonPatch(block.id, p), "human");
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold tracking-tight text-stone-900">Edit video</h3>
        <p className="mt-0.5 text-sm text-stone-500">
          Ready · {formatDuration(shownDuration)}
          {trimmed && " · trimmed"}
        </p>
      </div>

      {showTrim && duration > 0 ? (
        <VideoTrimEditor
          src={src}
          poster={poster}
          durationSeconds={duration}
          trimStart={block.edit.trimStartSeconds}
          trimEnd={block.edit.trimEndSeconds}
          thumbnailAt={thumbnailAt}
          onChange={(start, end) => patch({ edit: { trimStartSeconds: start ?? null, trimEndSeconds: end ?? null } })}
        />
      ) : (
        <VideoPreviewPlayer
          src={src}
          poster={poster}
          trimStart={block.edit.trimStartSeconds}
          trimEnd={block.edit.trimEndSeconds}
          controls={block.settings.showControls}
          className="aspect-video w-full"
          emptyMessage={emptyMessage}
          captions={captionCues}
          captionsDefaultOn={block.settings.showTranscript}
        />
      )}

      <button
        type="button"
        onClick={() => setShowTrim((s) => !s)}
        disabled={duration <= 0}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40",
          showTrim
            ? "bg-brand-500 text-white shadow-sm hover:bg-brand-600"
            : "border border-stone-200 text-stone-600 hover:border-stone-300 hover:bg-stone-50"
        )}
      >
        <Scissors className="size-3.5" />
        {showTrim ? "Save changes" : "Trim start / end"}
      </button>

      <CaptionsSection view={view} block={block} onRefetch={onRefetch} />

      <div>
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          Description
        </span>
        <InlineTextArea
          value={block.description ?? ""}
          aria-label="Video description"
          placeholder="Add a short description of this video…"
          onCommit={(v) => patch({ description: v || null })}
          className="text-sm leading-relaxed text-stone-700"
        />
      </div>

      <div>
        <span className="mb-2 block text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          Playback
        </span>
        <div className="space-y-2">
          {SETTINGS.map((s) => (
            <label
              key={s.key}
              className={cn(
                "flex items-center justify-between gap-3 rounded-xl border border-stone-200 px-3 py-2",
                s.comingSoon && "opacity-60"
              )}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium text-stone-800">
                  {s.label}
                  {s.comingSoon && (
                    <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
                      Coming later
                    </span>
                  )}
                </span>
                <span className="block text-[11px] text-stone-400">{s.hint}</span>
              </span>
              <input
                type="checkbox"
                disabled={s.comingSoon}
                checked={Boolean(block.settings[s.key])}
                onChange={(e) => patch({ settings: { [s.key]: e.target.checked } })}
                className="size-4 shrink-0 accent-brand-500"
              />
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-4">
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-50"
        >
          <Trash2 className="size-3.5" />
          Remove video
        </button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRecordAgain}>
            <RefreshCw className="size-3.5" />
            Record again
          </Button>
          <Button variant="outline" size="sm" onClick={onReplace}>
            <UploadCloud className="size-3.5" />
            Replace
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Captions & Transcript — status (Not requested / Generating / Ready / Failed),
 *  a generate/retry action, and a read-only transcript preview once ready. Deeper
 *  editing (manual correction, WebVTT export, translations, re-uploaded tracks) is
 *  a deliberate extension point — not built here. */
function CaptionsSection({
  view,
  block,
  onRefetch,
}: {
  view: VideoAssetView | null;
  block: VideoLessonBlock;
  onRefetch?: () => Promise<VideoAssetView | null>;
}) {
  const videoAssetId = view?.id ?? block.asset.videoAssetId ?? null;
  const status = view?.captionStatus ?? block.captions?.status ?? "none";
  const lang = languageName(view?.captionLanguageCode ?? block.captions?.languageCode);
  const transcript = view?.transcript ?? null;
  const errorMessage = view?.captionError ?? block.captions?.error ?? null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);

  const generate = useCallback(async () => {
    if (!videoAssetId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/video/mux/generate-captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoAssetId }),
      });
      if (!res.ok) {
        setError((await res.text()) || "Couldn't start caption generation.");
      } else {
        await onRefetch?.();
      }
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }, [videoAssetId, busy, onRefetch]);

  return (
    <div>
      <span className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
        <Captions className="size-3.5" />
        Captions &amp; transcript
      </span>

      <div className="rounded-xl border border-stone-200">
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <StatusLabel status={status} lang={lang} />
          {(status === "none" || status === "failed") && (
            <Button size="sm" variant={status === "failed" ? "outline" : "secondary"} onClick={() => void generate()} disabled={busy || !videoAssetId}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Captions className="size-3.5" />}
              {status === "failed" ? "Try again" : "Generate captions"}
            </Button>
          )}
        </div>

        {(error || (status === "failed" && errorMessage)) && (
          <p className="border-t border-stone-100 px-3 py-2 text-xs text-rose-600">{error ?? errorMessage}</p>
        )}

        {status === "ready" && transcript && (
          <div className="border-t border-stone-100">
            <button
              type="button"
              onClick={() => setShowTranscript((s) => !s)}
              className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50"
            >
              <span>Transcript ({transcript.length.toLocaleString()} chars)</span>
              <ChevronDown className={cn("size-4 transition-transform", showTranscript && "rotate-180")} />
            </button>
            {showTranscript && (
              <div className="max-h-40 overflow-y-auto border-t border-stone-100 px-3 py-2 text-xs leading-relaxed text-stone-600">
                {transcript}
              </div>
            )}
          </div>
        )}

        {status === "ready" && (
          <p className="border-t border-stone-100 px-3 py-2 text-[11px] text-stone-400">
            Auto-generated. Manual correction, WebVTT export, and translations are coming later.
          </p>
        )}
      </div>
    </div>
  );
}

function StatusLabel({ status, lang }: { status: string; lang: string }) {
  if (status === "generating") {
    return (
      <span className="flex items-center gap-2 text-sm font-medium text-stone-700">
        <Loader2 className="size-4 animate-spin text-brand-500" />
        Generating captions…
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span className="flex items-center gap-2 text-sm font-medium text-stone-800">
        <CheckCircle2 className="size-4 text-emerald-600" />
        Captions ready · {lang}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center gap-2 text-sm font-medium text-stone-800">
        <AlertCircle className="size-4 text-rose-500" />
        Caption generation failed
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-sm font-medium text-stone-600">
      <Captions className="size-4 text-stone-400" />
      Not requested
    </span>
  );
}
