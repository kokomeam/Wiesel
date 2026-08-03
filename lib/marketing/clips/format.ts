/**
 * Recording-format resolution (amendment FR-1) — metadata first, classifier
 * fallback, creator override on top.
 *
 * PRECEDENCE (binding): the platform already KNOWS the format for lessons
 * recorded in the studio — `VideoLessonBlock.recording.mode` (blocks.content
 * jsonb; the literals equal RECORDING_FORMATS verbatim, an identity map).
 * When that metadata exists, detection MUST NOT run (spy-tested). The
 * classifier exists ONLY for externally UPLOADED videos, which never get a
 * mode (the upload path skips `chooseMode` — verified in VideoStudioModal).
 *
 * CLASSIFIER (fallback): sampled-frame inspection — ≥FORMAT_CLASSIFIER_MIN_
 * FRAMES frames spread across the duration, each judged {facePresent,
 * screenContentPresent}, decided by classifyRecordingFormat (the pure,
 * table-tested decision):
 *   face in ≥60% of samples, screen content NOT frame-dominant → camera_only
 *   face in ≥60% AND screen content frame-dominant             → screen_camera
 *   otherwise (no consistent face)                             → screen_only
 *
 * FRAME SIGNALS — repo-reality note (surfaced at the checkpoint, not silently
 * adapted): the directive names "ffprobe stream inspection + face detection".
 * ffprobe/ffmpeg are NOT installed in this runtime and the repo has no
 * face-detection dependency; the ONE face-capable capability it already has
 * is `ModelClient.inspectImage` (the vision seam the visual pipeline uses).
 * So the frame source is an injectable FrameInspector; the production
 * implementation (createMuxFrameInspector) samples Mux thumbnail stills and
 * judges them through inspectImage — zero new deps, works on every uploaded
 * asset (they all live on Mux). A local ffprobe-based inspector can be
 * dropped into the same seam if the runtime ever gains the binary.
 *
 * DEGRADED DEFAULT: no metadata AND no usable inspector ⇒ camera_only with
 * source='classifier' (conservative: face_track is the least-wrong render
 * treatment, and the creator override corrects any miss). In the real
 * selection path an inspector always exists — selection is model-REQUIRED.
 *
 * Classification runs ONCE per lesson: the result persists on the
 * lesson_transcript row (recording_format + format_source) and is
 * creator-overridable via overrideTranscriptFormat (format_source=
 * 'creator_override' — subsequent runs never re-classify over an override).
 */

import type { ModelClient } from "@/lib/ai/modelClient";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { z } from "zod";
import { thumbnailUrl } from "@/lib/video/playbackUrls";
import {
  FORMAT_CLASSIFIER_FACE_PCT,
  FORMAT_CLASSIFIER_MIN_FRAMES,
  FORMAT_CLASSIFIER_SCREEN_PCT,
} from "./constants";
import { RecordingFormatSchema, type FormatSource, type RecordingFormat } from "./schemas";

/* ───────────────────────── pure decision (FR-1) ────────────────────────── */

/** One sampled frame's judged content. */
export interface FrameSignal {
  facePresent: boolean;
  screenContentPresent: boolean;
}

/** The binding FR-1 decision over sampled frames. Empty input ⇒ null (the
 *  caller applies the degraded default and keeps the evidence honest). */
export function classifyRecordingFormat(frames: FrameSignal[]): RecordingFormat | null {
  if (frames.length === 0) return null;
  const n = frames.length;
  const facePct = frames.filter((f) => f.facePresent).length / n;
  const screenPct = frames.filter((f) => f.screenContentPresent).length / n;
  if (facePct >= FORMAT_CLASSIFIER_FACE_PCT) {
    return screenPct >= FORMAT_CLASSIFIER_SCREEN_PCT ? "screen_camera" : "camera_only";
  }
  return "screen_only";
}

/* ─────────────────────── injectable frame source ───────────────────────── */

export interface FrameInspector {
  /** Sample `count` frames spread across the media and judge each one.
   *  Individual frame failures are skipped, not fatal. */
  sampleFrames(count: number): Promise<FrameSignal[]>;
}

export interface FormatResolution {
  format: RecordingFormat;
  source: FormatSource;
  /** Present when the classifier ran — persisted into events/audit trails. */
  classifierEvidence?: { frames: number; facePct: number; screenPct: number } | null;
}

/**
 * Resolve a recording's format. `metadataMode` is the raw
 * blocks.content→recording→mode value (or null); ANY valid mode short-circuits
 * — the classifier is NEVER invoked when metadata exists (FR-1, spy-tested).
 */
export async function resolveRecordingFormat(input: {
  metadataMode: string | null | undefined;
  frameInspector: FrameInspector | null;
}): Promise<FormatResolution> {
  const meta = RecordingFormatSchema.safeParse(input.metadataMode);
  if (meta.success) {
    return { format: meta.data, source: "platform", classifierEvidence: null };
  }

  if (input.frameInspector) {
    try {
      const frames = await input.frameInspector.sampleFrames(FORMAT_CLASSIFIER_MIN_FRAMES);
      const format = classifyRecordingFormat(frames);
      if (format) {
        const n = frames.length;
        return {
          format,
          source: "classifier",
          classifierEvidence: {
            frames: n,
            facePct: frames.filter((f) => f.facePresent).length / n,
            screenPct: frames.filter((f) => f.screenContentPresent).length / n,
          },
        };
      }
    } catch {
      // inspector failure falls through to the degraded default — a broken
      // frame source must never block transcript acquisition
    }
  }

  return { format: "camera_only", source: "classifier", classifierEvidence: null };
}

/* ──────────────── production inspector: Mux stills + vision ────────────── */

const FrameVerdictSchema = z.object({
  facePresent: z.boolean(),
  screenContentPresent: z.boolean(),
});

const FRAME_INSPECT_INSTRUCTION = [
  "This is one still frame sampled from a lesson video recording. Judge two things:",
  "1. facePresent — is a real human face visible (a webcam feed, a person on camera)? A face inside an on-screen photo/slide illustration counts ONLY if it is clearly a live camera feed (webcam bubble or full-frame person).",
  "2. screenContentPresent — does the frame show frame-dominant computer-screen content (slides, code editor, terminal, browser, application UI, whiteboard app)? A person in front of a plain room/backdrop is NOT screen content.",
  "Return JSON matching the schema exactly.",
].join("\n");

/**
 * The production FrameInspector: Mux thumbnail stills spread across the
 * duration, judged by the model's vision seam. Returns null when the asset
 * has no playback id or the model cannot inspect images (⇒ degraded default).
 */
export function createMuxFrameInspector(
  model: ModelClient | undefined,
  asset: { playbackId: string | null; durationSeconds: number | null },
  deps: { fetchImpl?: typeof fetch } = {}
): FrameInspector | null {
  if (!model?.inspectImage || !asset.playbackId) return null;
  const playbackId = asset.playbackId;
  const inspect = model.inspectImage.bind(model);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const duration = Math.max(asset.durationSeconds ?? 0, 1);
  const schema = toStrictJsonSchema(FrameVerdictSchema);

  return {
    async sampleFrames(count: number): Promise<FrameSignal[]> {
      const signals: FrameSignal[] = [];
      for (let i = 0; i < count; i++) {
        // (i + 0.5)/count spreads samples across the duration, avoiding the
        // black first frame and end-card.
        const time = ((i + 0.5) / count) * duration;
        try {
          const res = await fetchImpl(thumbnailUrl(playbackId, { time, width: 640 }));
          if (!res.ok) continue;
          const bytes = Buffer.from(await res.arrayBuffer());
          const verdict = await inspect({
            base64: bytes.toString("base64"),
            mimeType: "image/jpeg",
            instruction: FRAME_INSPECT_INSTRUCTION,
            responseFormat: { name: "clip_frame_signal", schema },
          });
          if (!verdict) continue;
          const parsed = FrameVerdictSchema.safeParse(JSON.parse(verdict.text));
          if (parsed.success) signals.push(parsed.data);
        } catch {
          // skip the frame — partial evidence still classifies
        }
      }
      return signals;
    },
  };
}
