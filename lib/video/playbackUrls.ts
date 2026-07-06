/**
 * Pure Mux playback URL builders. PURE + deterministic (no env, no fetch), so
 * they're safe to call anywhere (server view mapping, client player) and easy to
 * test. These are for PUBLIC playback ids only — signed playback would append a
 * JWT `token`, which the (future) signed-policy path would add server-side.
 */

/** HLS manifest — for a future Mux Player / hls.js upgrade. Native <video> only
 *  plays this in Safari, so the studio prefers the MP4 rendition (see the block
 *  view's `mp4Url`); this is exposed as an extension point. */
export function hlsUrl(playbackId: string): string {
  return `https://stream.mux.com/${playbackId}.m3u8`;
}

export interface ThumbnailOptions {
  /** Frame time in seconds (default 0 / first frame). */
  time?: number;
  width?: number;
  height?: number;
  /** How the frame is fit into width×height. */
  fitMode?: "preserve" | "stretch" | "crop" | "smartcrop" | "pad";
}

/** A still poster/thumbnail from the Mux image API. */
export function thumbnailUrl(playbackId: string, opts: ThumbnailOptions = {}): string {
  const params = new URLSearchParams();
  if (opts.time !== undefined) params.set("time", String(Math.max(0, opts.time)));
  if (opts.width) params.set("width", String(opts.width));
  if (opts.height) params.set("height", String(opts.height));
  if (opts.fitMode) params.set("fit_mode", opts.fitMode);
  const qs = params.toString();
  return `https://image.mux.com/${playbackId}/thumbnail.jpg${qs ? `?${qs}` : ""}`;
}

/** A caption track as WebVTT (public playback). Extension point for a native
 *  <track>, WebVTT export, or a future Mux Player upgrade. Replace `.vtt` with
 *  `.txt` for Mux's plain-text rendition. */
export function captionVttUrl(playbackId: string, trackId: string): string {
  return `https://stream.mux.com/${playbackId}/text/${trackId}.vtt`;
}

/** A short animated preview (GIF) — handy for hover previews later. */
export function animatedThumbnailUrl(
  playbackId: string,
  opts: { start?: number; end?: number; width?: number } = {}
): string {
  const params = new URLSearchParams();
  if (opts.start !== undefined) params.set("start", String(Math.max(0, opts.start)));
  if (opts.end !== undefined) params.set("end", String(opts.end));
  if (opts.width) params.set("width", String(opts.width));
  const qs = params.toString();
  return `https://image.mux.com/${playbackId}/animated.gif${qs ? `?${qs}` : ""}`;
}
