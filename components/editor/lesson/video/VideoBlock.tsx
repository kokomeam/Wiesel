"use client";

/**
 * Renders a video-lesson block inside the lesson editor. Reads the LIVE asset
 * status via useVideoAsset (which polls while Mux is still processing), mirrors
 * meaningful changes back into the block snapshot so the persisted doc stays
 * accurate across reloads, and shows the right surface: empty · processing ·
 * ready (with an inline preview) · failed. The full record/edit/replace flow
 * lives in VideoStudioModal.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Captions,
  CheckCircle2,
  Clock,
  Loader2,
  Pencil,
  RefreshCw,
  UploadCloud,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { updateVideoLessonPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { VideoCaptionStatus, VideoLessonBlock } from "@/lib/course/types";
import { captionsFromView, type Mp4Status } from "@/lib/video/videoTypes";
import { parseVtt, type CaptionCue } from "@/lib/video/captions";
import { hasTrim, trimmedDurationSeconds } from "@/lib/video/videoStatus";
import { formatDuration } from "@/lib/video/recorderConfig";
import { VideoPreviewPlayer } from "./VideoPreviewPlayer";
import { VideoStudioModal } from "./VideoStudioModal";
import { useVideoAsset } from "./useVideoAsset";

export function VideoBlock({ block, lessonId }: { block: VideoLessonBlock; lessonId: string }) {
  const apply = useEditorStore((s) => s.apply);
  const [modal, setModal] = useState<null | { initialUpload: boolean }>(null);

  const hasAsset = Boolean(block.asset.videoAssetId) && block.asset.status !== "empty";
  const asset = useVideoAsset(hasAsset ? block.asset.videoAssetId : null, {
    initialStatus: block.asset.status === "empty" ? undefined : block.asset.status,
  });
  const view = asset.view;

  // Mirror meaningful live changes into the block snapshot (so a reload shows the
  // right state instantly + the doc persists "ready"). Only the fields that
  // change at transitions — never the polling timestamp — so this stays quiet.
  useEffect(() => {
    if (!view) return;
    const a = block.asset;
    const assetChanged =
      view.status !== a.status ||
      (view.durationSeconds ?? undefined) !== a.durationSeconds ||
      (view.aspectRatio ?? undefined) !== a.aspectRatio ||
      (view.playbackId ?? undefined) !== a.playbackId ||
      (view.thumbnailUrl ?? undefined) !== a.thumbnailUrl ||
      (view.error ?? undefined) !== a.errorMessage;
    const c = block.captions;
    const captionsChanged =
      view.captionStatus !== (c?.status ?? "none") ||
      (view.captionTrackId ?? undefined) !== c?.trackId ||
      (view.captionTrackName ?? undefined) !== c?.trackName ||
      (view.captionLanguageCode ?? undefined) !== c?.languageCode ||
      (view.captionError ?? undefined) !== c?.error;
    if (!assetChanged && !captionsChanged) return;
    apply(
      updateVideoLessonPatch(block.id, {
        ...(assetChanged
          ? {
              asset: {
                status: view.status,
                videoAssetId: view.id,
                uploadId: view.uploadId,
                assetId: view.assetId,
                playbackId: view.playbackId,
                durationSeconds: view.durationSeconds,
                aspectRatio: view.aspectRatio,
                thumbnailUrl: view.thumbnailUrl,
                updatedAt: view.updatedAt,
                errorMessage: view.error,
              },
            }
          : {}),
        // Mirror only the caption METADATA (status/track/lang) — the transcript
        // text stays on the row + rides in `view`, keeping the doc lean.
        ...(captionsChanged ? { captions: captionsFromView(view) } : {}),
      }),
      "human"
    );
  }, [view, block.id, block.asset, block.captions, apply]);

  const status = view?.status ?? (block.asset.status === "empty" ? "empty" : block.asset.status);

  let body;
  if (status === "empty") {
    body = (
      <EmptyCard
        onRecord={() => setModal({ initialUpload: false })}
        onUpload={() => setModal({ initialUpload: true })}
      />
    );
  } else if (status === "failed") {
    body = (
      <FailedCard
        message={view?.error ?? block.asset.errorMessage}
        onFix={() => setModal({ initialUpload: false })}
      />
    );
  } else if (status === "ready") {
    body = (
      <ReadyCard
        block={block}
        mp4Url={view?.mp4Url ?? null}
        mp4Status={view?.mp4Status ?? null}
        poster={view?.thumbnailUrl ?? block.asset.thumbnailUrl ?? null}
        duration={view?.durationSeconds ?? block.asset.durationSeconds ?? 0}
        transcriptVtt={view?.transcriptVtt ?? null}
        captionStatus={view?.captionStatus ?? block.captions?.status ?? "none"}
        onEdit={() => setModal({ initialUpload: false })}
      />
    );
  } else {
    body = <ProcessingCard status={status} />;
  }

  return (
    <div>
      {body}
      {modal && (
        <VideoStudioModal
          block={block}
          lessonId={lessonId}
          initialUpload={modal.initialUpload}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function EmptyCard({ onRecord, onUpload }: { onRecord: () => void; onUpload: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50/50 px-6 py-8 text-center">
      <span className="mx-auto mb-3 grid size-11 place-items-center rounded-2xl bg-brand-50 text-brand-600">
        <Video className="size-5" />
      </span>
      <h4 className="text-sm font-semibold text-stone-900">Video lesson</h4>
      <p className="mx-auto mt-0.5 mb-4 max-w-xs text-xs text-stone-500">
        Record or upload a video lesson.
      </p>
      <div className="flex items-center justify-center gap-2">
        <Button size="sm" onClick={onRecord}>
          <Video className="size-3.5" />
          Record video
        </Button>
        <Button size="sm" variant="outline" onClick={onUpload}>
          <UploadCloud className="size-3.5" />
          Upload video
        </Button>
      </div>
    </div>
  );
}

function ProcessingCard({ status }: { status: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
        <Loader2 className="size-4 animate-spin" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-stone-800">
          {status === "uploading" ? "Uploading video…" : "Processing video…"}
        </p>
        <p className="text-xs text-stone-400">
          This can take a minute. You can keep editing — it&apos;ll appear when ready.
        </p>
      </div>
    </div>
  );
}

function FailedCard({ message, onFix }: { message?: string; onFix: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-rose-100 text-rose-500">
          <AlertCircle className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-800">Video couldn&apos;t be processed</p>
          <p className="truncate text-xs text-stone-500">
            {message ?? "Something went wrong. Try recording or uploading again."}
          </p>
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onFix}>
        <RefreshCw className="size-3.5" />
        Try again
      </Button>
    </div>
  );
}

function ReadyCard({
  block,
  mp4Url,
  mp4Status,
  poster,
  duration,
  transcriptVtt,
  captionStatus,
  onEdit,
}: {
  block: VideoLessonBlock;
  mp4Url: string | null;
  mp4Status: Mp4Status | null;
  poster: string | null;
  duration: number;
  transcriptVtt: string | null;
  captionStatus: VideoCaptionStatus;
  onEdit: () => void;
}) {
  const captionCues: CaptionCue[] = useMemo(() => parseVtt(transcriptVtt), [transcriptVtt]);
  // Play as soon as we have an MP4 URL. When we don't, distinguish a rendition
  // that's still generating (keep showing "Preparing…") from one that's genuinely
  // unavailable (mp4 "disabled") — the latter must NOT masquerade as forever-loading.
  const emptyMessage =
    mp4Status === "disabled"
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
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1.5fr_1fr] sm:items-start">
        <VideoPreviewPlayer
          src={mp4Url}
          poster={poster}
          trimStart={block.edit.trimStartSeconds}
          trimEnd={block.edit.trimEndSeconds}
          controls={block.settings.showControls}
          className="aspect-video w-full"
          emptyMessage={emptyMessage}
          captions={captionCues}
          captionsDefaultOn={block.settings.showTranscript}
        />
        <div className="space-y-2.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
            <CheckCircle2 className="size-4" />
            Ready
          </div>
          <div className="flex items-center gap-1.5 text-xs text-stone-500">
            <Clock className="size-3.5" />
            {formatDuration(shownDuration)}
            {trimmed && (
              <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-stone-500">
                trimmed
              </span>
            )}
          </div>
          {block.description && (
            <p className="line-clamp-3 text-xs leading-relaxed text-stone-500">{block.description}</p>
          )}
          <CaptionStatusLine status={captionStatus} />
          <div className="pt-1">
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil className="size-3.5" />
              Edit video
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Compact caption status on the ready card (mirrors the manage-panel section). */
function CaptionStatusLine({ status }: { status: VideoCaptionStatus }) {
  const map: Record<VideoCaptionStatus, { icon: React.ReactNode; text: string; tone: string }> = {
    none: { icon: <Captions className="size-3.5" />, text: "No captions", tone: "text-stone-400" },
    generating: {
      icon: <Loader2 className="size-3.5 animate-spin" />,
      text: "Generating captions…",
      tone: "text-stone-500",
    },
    ready: { icon: <Captions className="size-3.5" />, text: "Captions ready", tone: "text-emerald-600" },
    failed: { icon: <AlertCircle className="size-3.5" />, text: "Captions failed", tone: "text-rose-500" },
  };
  const s = map[status];
  return (
    <p className={`flex items-center gap-1.5 text-[11px] ${s.tone}`}>
      {s.icon}
      {s.text}
    </p>
  );
}
