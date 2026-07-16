/**
 * Action-density check (amendment FR-3) — a DETERMINISTIC module, no model
 * call, answering: is this span's screen doing something worth watching?
 *
 * Two signals, either sufficient:
 *   1. TRANSCRIPT CUES — demonstration verbs/phrases from the maintained
 *      lexicon (CLIP_ACTION_CUES in constants.ts — adding a cue is a data
 *      change only). Rate = DISTINCT cue hits per minute of span, vs.
 *      CLIP_ACTION_DENSITY_THRESHOLD.
 *   2. FRAME-DIFF (optional) — a coarse frame-difference ratio over sampled
 *      frames of the span, supplied by the caller when the media is locally
 *      accessible (it never is in this runtime: media lives on Mux and
 *      ffmpeg/ffprobe are not installed — verified 2026-07-08). vs.
 *      CLIP_ACTION_FRAME_DIFF_THRESHOLD.
 *
 * DEGRADED MODE (binding, tested): frameDiffRatio null/absent ⇒ transcript
 * cues alone decide. Threshold rationale lives on the constants (docs/clips.md
 * carries the maintenance guide).
 */

import {
  CLIP_ACTION_CUES,
  clipActionDensityThreshold,
  clipActionFrameDiffThreshold,
} from "./constants";
import type { TranscriptWord } from "./schemas";

/** Compiled once — whole-word/phrase, case-insensitive, apostrophe-tolerant. */
const CUE_REGEXES: { source: string; re: RegExp }[] = CLIP_ACTION_CUES.map((source) => ({
  source,
  re: new RegExp(`\\b(?:${source})\\b`, "iu"),
}));

export interface ActionDensitySignal {
  /** Distinct lexicon cues matched in the span's transcript. */
  cueHits: string[];
  /** Distinct cue hits per minute of span. */
  cuesPerMinute: number;
  /** The optional coarse frame-diff signal (null = unavailable → degraded). */
  frameDiffRatio: number | null;
  /** The FR-3 verdict. */
  dense: boolean;
}

export interface ActionDensityOptions {
  /** Coarse frame-difference ratio over the span's sampled frames, when the
   *  media is locally accessible. Null/omitted ⇒ degraded mode. */
  frameDiffRatio?: number | null;
  /** Test/config overrides — production reads the env-backed defaults. */
  cueThresholdPerMinute?: number;
  frameDiffThreshold?: number;
}

/** Cue hits over arbitrary text (exposed for the lexicon's table tests). */
export function matchActionCues(text: string): string[] {
  const normalized = text.replace(/[’‘]/g, "'");
  return CUE_REGEXES.filter(({ re }) => re.test(normalized)).map(({ source }) => source);
}

/**
 * WHEN the demonstration cues land inside a span — clip-relative ms offsets,
 * one per cue hit (the screen_action_zoom pan keyframes, FR-5: "zoompan
 * keyframing driven by transcript-cued regions"). Pure: builds the span's
 * text with a char→word map, finds each cue match, converts the match
 * offset to the underlying word's startMs.
 */
export function actionCueTimes(
  words: TranscriptWord[],
  span: { startMs: number; endMs: number }
): number[] {
  const spanWords = words.filter((w) => w.startMs < span.endMs && w.endMs > span.startMs);
  if (spanWords.length === 0) return [];
  let text = "";
  const charToWord: number[] = [];
  for (const [i, w] of spanWords.entries()) {
    if (i > 0) {
      text += " ";
      charToWord.push(i - 1);
    }
    for (let c = 0; c < w.w.length; c++) charToWord.push(i);
    text += w.w;
  }
  const normalized = text.replace(/[’‘]/g, "'");
  const times: number[] = [];
  for (const { source } of CUE_REGEXES) {
    const re = new RegExp(`\\b(?:${source})\\b`, "giu");
    for (const m of normalized.matchAll(re)) {
      const wordIdx = charToWord[m.index] ?? 0;
      times.push(Math.max(0, spanWords[wordIdx].startMs - span.startMs));
    }
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

/**
 * Score one span. Duration comes from the span bounds (not word count) so an
 * empty-transcript span scores 0 cues/min rather than dividing by zero.
 */
export function scoreActionDensity(
  words: TranscriptWord[],
  span: { startMs: number; endMs: number },
  opts: ActionDensityOptions = {}
): ActionDensitySignal {
  const cueThreshold = opts.cueThresholdPerMinute ?? clipActionDensityThreshold();
  const diffThreshold = opts.frameDiffThreshold ?? clipActionFrameDiffThreshold();
  const frameDiffRatio = opts.frameDiffRatio ?? null;

  const spanText = words
    .filter((w) => w.startMs < span.endMs && w.endMs > span.startMs)
    .map((w) => w.w)
    .join(" ");
  const cueHits = matchActionCues(spanText);

  const minutes = Math.max((span.endMs - span.startMs) / 60_000, 1 / 60);
  const cuesPerMinute = cueHits.length / minutes;

  const denseByCues = cuesPerMinute >= cueThreshold;
  const denseByFrames = frameDiffRatio !== null && frameDiffRatio >= diffThreshold;

  return { cueHits, cuesPerMinute, frameDiffRatio, dense: denseByCues || denseByFrames };
}
