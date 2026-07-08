/**
 * Video-asset service: CRUD over `video_assets`, the Mux-truth sync, and the
 * row → client-`View` mapping (which is where public playback/thumbnail URLs are
 * derived). Works with EITHER a request-scoped client (RLS enforces ownership for
 * the editor) or the service-role client (the webhook, which writes across users).
 *
 * The Mux HTTP shape never appears here — only the normalized provider seam
 * (`lib/video/provider`) and the pure status logic (`videoStatus.ts`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { plainTextFromVtt } from "./captions";
import { hlsUrl, thumbnailUrl } from "./playbackUrls";
import type { VideoProvider } from "./provider/types";
import { VideoProviderError } from "./provider/types";
import { reconcileMuxState } from "./videoStatus";
import {
  isCaptionStatus,
  rowStatus,
  viewCaptionVttUrl,
  type CaptionStatus,
  type Mp4Status,
  type VideoAssetRow,
  type VideoAssetUpdate,
  type VideoAssetView,
} from "./videoTypes";

type DB = SupabaseClient<Database>;

/** Default caption language requested at upload (English auto-captions). */
export const DEFAULT_CAPTION_LANGUAGE = "en";
export const DEFAULT_CAPTION_NAME = "English (auto)";

/* ─────────────────────────────── create ───────────────────────────────── */

export interface CreateVideoAssetArgs {
  ownerId: string;
  courseId: string;
  lessonId?: string | null;
  blockId?: string | null;
  muxUploadId: string;
  playbackPolicy?: "public" | "signed";
  /** When true, we requested Mux auto-captions at upload → seed the row as
   *  `generating` (the track appears in `preparing` once the asset is ready). */
  requestCaptions?: boolean;
  captionLanguageCode?: string;
  /** M-R (D-4): auxiliary-track marker (e.g. "camera_dual_track"). */
  role?: string | null;
}

export async function createVideoAsset(
  supabase: DB,
  args: CreateVideoAssetArgs
): Promise<{ row: VideoAssetRow } | { error: string }> {
  const { data, error } = await supabase
    .from("video_assets")
    .insert({
      owner_id: args.ownerId,
      course_id: args.courseId,
      lesson_id: args.lessonId ?? null,
      block_id: args.blockId ?? null,
      provider: "mux",
      mux_upload_id: args.muxUploadId,
      playback_policy: args.playbackPolicy ?? "public",
      status: "uploading",
      caption_status: args.requestCaptions ? "generating" : "none",
      caption_language_code: args.requestCaptions
        ? args.captionLanguageCode ?? DEFAULT_CAPTION_LANGUAGE
        : null,
      caption_source: args.requestCaptions ? "generated" : null,
      // M-R (D-4): role metadata marks auxiliary tracks (e.g. the raw camera
      // capture) so lesson-video pickers can exclude them.
      ...(args.role ? { metadata: { role: args.role } } : {}),
    })
    .select("*")
    .single();
  if (error || !data) return { error: error?.message ?? "Failed to create video asset" };
  return { row: data };
}

/* ─────────────────────────────── read ─────────────────────────────────── */

export async function getVideoAsset(supabase: DB, id: string): Promise<VideoAssetRow | null> {
  const { data, error } = await supabase.from("video_assets").select("*").eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data;
}

/** Find a row by its Mux passthrough/asset/upload id (webhook routing). */
export async function findVideoAssetByMuxId(
  supabase: DB,
  ids: { rowId?: string | null; assetId?: string | null; uploadId?: string | null }
): Promise<VideoAssetRow | null> {
  if (ids.rowId) {
    const byRow = await getVideoAsset(supabase, ids.rowId);
    if (byRow) return byRow;
  }
  if (ids.assetId) {
    const { data } = await supabase.from("video_assets").select("*").eq("mux_asset_id", ids.assetId).maybeSingle();
    if (data) return data;
  }
  if (ids.uploadId) {
    const { data } = await supabase.from("video_assets").select("*").eq("mux_upload_id", ids.uploadId).maybeSingle();
    if (data) return data;
  }
  return null;
}

/* ─────────────────────────────── update ───────────────────────────────── */

export async function updateVideoAsset(
  supabase: DB,
  id: string,
  patch: VideoAssetUpdate
): Promise<{ row: VideoAssetRow } | { error: string }> {
  const { data, error } = await supabase
    .from("video_assets")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error || !data) return { error: error?.message ?? "Failed to update video asset" };
  return { row: data };
}

/* ─────────────────────────────── delete ───────────────────────────────── */

/** Remove a video asset: delete the Mux asset (best-effort) then the row. */
export async function deleteVideoAsset(
  supabase: DB,
  provider: VideoProvider,
  row: VideoAssetRow
): Promise<string | null> {
  if (row.mux_asset_id) {
    try {
      await provider.deleteAsset(row.mux_asset_id);
    } catch (err) {
      // Best-effort: a failed Mux delete must not block removing the row (an
      // orphaned Mux asset is reaped/ignorable; a stuck block is worse).
      console.log(
        JSON.stringify({ tag: "video_mux_delete_error", message: (err as Error).message })
      );
    }
  }
  const { error } = await supabase.from("video_assets").delete().eq("id", row.id);
  return error?.message ?? null;
}

/* ───────────────────────── Mux truth → row sync ────────────────────────── */

/**
 * Pull Mux's authoritative state and reconcile it into the row. Terminal rows
 * (ready/failed) short-circuit (no Mux call). A transient Mux/network error is
 * swallowed — we return the current view so a status poll degrades gracefully
 * instead of 500-ing.
 */
export async function syncVideoAssetFromMux(
  supabase: DB,
  provider: VideoProvider,
  row: VideoAssetRow
): Promise<VideoAssetView> {
  const current = rowStatus(row);
  // Captions are asynchronous: they must NOT be considered settled while they're
  // still generating, nor while a ready track's transcript hasn't been fetched yet
  // — otherwise the short-circuit below would stop the sync before captions land.
  const captionStatus: CaptionStatus = isCaptionStatus(row.caption_status) ? row.caption_status : "none";
  const captionsSettled =
    captionStatus !== "generating" && !(captionStatus === "ready" && !row.transcript);
  // "failed" is terminal, and so is a "ready" asset whose MP4 rendition resolved
  // AND whose captions have settled. A "ready" asset with a "disabled" MP4 is NOT
  // short-circuited: the poll has stopped (isActiveVideoStatus is false), but a
  // fresh load re-syncs so the self-heal below can request an adaptive rendition
  // for an asset that ended up with no usable MP4 (an older fixed-resolution
  // request Mux skipped).
  if (
    current === "failed" ||
    (current === "ready" && row.mp4_status === "ready" && captionsSettled)
  ) {
    return buildVideoAssetView(row);
  }
  if (!provider.isConfigured()) {
    return buildVideoAssetView(row);
  }

  try {
    let upload = null;
    let asset = null;
    let assetId = row.mux_asset_id;

    if (!assetId && row.mux_upload_id) {
      upload = await provider.getUpload(row.mux_upload_id);
      if (upload.assetId) assetId = upload.assetId;
    }
    if (assetId) {
      asset = await provider.getAsset(assetId);
    }

    const fields = reconcileMuxState({ upload, asset });

    // Self-heal: a ready video asset with no usable MP4 (its only requested
    // rendition was skipped — a fixed resolution larger than the source) — ask the
    // provider for an adaptive rendition ONCE and report it as preparing so the
    // poll fills in mp4_url. Guards that make this TERMINATE (no retry loop):
    //  - genuine video only (has an aspect ratio) so audio-only isn't re-requested;
    //  - only when NO adaptive rendition already exists (`adaptiveMp4Present`) — if
    //    one is present but unusable, re-requesting can't help, so we leave it
    //    disabled (poster + honest message) instead of looping.
    if (
      asset &&
      fields.status === "ready" &&
      fields.mp4_status === "disabled" &&
      !fields.mp4_url &&
      asset.playbackId &&
      asset.aspectRatio &&
      !asset.adaptiveMp4Present &&
      typeof provider.addMp4Rendition === "function"
    ) {
      try {
        await provider.addMp4Rendition(asset.assetId);
        fields.mp4_status = "preparing";
        console.log(JSON.stringify({ tag: "video_mp4_reheal", assetId: asset.assetId }));
      } catch (err) {
        // Best-effort: if we can't add a rendition, leave it disabled (the block
        // stays ready and shows the poster — no infinite spinner).
        console.log(
          JSON.stringify({ tag: "video_mp4_reheal_error", message: (err as Error).message })
        );
      }
    }

    // Only write when something changed (avoid needless updates/updated_at churn).
    const patch: VideoAssetUpdate = {};
    if (fields.status !== row.status) patch.status = fields.status;
    if (fields.mux_asset_id !== undefined && fields.mux_asset_id !== row.mux_asset_id)
      patch.mux_asset_id = fields.mux_asset_id;
    if (fields.mux_playback_id !== undefined && fields.mux_playback_id !== row.mux_playback_id)
      patch.mux_playback_id = fields.mux_playback_id;
    if (fields.duration_seconds !== undefined && fields.duration_seconds !== row.duration_seconds)
      patch.duration_seconds = fields.duration_seconds;
    if (fields.aspect_ratio !== undefined && fields.aspect_ratio !== row.aspect_ratio)
      patch.aspect_ratio = fields.aspect_ratio;
    if (fields.mp4_url !== undefined && fields.mp4_url !== row.mp4_url) patch.mp4_url = fields.mp4_url;
    if (fields.mp4_status !== undefined && fields.mp4_status !== row.mp4_status)
      patch.mp4_status = fields.mp4_status;
    if (fields.error !== undefined && fields.error !== row.error) patch.error = fields.error;

    // Caption fields — present in `fields` ONLY when Mux listed a caption track, so
    // this never downgrades a freshly-requested "generating" row before the track
    // appears. (deriveCaptionFields ran inside reconcileMuxState.)
    if (fields.caption_status !== undefined && fields.caption_status !== row.caption_status)
      patch.caption_status = fields.caption_status;
    if (fields.caption_track_id !== undefined && fields.caption_track_id !== row.caption_track_id)
      patch.caption_track_id = fields.caption_track_id;
    if (fields.caption_track_name !== undefined && fields.caption_track_name !== row.caption_track_name)
      patch.caption_track_name = fields.caption_track_name;
    if (
      fields.caption_language_code !== undefined &&
      fields.caption_language_code !== row.caption_language_code
    )
      patch.caption_language_code = fields.caption_language_code;
    if (fields.caption_source !== undefined && fields.caption_source !== row.caption_source)
      patch.caption_source = fields.caption_source;
    if (fields.caption_error !== undefined && fields.caption_error !== row.caption_error)
      patch.caption_error = fields.caption_error;

    // Transcript fetch — once a caption track is ready and we don't yet have the
    // transcript, pull the WebVTT (public playback, no auth) and derive a plain
    // transcript. Off the pure path (it's a network read) and gated so it runs at
    // most once. Best-effort: a failure just leaves the transcript for next poll.
    const captionTrackId = patch.caption_track_id ?? row.caption_track_id ?? null;
    const captionReady = (patch.caption_status ?? row.caption_status) === "ready";
    const playbackId = fields.mux_playback_id ?? row.mux_playback_id ?? null;
    if (
      captionReady &&
      !row.transcript &&
      playbackId &&
      captionTrackId &&
      typeof provider.fetchCaptionVtt === "function"
    ) {
      try {
        const vtt = await provider.fetchCaptionVtt(playbackId, captionTrackId);
        if (vtt) {
          patch.transcript_vtt = vtt;
          patch.transcript = plainTextFromVtt(vtt);
          patch.transcript_updated_at = new Date().toISOString();
          console.log(
            JSON.stringify({ tag: "video_transcript_fetched", assetId: row.mux_asset_id, chars: patch.transcript.length })
          );
        }
      } catch (err) {
        console.log(
          JSON.stringify({ tag: "video_transcript_fetch_error", message: (err as Error).message })
        );
      }
    }

    if (Object.keys(patch).length === 0) return buildVideoAssetView(row);

    const res = await updateVideoAsset(supabase, row.id, patch);
    if ("error" in res) {
      console.log(JSON.stringify({ tag: "video_sync_update_error", message: res.error }));
      return buildVideoAssetView(row);
    }
    return buildVideoAssetView(res.row);
  } catch (err) {
    const status = err instanceof VideoProviderError ? err.status : 502;
    console.log(
      JSON.stringify({ tag: "video_sync_error", status, message: (err as Error).message })
    );
    return buildVideoAssetView(row);
  }
}

/* ───────────────────────── row → client View ───────────────────────────── */

/** A recorded composite (screen+camera canvas capture) draws its black letterbox
 *  fill before the source `<video>` elements report a real frame, so the first
 *  instants of the recording are briefly solid black — Mux's default `time=0`
 *  thumbnail lands squarely on that gap. Default a beat later instead; clamp to
 *  the clip's own length so a very short recording never requests past its end. */
function defaultThumbnailTime(durationSeconds: number | null): number {
  const DEFAULT = 1;
  if (durationSeconds == null) return DEFAULT;
  return Math.min(DEFAULT, durationSeconds / 2);
}

/** Build the client-safe view, deriving public playback + thumbnail URLs from the
 *  playback id. PURE (no I/O) — the URLs are public (public playback policy). */
export function buildVideoAssetView(row: VideoAssetRow): VideoAssetView {
  const playbackId = row.mux_playback_id;
  const captionTrackId = row.caption_track_id ?? null;
  return {
    id: row.id,
    courseId: row.course_id,
    lessonId: row.lesson_id,
    blockId: row.block_id,
    provider: "mux",
    status: rowStatus(row),
    uploadId: row.mux_upload_id,
    assetId: row.mux_asset_id,
    playbackId,
    durationSeconds: row.duration_seconds,
    aspectRatio: row.aspect_ratio,
    mp4Url: row.mp4_url,
    mp4Status: (row.mp4_status as Mp4Status | null) ?? null,
    hlsUrl: playbackId ? hlsUrl(playbackId) : null,
    thumbnailUrl: playbackId
      ? thumbnailUrl(playbackId, {
          time: row.thumbnail_time ?? defaultThumbnailTime(row.duration_seconds),
          width: 640,
          fitMode: "smartcrop",
        })
      : null,
    captionStatus: isCaptionStatus(row.caption_status) ? row.caption_status : "none",
    captionTrackId,
    captionTrackName: row.caption_track_name ?? null,
    captionLanguageCode: row.caption_language_code ?? null,
    captionSource: row.caption_source ?? null,
    captionError: row.caption_error ?? null,
    captionVttUrl: viewCaptionVttUrl(playbackId, captionTrackId),
    transcript: row.transcript ?? null,
    transcriptVtt: row.transcript_vtt ?? null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
