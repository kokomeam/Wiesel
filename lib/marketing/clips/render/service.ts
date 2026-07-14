/**
 * Render service (M-B) — job creation (quota-gated) + the TICK that advances
 * every active job one step per pass. No cron of its own: the marketing
 * scheduler tick calls `processClipRenderTick` (the reconciliation sweep IS
 * the primary delivery path — Task 0 (b): Reap has no webhooks), and dev
 * has a "process now" action, exactly the email-outbox precedent.
 *
 * Step map (each tick advances a job at most one edge; every write goes
 * through transitionRenderJob — the single legal write path):
 *   queued           → start the pre-cut (one temp Mux clip asset per
 *                      segment; multi-segment candidates stitch later)
 *   precutting       → all segments ready? download bytes (+ concat when
 *                      stitched), then EITHER submit to the provider
 *                      (face_track → Reap, token-bucket-gated) OR flip to
 *                      rendering_local and run the in-house layout
 *   submitted        → poll the provider; completed → download → storage →
 *                      completed (+ provider billedDuration as the cost)
 *   rendering_local  → normally completes within its own tick; a row stuck
 *                      past CLIP_LOCAL_RENDER_STALE_MS is presumed crashed
 *                      and retried (attempts-capped)
 *
 * Cost ledger: provider jobs record Reap's billedDuration; in-house jobs
 * record ceil(spanMinutes) × CLIP_INHOUSE_MINUTE_RATE. One column, one
 * quota (CLIP_MINUTES_PER_MONTH) across providers.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { ModelClient } from "@/lib/ai/modelClient";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import { z } from "zod";
import { thumbnailUrl } from "@/lib/video/playbackUrls";
import { bubbleRect, COMPOSITE_HEIGHT, COMPOSITE_WIDTH } from "@/lib/video/recorderConfig";
import type { CameraBubblePosition } from "@/lib/course/types";
import { actionCueTimes } from "../actionDensity";
import { clipRenderConfig, CLIP_JOB_MAX_ATTEMPTS, CLIP_LOCAL_RENDER_STALE_MS } from "../constants";
import { emitClipEvent } from "../events";
import { getLessonTranscript } from "../transcripts";
import { ingestCompletedClipJob } from "../ingest";
import { getCandidate } from "../repository";
import type { ClipMomentCandidate } from "../schemas";
import type { ClipRenderProvider } from "../provider/types";
import {
  buildAudiogramArgs,
  buildStackedSplitArgs,
  buildStackedSplitDualArgs,
  buildZoomPanArgs,
  CLIP_OUT_H,
  CLIP_OUT_W,
  zoomKeyframesFromCues,
  type PipRect,
} from "./ffmpegArgs";
import { FfmpegError, runFfmpeg } from "./localRender";
import { renderSlideShort } from "./slideShort/renderSlideShort";
import { buildSlideShortSpec } from "./slideShort/buildSpec";
import type { PrecutOps } from "./precut";
import {
  createRenderJob,
  costMinutesThisMonth,
  getRenderJob,
  jobsCreatedToday,
  listActiveRenderJobs,
  submissionsInLastMinute,
  transitionRenderJob,
  type ClipJobSource,
  type ClipRenderJob,
} from "./jobs";

type DB = SupabaseClient<Database>;

export class ClipRenderError extends Error {
  constructor(
    readonly code:
      | "quota_jobs"
      | "quota_minutes"
      | "no_video"
      | "unrenderable_layout"
      | "multi_segment"
      | "candidate_not_found",
    message: string
  ) {
    super(message);
    this.name = "ClipRenderError";
  }
}

/** Layout → who renders it (the D-5 resolution, Task-0-backed). */
export function providerForLayout(layout: ClipMomentCandidate["layout"]): ClipRenderJob["provider"] {
  switch (layout) {
    case "face_track":
      return "reap";
    case "stacked_split":
    case "screen_action_zoom":
    case "audiogram":
      return "wisesel_ffmpeg";
    case "slide_short":
      return "wisesel_slides";
  }
}

/* ───────────────────── PiP rect (D-3 provenance) ──────────────────────── */

const PipCornerSchema = z.object({
  corner: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]).nullable(),
});

/**
 * The stacked_split face-band rect. Deterministic when the recording
 * metadata names the bubble corner (the recorder's OWN bubbleRect constants
 * — no detection over facts we already have); vision-DETECTED corner for
 * legacy uploads (one frame, one call); bottom-right default when neither.
 * Returns the provenance alongside (persisted on the job — D-3).
 */
export async function resolvePipRect(args: {
  bubblePosition: CameraBubblePosition | null;
  model?: ModelClient;
  playbackId: string | null;
  durationSeconds: number | null;
  fetchImpl?: typeof fetch;
}): Promise<{ rect: PipRect; provenance: "deterministic" | "detected" }> {
  const rectFor = (corner: CameraBubblePosition) =>
    bubbleRect(COMPOSITE_WIDTH, COMPOSITE_HEIGHT, 16 / 9, corner);
  if (args.bubblePosition) {
    return { rect: rectFor(args.bubblePosition), provenance: "deterministic" };
  }
  // Legacy path: one vision call locates the corner.
  if (args.model?.inspectImage && args.playbackId) {
    try {
      const fetchImpl = args.fetchImpl ?? fetch;
      const time = Math.max((args.durationSeconds ?? 60) / 2, 1);
      const res = await fetchImpl(thumbnailUrl(args.playbackId, { time, width: 640 }));
      if (res.ok) {
        const bytes = Buffer.from(await res.arrayBuffer());
        const verdict = await args.model.inspectImage({
          base64: bytes.toString("base64"),
          mimeType: "image/jpeg",
          instruction:
            "This frame is a screen recording that may contain a small webcam bubble (a live camera feed of a person) in one corner. Which corner is it in? Return JSON {corner} with one of bottom-right/bottom-left/top-right/top-left, or null if there is no webcam bubble.",
          responseFormat: { name: "clip_pip_corner", schema: toStrictJsonSchema(PipCornerSchema) },
        });
        if (verdict) {
          const parsed = PipCornerSchema.safeParse(JSON.parse(verdict.text));
          if (parsed.success && parsed.data.corner) {
            return { rect: rectFor(parsed.data.corner), provenance: "detected" };
          }
        }
      }
    } catch {
      // fall through to the default
    }
  }
  return { rect: rectFor("bottom-right"), provenance: "detected" };
}

/* ───────────────────────────── creation ───────────────────────────────── */

export interface CreateClipJobDeps {
  supabase: DB;
  ownerId: string;
  courseIdForEvents: string;
  model?: ModelClient;
  nowIso: string;
}

/** The lesson's renderable video: the same picker order the transcript path
 *  uses (captioned first, longest first) but carrying the Mux ASSET id the
 *  pre-cut needs. */
async function findRenderSource(supabase: DB, lessonId: string) {
  const { data, error } = await supabase
    .from("video_assets")
    .select("id,block_id,mux_asset_id,mux_playback_id,duration_seconds,transcript_vtt,metadata")
    .eq("lesson_id", lessonId)
    .eq("status", "ready")
    .order("duration_seconds", { ascending: false, nullsFirst: false });
  if (error) throw new Error(`video_assets read: ${error.message}`);
  const rows = (data ?? []).filter(
    (r) =>
      r.mux_asset_id &&
      (r.metadata as { role?: string } | null)?.role !== "camera_dual_track"
  );
  if (rows.length === 0) return null;
  return rows.find((r) => r.transcript_vtt) ?? rows[0];
}

/** D-4: the block's linked raw-camera asset (full-res face band), if the
 *  dual-track flag captured one and it's ready. */
async function findDualCameraSource(
  supabase: DB,
  blockId: string | null
): Promise<{ videoAssetRowId: string; sourceMuxAssetId: string } | null> {
  if (!blockId) return null;
  const { data } = await supabase.from("blocks").select("content").eq("id", blockId).maybeSingle();
  const rowId = (data?.content as { recording?: { dualCameraAssetRowId?: string } } | null)?.recording
    ?.dualCameraAssetRowId;
  if (!rowId) return null;
  const { data: asset } = await supabase
    .from("video_assets")
    .select("id,mux_asset_id,status")
    .eq("id", rowId)
    .maybeSingle();
  if (!asset?.mux_asset_id || asset.status !== "ready") return null;
  return { videoAssetRowId: asset.id, sourceMuxAssetId: asset.mux_asset_id };
}

/** D-3: the recorder-stamped pipGeometry (exact rect from the compositor). */
async function readPipGeometry(
  supabase: DB,
  blockId: string | null
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (!blockId) return null;
  const { data } = await supabase.from("blocks").select("content").eq("id", blockId).maybeSingle();
  const g = (data?.content as { recording?: { pipGeometry?: unknown } } | null)?.recording?.pipGeometry as
    | { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
    | undefined;
  if (
    g &&
    typeof g.x === "number" &&
    typeof g.y === "number" &&
    typeof g.width === "number" &&
    typeof g.height === "number" &&
    g.width > 0 &&
    g.height > 0
  ) {
    return { x: g.x, y: g.y, width: g.width, height: g.height };
  }
  return null;
}

async function readBubblePosition(supabase: DB, blockId: string | null): Promise<CameraBubblePosition | null> {
  if (!blockId) return null;
  const { data } = await supabase.from("blocks").select("content").eq("id", blockId).maybeSingle();
  const rec = (data?.content as { recording?: { cameraBubblePosition?: string } } | null)?.recording;
  const pos = rec?.cameraBubblePosition;
  return pos === "bottom-right" || pos === "bottom-left" || pos === "top-right" || pos === "top-left"
    ? pos
    : null;
}

export async function createClipRenderJob(
  deps: CreateClipJobDeps,
  args: { candidate: ClipMomentCandidate; preset: string; idempotencyKey?: string | null }
): Promise<ClipRenderJob> {
  const { candidate } = args;
  const cfg = clipRenderConfig();
  const provider = providerForLayout(candidate.layout);
  // Multi-segment candidates (the §7.3 EXCEPTION shape) need segment-wise
  // pre-cut + stitch; enveloping their span would silently render the
  // unwanted middle — refuse loudly instead (surfaced at the M-B checkpoint;
  // stitch support is scoped with the M-G hardening pass).
  if (candidate.segments !== null) {
    throw new ClipRenderError(
      "multi_segment",
      "This is a stitched multi-segment moment — rendering it needs the segment-stitch pass, which isn't live yet. Contiguous candidates render today."
    );
  }

  // Quotas (server-side, the carryover invariant).
  const [today, monthMinutes] = await Promise.all([
    jobsCreatedToday(deps.supabase, deps.ownerId, deps.nowIso),
    costMinutesThisMonth(deps.supabase, deps.ownerId, deps.nowIso),
  ]);
  if (today >= cfg.jobsPerDay) {
    throw new ClipRenderError("quota_jobs", `Daily render quota reached (${cfg.jobsPerDay}/day). Try again tomorrow.`);
  }
  const spanMinutes = Math.ceil((candidate.endMs - candidate.startMs) / 60_000);
  if (monthMinutes + spanMinutes > cfg.minutesPerMonth) {
    throw new ClipRenderError(
      "quota_minutes",
      `Monthly render minutes exhausted (${monthMinutes}/${cfg.minutesPerMonth} used; this clip needs ~${spanMinutes}).`
    );
  }

  const asset = await findRenderSource(deps.supabase, candidate.lessonId);
  if (!asset?.mux_asset_id) {
    throw new ClipRenderError("no_video", "This lesson has no ready video recording to render from.");
  }

  const transcript = await getLessonTranscript(deps.supabase, candidate.lessonId);
  const recordingFormat = transcript?.recordingFormat ?? "camera_only";

  let pipRect: PipRect | null = null;
  let cropProvenance: "deterministic" | "detected" | null = null;
  let dualCamera: { videoAssetRowId: string; sourceMuxAssetId: string } | null = null;
  if (candidate.layout === "stacked_split") {
    // D-4: a raw camera dual-track (full-res face band) beats any crop.
    dualCamera = await findDualCameraSource(deps.supabase, asset.block_id);
    // D-3: recorder-stamped pipGeometry is exact; corner metadata derives via
    // the recorder's own constants; detection is the legacy-upload path only.
    const stamped = await readPipGeometry(deps.supabase, asset.block_id);
    if (stamped) {
      pipRect = { x: stamped.x, y: stamped.y, w: stamped.width, h: stamped.height };
      cropProvenance = "deterministic";
    } else {
      const bubble = await readBubblePosition(deps.supabase, asset.block_id);
      const resolved = await resolvePipRect({
        bubblePosition: bubble,
        model: deps.model,
        playbackId: asset.mux_playback_id,
        durationSeconds: asset.duration_seconds,
      });
      pipRect = resolved.rect;
      cropProvenance = resolved.provenance;
    }
  }

  const source: ClipJobSource = {
    videoAssetRowId: asset.id,
    sourceMuxAssetId: asset.mux_asset_id,
    playbackId: asset.mux_playback_id,
    startMs: candidate.startMs,
    endMs: candidate.endMs,
    recordingFormat,
    pipRect,
    dualCamera,
  };

  return createRenderJob(deps.supabase, {
    creatorId: deps.ownerId,
    courseId: candidate.courseId ?? deps.courseIdForEvents,
    lessonId: candidate.lessonId,
    candidateId: candidate.id,
    layout: candidate.layout,
    provider,
    preset: args.preset,
    source,
    cropProvenance,
    idempotencyKey: args.idempotencyKey ?? null,
  });
}

/* ─────────────────────────────── the tick ─────────────────────────────── */

export interface RenderTickDeps {
  /** ADMIN client — the tick crosses users (cron) and writes storage. */
  supabase: DB;
  provider?: ClipRenderProvider;
  precut: PrecutOps;
  nowIso: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests — the real one spawns ffmpeg-static. */
  runFfmpegImpl?: typeof runFfmpeg;
  /** Injectable for tests — the real one drives Remotion's headless Chrome. */
  renderSlideShortImpl?: typeof renderSlideShort;
}

export interface RenderTickResult {
  processed: number;
  advanced: number;
  completed: number;
  failed: number;
  heldByBucket: number;
}

/** Segment ranges for a job (multi-segment candidates carry their own). */
function jobRanges(job: ClipRenderJob): { startMs: number; endMs: number }[] {
  return [{ startMs: job.source.startMs, endMs: job.source.endMs }];
}

async function downloadBytes(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadOutput(
  supabase: DB,
  path: string,
  bytes: Buffer
): Promise<void> {
  const { error } = await supabase.storage
    .from("clip-media")
    .upload(path, bytes, { contentType: "video/mp4", upsert: true });
  if (error) throw new Error(`clip-media upload: ${error.message}`);
}

async function failJob(
  deps: RenderTickDeps,
  job: ClipRenderJob,
  message: string
): Promise<void> {
  await transitionRenderJob(deps.supabase, job.id, job.status, "failed", { error: message.slice(0, 500) });
  await emitClipEvent(deps.supabase, job.courseId ?? "", "clip_job_failed", {
    jobId: job.id,
    candidateId: job.candidateId,
    lessonId: job.lessonId,
    layout: job.layout,
    recordingFormat: job.source.recordingFormat,
    provider: job.provider,
    error: message.slice(0, 300),
  });
}

/** In-house render: precut bytes are on disk; produce the layout output. */
async function renderLocal(
  deps: RenderTickDeps,
  job: ClipRenderJob,
  inputPath: string,
  outputPath: string,
  cameraInputPath: string | null
): Promise<void> {
  const run = deps.runFfmpegImpl ?? runFfmpeg;
  const durationSeconds = (job.source.endMs - job.source.startMs) / 1000;
  if (job.layout === "slide_short") {
    // FR-6: the Remotion provider — spec built from the M-R sync + the real
    // deck; audio = the precut span's own media URL (Chrome fetches it).
    const candidate = await getCandidate(deps.supabase, job.candidateId);
    if (!candidate) throw new Error("slide_short job's candidate is gone");
    if (!job.precut?.mp4Url) throw new Error("slide_short job has no precut media url");
    const spec = await buildSlideShortSpec(deps.supabase, job, candidate, job.precut.mp4Url);
    const render = deps.renderSlideShortImpl ?? renderSlideShort;
    await render(spec, outputPath);
    return;
  }
  if (job.layout === "stacked_split") {
    // D-4: the full-res camera track beats the PiP crop when captured.
    if (cameraInputPath) {
      await run(
        buildStackedSplitDualArgs({
          screenInputPath: inputPath,
          cameraInputPath,
          outputPath,
          durationSeconds,
        })
      );
      return;
    }
    if (!job.source.pipRect) throw new Error("stacked_split job has no pipRect");
    await run(buildStackedSplitArgs({ inputPath, outputPath, pipRect: job.source.pipRect, durationSeconds }));
    return;
  }
  if (job.layout === "screen_action_zoom") {
    const transcript = await getLessonTranscript(deps.supabase, job.lessonId);
    const cueTimes = transcript
      ? actionCueTimes(transcript.words, { startMs: job.source.startMs, endMs: job.source.endMs })
      : [];
    const keyframes = zoomKeyframesFromCues(cueTimes, job.source.endMs - job.source.startMs);
    await run(
      buildZoomPanArgs({
        inputPath,
        outputPath,
        keyframes,
        durationSeconds,
        sourceW: COMPOSITE_WIDTH,
        sourceH: COMPOSITE_HEIGHT,
      })
    );
    return;
  }
  if (job.layout === "audiogram") {
    await run(buildAudiogramArgs({ inputPath, outputPath, durationSeconds }));
    return;
  }
  throw new Error(`layout ${job.layout} is not an in-house render`);
}

/** M-C: a completed job becomes a social_post (post_type='clip'). Best-
 *  effort here — ingest is idempotent per job and the NEXT tick's sweep of
 *  completed-but-uningested jobs would be redundant (the completion edge
 *  only fires once); a failure logs loudly instead of failing the job. */
async function ingestJob(deps: RenderTickDeps, jobId: string): Promise<void> {
  try {
    const fresh = await getRenderJob(deps.supabase, jobId);
    if (!fresh) return;
    const candidate = await getCandidate(deps.supabase, fresh.candidateId);
    if (!candidate) return;
    await ingestCompletedClipJob(deps.supabase, fresh, candidate);
  } catch (err) {
    console.log(
      JSON.stringify({
        tag: "clip_ingest_error",
        jobId,
        error: err instanceof Error ? err.message.slice(0, 300) : String(err),
      })
    );
  }
}

/** Advance ONE job one step. Returns what happened (tick bookkeeping). */
export async function advanceRenderJob(
  deps: RenderTickDeps,
  job: ClipRenderJob
): Promise<"advanced" | "completed" | "failed" | "held" | "noop"> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cfg = clipRenderConfig();

  try {
    switch (job.status) {
      case "queued": {
        const range = jobRanges(job)[0];
        const started = await deps.precut.start(
          job.source.sourceMuxAssetId,
          range.startMs,
          range.endMs,
          `wisesel-clip-precut:${job.id}`
        );
        // D-4: the raw camera track precuts to the SAME span for the
        // full-res face band (stacked_split only).
        let cameraMuxAssetId: string | null = null;
        if (job.layout === "stacked_split" && job.source.dualCamera) {
          const cam = await deps.precut.start(
            job.source.dualCamera.sourceMuxAssetId,
            range.startMs,
            range.endMs,
            `wisesel-clip-precut-cam:${job.id}`
          );
          cameraMuxAssetId = cam.muxAssetId;
        }
        await transitionRenderJob(deps.supabase, job.id, "queued", "precutting", {
          precut: { muxAssetId: started.muxAssetId, cameraMuxAssetId },
        });
        return "advanced";
      }

      case "precutting": {
        if (!job.precut?.muxAssetId) {
          await failJob(deps, job, "precutting job lost its precut ref");
          return "failed";
        }
        const state = await deps.precut.check(job.precut.muxAssetId);
        if (state.status === "errored") {
          await failJob(deps, job, `pre-cut failed: ${state.error ?? "clip asset errored"}`);
          return "failed";
        }
        if (state.status !== "ready" || !state.mp4Url) return "noop"; // keep polling
        // D-4: the camera precut must be ready too (falls back to the PiP
        // crop if the camera precut errored — the render must not strand).
        let cameraMp4Url: string | null = null;
        if (job.precut.cameraMuxAssetId) {
          const camState = await deps.precut.check(job.precut.cameraMuxAssetId);
          if (camState.status === "errored") {
            await deps.precut.cleanup(job.precut.cameraMuxAssetId);
            cameraMp4Url = null; // PiP-crop fallback
          } else if (camState.status !== "ready" || !camState.mp4Url) {
            return "noop"; // keep polling both
          } else {
            cameraMp4Url = camState.mp4Url;
          }
        }

        if (job.provider === "reap") {
          if (!deps.provider) return "noop"; // provider unconfigured — hold
          const inFlight = await submissionsInLastMinute(deps.supabase, job.creatorId, deps.nowIso);
          if (inFlight >= cfg.tokensPerMinute) return "held"; // 10/min bucket
          const bytes = await downloadBytes(state.mp4Url, fetchImpl);
          const submitted = await deps.provider.submit({
            kind: "provider_reframe",
            bytes,
            filename: `wisesel-clip-${job.id}.mp4`,
          });
          await transitionRenderJob(deps.supabase, job.id, "precutting", "submitted", {
            providerRef: submitted.providerRef,
            uploadRef: submitted.uploadRef,
            costMinutes: submitted.costMinutes,
            submittedAt: deps.nowIso,
            precut: { ...job.precut, mp4Url: state.mp4Url },
          });
          await deps.precut.cleanup(job.precut.muxAssetId);
          await emitClipEvent(deps.supabase, job.courseId ?? "", "clip_job_submitted", {
            jobId: job.id,
            candidateId: job.candidateId,
            lessonId: job.lessonId,
            layout: job.layout,
            recordingFormat: job.source.recordingFormat,
            provider: job.provider,
          });
          return "advanced";
        }

        // In-house: flip to rendering_local (crash-visible), then render in
        // this same tick pass.
        const flipped = await transitionRenderJob(deps.supabase, job.id, "precutting", "rendering_local", {
          precut: { ...job.precut, mp4Url: state.mp4Url, cameraMp4Url },
          submittedAt: deps.nowIso,
        });
        return advanceRenderJob(deps, flipped);
      }

      case "rendering_local": {
        if (!job.precut?.mp4Url) {
          await failJob(deps, job, "rendering_local job lost its precut media url");
          return "failed";
        }
        // Stale-crash guard: only re-enter a rendering_local row past the
        // stale window (a fresh flip re-enters immediately via recursion).
        const ageMs = Date.now() - new Date(job.updatedAt).getTime();
        const freshFlip = job.submittedAt && new Date(deps.nowIso).getTime() - new Date(job.submittedAt).getTime() < 5_000;
        if (!freshFlip && ageMs < CLIP_LOCAL_RENDER_STALE_MS) return "noop";
        if (job.attempts >= CLIP_JOB_MAX_ATTEMPTS) {
          await failJob(deps, job, "in-house render exceeded max attempts");
          return "failed";
        }

        const dir = mkdtempSync(join(tmpdir(), "wisesel-clip-"));
        try {
          const inputPath = join(dir, "input.mp4");
          const outputPath = join(dir, "output.mp4");
          if (job.layout !== "slide_short") {
            // slide_short streams the precut URL straight into the render
            // Chrome — no local input bytes needed.
            writeFileSync(inputPath, await downloadBytes(job.precut.mp4Url, fetchImpl));
          }
          let cameraInputPath: string | null = null;
          if (job.precut.cameraMp4Url) {
            cameraInputPath = join(dir, "camera.mp4");
            writeFileSync(cameraInputPath, await downloadBytes(job.precut.cameraMp4Url, fetchImpl));
          }
          await renderLocal(deps, job, inputPath, outputPath, cameraInputPath);
          const out = readFileSync(outputPath);
          const storagePath = `${job.creatorId}/clips/${job.id}.mp4`;
          await uploadOutput(deps.supabase, storagePath, out);
          const durationSeconds = (job.source.endMs - job.source.startMs) / 1000;
          const costMinutes = Math.ceil(durationSeconds / 60) * cfg.inhouseMinuteRate;
          await transitionRenderJob(deps.supabase, job.id, "rendering_local", "completed", {
            output: { storagePath, width: CLIP_OUT_W, height: CLIP_OUT_H, durationSeconds },
            costMinutes,
          });
          await deps.precut.cleanup(job.precut.muxAssetId);
          if (job.precut.cameraMuxAssetId) await deps.precut.cleanup(job.precut.cameraMuxAssetId);
          await emitClipEvent(deps.supabase, job.courseId ?? "", "clip_job_completed", {
            jobId: job.id,
            candidateId: job.candidateId,
            lessonId: job.lessonId,
            layout: job.layout,
            recordingFormat: job.source.recordingFormat,
            provider: job.provider,
            costMinutes,
          });
          await ingestJob(deps, job.id);
          return "completed";
        } catch (err) {
          // FfmpegError carries the stderr tail — the diagnosable part.
          const msg =
            err instanceof FfmpegError
              ? `${err.message} — ${err.stderrTail.slice(-300)}`
              : err instanceof Error
                ? err.message
                : String(err);
          if (job.attempts + 1 >= CLIP_JOB_MAX_ATTEMPTS) {
            await failJob(deps, job, `in-house render: ${msg}`);
            return "failed";
          }
          // stay in rendering_local; bump attempts for the next stale retry
          await deps.supabase
            .from("clip_render_job")
            .update({ attempts: job.attempts + 1, error: msg.slice(0, 500) })
            .eq("id", job.id);
          return "noop";
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      case "submitted": {
        if (!deps.provider || !job.providerRef) return "noop";
        const view = await deps.provider.getJob(job.providerRef);
        if (view.status === "processing") return "noop";
        if (view.status === "failed" || view.status === "cancelled") {
          await failJob(deps, job, view.error ?? `provider ${view.status}`);
          return "failed";
        }
        if (!view.outputUrl) {
          await failJob(deps, job, "provider completed without an output url");
          return "failed";
        }
        const bytes = await downloadBytes(view.outputUrl, fetchImpl);
        const storagePath = `${job.creatorId}/clips/${job.id}.mp4`;
        await uploadOutput(deps.supabase, storagePath, bytes);
        const completed = await transitionRenderJob(deps.supabase, job.id, "submitted", "completed", {
          output: {
            storagePath,
            width: view.output?.width ?? CLIP_OUT_W,
            height: view.output?.height ?? CLIP_OUT_H,
            durationSeconds: view.output?.durationSeconds ?? (job.source.endMs - job.source.startMs) / 1000,
          },
          costMinutes: view.costMinutes ?? job.costMinutes,
        });
        await emitClipEvent(deps.supabase, job.courseId ?? "", "clip_job_completed", {
          jobId: job.id,
          candidateId: job.candidateId,
          lessonId: job.lessonId,
          layout: job.layout,
          recordingFormat: job.source.recordingFormat,
          provider: job.provider,
          costMinutes: completed.costMinutes,
        });
        await ingestJob(deps, job.id);
        return "completed";
      }

      default:
        return "noop";
    }
  } catch (err) {
    // A step exception (network, provider 5xx) leaves the job where it was —
    // the next tick retries the same edge. Terminal failures happen only
    // through failJob above.
    console.log(
      JSON.stringify({
        tag: "clip_render_step_error",
        jobId: job.id,
        status: job.status,
        error: err instanceof Error ? err.message.slice(0, 300) : String(err),
      })
    );
    return "noop";
  }
}

/** One pass over every active job (the scheduler-tick entry point). */
export async function processClipRenderTick(
  deps: RenderTickDeps,
  opts: { limit?: number } = {}
): Promise<RenderTickResult> {
  const jobs = await listActiveRenderJobs(deps.supabase, opts.limit ?? 25);
  const result: RenderTickResult = { processed: 0, advanced: 0, completed: 0, failed: 0, heldByBucket: 0 };
  for (const job of jobs) {
    result.processed++;
    const outcome = await advanceRenderJob(deps, job);
    if (outcome === "advanced") result.advanced++;
    else if (outcome === "completed") result.completed++;
    else if (outcome === "failed") result.failed++;
    else if (outcome === "held") result.heldByBucket++;
  }
  return result;
}

/** Cancel a job (the revert path + the cancel tool): best-effort provider
 *  cancel, then the row transition. Terminal rows are a no-op. */
export async function cancelRenderJob(
  deps: { supabase: DB; provider?: ClipRenderProvider; precutOps?: PrecutOps },
  jobId: string
): Promise<ClipRenderJob | null> {
  const job = await getRenderJob(deps.supabase, jobId);
  if (!job) return null;
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job;
  if (job.providerRef && deps.provider) {
    try {
      await deps.provider.cancel(job.providerRef);
    } catch {
      // best-effort — the row cancel is authoritative for OUR pipeline
    }
  }
  if (job.precut?.muxAssetId && deps.precutOps) {
    await deps.precutOps.cleanup(job.precut.muxAssetId);
  }
  return transitionRenderJob(deps.supabase, job.id, job.status, "cancelled", {});
}
