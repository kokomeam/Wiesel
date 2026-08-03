/**
 * Text burn stage (directive H-2) — the post-geometry pass that burns the
 * hook overlay + karaoke captions onto the FINAL-RESOLUTION video, for every
 * real-footage path:
 *
 *   - provider clips (face_track): runs at INGEST — the CLEAN provider
 *     variant is downloaded (H-6: provider captions bypassed entirely) and
 *     burned locally before storage.
 *   - in-house ffmpeg layouts (stacked_split / screen_action_zoom /
 *     audiogram): runs as the final composite pass after geometry.
 *   - slide_short keeps its native Remotion captions/overlays (H-4: same
 *     style constants — never burned twice).
 *
 * BOTH artifacts are stored: the burned one is the post's media
 * (`video_path` / job output.storagePath); the pre-burn CLEAN MASTER
 * (`clean_video_path` / output.cleanStoragePath) makes hook edits free
 * local re-burns (H-3 — zero provider cost, quota untouched).
 *
 * One FFmpeg pass: `subtitles=` (libass) with the bundled fonts via
 * `fontsdir=` (textFonts.ts asserts resolution first — no silent DejaVu),
 * H.264 re-encode at the pipeline's own quality settings (crf 20 —
 * bitrate/resolution parity with the geometry pass), audio stream COPIED
 * (no generational audio loss).
 *
 * Failure honesty: a hook that can't fit even the T-7 shrink step degrades
 * to a captions-only burn with a `hook_omitted_unfit` finding (the creator
 * fixes the hook and re-burns — an unattended render never strands on
 * typography); a burn with NOTHING to draw copies the master through.
 */

import { copyFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { getLessonTranscript } from "../transcripts";
import type { ClipMomentCandidate } from "../schemas";
import type { ClipPlatform } from "../constants";
import {
  buildClipTextTrack,
  ClipTextTrackError,
  type ClipTextFinding,
  type ClipTextTrackSpec,
} from "../textTrack";
import type { ClipCaptionStyle, ClipHookAnimation } from "../textStyles";
import { assertClipFontsResolvable } from "../textFonts";
import { runFfmpeg } from "./localRender";
import type { ClipRenderJob } from "./jobs";

type DB = SupabaseClient<Database>;

/* ─────────────────── pure arg builders (golden-tested) ─────────────────── */

/**
 * Escape a path for use inside a single-quoted filter option value.
 * FFmpeg's filtergraph parser treats `'…'` as literal except the quote
 * itself; a quote splices out via `'\''` (close, escaped quote, reopen).
 */
export function escapeFilterPath(p: string): string {
  return p.replace(/'/g, "'\\''");
}

export function buildSubtitlesFilter(assPath: string, fontsDir: string): string {
  return `subtitles=filename='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath(fontsDir)}'`;
}

export interface BurnArgsInput {
  inputPath: string;
  assPath: string;
  fontsDir: string;
  outputPath: string;
}

/** Single-pass burn: libass subtitles filter, H.264 at the pipeline's own
 *  quality (crf 20 — parity with the geometry pass), audio copied. */
export function buildBurnArgs(input: BurnArgsInput): string[] {
  return [
    "-y",
    "-i", input.inputPath,
    "-vf", buildSubtitlesFilter(input.assPath, input.fontsDir),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "copy",
    "-movflags", "+faststart",
    input.outputPath,
  ];
}

/* ─────────────────────────── burn provenance ───────────────────────────── */

/** Persisted at ai_metadata.textBurn (post) / output.textBurn (job). */
export interface TextBurnMeta {
  /** The hook actually burned (null = omitted/disabled). */
  hookText: string | null;
  animation: ClipHookAnimation | null;
  holdSeconds: number | null;
  captionsEnabled: boolean;
  captionStyle: ClipCaptionStyle;
  platform: ClipPlatform;
  styleVersion: string;
  /** sha256 of the ASS document (null when nothing was drawn). */
  assHash: string | null;
  findings: ClipTextFinding[];
  /** False = nothing to draw; the master was copied through. */
  burned: boolean;
}

/* ───────────────────────── spec assembly (impure) ──────────────────────── */

/** The burn platform mirrors ingest's post platform (one burned artifact per
 *  post; the candidate's primary platform target decides the safe area). */
export function burnPlatformFor(candidate: Pick<ClipMomentCandidate, "targetPlatformFit">): ClipPlatform {
  return candidate.targetPlatformFit[0] ?? "instagram";
}

export interface JobTextSpecOverrides {
  hookText?: string | null;
  animation?: ClipHookAnimation | null;
  holdSeconds?: number | null;
  captionsEnabled?: boolean;
  captionStyle?: ClipCaptionStyle | null;
}

/**
 * Assemble the text-track spec for a render job: the candidate's hook +
 * clip-relative transcript words over the job's exact span (the
 * buildSlideShortSpec word logic — same intersection, same shift), preset
 * defaults for animation/style (H-5), captions ON by default.
 */
export async function buildJobTextSpec(
  supabase: DB,
  job: Pick<ClipRenderJob, "lessonId" | "preset" | "source">,
  candidate: Pick<ClipMomentCandidate, "hookText" | "targetPlatformFit">,
  video: { width: number; height: number },
  overrides: JobTextSpecOverrides = {}
): Promise<ClipTextTrackSpec> {
  const span = { startMs: job.source.startMs, endMs: job.source.endMs };
  const durationMs = span.endMs - span.startMs;
  const transcript = await getLessonTranscript(supabase, job.lessonId);
  const captionWords = (transcript?.words ?? [])
    .filter((w) => w.startMs < span.endMs && w.endMs > span.startMs)
    .map((w) => ({
      w: w.w,
      startMs: Math.max(0, w.startMs - span.startMs),
      endMs: Math.min(durationMs, w.endMs - span.startMs),
    }));
  const hookText = overrides.hookText !== undefined ? overrides.hookText : candidate.hookText;
  return {
    platform: burnPlatformFor(candidate),
    preset: job.preset,
    videoWidth: video.width,
    videoHeight: video.height,
    clipDurationMs: durationMs,
    hook: hookText
      ? {
          text: hookText,
          animation: overrides.animation ?? null,
          holdSeconds: overrides.holdSeconds ?? null,
        }
      : null,
    captionsEnabled: overrides.captionsEnabled ?? true,
    captionStyle: overrides.captionStyle ?? null,
    captionWords,
  };
}

/* ────────────────────────────── the burn ───────────────────────────────── */

export interface BurnClipTextArgs {
  inputPath: string;
  outputPath: string;
  spec: ClipTextTrackSpec;
  /** Injectable for tests — the real one spawns ffmpeg-static. */
  runFfmpegImpl?: typeof runFfmpeg;
}

/**
 * Burn the text track onto `inputPath` → `outputPath`. Returns the
 * provenance to persist. The ASS document is written next to the output
 * (the caller owns the temp dir). Degrades per the module docblock.
 */
export async function burnClipText(args: BurnClipTextArgs): Promise<TextBurnMeta> {
  const run = args.runFfmpegImpl ?? runFfmpeg;
  const findings: ClipTextFinding[] = [];
  let spec = args.spec;
  let track: ReturnType<typeof buildClipTextTrack>;
  try {
    track = buildClipTextTrack(spec);
  } catch (err) {
    if (err instanceof ClipTextTrackError && (err.code === "hook_unfit" || err.code === "hook_too_many_words")) {
      findings.push({ kind: "hook_omitted_unfit", detail: err.message });
      spec = { ...spec, hook: null };
      track = buildClipTextTrack(spec);
    } else {
      throw err;
    }
  }
  findings.push(...track.findings);

  const meta: TextBurnMeta = {
    hookText: spec.hook?.text ?? null,
    animation: track.hookPlan?.animation ?? null,
    holdSeconds: spec.hook?.holdSeconds ?? (track.hookPlan ? track.hookPlan.holdMs / 1000 : null),
    captionsEnabled: spec.captionsEnabled,
    captionStyle: track.captionStyle,
    platform: spec.platform,
    styleVersion: track.styleVersion,
    assHash: null,
    findings,
    burned: false,
  };

  const hasEvents = /\nDialogue: /.test(track.ass);
  if (!hasEvents) {
    // Nothing to draw (no hook, captions off/empty) — pass the master through.
    copyFileSync(args.inputPath, args.outputPath);
    return meta;
  }

  const { dir: fontsDir } = assertClipFontsResolvable();
  const assPath = `${args.outputPath}.ass`;
  writeFileSync(assPath, track.ass, "utf8");
  await run(buildBurnArgs({ inputPath: args.inputPath, assPath, fontsDir, outputPath: args.outputPath }));
  meta.assHash = createHash("sha256").update(track.ass).digest("hex");
  meta.burned = true;
  return meta;
}
