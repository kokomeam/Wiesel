/**
 * PURE FFmpeg argument builders for the in-house clip layouts (M-B, the D-5
 * resolution: the provider's reframe pan-crops toward a PiP face and has no
 * active-region tracking — Task 0 (f)). No IO, no spawn — localRender.ts
 * executes; these are golden-tested string builders.
 *
 * Output contract for every layout: 720×1280 (9:16), H.264 + AAC, the
 * span's own audio verbatim. Burned captions are NOT in the M-B in-house
 * outputs (deliberate, surfaced at the checkpoint): the caption engine with
 * real font infrastructure arrives with M-F's Remotion composition and will
 * caption these layouts too; drawtext/libass font resolution is unreliable
 * across dev/deploy targets and a wrong-font burn is worse than none.
 *
 * Layouts:
 *   stacked_split — face band (the PiP crop, deterministic via bubbleRect
 *     from the recorder's OWN constants when recording metadata exists —
 *     the D-3 'deterministic' provenance; vision-detected rect for legacy
 *     uploads) + full-width screen band + a brand backdrop caption zone.
 *   screen_action_zoom — Ken-Burns pans between transcript-cued regions of
 *     the screen: the frame is scaled so its HEIGHT fills 1280 (an implicit
 *     ~1.78× zoom on 16:9) and a 720-wide window pans between keyframe
 *     centers (piecewise-linear, expression-built).
 *   audiogram — the honest "simplest visual treatment": blurred backdrop
 *     from the footage + the footage as a legible 16:9 card + a brand-color
 *     waveform strip (showwaves) reacting to the audio.
 */

import { BRAND_TOKENS, ffmpegColor } from "@/lib/marketing/brand/tokens";

export const CLIP_OUT_W = 720;
export const CLIP_OUT_H = 1280;

/* ───────────────────────── stacked_split geometry ──────────────────────── */

/** 720×1280 = face band + screen band + caption zone. The screen band keeps
 *  the FULL slide legible (720 wide × 16:9 = 405); the caption zone is the
 *  reserved seam region (amendment FR-5's "captions across the seam"). */
export const STACKED_FACE_BAND_H = 460;
export const STACKED_SCREEN_BAND_H = 405;
export const STACKED_CAPTION_BAND_H = CLIP_OUT_H - STACKED_FACE_BAND_H - STACKED_SCREEN_BAND_H; // 415

export interface PipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StackedSplitArgsInput {
  inputPath: string;
  outputPath: string;
  /** The face (PiP) rect in SOURCE pixels. */
  pipRect: PipRect;
  durationSeconds: number;
}

/** Escape a filter-graph value that rides inside a filter option. */
function fc(hex: string): string {
  return ffmpegColor(hex);
}

export function buildStackedSplitArgs(input: StackedSplitArgsInput): string[] {
  const { pipRect } = input;
  const filter = [
    // face band: crop the bubble, fill 720×460 (cover), center-crop overflow
    `[0:v]crop=${pipRect.w}:${pipRect.h}:${pipRect.x}:${pipRect.y},` +
      `scale=${CLIP_OUT_W}:${STACKED_FACE_BAND_H}:force_original_aspect_ratio=increase,` +
      `crop=${CLIP_OUT_W}:${STACKED_FACE_BAND_H},setsar=1[face]`,
    // screen band: the FULL frame, legible (720 wide, 16:9 → 405)
    `[0:v]scale=${CLIP_OUT_W}:${STACKED_SCREEN_BAND_H},setsar=1[screen]`,
    // caption zone: brand backdrop (M-F's caption engine draws here)
    `color=c=${fc(BRAND_TOKENS.colors.backdrop)}:s=${CLIP_OUT_W}x${STACKED_CAPTION_BAND_H}:d=${input.durationSeconds}[pad]`,
    `[face][screen]vstack=inputs=2[fs]`,
    `[fs][pad]vstack=inputs=2[v]`,
  ].join(";");
  return [
    "-y",
    "-i", input.inputPath,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "160k",
    "-r", "30",
    "-shortest",
    "-movflags", "+faststart",
    input.outputPath,
  ];
}

/* ─────────────────────── screen_action_zoom (pans) ─────────────────────── */

export interface ZoomKeyframe {
  /** When this region becomes the target, ms from the CLIP start. */
  atMs: number;
  /** The region center as a fraction of source width (0..1). */
  centerX: number;
}

/**
 * Derive pan keyframes from the span's action-cue hit times: each cue pulls
 * the window toward an alternating third of the screen (demo action usually
 * alternates between the work area and the result area); no cues in a
 * stretch ⇒ hold. Deterministic + golden-tested; a real frame-diff hot-zone
 * signal can replace the alternation later without touching the expression
 * builder.
 */
export function zoomKeyframesFromCues(cueTimesMs: number[], clipDurationMs: number): ZoomKeyframe[] {
  const CENTERS = [0.35, 0.65]; // work area ↔ result area thirds
  const frames: ZoomKeyframe[] = [{ atMs: 0, centerX: 0.5 }];
  const inSpan = [...cueTimesMs].filter((t) => t >= 0 && t <= clipDurationMs).sort((a, b) => a - b);
  for (const [i, t] of inSpan.entries()) {
    frames.push({ atMs: t, centerX: CENTERS[i % CENTERS.length] });
  }
  return frames;
}

export interface ZoomPanArgsInput {
  inputPath: string;
  outputPath: string;
  keyframes: ZoomKeyframe[];
  durationSeconds: number;
  /** Source dimensions (the composited canvas is 1280×720). */
  sourceW: number;
  sourceH: number;
  /** Seconds a pan movement takes (ease between targets). */
  panSeconds?: number;
}

/**
 * Piecewise overlay-x expression over `t` (overlay evaluates x per frame):
 * before the first cue the window sits at the opening center; at each
 * keyframe it eases linearly to the new center over `panSeconds`
 * (`min((t-tᵢ)/pan, 1)` clamps the ease into a hold). Built inside-out:
 *
 *   segment(i) = xs[i-1] + (xs[i]-xs[i-1]) * min((t-tᵢ)/pan, 1)
 *   expr       = if(t<t₁, xs[0], if(t<t₂, segment(1), … segment(n)))
 *
 * Commas are legal inside the single-quoted x='…' option value.
 */
export function buildPanExpression(
  keyframes: ZoomKeyframe[],
  scaledW: number,
  panSeconds = 1.2
): string {
  const minX = -(scaledW - CLIP_OUT_W);
  const xFor = (centerX: number) =>
    Math.round(Math.min(0, Math.max(minX, -(centerX * scaledW - CLIP_OUT_W / 2))));
  const sorted = [...keyframes].sort((a, b) => a.atMs - b.atMs);
  const xs = sorted.map((k) => xFor(k.centerX));
  if (sorted.length === 1) return String(xs[0]);

  const sec = (i: number) => (sorted[i].atMs / 1000).toFixed(3);
  const segment = (i: number) =>
    `${xs[i - 1]}+(${xs[i]}-${xs[i - 1]})*min((t-${sec(i)})/${panSeconds},1)`;

  let expr = segment(sorted.length - 1);
  for (let i = sorted.length - 1; i >= 2; i--) {
    expr = `if(lt(t,${sec(i)}),${segment(i - 1)},${expr})`;
  }
  return `if(lt(t,${sec(1)}),${xs[0]},${expr})`;
}

export function buildZoomPanArgs(input: ZoomPanArgsInput): string[] {
  // Scale so height fills the canvas — the implicit zoom; even width for x264.
  const scaledW = Math.round((input.sourceW / input.sourceH) * CLIP_OUT_H) & ~1;
  const xExpr = buildPanExpression(input.keyframes, scaledW, input.panSeconds);
  const filter = [
    `color=c=${fc(BRAND_TOKENS.colors.backdrop)}:s=${CLIP_OUT_W}x${CLIP_OUT_H}:d=${input.durationSeconds}[bg]`,
    `[0:v]scale=${scaledW}:${CLIP_OUT_H},setsar=1[zoomed]`,
    `[bg][zoomed]overlay=x='${xExpr}':y=0:shortest=1[v]`,
  ].join(";");
  return [
    "-y",
    "-i", input.inputPath,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "160k",
    "-r", "30",
    "-movflags", "+faststart",
    input.outputPath,
  ];
}

/* ────────────────────────────── audiogram ──────────────────────────────── */

export interface AudiogramArgsInput {
  inputPath: string;
  outputPath: string;
  durationSeconds: number;
}

export const AUDIOGRAM_CARD_W = 656; // 720 − 2×32 margins
export const AUDIOGRAM_CARD_H = 369; // 16:9
export const AUDIOGRAM_CARD_Y = 320;
export const AUDIOGRAM_WAVE_H = 120;
export const AUDIOGRAM_WAVE_Y = 760;

export function buildAudiogramArgs(input: AudiogramArgsInput): string[] {
  const filter = [
    // blurred cover backdrop from the footage itself
    `[0:v]scale=${CLIP_OUT_W}:${CLIP_OUT_H}:force_original_aspect_ratio=increase,` +
      `crop=${CLIP_OUT_W}:${CLIP_OUT_H},boxblur=20:2,setsar=1[bg]`,
    // the footage, legible, as a centered card
    `[0:v]scale=${AUDIOGRAM_CARD_W}:${AUDIOGRAM_CARD_H},setsar=1[card]`,
    // brand-color waveform strip reacting to the span's audio
    `[0:a]showwaves=s=${AUDIOGRAM_CARD_W}x${AUDIOGRAM_WAVE_H}:mode=cline:colors=${fc(BRAND_TOKENS.colors.brand)}[wave]`,
    `[bg][card]overlay=32:${AUDIOGRAM_CARD_Y}[t1]`,
    `[t1][wave]overlay=32:${AUDIOGRAM_WAVE_Y}[v]`,
  ].join(";");
  return [
    "-y",
    "-i", input.inputPath,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "160k",
    "-r", "30",
    "-shortest",
    "-movflags", "+faststart",
    input.outputPath,
  ];
}
