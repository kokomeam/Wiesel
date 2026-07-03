/**
 * PURE video-status logic (no Supabase, no fetch): the lifecycle state machine,
 * the Mux-truth → row-fields reconciliation, and non-destructive trim validation.
 * Kept pure so the whole decision layer is unit-testable with no key/DB (see
 * scripts/verify-video.ts).
 */

import type { ProviderAssetInfo, ProviderCaptionTrack, ProviderUploadInfo } from "./provider/types";
import type { CaptionStatus, Mp4Status, VideoRowStatus } from "./videoTypes";

/** Legal forward transitions of the asset lifecycle. Self-transitions always
 *  allowed (idempotent writes). `ready → uploading` covers a Replace. */
const VIDEO_TRANSITIONS: Record<VideoRowStatus, VideoRowStatus[]> = {
  uploading: ["processing", "ready", "failed"],
  processing: ["ready", "failed", "uploading"],
  ready: ["uploading", "processing", "failed"],
  failed: ["uploading", "processing"],
};

export function canTransitionVideo(from: VideoRowStatus, to: VideoRowStatus): boolean {
  return from === to || VIDEO_TRANSITIONS[from].includes(to);
}

export const VIDEO_ROW_STATUSES: VideoRowStatus[] = [
  "uploading",
  "processing",
  "ready",
  "failed",
];

/** True while the asset is still moving (client should keep polling). `ready` is
 *  still "active" until the MP4 rendition resolves, so the native-<video> source
 *  fills in; a disabled/ready MP4 ends polling. Captions are asynchronous and
 *  independent of playback: while they're still `generating` we ALSO keep polling
 *  (so the Captions section updates), but that never blocks the video playing. */
export function isActiveVideoStatus(
  status: VideoRowStatus,
  mp4Status: Mp4Status | null,
  captionStatus?: CaptionStatus | null
): boolean {
  if (status === "uploading" || status === "processing") return true;
  if (status === "ready" && mp4Status === "preparing") return true;
  if (status === "ready" && captionStatus === "generating") return true;
  return false;
}

/** The subset of a `video_assets` row that a Mux sync recomputes. */
export interface MuxSyncFields {
  status: VideoRowStatus;
  mux_asset_id?: string | null;
  mux_playback_id?: string | null;
  duration_seconds?: number | null;
  aspect_ratio?: string | null;
  mp4_url?: string | null;
  mp4_status?: string | null;
  error?: string | null;
  // Caption fields — present ONLY when Mux reports a caption track (so the
  // service's changed-only write never downgrades a freshly-requested
  // "generating" row before the track appears). Never touches the transcript
  // text (that's fetched separately from the VTT, off the pure path).
  caption_status?: CaptionStatus;
  caption_track_id?: string | null;
  caption_track_name?: string | null;
  caption_language_code?: string | null;
  caption_source?: string | null;
  caption_error?: string | null;
}

/**
 * Pick the caption track to represent on the row and map it to our fields. Prefers
 * a ready track, then a preparing one, then an errored one; among equals prefers a
 * Mux-generated track. Returns null when there is no caption track at all (so the
 * caller leaves the row's caption_status untouched — e.g. a request in flight).
 */
export function deriveCaptionFields(
  captions: ProviderCaptionTrack[] | undefined
): Pick<
  MuxSyncFields,
  | "caption_status"
  | "caption_track_id"
  | "caption_track_name"
  | "caption_language_code"
  | "caption_source"
  | "caption_error"
> | null {
  if (!captions || captions.length === 0) return null;
  const rank = (t: ProviderCaptionTrack) =>
    (t.status === "ready" ? 3 : t.status === "preparing" ? 2 : 1) * 2 + (t.source === "generated" ? 1 : 0);
  const best = [...captions].sort((a, b) => rank(b) - rank(a))[0];
  const status: CaptionStatus =
    best.status === "ready" ? "ready" : best.status === "errored" ? "failed" : "generating";
  return {
    caption_status: status,
    caption_track_id: best.id,
    caption_track_name: best.name ?? null,
    caption_language_code: best.languageCode ?? null,
    caption_source: best.source,
    caption_error: status === "failed" ? "Caption generation failed." : null,
  };
}

/**
 * Reconcile Mux's authoritative state (an upload and/or asset lookup) into the
 * fields we persist. Mux is monotonic + authoritative, so this is last-write-wins
 * from Mux. Ready ⟺ the asset is ready AND the MP4 rendition is resolvable
 * (ready or disabled) — so "ready" always means the studio <video> can play it;
 * while the MP4 is still "preparing" we stay in `processing`.
 */
export function reconcileMuxState(input: {
  upload?: ProviderUploadInfo | null;
  asset?: ProviderAssetInfo | null;
}): MuxSyncFields {
  const { upload, asset } = input;

  if (asset) {
    if (asset.status === "errored") {
      return {
        status: "failed",
        mux_asset_id: asset.assetId,
        error: asset.error ?? "Mux could not process this video.",
      };
    }
    if (asset.status === "ready" && asset.playbackId) {
      // Ready as soon as the asset is playable — do NOT wait on the MP4 static
      // rendition (it's a slower second step). The MP4 fills in via continued
      // polling (isActiveVideoStatus keeps ready+mp4-preparing active), and the
      // card shows the poster until it lands. This avoids a long "processing"
      // spinner and a stuck-forever state if MP4 detection ever misses. Captions
      // (also produced after ingest) are merged in when present — never gating
      // readiness.
      return {
        status: "ready",
        mux_asset_id: asset.assetId,
        mux_playback_id: asset.playbackId,
        duration_seconds: asset.durationSeconds ?? null,
        aspect_ratio: asset.aspectRatio ?? null,
        mp4_url: asset.mp4Url ?? null,
        mp4_status: asset.mp4Status ?? null,
        error: null,
        ...(deriveCaptionFields(asset.captions) ?? {}),
      };
    }
    // asset exists but still preparing (a caption track can already be listed).
    return {
      status: "processing",
      mux_asset_id: asset.assetId,
      error: null,
      ...(deriveCaptionFields(asset.captions) ?? {}),
    };
  }

  if (upload) {
    if (upload.status === "errored" || upload.status === "cancelled" || upload.status === "timed_out") {
      return {
        status: "failed",
        error:
          upload.error ??
          (upload.status === "timed_out"
            ? "The upload timed out before it finished."
            : upload.status === "cancelled"
              ? "The upload was cancelled."
              : "The upload failed."),
      };
    }
    if (upload.status === "asset_created") {
      return { status: "processing", mux_asset_id: upload.assetId ?? null, error: null };
    }
    // still waiting for the bytes
    return { status: "uploading", error: null };
  }

  // Nothing to go on — leave as processing (a poll will refine it).
  return { status: "processing" };
}

/* ─────────────────────────────── trim ─────────────────────────────────── */

export interface TrimInput {
  trimStartSeconds?: number | null;
  trimEndSeconds?: number | null;
  /** Total video length; when known, the end is clamped to it. */
  durationSeconds?: number | null;
}

export type TrimValidation =
  | { ok: true; trimStartSeconds?: number; trimEndSeconds?: number }
  | { ok: false; error: string };

/** Minimum retained clip length (seconds) — a trim can't collapse the video. */
export const MIN_TRIM_DURATION_SECONDS = 0.5;

/**
 * Validate + normalize a non-destructive trim. Both bounds are optional (absent =
 * play from start / to end). Enforces 0 ≤ start < end ≤ duration and a minimum
 * retained length. Rounds to 2 decimals to keep the stored numbers tidy.
 */
export function validateTrim(input: TrimInput): TrimValidation {
  const dur = input.durationSeconds ?? undefined;
  const round = (n: number) => Math.round(n * 100) / 100;

  let start = input.trimStartSeconds ?? undefined;
  let end = input.trimEndSeconds ?? undefined;

  if (start !== undefined) {
    if (!Number.isFinite(start) || start < 0) return { ok: false, error: "Start time must be 0 or more." };
    start = round(start);
  }
  if (end !== undefined) {
    if (!Number.isFinite(end) || end <= 0) return { ok: false, error: "End time must be greater than 0." };
    if (dur !== undefined && end > dur + 0.05) {
      return { ok: false, error: "End time can't be past the end of the video." };
    }
    if (dur !== undefined) end = round(Math.min(end, dur));
    else end = round(end);
  }
  if (start !== undefined && end !== undefined) {
    if (start >= end) return { ok: false, error: "Start time must come before the end time." };
    if (end - start < MIN_TRIM_DURATION_SECONDS) {
      return { ok: false, error: "The trimmed clip is too short." };
    }
  }
  if (dur !== undefined && start !== undefined && start >= dur) {
    return { ok: false, error: "Start time must be before the end of the video." };
  }
  return { ok: true, trimStartSeconds: start, trimEndSeconds: end };
}

/** The effective playback window [start, end] given trim + duration. Used by the
 *  preview player to clamp playback. */
export function effectiveTrim(input: TrimInput): { start: number; end: number | null } {
  const start = Math.max(0, input.trimStartSeconds ?? 0);
  const end =
    input.trimEndSeconds != null
      ? input.trimEndSeconds
      : input.durationSeconds != null
        ? input.durationSeconds
        : null;
  return { start, end };
}

/** The kept (trimmed) length in seconds = end − start. This is the duration the
 *  clip actually plays for, so it's what the UI should show once a trim is set
 *  (not the untrimmed source length). Falls back to 0 when nothing is known. */
export function trimmedDurationSeconds(input: TrimInput): number {
  const { start, end } = effectiveTrim(input);
  const total = end ?? input.durationSeconds ?? 0;
  return Math.max(0, total - start);
}

/** Whether a real trim window is set (either bound moved off the natural edge). */
export function hasTrim(input: Pick<TrimInput, "trimStartSeconds" | "trimEndSeconds">): boolean {
  return (input.trimStartSeconds != null && input.trimStartSeconds > 0.05) || input.trimEndSeconds != null;
}
