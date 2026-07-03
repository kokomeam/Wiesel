/**
 * Canonical types for the video-lesson service layer. Row/Insert/Update come
 * from the generated DB types; `VideoAssetView` is the CLIENT-SAFE shape the API
 * returns — it carries only public ids + derived public URLs, never Mux secrets
 * or the passthrough token beyond what the author already owns.
 */

import type { Database } from "@/lib/database.types";
import type {
  VideoAssetSnapshot,
  VideoCaptions,
  VideoCaptionStatus,
  VideoProviderId,
} from "@/lib/course/types";
import { captionVttUrl } from "./playbackUrls";

export type VideoAssetRow = Database["public"]["Tables"]["video_assets"]["Row"];
export type VideoAssetInsert = Database["public"]["Tables"]["video_assets"]["Insert"];
export type VideoAssetUpdate = Database["public"]["Tables"]["video_assets"]["Update"];

/** The row/view status vocabulary (the block adds an `empty` no-asset state). */
export type VideoRowStatus = "uploading" | "processing" | "ready" | "failed";

export type Mp4Status = "preparing" | "ready" | "disabled";

/** Caption lifecycle (mirrors the block's VideoCaptionStatus). */
export type CaptionStatus = VideoCaptionStatus;

export function isCaptionStatus(v: unknown): v is CaptionStatus {
  return v === "none" || v === "generating" || v === "ready" || v === "failed";
}

/** The whole video asset as the client consumes it — public ids + derived public
 *  URLs. No Mux tokens, no owner leakage beyond the author's own data. */
export interface VideoAssetView {
  id: string;
  courseId: string;
  lessonId: string | null;
  blockId: string | null;
  provider: VideoProviderId;
  status: VideoRowStatus;
  uploadId: string | null;
  assetId: string | null;
  playbackId: string | null;
  durationSeconds: number | null;
  aspectRatio: string | null;
  /** Downloadable MP4 (static rendition) — the studio's native <video> source. */
  mp4Url: string | null;
  mp4Status: Mp4Status | null;
  /** HLS manifest (extension point for a future Mux Player upgrade). */
  hlsUrl: string | null;
  /** Poster/thumbnail (Mux image API). */
  thumbnailUrl: string | null;
  /* ── captions / transcript (Mux auto-generated) ── */
  captionStatus: CaptionStatus;
  captionTrackId: string | null;
  captionTrackName: string | null;
  captionLanguageCode: string | null;
  captionSource: string | null;
  captionError: string | null;
  /** Public WebVTT URL for the caption track (extension point: native <track>,
   *  WebVTT export, Mux Player). Null until a track id exists. */
  captionVttUrl: string | null;
  /** Plain transcript derived from the VTT (for the preview + future AI). */
  transcript: string | null;
  /** Raw WebVTT / timed transcript (drives the synced caption overlay; also the
   *  extension point for WebVTT export + transcript-based editing). */
  transcriptVtt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Client-safe caption VTT URL from a playback id + track id (public playback). */
export function viewCaptionVttUrl(
  playbackId: string | null,
  trackId: string | null
): string | null {
  return playbackId && trackId ? captionVttUrl(playbackId, trackId) : null;
}

export function isVideoRowStatus(v: unknown): v is VideoRowStatus {
  return v === "uploading" || v === "processing" || v === "ready" || v === "failed";
}

export function rowStatus(row: Pick<VideoAssetRow, "status">): VideoRowStatus {
  return isVideoRowStatus(row.status) ? row.status : "processing";
}

/** Map a client view onto the block's caption METADATA (what UPDATE_VIDEO_LESSON
 *  persists). The heavy transcript text is intentionally NOT included — it lives
 *  on the row + rides in the live view, keeping the course document lean. PURE. */
export function captionsFromView(view: VideoAssetView): VideoCaptions {
  return {
    status: view.captionStatus,
    trackId: view.captionTrackId ?? undefined,
    trackName: view.captionTrackName ?? undefined,
    languageCode: view.captionLanguageCode ?? undefined,
    source: view.captionSource === "uploaded" ? "uploaded" : view.captionSource === "generated" ? "generated" : undefined,
    error: view.captionError ?? undefined,
    updatedAt: view.updatedAt,
  };
}

/** Map a client view onto the denormalized block snapshot (what UPDATE_VIDEO_LESSON
 *  writes). PURE — no derivation of secrets. */
export function snapshotFromView(view: VideoAssetView): VideoAssetSnapshot {
  return {
    provider: view.provider,
    status: view.status,
    videoAssetId: view.id,
    uploadId: view.uploadId ?? undefined,
    assetId: view.assetId ?? undefined,
    playbackId: view.playbackId ?? undefined,
    durationSeconds: view.durationSeconds ?? undefined,
    aspectRatio: view.aspectRatio ?? undefined,
    thumbnailUrl: view.thumbnailUrl ?? undefined,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    errorMessage: view.error ?? undefined,
  };
}
