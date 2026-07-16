/**
 * Mux implementation of the `VideoProvider` seam — the ONLY file that knows Mux's
 * HTTP shape. No Mux SDK: the Mux Video REST API is plain JSON + HTTP Basic auth,
 * so a tiny fetch wrapper keeps the runtime dependency count unchanged and the
 * blast radius one file. Server-only (reads MUX_TOKEN_ID / MUX_TOKEN_SECRET /
 * MUX_WEBHOOK_SIGNING_SECRET) — never import into client code.
 *
 * Direct-upload flow: we create an upload, the browser PUTs the recording bytes
 * straight to Mux (never through our server / storage), and Mux ingests + encodes
 * an asset. We request a `highest` MP4 static rendition so a downloadable MP4 exists
 * — that plays in a native <video> in every browser without an HLS library (see
 * playbackUrls.ts). `highest` is the RIGHT choice: it renders at the source's OWN
 * resolution, so it's never skipped for upscaling and is accepted on every asset
 * tier. A fixed resolution (e.g. `720p`) is SKIPPED whenever the source is smaller,
 * silently leaving the asset with no MP4. NOTE: read the rendition off
 * `static_renditions.files` — do NOT gate on `mp4_support`, which the modern
 * renditions API always reports as "none" even for a healthy asset. `passthrough`
 * carries our `video_assets` row id back on the asset + webhooks so we never need a
 * Mux→row lookup table.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CreateUploadOptions,
  ProviderAssetInfo,
  ProviderCaptionTrack,
  ProviderDirectUpload,
  ProviderMp4Status,
  ProviderUploadInfo,
  ProviderUploadStatus,
  ProviderWebhookEvent,
  VideoProvider,
} from "./types";
import { VideoProviderError } from "./types";

const MUX_API_BASE = "https://api.mux.com";

/** Public stream host — caption WebVTT/plain-text live here (no auth for public
 *  playback): https://stream.mux.com/{playbackId}/text/{trackId}.vtt */
const MUX_STREAM_BASE = "https://stream.mux.com";

/** Max seconds a direct-upload URL stays valid. 1h is plenty for one recording. */
const UPLOAD_URL_TTL_SECONDS = 3600;

/** Signature freshness window (seconds) — rejects replays of an old signed body. */
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Valid Mux static-rendition resolution INPUTS for `static_renditions: [{resolution}]`
 * (per the Mux API — audio-only excluded here since we always want video).
 *
 * `highest` is the adaptive default: it renders at the source's own resolution, so
 * it's NEVER skipped for upscaling and is accepted on every asset tier. The numeric
 * resolutions are fixed: Mux SKIPS one whenever the source is smaller than it, which
 * can silently leave the asset with no MP4 — allow them for deliberate overrides
 * only. (Note: `capped-1080p` is a rendition NAME Mux can emit, but NOT a valid
 * resolution INPUT — Mux rejects it with a 400 — so it's intentionally absent here.)
 */
const ALLOWED_MP4_RESOLUTIONS = new Set([
  "highest",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "540p",
  "480p",
  "360p",
  "270p",
]);

/** The adaptive rendition we default to (and self-heal to) — never upscale-skipped,
 *  accepted on every tier. */
export const ADAPTIVE_MP4_RESOLUTION = "highest";

/**
 * Resolution of the downloadable MP4 the studio plays. Default `highest` — an
 * adaptive rendition rendered at the source resolution, so EVERY asset ends up with
 * a playable MP4 (never skipped). Override with `MUX_MP4_RESOLUTION` to a fixed size
 * like `720p` to trade quality for size — but a fixed size is SKIPPED for any source
 * smaller than it, so prefer the adaptive default unless you control the source.
 */
function mp4Resolution(): string {
  const r = process.env.MUX_MP4_RESOLUTION?.trim().toLowerCase();
  return r && ALLOWED_MP4_RESOLUTIONS.has(r) ? r : ADAPTIVE_MP4_RESOLUTION;
}

function readCreds(): { id: string; secret: string } | null {
  const id = process.env.MUX_TOKEN_ID;
  const secret = process.env.MUX_TOKEN_SECRET;
  if (!id || !secret) return null;
  return { id, secret };
}

/** Env presence (booleans only — never the values) for startup logging. */
export function muxEnvStatus(): Record<string, boolean> {
  return {
    MUX_TOKEN_ID: Boolean(process.env.MUX_TOKEN_ID),
    MUX_TOKEN_SECRET: Boolean(process.env.MUX_TOKEN_SECRET),
    MUX_WEBHOOK_SIGNING_SECRET: Boolean(process.env.MUX_WEBHOOK_SIGNING_SECRET),
  };
}

async function muxFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const creds = readCreds();
  if (!creds) {
    throw new VideoProviderError(
      "Mux is not configured (set MUX_TOKEN_ID and MUX_TOKEN_SECRET).",
      503
    );
  }
  const auth = Buffer.from(`${creds.id}:${creds.secret}`).toString("base64");
  let res: Response;
  try {
    res = await fetch(`${MUX_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      // Mux calls are quick; keep them off any Next cache.
      cache: "no-store",
    });
  } catch (err) {
    throw new VideoProviderError(`Mux request failed: ${(err as Error).message}`, 502);
  }
  if (res.status === 204) return undefined as unknown as T;
  const text = await res.text();
  if (!res.ok) {
    // Mux error body: { error: { type, messages: [...] } }
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { messages?: string[] } };
      if (parsed.error?.messages?.length) detail = parsed.error.messages.join("; ");
    } catch {
      /* keep raw text */
    }
    throw new VideoProviderError(`Mux ${res.status}: ${detail || res.statusText}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new VideoProviderError("Mux returned a non-JSON response.", 502);
  }
}

/* ────────────────────────── response normalization ─────────────────────── */

interface MuxUpload {
  id: string;
  status: string;
  asset_id?: string;
  error?: { type?: string; message?: string };
  new_asset_settings?: unknown;
}

interface MuxPlaybackId {
  id: string;
  policy?: string;
}

interface MuxStaticRenditionFile {
  name?: string;
  ext?: string;
  height?: number;
  width?: number;
  bitrate?: number;
  /** Create-time resolution option: "highest" | "audio-only" | a fixed size. */
  resolution?: string;
  /** Newer renditions carry the produced tier (e.g. "720p", "audio-only"). */
  resolution_tier?: string;
  /** Per-file status on the modern (array-input) renditions API. Absent on the
   *  legacy `mp4_support` shape (there only the parent `status` is set). */
  status?: string;
}

/** A track on the asset. Audio tracks carry the id we need to trigger generated
 *  subtitles; text tracks are the captions themselves. */
interface MuxTrack {
  id?: string;
  type?: string; // "video" | "audio" | "text"
  text_type?: string; // "subtitles" for captions
  text_source?: string; // "generated_vod" for auto-captions, else uploaded
  status?: string; // "preparing" | "ready" | "errored"
  language_code?: string;
  name?: string;
  primary?: boolean;
}

interface MuxAsset {
  id: string;
  status: string;
  duration?: number;
  aspect_ratio?: string;
  playback_ids?: MuxPlaybackId[];
  mp4_support?: string;
  static_renditions?: {
    status?: string;
    files?: MuxStaticRenditionFile[];
  };
  tracks?: MuxTrack[];
  passthrough?: string;
  errors?: { messages?: string[] };
}

function normalizeUploadStatus(status: string): ProviderUploadStatus {
  switch (status) {
    case "asset_created":
      return "asset_created";
    case "errored":
      return "errored";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    default:
      return "waiting";
  }
}

function fileName(f: MuxStaticRenditionFile): string | undefined {
  if (f.name) return f.name;
  const tier = f.resolution_tier ?? f.resolution;
  return tier && tier !== "audio-only" ? `${tier}.mp4` : undefined;
}

function isAudioRendition(f: MuxStaticRenditionFile): boolean {
  const name = (f.name ?? "").toLowerCase();
  return (
    name.includes("audio") ||
    (f.ext ?? "").toLowerCase() === "m4a" ||
    f.resolution === "audio-only" ||
    f.resolution_tier === "audio-only"
  );
}

/** Whether an asset already has an adaptive `highest` rendition (in ANY state) —
 *  used by the self-heal to avoid re-requesting one that's present. */
function hasAdaptiveMp4(asset: MuxAsset): boolean {
  return (asset.static_renditions?.files ?? []).some(
    (f) => f.resolution === "highest" || (f.name ?? "").toLowerCase() === "highest.mp4"
  );
}

/** Choose the best non-audio MP4 static rendition and build its stream URL.
 *  Identifies the rendition by its file NAME (the MP4 URL is always
 *  `https://stream.mux.com/{playbackId}/{file.name}`).
 *
 *  IMPORTANT: this looks ONLY at `static_renditions.files` + their per-file status —
 *  NOT `mp4_support`. The modern `static_renditions: [{resolution}]` API always
 *  reports `mp4_support: "none"` even while it produces (and finishes) renditions,
 *  so gating on `mp4_support` wrongly hides a perfectly good MP4. Status:
 *   - a READY video file → "ready" (+ URL);
 *   - a video file still generating → "preparing" (the poll keeps going);
 *   - video renditions exist but none is (or will be) usable — all skipped/errored,
 *     or the set is explicitly disabled → "disabled" so the block goes ready
 *     (poster) instead of spinning forever.
 */
function resolveMp4(
  asset: MuxAsset,
  playbackId: string | undefined
): { mp4Url?: string; mp4Status: ProviderMp4Status } {
  if (!playbackId) return { mp4Status: "preparing" };
  const sr = asset.static_renditions;

  const videoFiles = (sr?.files ?? []).filter((f) => !isAudioRendition(f));
  // A file whose per-file status is ready (or the legacy shape, which lists files
  // without a per-file status only once the parent set is ready).
  const ready = videoFiles
    .filter((f) => (f.status ?? "ready") === "ready" && fileName(f))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  if (ready) {
    return { mp4Url: `https://stream.mux.com/${playbackId}/${fileName(ready)}`, mp4Status: "ready" };
  }
  // Still generating a video rendition → keep polling.
  if (videoFiles.some((f) => f.status === "preparing")) {
    return { mp4Status: "preparing" };
  }
  // Video renditions exist but none is usable (all skipped/errored), or the set is
  // explicitly disabled/skipped/errored → no MP4 is coming. Report "disabled" so the
  // block goes ready and the poll stops rather than spinning forever. (We do NOT use
  // `mp4_support` here: the modern renditions API always reports it as "none" even
  // for a healthy asset, so it would wrongly disable a brand-new asset whose
  // renditions simply haven't been listed yet.)
  if (
    videoFiles.length > 0 ||
    sr?.status === "disabled" ||
    sr?.status === "skipped" ||
    sr?.status === "errored"
  ) {
    return { mp4Status: "disabled" };
  }
  // No renditions listed yet — they're produced after the main encode, so keep
  // polling; the file we requested (`highest`) will appear shortly.
  return { mp4Status: "preparing" };
}

/** Normalize the asset's text tracks into caption tracks (subtitles/captions). */
function captionTracks(asset: MuxAsset): ProviderCaptionTrack[] {
  return (asset.tracks ?? [])
    .filter((t) => t.type === "text" && t.id)
    .map((t) => ({
      id: t.id as string,
      languageCode: t.language_code,
      name: t.name,
      status: t.status === "ready" ? "ready" : t.status === "errored" ? "errored" : "preparing",
      source: t.text_source === "generated_vod" ? "generated" : "uploaded",
    }));
}

/** The id of the primary (or first) audio track — the track generated subtitles
 *  are requested against on an already-ready asset. */
function audioTrackId(asset: MuxAsset): string | undefined {
  const audio = (asset.tracks ?? []).filter((t) => t.type === "audio" && t.id);
  return (audio.find((t) => t.primary) ?? audio[0])?.id;
}

function normalizeAsset(asset: MuxAsset): ProviderAssetInfo {
  const publicPlayback =
    asset.playback_ids?.find((p) => p.policy === "public") ?? asset.playback_ids?.[0];
  const playbackId = publicPlayback?.id;
  const status: ProviderAssetInfo["status"] =
    asset.status === "ready" ? "ready" : asset.status === "errored" ? "errored" : "preparing";
  const { mp4Url, mp4Status } = resolveMp4(asset, playbackId);
  return {
    assetId: asset.id,
    status,
    playbackId,
    playbackPolicy: publicPlayback?.policy === "signed" ? "signed" : "public",
    durationSeconds: typeof asset.duration === "number" ? asset.duration : undefined,
    aspectRatio: asset.aspect_ratio,
    mp4Url,
    mp4Status,
    adaptiveMp4Present: hasAdaptiveMp4(asset),
    captions: captionTracks(asset),
    audioTrackId: audioTrackId(asset),
    passthrough: asset.passthrough,
    error: asset.errors?.messages?.join("; "),
  };
}

/* ────────────────────────────── the provider ──────────────────────────── */

class MuxProvider implements VideoProvider {
  readonly id = "mux" as const;

  isConfigured(): boolean {
    return readCreds() !== null;
  }

  async createDirectUpload(opts: CreateUploadOptions): Promise<ProviderDirectUpload> {
    // Auto-generated captions: for a DIRECT upload the first `inputs` entry omits
    // `url` (the uploaded file IS the input) and carries `generated_subtitles`.
    // Mux transcribes AFTER ingest, so the text track appears in `preparing` state
    // once the asset is ready — it never delays playback. (Verified against Mux
    // docs — do NOT guess this shape; see the video-captions memory.)
    const inputs = opts.generateSubtitles
      ? [
          {
            generated_subtitles: [
              {
                language_code: opts.generateSubtitles.languageCode,
                name: opts.generateSubtitles.name,
              },
            ],
          },
        ]
      : undefined;
    const body = {
      cors_origin: opts.corsOrigin || "*",
      timeout: UPLOAD_URL_TTL_SECONDS,
      new_asset_settings: {
        playback_policy: ["public"],
        // Request a downloadable MP4 static rendition so a native <video> plays
        // everywhere without an HLS library. `static_renditions` is the modern
        // replacement for the deprecated `mp4_support: "standard"` (which Mux now
        // rejects on the default asset tier). Default `highest` — adaptive (renders
        // at the source resolution) so it's NEVER skipped and is a valid resolution
        // input on every tier. Read back from static_renditions.files.
        static_renditions: [{ resolution: mp4Resolution() }],
        ...(inputs ? { inputs } : {}),
        passthrough: opts.passthrough,
      },
    };
    const res = await muxFetch<{ data: { id: string; url: string } }>("/video/v1/uploads", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.data?.id || !res.data?.url) {
      throw new VideoProviderError("Mux did not return an upload URL.", 502);
    }
    return { uploadId: res.data.id, uploadUrl: res.data.url };
  }

  async getUpload(uploadId: string): Promise<ProviderUploadInfo> {
    const res = await muxFetch<{ data: MuxUpload }>(
      `/video/v1/uploads/${encodeURIComponent(uploadId)}`
    );
    const d = res.data;
    return {
      uploadId: d.id,
      status: normalizeUploadStatus(d.status),
      assetId: d.asset_id,
      error: d.error?.message,
    };
  }

  async getAsset(assetId: string): Promise<ProviderAssetInfo> {
    const res = await muxFetch<{ data: MuxAsset }>(
      `/video/v1/assets/${encodeURIComponent(assetId)}`
    );
    const a = res.data;
    // Diagnostic (safe): surfaces the real static_renditions shape so MP4
    // detection can be verified against the live response.
    console.log(
      JSON.stringify({
        tag: "mux_get_asset",
        id: a.id,
        status: a.status,
        mp4Support: a.mp4_support ?? null,
        srStatus: a.static_renditions?.status ?? null,
        srFiles: (a.static_renditions?.files ?? []).map(
          (f) => `${f.name ?? f.resolution ?? f.ext ?? "?"}:${f.status ?? "?"}`
        ),
        tracks: (a.tracks ?? []).map(
          (t) => `${t.type ?? "?"}${t.type === "text" ? `/${t.text_source ?? "?"}` : ""}:${t.status ?? "?"}`
        ),
      })
    );
    return normalizeAsset(a);
  }

  async deleteAsset(assetId: string): Promise<void> {
    await muxFetch<void>(`/video/v1/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
  }

  /** Create a TEMPORARY clip asset from an existing asset (the clips render
   *  pre-cut). Requests the adaptive MP4 rendition so the pipeline can
   *  download the exact-span bytes; public policy (the source lesson assets
   *  are public-policy too). The caller polls getAsset and deletes after
   *  download. */
  async createClipAsset(
    sourceAssetId: string,
    startSeconds: number,
    endSeconds: number,
    opts: { passthrough?: string } = {}
  ): Promise<{ assetId: string }> {
    const body = {
      input: [
        {
          url: `mux://assets/${sourceAssetId}`,
          start_time: startSeconds,
          end_time: endSeconds,
        },
      ],
      playback_policy: ["public"],
      static_renditions: [{ resolution: ADAPTIVE_MP4_RESOLUTION }],
      ...(opts.passthrough ? { passthrough: opts.passthrough } : {}),
    };
    const res = await muxFetch<{ data: { id?: string } }>("/video/v1/assets", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.data?.id) {
      throw new VideoProviderError("Mux did not return a clip asset id.", 502);
    }
    return { assetId: res.data.id };
  }

  /** Add a static MP4 rendition to an EXISTING asset (self-heal for an older asset
   *  whose only requested rendition was skipped — e.g. a fixed size larger than the
   *  source). Idempotent: a 400 that says the rendition ALREADY EXISTS is treated as
   *  success. Any other 400 (e.g. an invalid resolution) is re-thrown so the caller
   *  can log it and NOT enter a retry loop. */
  async addMp4Rendition(assetId: string, resolution?: string): Promise<void> {
    const res = resolution?.trim().toLowerCase();
    const chosen = res && ALLOWED_MP4_RESOLUTIONS.has(res) ? res : ADAPTIVE_MP4_RESOLUTION;
    try {
      await muxFetch<{ data: unknown }>(
        `/video/v1/assets/${encodeURIComponent(assetId)}/static-renditions`,
        { method: "POST", body: JSON.stringify({ resolution: chosen }) }
      );
    } catch (err) {
      if (err instanceof VideoProviderError && err.status === 400 && /already exist/i.test(err.message)) {
        return; // the rendition is already present — nothing to do
      }
      throw err;
    }
  }

  /** Request Mux auto-generated subtitles for an existing asset's audio track.
   *  POST /video/v1/assets/{ASSET_ID}/tracks/{AUDIO_TRACK_ID}/generate-subtitles
   *  (verified against Mux docs). A 400 that says a matching track already exists
   *  is swallowed (idempotent); any other 400 is re-thrown so callers don't loop. */
  async requestGeneratedSubtitles(
    assetId: string,
    trackId: string,
    opts: { languageCode: string; name: string }
  ): Promise<void> {
    try {
      await muxFetch<{ data: unknown }>(
        `/video/v1/assets/${encodeURIComponent(assetId)}/tracks/${encodeURIComponent(trackId)}/generate-subtitles`,
        {
          method: "POST",
          body: JSON.stringify({
            generated_subtitles: [{ language_code: opts.languageCode, name: opts.name }],
          }),
        }
      );
    } catch (err) {
      if (err instanceof VideoProviderError && err.status === 400 && /already exist/i.test(err.message)) {
        return;
      }
      throw err;
    }
  }

  /** Fetch a caption track as raw WebVTT (public playback — no auth). Returns null
   *  if it isn't ready yet / on any transient failure (the caller degrades). */
  async fetchCaptionVtt(playbackId: string, trackId: string): Promise<string | null> {
    try {
      const res = await fetch(
        `${MUX_STREAM_BASE}/${encodeURIComponent(playbackId)}/text/${encodeURIComponent(trackId)}.vtt`,
        { cache: "no-store" }
      );
      if (!res.ok) return null;
      const text = await res.text();
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
    const secret = process.env.MUX_WEBHOOK_SIGNING_SECRET;
    // No secret configured → verification is opt-out (dev). Callers log this.
    if (!secret) return true;
    if (!signatureHeader) return false;
    // Header format: "t=<unix>,v1=<hex hmac>"
    const parts = Object.fromEntries(
      signatureHeader.split(",").map((kv) => {
        const [k, v] = kv.split("=");
        return [k?.trim(), v?.trim()];
      })
    ) as { t?: string; v1?: string };
    if (!parts.t || !parts.v1) return false;
    const ts = Number(parts.t);
    if (!Number.isFinite(ts)) return false;
    // Reject stale signatures (replay protection). `t` is in seconds.
    const nowSec = Date.now() / 1000;
    if (Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;
    const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(parts.v1, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parseWebhookEvent(rawBody: string): ProviderWebhookEvent | null {
    let parsed: {
      type?: string;
      data?: { id?: string; asset_id?: string; upload_id?: string; passthrough?: string };
    };
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!parsed.type || !parsed.data) return null;
    const type = parsed.type;
    const d = parsed.data;
    const isAssetEvent = type.startsWith("video.asset.");
    const isUploadEvent = type.startsWith("video.upload.");
    // A track event (e.g. video.asset.track.ready) carries the TRACK id in `data.id`
    // and the asset id in `data.asset_id` — so we must NOT read `data.id` as the
    // asset id here (that would misroute the webhook). Route it by `data.asset_id`.
    const isTrackEvent = type.startsWith("video.asset.track.");
    const assetId = isTrackEvent
      ? d.asset_id ?? null
      : isAssetEvent
        ? d.id ?? null
        : d.asset_id ?? null;
    return {
      type,
      objectId: d.id ?? null,
      assetId,
      uploadId: isUploadEvent ? d.id ?? null : d.upload_id ?? null,
      passthrough: d.passthrough ?? null,
    };
  }
}

/** Singleton — the process-wide Mux provider. */
export const muxProvider: VideoProvider = new MuxProvider();
