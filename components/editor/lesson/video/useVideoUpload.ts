"use client";

/**
 * useVideoUpload — turns a recorded Blob or a chosen File into a Mux asset:
 *   1) POST /api/video/mux/create-upload → { videoAssetId, uploadId, uploadUrl }
 *   2) PUT the bytes straight to Mux's one-time uploadUrl (real progress via XHR)
 *   3) one status fetch so the caller can persist the block snapshot
 *
 * It deliberately does NOT wait for Mux to finish encoding — the video BLOCK owns
 * that poll (useVideoAsset), so the modal can persist "processing" and close.
 */

import { useCallback, useRef, useState } from "react";
import type { VideoAssetView } from "@/lib/video/videoTypes";

export type UploadPhase = "idle" | "creating" | "uploading" | "processing" | "failed";

export interface UseVideoUpload {
  phase: UploadPhase;
  progress: number; // 0..100 during the PUT
  error: string | null;
  view: VideoAssetView | null;
  /** Run the full create → PUT → status flow. Resolves with the view (status
   *  usually "processing") once the bytes are uploaded, or null on failure. */
  start: (source: Blob | File, opts?: { role?: "camera_dual_track" }) => Promise<VideoAssetView | null>;
  cancel: () => void;
  reset: () => void;
}

function putToMux(
  url: string,
  body: Blob,
  onProgress: (pct: number) => void,
  xhrRef: { current: XMLHttpRequest | null }
): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("PUT", url);
    // Mux infers the type; setting a content-type on a pre-signed PUT can break
    // the signature on some setups, so we send the raw body only.
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status });
    xhr.onerror = () => reject(new Error("network"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(body);
  });
}

export function useVideoUpload(target: {
  courseId: string | null;
  lessonId: string;
  blockId: string;
}): UseVideoUpload {
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<VideoAssetView | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const cancelledRef = useRef(false);

  const reset = useCallback(() => {
    cancelledRef.current = false;
    setPhase("idle");
    setProgress(0);
    setError(null);
    setView(null);
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    xhrRef.current?.abort();
    xhrRef.current = null;
  }, []);

  const start = useCallback(
    async (
      source: Blob | File,
      opts: { role?: "camera_dual_track" } = {}
    ): Promise<VideoAssetView | null> => {
      if (!target.courseId) {
        setError("This course isn't ready yet. Try again in a moment.");
        setPhase("failed");
        return null;
      }
      cancelledRef.current = false;
      setError(null);
      setProgress(0);
      setPhase("creating");

      // 1) create the direct upload + row
      let created: { videoAssetId: string; uploadId: string; uploadUrl: string };
      try {
        const res = await fetch("/api/video/mux/create-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            courseId: target.courseId,
            lessonId: target.lessonId,
            blockId: target.blockId,
            ...(opts.role ? { role: opts.role } : {}),
          }),
        });
        if (!res.ok) {
          setError((await res.text()) || "We couldn't start the upload. Please try again.");
          setPhase("failed");
          return null;
        }
        created = await res.json();
      } catch {
        setError("We couldn't reach the server. Please try again.");
        setPhase("failed");
        return null;
      }
      if (cancelledRef.current) return null;

      // 2) PUT the bytes to Mux with progress
      setPhase("uploading");
      try {
        const put = await putToMux(created.uploadUrl, source, setProgress, xhrRef);
        if (!put.ok) {
          setError("The upload was rejected. Please try again.");
          setPhase("failed");
          return null;
        }
      } catch (err) {
        if ((err as Error).message === "aborted") {
          setPhase("idle");
          return null;
        }
        setError("The upload failed. Check your connection and try again.");
        setPhase("failed");
        return null;
      }
      if (cancelledRef.current) return null;

      // 3) one status fetch so the caller can persist the snapshot
      setPhase("processing");
      let statusView: VideoAssetView | null = null;
      try {
        const res = await fetch("/api/video/mux/asset-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoAssetId: created.videoAssetId }),
        });
        if (res.ok) statusView = await res.json();
      } catch {
        /* non-fatal — the block poll will catch up */
      }
      // Even if the status fetch failed, we know the ids — synthesize a minimal
      // processing view so the block persists and can poll.
      const result: VideoAssetView =
        statusView ?? {
          id: created.videoAssetId,
          courseId: target.courseId,
          lessonId: target.lessonId,
          blockId: target.blockId,
          provider: "mux",
          status: "processing",
          uploadId: created.uploadId,
          assetId: null,
          playbackId: null,
          durationSeconds: null,
          aspectRatio: null,
          mp4Url: null,
          mp4Status: null,
          hlsUrl: null,
          thumbnailUrl: null,
          captionStatus: "none",
          captionTrackId: null,
          captionTrackName: null,
          captionLanguageCode: null,
          captionSource: null,
          captionError: null,
          captionVttUrl: null,
          transcript: null,
          transcriptVtt: null,
          error: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      setView(result);
      return result;
    },
    [target.courseId, target.lessonId, target.blockId]
  );

  return { phase, progress, error, view, start, cancel, reset };
}
