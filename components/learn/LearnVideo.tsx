"use client";

/**
 * Student video player: the editor's trim-aware VideoPreviewPlayer (captions
 * default ON when a track exists) with progress reporting. The player emits a
 * window-relative position; this wrapper keeps a high-water mark and reports
 * it at every 10-point crossing (and immediately at the ≥90% completion
 * threshold) so the server can apply the fixed video rule without a flood of
 * writes. The server clamps/high-waters again — this is just batching.
 */

import { useCallback, useRef } from "react";
import type { VideoLessonBlock } from "@/lib/course/types";
import type { LearnerVideoData } from "@/lib/learn/media";
import { VIDEO_COMPLETE_PCT } from "@/lib/learn/completion";
import { VideoPreviewPlayer } from "@/components/editor/lesson/video/VideoPreviewPlayer";
import { useAnalytics } from "./AnalyticsProvider";

export function LearnVideo({
  block,
  data,
  onVideoProgress,
}: {
  block: VideoLessonBlock;
  data: LearnerVideoData | null;
  onVideoProgress?: (pct: number) => void;
}) {
  const highWaterRef = useRef(0);
  const reportedBucketRef = useRef(-1);
  // Analytics quartiles: 25/50/75 emit video_progress; ≥VIDEO_COMPLETE_PCT
  // emits video_completed (the app's own completion threshold — quartile 4).
  const { track } = useAnalytics();
  const reportedQuartileRef = useRef(0);

  const handleProgress = useCallback(
    (pct: number) => {
      if (pct <= highWaterRef.current) return;
      highWaterRef.current = pct;

      const quartile =
        pct >= VIDEO_COMPLETE_PCT ? 4 : pct >= 75 ? 3 : pct >= 50 ? 2 : pct >= 25 ? 1 : 0;
      while (reportedQuartileRef.current < quartile) {
        const next = reportedQuartileRef.current + 1;
        reportedQuartileRef.current = next;
        if (next === 4) {
          track({ eventType: "video_completed", blockId: block.id });
        } else {
          track({
            eventType: "video_progress",
            blockId: block.id,
            quartile: next as 1 | 2 | 3,
          });
        }
      }

      const bucket = Math.floor(pct / 10);
      const crossedComplete =
        pct >= VIDEO_COMPLETE_PCT && reportedBucketRef.current < VIDEO_COMPLETE_PCT / 10;
      if (bucket > reportedBucketRef.current || crossedComplete) {
        reportedBucketRef.current = Math.max(bucket, reportedBucketRef.current);
        onVideoProgress?.(pct);
      }
    },
    [onVideoProgress, track, block.id]
  );

  if (!data) {
    return (
      <p className="rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-6 text-center text-sm text-stone-500">
        This video isn&apos;t available right now.
      </p>
    );
  }

  const emptyMessage =
    data.mp4Status === "disabled"
      ? "Playback isn't available for this video."
      : "Preparing video…";

  return (
    <div>
      {block.description ? (
        <p className="mb-3 text-sm leading-relaxed text-stone-600">{block.description}</p>
      ) : null}
      <VideoPreviewPlayer
        src={data.mp4Url}
        poster={data.posterUrl}
        trimStart={block.edit.trimStartSeconds}
        trimEnd={block.edit.trimEndSeconds}
        captions={data.captions}
        captionsDefaultOn={Boolean(data.captions && data.captions.length > 0)}
        emptyMessage={emptyMessage}
        onProgressPct={handleProgress}
        className="overflow-hidden rounded-xl"
      />
    </div>
  );
}
