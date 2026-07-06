/**
 * Provider-agnostic video hosting seam.
 *
 * Everything above this layer (service, routes, UI) speaks ONLY these normalized
 * shapes — never a provider's raw JSON. Mux is the sole implementation today
 * (`muxClient.ts`), but a second provider would implement `VideoProvider` and
 * nothing else would change. This mirrors the `ModelClient` seam used for the AI
 * provider (lib/ai/modelClient.ts): the provider SDK/HTTP lives in exactly one
 * file.
 */

/** A freshly-created direct upload the browser PUTs the recording bytes to. */
export interface ProviderDirectUpload {
  uploadId: string;
  /** The one-time URL the client uploads the file to (never persisted). */
  uploadUrl: string;
}

/** Lifecycle of a direct upload, normalized across providers. */
export type ProviderUploadStatus =
  | "waiting" // URL issued, bytes not fully received yet
  | "asset_created" // upload complete, provider is creating the asset
  | "errored"
  | "cancelled"
  | "timed_out";

export interface ProviderUploadInfo {
  uploadId: string;
  status: ProviderUploadStatus;
  /** Present once the provider has created the asset from the upload. */
  assetId?: string;
  error?: string;
}

/** Lifecycle of the encoded asset, normalized across providers. */
export type ProviderAssetStatus = "preparing" | "ready" | "errored";

/** Readiness of the downloadable MP4 (static rendition) used by the <video> tag. */
export type ProviderMp4Status = "preparing" | "ready" | "disabled";

/** A text (subtitle/caption) track on the asset, normalized. `source` is
 *  `generated` for Mux auto-captions (Mux `text_source: "generated_vod"`) and
 *  `uploaded` for an educator-supplied track (extension point). */
export interface ProviderCaptionTrack {
  id: string;
  languageCode?: string;
  name?: string;
  status: "preparing" | "ready" | "errored";
  source: "generated" | "uploaded";
}

export interface ProviderAssetInfo {
  assetId: string;
  status: ProviderAssetStatus;
  /** The public playback id (the only id the browser needs). */
  playbackId?: string;
  playbackPolicy?: "public" | "signed";
  durationSeconds?: number;
  /** Aspect ratio string, e.g. "16:9". */
  aspectRatio?: string;
  /** Resolved MP4 URL (static rendition) once ready — plays in a native
   *  <video> everywhere without an HLS library. Absent until ready/if disabled. */
  mp4Url?: string;
  mp4Status?: ProviderMp4Status;
  /** Whether an adaptive (source-resolution) MP4 rendition already exists on the
   *  asset in any state. When true the self-heal must NOT request another one (it
   *  would loop): the adaptive rendition is either coming or has genuinely failed. */
  adaptiveMp4Present?: boolean;
  /** Text (caption/subtitle) tracks present on the asset, if any. */
  captions?: ProviderCaptionTrack[];
  /** The primary audio track id — needed to request generated subtitles on an
   *  already-ready asset (the "Generate captions" path). */
  audioTrackId?: string;
  /** The passthrough token we set at upload time (our `video_assets` row id),
   *  echoed back so webhooks can be routed without a lookup table. */
  passthrough?: string;
  error?: string;
}

export interface CreateUploadOptions {
  /** Restrict the upload URL's CORS to this origin (the app origin). "*" in dev. */
  corsOrigin: string;
  /** Opaque token echoed back on the asset + webhooks (we pass the row id). */
  passthrough: string;
  /** When set, request Mux auto-generated subtitles for this language at ingest
   *  (asynchronous — never blocks the asset going `ready`). Omit to skip. */
  generateSubtitles?: { languageCode: string; name: string } | null;
}

/** A normalized webhook event: enough to route + refresh without provider shapes. */
export interface ProviderWebhookEvent {
  /** Raw provider event type, e.g. "video.asset.ready". */
  type: string;
  /** The primary object id (asset id for asset.* events, upload id for upload.*). */
  objectId: string | null;
  /** Asset id when derivable (asset.* events, or upload.asset_created). */
  assetId: string | null;
  uploadId: string | null;
  /** Our passthrough token (the `video_assets` row id) when present. */
  passthrough: string | null;
}

/**
 * The seam every consumer depends on. `verifyWebhookSignature` returns false when
 * a signing secret is configured and the signature doesn't match; when NO secret
 * is configured it returns true (dev/opt-out) — callers log that fact.
 */
export interface VideoProvider {
  readonly id: "mux";
  isConfigured(): boolean;
  createDirectUpload(opts: CreateUploadOptions): Promise<ProviderDirectUpload>;
  getUpload(uploadId: string): Promise<ProviderUploadInfo>;
  getAsset(assetId: string): Promise<ProviderAssetInfo>;
  deleteAsset(assetId: string): Promise<void>;
  /** Add a downloadable MP4 static rendition to an EXISTING asset — the recovery
   *  path when an asset ended up with no usable MP4 (a fixed rendition Mux skipped
   *  because it was larger than the source). `resolution` is provider-specific and
   *  optional; omit it to let the provider pick its adaptive default. Idempotent on
   *  an already-present rendition. Optional so a minimal provider can omit it (the
   *  caller guards). */
  addMp4Rendition?(assetId: string, resolution?: string): Promise<void>;
  /** Request auto-generated subtitles for an ALREADY-ready asset's audio track
   *  (the "Generate captions" button / a retry). Idempotent on an already-present
   *  request. Optional so a minimal provider can omit it (the caller guards). */
  requestGeneratedSubtitles?(
    assetId: string,
    audioTrackId: string,
    opts: { languageCode: string; name: string }
  ): Promise<void>;
  /** Fetch a caption track as raw WebVTT text (public playback). Returns null if
   *  it isn't available yet / on a transient error. Optional (caller guards). */
  fetchCaptionVtt?(playbackId: string, trackId: string): Promise<string | null>;
  /** True if the raw body is authentic (or no secret configured). */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean;
  parseWebhookEvent(rawBody: string): ProviderWebhookEvent | null;
}

/** Thrown by the provider for a non-2xx / malformed response. Carries an HTTP-ish
 *  status so routes can map it (404 → not found, else 502). */
export class VideoProviderError extends Error {
  constructor(
    message: string,
    readonly status: number = 502
  ) {
    super(message);
    this.name = "VideoProviderError";
  }
}
