/**
 * Pre-cut — the exact-span trim EVERY render starts from (Task 0 (a): Reap
 * re-picks inside any window, so the render provider is only ever handed
 * the final clip-length video; the in-house layouts need the span bytes
 * too).
 *
 * Mechanism: a TEMPORARY Mux clip asset (`input: mux://assets/{source}` +
 * start/end — the zero-dependency server-side trim; the media already lives
 * on Mux). Lifecycle: start → poll ready (adaptive MP4 rendition) →
 * download bytes → DELETE the temp asset (cleanup is part of the job step,
 * best-effort — a leaked asset costs storage, not correctness).
 *
 * ffmpeg-static exists in the repo (the in-house layouts need it anyway),
 * so a local-trim fallback is one function swap if Mux clipping ever
 * misbehaves — documented, not built twice.
 */

import { getVideoProvider } from "@/lib/video/provider";
import type { VideoProvider } from "@/lib/video/provider/types";

export interface PrecutStart {
  muxAssetId: string;
}

export interface PrecutState {
  status: "preparing" | "ready" | "errored";
  playbackId: string | null;
  /** The downloadable exact-span MP4 once ready. */
  mp4Url: string | null;
  error: string | null;
}

export interface PrecutOps {
  start(sourceMuxAssetId: string, startMs: number, endMs: number, passthrough: string): Promise<PrecutStart>;
  check(muxAssetId: string): Promise<PrecutState>;
  cleanup(muxAssetId: string): Promise<void>;
}

/** The production ops over the Mux provider; tests inject a fake PrecutOps. */
export function createMuxPrecutOps(provider: VideoProvider = getVideoProvider()): PrecutOps {
  return {
    async start(sourceMuxAssetId, startMs, endMs, passthrough) {
      if (!provider.createClipAsset) {
        throw new Error("video provider cannot create clip assets (pre-cut unavailable)");
      }
      const { assetId } = await provider.createClipAsset(
        sourceMuxAssetId,
        startMs / 1000,
        endMs / 1000,
        { passthrough }
      );
      return { muxAssetId: assetId };
    },
    async check(muxAssetId) {
      const asset = await provider.getAsset(muxAssetId);
      if (asset.status === "errored") {
        return { status: "errored", playbackId: null, mp4Url: null, error: asset.error ?? "clip asset errored" };
      }
      if (asset.status === "ready" && asset.mp4Url) {
        return { status: "ready", playbackId: asset.playbackId ?? null, mp4Url: asset.mp4Url, error: null };
      }
      // ready-but-mp4-preparing keeps polling — the videoStatus lesson: a
      // playable asset's MP4 rendition fills in shortly after.
      return { status: "preparing", playbackId: asset.playbackId ?? null, mp4Url: null, error: null };
    },
    async cleanup(muxAssetId) {
      try {
        await provider.deleteAsset(muxAssetId);
      } catch {
        // best-effort — a leaked temp asset is storage cost, not correctness
      }
    },
  };
}
