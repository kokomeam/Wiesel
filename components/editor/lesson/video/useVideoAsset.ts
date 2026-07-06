"use client";

/**
 * Client hook for one video asset. Fetches the server view (Mux-synced status +
 * playback/thumbnail URLs) via the asset-status endpoint, POLLS while the asset
 * is still moving (uploading/processing, or ready-but-MP4-preparing), and exposes
 * a delete action. Mirrors the imported-deck `useDeckImport` pattern.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isActiveVideoStatus } from "@/lib/video/videoStatus";
import type { VideoAssetView, VideoRowStatus } from "@/lib/video/videoTypes";

interface State {
  view: VideoAssetView | null;
  loading: boolean;
  error: string | null;
}

export interface UseVideoAsset extends State {
  refetch: () => Promise<VideoAssetView | null>;
  remove: () => Promise<boolean>;
}

export function useVideoAsset(
  videoAssetId: string | null | undefined,
  opts?: { initialStatus?: VideoRowStatus; pollMs?: number }
): UseVideoAsset {
  const pollMs = opts?.pollMs ?? 3000;
  const [state, setState] = useState<State>({ view: null, loading: Boolean(videoAssetId), error: null });
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const fetchOnce = useCallback(async (): Promise<VideoAssetView | null> => {
    if (!videoAssetId || inFlight.current) return null;
    inFlight.current = true;
    try {
      const res = await fetch("/api/video/mux/asset-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoAssetId }),
        cache: "no-store",
      });
      if (!mounted.current) return null;
      if (!res.ok) {
        setState((s) => ({
          view: s.view,
          loading: false,
          error: res.status === 404 ? "This video is no longer available." : "Couldn't load this video.",
        }));
        return null;
      }
      const view = (await res.json()) as VideoAssetView;
      if (!mounted.current) return view;
      setState({ view, loading: false, error: null });
      return view;
    } catch {
      if (mounted.current) setState((s) => ({ ...s, loading: false, error: "Couldn't load this video." }));
      return null;
    } finally {
      inFlight.current = false;
    }
  }, [videoAssetId]);

  useEffect(() => {
    mounted.current = true;
    if (!videoAssetId) return; // no asset → the derived return below reports empty
    const t = setTimeout(() => void fetchOnce(), 0);
    return () => {
      mounted.current = false;
      clearTimeout(t);
    };
  }, [fetchOnce, videoAssetId]);

  // Derive the reported state from videoAssetId so a null id never needs a
  // synchronous setState in the effect (React 19 forbids that).
  const view = videoAssetId ? state.view : null;
  const loading = videoAssetId ? state.loading : false;
  const error = videoAssetId ? state.error : null;

  const liveStatus = view?.status ?? opts?.initialStatus ?? "processing";
  const mp4Status = view?.mp4Status ?? null;
  const captionStatus = view?.captionStatus ?? null;
  const isActive = Boolean(videoAssetId) && isActiveVideoStatus(liveStatus, mp4Status, captionStatus);
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => void fetchOnce(), pollMs);
    return () => clearInterval(interval);
  }, [isActive, fetchOnce, pollMs]);

  const refetch = useCallback(() => fetchOnce(), [fetchOnce]);

  const remove = useCallback(async () => {
    if (!videoAssetId) return true;
    try {
      const res = await fetch(`/api/video/${videoAssetId}`, { method: "DELETE" });
      return res.ok;
    } catch {
      return false;
    }
  }, [videoAssetId]);

  return { view, loading, error, refetch, remove };
}
