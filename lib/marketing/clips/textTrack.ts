/**
 * ASS text-track builder (directive H-1) — PURE: spec in, ASS document out.
 * No IO, no clock, no crypto; the burn stage (render/burn.ts) writes the
 * file and runs FFmpeg's `subtitles=` filter over it (libass), with the
 * bundled fonts via `fontsdir=` (textFonts.ts).
 *
 * Everything visual comes from textStyles.ts (H-4/T-2/T-3/T-4) + brand
 * tokens — this file contains zero magic style values. The document is
 * authored at the ACTUAL video resolution (PlayResX/Y = the video's own
 * dimensions) with every reference constant scaled BY HEIGHT (the T-2 rule),
 * so libass never rescales anamorphically on 1:1 canvases.
 *
 * Layers:
 *   HOOK — one dialogue event; animation variants are data-driven
 *     (CLIP_HOOK_ANIMATIONS; motion values in CLIP_TEXT_MOTION, T-4).
 *     Wrapping is deterministic (estimated advance widths, T-2 ratios):
 *     ≤6 words try one line @hookSingleLine, 7–10 words two balanced lines
 *     @hookTwoLine; a still-overflowing hook takes T-7's ONE shrink step
 *     (@hookShrunk) and then HARD-FAILS (`hook_unfit`) — the burn stage
 *     degrades to captions-only and surfaces the finding.
 *   CAPTIONS — word-level karaoke from transcript timestamps, grouped 3–4
 *     words per line (T-2), ONE line at a time, lower-third inside the
 *     platform safe area (H-4). Styles (T-3 beam/block/minimal) are pure
 *     data over one renderer: per word interval the line re-renders with
 *     the active word styled; `block` uses a second layer whose BorderStyle=3
 *     run-box is alpha-hidden on every word except the active one (both
 *     layers \an5 at the same center so symmetric border growth can't
 *     misalign the glyph overlay — the boxed word carries no stroke, it sits
 *     on its own brand box).
 *
 * T-7 legibility lint runs inside `prepareTextTrack` (pre-burn,
 * deterministic): wrap/shrink, width-driven regrouping, hook-duplicate
 * caption suppression during the hold window, accent clamping, and a
 * post-layout safe-area re-verification.
 */

import { CLIP_HOOK_MAX_WORDS, type ClipPlatform } from "./constants";
import {
  CLIP_CAPTION_STYLE_SPECS,
  CLIP_TEXT_MOTION,
  CLIP_TEXT_STYLES,
  CLIP_TEXT_STYLE_VERSION,
  captionAnchor,
  clipTextPresetDefaults,
  clipTextScale,
  hookAnchor,
  safeTextFrame,
  usableTextWidth,
  type ClipCaptionStyle,
  type ClipHookAnimation,
  type ClipTextLayerStyle,
} from "./textStyles";

/* ────────────────────────────── spec types ─────────────────────────────── */

export interface ClipCaptionWordInput {
  w: string;
  /** CLIP-relative ms. */
  startMs: number;
  endMs: number;
}

export interface ClipHookSpec {
  text: string;
  /** Default: the preset's animation (H-5). */
  animation?: ClipHookAnimation | null;
  /** Default: the animation's holdMsDefault (T-4). Ignored by
   *  slide_across/persistent (their windows are fixed/full-clip). */
  holdSeconds?: number | null;
  /** ≤2 word indices rendered in the brand accent (T-2); extras clamp. */
  accentWordIndices?: number[] | null;
}

export interface ClipTextTrackSpec {
  platform: ClipPlatform;
  /** Packaging preset id (tofu_hook | mofu_story | bofu_preview). */
  preset: string;
  videoWidth: number;
  videoHeight: number;
  clipDurationMs: number;
  /** null = no hook layer (captions-only burn). */
  hook: ClipHookSpec | null;
  captionsEnabled: boolean;
  /** Default: the preset's caption style (T-3/H-5). */
  captionStyle?: ClipCaptionStyle | null;
  captionWords: ClipCaptionWordInput[];
}

export type ClipTextFinding =
  | { kind: "hook_shrunk"; detail: string }
  | { kind: "hook_omitted_unfit"; detail: string }
  | { kind: "hook_accent_clamped"; detail: string }
  | { kind: "caption_regrouped_for_width"; detail: string }
  | { kind: "caption_suppressed_under_hook"; detail: string }
  | { kind: "caption_word_overflow"; detail: string }
  | { kind: "safe_area_clamped"; detail: string };

export class ClipTextTrackError extends Error {
  constructor(
    readonly code: "hook_unfit" | "hook_too_many_words" | "bad_spec",
    message: string
  ) {
    super(message);
    this.name = "ClipTextTrackError";
  }
}

/* ─────────────────────────── small pure helpers ────────────────────────── */

/** #rrggbb → ASS &HAABBGGRR& (ASS colors are BGR with a leading alpha). */
export function assColor(hex: string, alphaByte = 0): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) throw new ClipTextTrackError("bad_spec", `assColor needs #rrggbb, got "${hex}"`);
  const a = alphaByte.toString(16).padStart(2, "0").toUpperCase();
  return `&H${a}${m[3].toUpperCase()}${m[2].toUpperCase()}${m[1].toUpperCase()}`;
}

/** ms → ASS h:mm:ss.cc (centiseconds). */
export function assTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms / 10) * 10);
  const cs = Math.round((clamped % 1000) / 10);
  const s = Math.floor(clamped / 1000) % 60;
  const min = Math.floor(clamped / 60_000) % 60;
  const h = Math.floor(clamped / 3_600_000);
  return `${h}:${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** Strip characters that would break out of dialogue text/override blocks. */
export function escapeAssText(text: string): string {
  return text.replace(/[{}\\]/g, " ").replace(/\s+/g, " ").trim();
}

export function applyCaseRule(text: string, rule: "upper" | "title"): string {
  if (rule === "upper") return text.toUpperCase();
  // Title Case that PRESERVES existing capitals ("USACO" stays "USACO").
  return text.replace(/(^|\s)(\p{Ll})/gu, (m, sep: string, ch: string) => sep + ch.toUpperCase());
}

function estWidthPx(text: string, sizePx: number, charFrac: number): number {
  return text.length * sizePx * charFrac;
}

/* ─────────────────────────── hook wrap + plan ──────────────────────────── */

export interface HookPlan {
  /** Display lines (case rule applied), 1 or 2. */
  lines: string[];
  /** Word→line mapping preserved for accent indices. */
  wordsPerLine: number[];
  sizePx: number;
  strokePx: number;
  shadowPx: number;
  animation: ClipHookAnimation;
  holdMs: number;
  /** [startMs, endMs] the hook is visible. */
  windowMs: [number, number];
  anchor: { x: number; y: number };
  blockHeightPx: number;
  estWidthPx: number;
}

/** Balanced two-line split: the word boundary minimizing width imbalance. */
export function balancedTwoLineSplit(words: string[]): [string, string] {
  let best: [string, string] = [words.slice(0, -1).join(" "), words[words.length - 1]];
  let bestDelta = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const delta = Math.abs(a.length - b.length);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = [a, b];
    }
  }
  return best;
}

interface HookFit {
  lines: string[];
  wordsPerLine: number[];
  style: ClipTextLayerStyle;
  estWidthPx: number;
  shrunk: boolean;
}

/** T-2 wrap ladder: 1 line @single → 2 lines @twoLine → 2 lines @shrunk
 *  (T-7's one step) → null (hard fail). All widths in video px. */
export function planHookFit(args: {
  displayText: string;
  wordCount: number;
  usableWidthPx: number;
  scale: number;
  charFrac: number;
  lowKey: boolean;
}): HookFit | null {
  const { displayText, wordCount, usableWidthPx, scale, charFrac, lowKey } = args;
  const words = displayText.split(/\s+/).filter(Boolean);
  const sized = (style: ClipTextLayerStyle) => ({
    ...style,
    sizePx: Math.round(style.sizePx * scale),
    strokePx: Math.max(1, Math.round(style.strokePx * scale)),
    shadowPx: Math.round(style.shadowPx * scale),
  });
  const oneLine = (style: ClipTextLayerStyle): HookFit | null => {
    const w = estWidthPx(displayText, style.sizePx, charFrac);
    return w <= usableWidthPx
      ? { lines: [displayText], wordsPerLine: [words.length], style, estWidthPx: w, shrunk: false }
      : null;
  };
  const twoLine = (style: ClipTextLayerStyle, shrunk: boolean): HookFit | null => {
    if (words.length < 2) return null;
    const [a, b] = balancedTwoLineSplit(words);
    const w = Math.max(estWidthPx(a, style.sizePx, charFrac), estWidthPx(b, style.sizePx, charFrac));
    return w <= usableWidthPx
      ? {
          lines: [a, b],
          wordsPerLine: [a.split(/\s+/).length, b.split(/\s+/).length],
          style,
          estWidthPx: w,
          shrunk,
        }
      : null;
  };

  if (lowKey) {
    const base = sized(CLIP_TEXT_STYLES.hookLowKey);
    const shrunkStyle = sized({ ...CLIP_TEXT_STYLES.hookShrunk, strokePx: CLIP_TEXT_STYLES.hookLowKey.strokePx, shadowPx: CLIP_TEXT_STYLES.hookLowKey.shadowPx });
    return oneLine(base) ?? twoLine(base, false) ?? twoLine(shrunkStyle, true);
  }
  const single = sized(CLIP_TEXT_STYLES.hookSingleLine);
  const two = sized(CLIP_TEXT_STYLES.hookTwoLine);
  const shrunkStyle = sized(CLIP_TEXT_STYLES.hookShrunk);
  if (wordCount <= 6) {
    return oneLine(single) ?? twoLine(two, false) ?? twoLine(shrunkStyle, true);
  }
  return twoLine(two, false) ?? twoLine(shrunkStyle, true);
}

/* ─────────────────────────── caption grouping ──────────────────────────── */

export interface CaptionGroup {
  words: ClipCaptionWordInput[];
  /** Display window (line visible), clip-relative ms. */
  startMs: number;
  endMs: number;
}

/**
 * Greedy 3–4 word grouping (T-2): fill to captionMaxWordsPerLine, break on
 * a ≥gapBreakMs silence; a stranded 1-word tail rebalances from the
 * previous group. Display window = first word start → next group's start,
 * capped at last word end + lingerMs.
 */
export function groupCaptionWords(
  words: ClipCaptionWordInput[],
  clipDurationMs: number,
  maxWordsPerLine: number = CLIP_TEXT_STYLES.captionMaxWordsPerLine
): CaptionGroup[] {
  const clean = words
    .map((w) => ({ ...w, w: escapeAssText(w.w) }))
    .filter((w) => w.w.length > 0 && w.endMs > w.startMs && w.startMs < clipDurationMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (clean.length === 0) return [];

  const chunks: ClipCaptionWordInput[][] = [];
  let current: ClipCaptionWordInput[] = [];
  for (const w of clean) {
    const prev = current[current.length - 1];
    if (current.length >= maxWordsPerLine || (prev && w.startMs - prev.endMs >= CLIP_TEXT_MOTION.caption.gapBreakMs)) {
      chunks.push(current);
      current = [];
    }
    current.push(w);
  }
  if (current.length) chunks.push(current);

  // Rebalance a stranded single-word tail (…4 + 1 → …3 + 2) when the tail
  // isn't its own gap-separated utterance.
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const tail = chunks[i];
    const gap = tail[0].startMs - prev[prev.length - 1].endMs;
    if (tail.length === 1 && prev.length >= CLIP_TEXT_STYLES.captionMinWordsPerLine && gap < CLIP_TEXT_MOTION.caption.gapBreakMs) {
      tail.unshift(prev.pop()!);
    }
  }

  return chunks.map((chunk, i) => {
    const next = chunks[i + 1];
    const start = chunk[0].startMs;
    const lastEnd = chunk[chunk.length - 1].endMs;
    const end = Math.min(
      next ? next[0].startMs : clipDurationMs,
      lastEnd + CLIP_TEXT_MOTION.caption.lingerMs,
      clipDurationMs
    );
    return { words: chunk, startMs: start, endMs: Math.max(end, lastEnd > clipDurationMs ? start : Math.min(lastEnd, clipDurationMs)) };
  });
}

/* ───────────────────────── prepare (T-7 lint) ──────────────────────────── */

export interface PreparedTextTrack {
  spec: ClipTextTrackSpec;
  hookPlan: HookPlan | null;
  groups: CaptionGroup[];
  captionStyle: ClipCaptionStyle;
  findings: ClipTextFinding[];
}

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * The deterministic pre-burn pass (T-7): resolves defaults, wraps/shrinks
 * the hook (throwing `hook_unfit` past the one shrink step), groups + width-
 * fits captions, suppresses a caption line that duplicates the hook inside
 * its hold window, and re-verifies every block against the safe area.
 */
export function prepareTextTrack(input: ClipTextTrackSpec): PreparedTextTrack {
  if (input.videoWidth <= 0 || input.videoHeight <= 0 || input.clipDurationMs <= 0) {
    throw new ClipTextTrackError("bad_spec", "video dimensions and clip duration must be positive");
  }
  const findings: ClipTextFinding[] = [];
  const defaults = clipTextPresetDefaults(input.preset);
  const scale = clipTextScale(input.videoHeight);
  const usableW = usableTextWidth(input.platform, input.videoWidth, input.videoHeight);
  const frame = safeTextFrame(input.platform, input.videoWidth, input.videoHeight);

  /* hook */
  let hookPlan: HookPlan | null = null;
  if (input.hook) {
    const rawWords = input.hook.text.trim().split(/\s+/).filter(Boolean);
    if (rawWords.length === 0) {
      throw new ClipTextTrackError("bad_spec", "hook text is empty");
    }
    if (rawWords.length > CLIP_HOOK_MAX_WORDS) {
      throw new ClipTextTrackError(
        "hook_too_many_words",
        `hook must be ≤${CLIP_HOOK_MAX_WORDS} words (got ${rawWords.length}) — the Zod bound upstream should have caught this`
      );
    }
    const displayText = escapeAssText(applyCaseRule(input.hook.text, defaults.hookCase));
    const charFrac =
      defaults.hookCase === "upper"
        ? CLIP_TEXT_STYLES.avgCharWidthFrac.hookUpper
        : CLIP_TEXT_STYLES.avgCharWidthFrac.hookTitle;
    const fit = planHookFit({
      displayText,
      wordCount: rawWords.length,
      usableWidthPx: usableW,
      scale,
      charFrac,
      lowKey: defaults.lowKeyHook,
    });
    if (!fit) {
      throw new ClipTextTrackError(
        "hook_unfit",
        `hook does not fit two lines at the shrink step on ${input.platform} — shorten the hook (≤${CLIP_HOOK_MAX_WORDS} words is necessary but not sufficient for very long words)`
      );
    }
    if (fit.shrunk) {
      findings.push({ kind: "hook_shrunk", detail: `hook shrunk one step to ${fit.style.sizePx}px to fit ${input.platform}` });
    }

    const animation = input.hook.animation ?? defaults.animation;
    const motion = CLIP_TEXT_MOTION;
    const holdMs =
      input.hook.holdSeconds != null
        ? Math.max(500, Math.round(input.hook.holdSeconds * 1000))
        : animation === "slide_in_fade"
          ? motion.slideInFade.holdMsDefault
          : motion.fadeInOut.holdMsDefault;
    let windowEnd: number;
    switch (animation) {
      case "slide_in_fade":
        windowEnd = motion.slideInFade.slideMs + holdMs + motion.slideInFade.fadeOutMs;
        break;
      case "fade_in_out":
        windowEnd = motion.fadeInOut.fadeInMs + holdMs + motion.fadeInOut.fadeOutMs;
        break;
      case "slide_across":
        windowEnd = motion.slideAcross.traverseMs;
        break;
      case "persistent":
        windowEnd = input.clipDurationMs;
        break;
    }
    windowEnd = Math.min(windowEnd, input.clipDurationMs);

    const blockHeightPx = Math.round(fit.lines.length * fit.style.sizePx * CLIP_TEXT_STYLES.lineHeightFrac);
    const anchor = hookAnchor(input.platform, input.preset, input.videoWidth, input.videoHeight, blockHeightPx);
    const wantedY = input.videoHeight * defaults.hookAnchorYFrac;
    if (Math.abs(anchor.y - wantedY) > 1) {
      findings.push({ kind: "safe_area_clamped", detail: `hook anchor clamped from y=${Math.round(wantedY)} to y=${anchor.y} inside the ${input.platform} safe area` });
    }

    hookPlan = {
      lines: fit.lines,
      wordsPerLine: fit.wordsPerLine,
      sizePx: fit.style.sizePx,
      strokePx: fit.style.strokePx,
      shadowPx: fit.style.shadowPx,
      animation,
      holdMs,
      windowMs: [0, windowEnd],
      anchor,
      blockHeightPx,
      estWidthPx: fit.estWidthPx,
    };

    // Accent clamp (T-2: ≤2 words).
    const accents = input.hook.accentWordIndices ?? [];
    if (accents.length > CLIP_TEXT_STYLES.hookAccentMaxWords) {
      findings.push({ kind: "hook_accent_clamped", detail: `accent limited to ${CLIP_TEXT_STYLES.hookAccentMaxWords} words (asked for ${accents.length})` });
    }

    // Post-layout safe-area re-verification (T-7).
    const halfW = fit.estWidthPx / 2;
    const halfH = blockHeightPx / 2;
    if (
      anchor.x - halfW < frame.x0 - 1 ||
      anchor.x + halfW > frame.x1 + 1 ||
      anchor.y - halfH < frame.y0 - 1 ||
      anchor.y + halfH > frame.y1 + 1
    ) {
      // By construction this can't happen (fit ≤ usable width, anchor
      // clamped) — a violation means the constants drifted; fail loudly.
      throw new ClipTextTrackError("bad_spec", "hook layout escaped the platform safe area — safe-area constants and fit math disagree");
    }
  }

  /* captions */
  const captionStyle = input.captionStyle ?? defaults.captionStyle;
  let groups: CaptionGroup[] = [];
  if (input.captionsEnabled && input.captionWords.length > 0) {
    const capSize = Math.round(CLIP_TEXT_STYLES.caption.sizePx * scale);
    groups = groupCaptionWords(input.captionWords, input.clipDurationMs);

    // Width fit (T-7 "caption group >4 words → regroup" generalized): a line
    // wider than the safe frame regroups at one word fewer, down to 1.
    for (let maxWords = CLIP_TEXT_STYLES.captionMaxWordsPerLine - 1; maxWords >= 1; maxWords--) {
      const tooWide = groups.some(
        (g) =>
          estWidthPx(g.words.map((w) => w.w).join(" "), capSize, CLIP_TEXT_STYLES.avgCharWidthFrac.caption) > usableW
      );
      if (!tooWide) break;
      groups = groupCaptionWords(input.captionWords, input.clipDurationMs, maxWords);
      findings.push({ kind: "caption_regrouped_for_width", detail: `caption lines regrouped at ≤${maxWords} words to fit ${input.platform}` });
    }
    for (const g of groups) {
      for (const w of g.words) {
        if (estWidthPx(w.w, capSize, CLIP_TEXT_STYLES.avgCharWidthFrac.caption) > usableW) {
          findings.push({ kind: "caption_word_overflow", detail: `single word "${w.w}" is wider than the ${input.platform} safe frame` });
        }
      }
    }

    // T-7: a first caption line that duplicates the hook is suppressed while
    // the hook is on screen (delayed past it, or dropped if fully covered).
    if (hookPlan && groups.length > 0) {
      const hookNorm = normalizeForCompare(input.hook!.text);
      const first = groups[0];
      const firstNorm = normalizeForCompare(first.words.map((w) => w.w).join(" "));
      const overlapsHook = first.startMs < hookPlan.windowMs[1];
      if (overlapsHook && firstNorm.length > 0 && (hookNorm === firstNorm || hookNorm.includes(firstNorm))) {
        if (first.endMs <= hookPlan.windowMs[1]) {
          groups = groups.slice(1);
          findings.push({ kind: "caption_suppressed_under_hook", detail: "first caption line duplicated the hook and sat fully inside its window — dropped" });
        } else {
          first.startMs = hookPlan.windowMs[1];
          findings.push({ kind: "caption_suppressed_under_hook", detail: "first caption line duplicated the hook — delayed until the hook exits" });
        }
      }
    }
  }

  return { spec: input, hookPlan, groups, captionStyle, findings };
}

/* ───────────────────────────── ASS assembly ────────────────────────────── */

const HOOK_STYLE = "WiseHook";
const CAPTION_STYLE = "WiseCaption";
const CAPTION_BOX_STYLE = "WiseCaptionBox";

function styleLine(args: {
  name: string;
  fontFamily: string;
  bold: boolean;
  sizePx: number;
  primary: string;
  outline: string;
  back: string;
  outlinePx: number;
  shadowPx: number;
  borderStyle: 1 | 3;
  align: number;
  marginL?: number;
  marginR?: number;
  marginV?: number;
}): string {
  return [
    `Style: ${args.name}`,
    args.fontFamily,
    args.sizePx,
    args.primary,
    args.primary, // SecondaryColour (unused — we never use \k fill)
    args.outline,
    args.back,
    args.bold ? -1 : 0,
    0, // Italic
    0, // Underline
    0, // StrikeOut
    100, // ScaleX
    100, // ScaleY
    0, // Spacing
    0, // Angle
    args.borderStyle,
    args.outlinePx,
    args.shadowPx,
    args.align,
    args.marginL ?? 0,
    args.marginR ?? 0,
    args.marginV ?? 0,
    1, // Encoding
  ].join(",");
}

function dialogue(args: {
  layer: number;
  startMs: number;
  endMs: number;
  style: string;
  text: string;
}): string {
  return `Dialogue: ${args.layer},${assTime(args.startMs)},${assTime(args.endMs)},${args.style},,0,0,0,,${args.text}`;
}

/** Blur/soften tag when the layer casts a shadow (T-2 "soft"). */
function softTag(shadowPx: number): string {
  return shadowPx > 0 ? `\\be${CLIP_TEXT_STYLES.shadowSoftness}` : "";
}

function buildHookEvents(prepared: PreparedTextTrack): string[] {
  const plan = prepared.hookPlan;
  if (!plan) return [];
  const spec = prepared.spec;
  const motion = CLIP_TEXT_MOTION;
  const accentSet = new Set((spec.hook?.accentWordIndices ?? []).slice(0, CLIP_TEXT_STYLES.hookAccentMaxWords));

  // Rebuild the display text with accent overrides, word-indexed across lines.
  const fill = assColor(CLIP_TEXT_STYLES.fill);
  const accent = assColor(CLIP_TEXT_STYLES.accent);
  let wordIndex = 0;
  const lines = plan.lines.map((line) => {
    const words = line.split(/\s+/).map((w) => {
      const styled = accentSet.has(wordIndex) ? `{\\1c${accent}}${w}{\\1c${fill}}` : w;
      wordIndex++;
      return styled;
    });
    return words.join(" ");
  });
  const text = lines.join("\\N");

  const { x, y } = plan.anchor;
  const sizeTag = `\\fs${plan.sizePx}\\bord${plan.strokePx}\\shad${plan.shadowPx}${softTag(plan.shadowPx)}`;
  let moveTag: string;
  switch (plan.animation) {
    case "slide_in_fade": {
      const travel = Math.round(motion.slideInFade.travelFrac * spec.videoWidth);
      moveTag = `\\move(${x - travel},${y},${x},${y},0,${motion.slideInFade.slideMs})\\fad(0,${motion.slideInFade.fadeOutMs})`;
      break;
    }
    case "fade_in_out":
      moveTag = `\\pos(${x},${y})\\fad(${motion.fadeInOut.fadeInMs},${motion.fadeInOut.fadeOutMs})`;
      break;
    case "slide_across": {
      const halfW = Math.round(plan.estWidthPx / 2);
      moveTag = `\\move(${-halfW},${y},${spec.videoWidth + halfW},${y},0,${motion.slideAcross.traverseMs})`;
      break;
    }
    case "persistent":
      moveTag = `\\pos(${x},${y})\\fad(${motion.persistent.fadeInMs},0)`;
      break;
  }

  return [
    dialogue({
      layer: 2,
      startMs: plan.windowMs[0],
      endMs: plan.windowMs[1],
      style: HOOK_STYLE,
      text: `{\\an5${moveTag}${sizeTag}}${text}`,
    }),
  ];
}

function buildCaptionEvents(prepared: PreparedTextTrack): string[] {
  const { spec, groups, captionStyle } = prepared;
  if (groups.length === 0) return [];
  const styleSpec = CLIP_CAPTION_STYLE_SPECS[captionStyle];
  const scale = clipTextScale(spec.videoHeight);
  const sizePx = Math.round(CLIP_TEXT_STYLES.caption.sizePx * scale);
  const lineH = Math.round(sizePx * CLIP_TEXT_STYLES.lineHeightFrac);
  const anchor = captionAnchor(spec.platform, spec.videoWidth, spec.videoHeight);
  const cx = anchor.x;
  const cy = anchor.bottomY - Math.round(lineH / 2);
  const posTag = `{\\an5\\pos(${cx},${cy})}`;
  const boxPad = Math.max(2, Math.round(CLIP_TEXT_STYLES.boxPadPx * scale));
  const fill = assColor(CLIP_TEXT_STYLES.fill);
  const events: string[] = [];

  for (const g of groups) {
    const words = g.words;
    const lineText = (activeIdx: number | null): string =>
      words
        .map((w, i) => {
          if (i !== activeIdx || !styleSpec.activeFill) return w.w;
          const scalePct = styleSpec.activeScalePct;
          const scaleTag = scalePct !== 100 ? `\\fscx${scalePct}\\fscy${scalePct}` : "";
          return `{\\1c${assColor(styleSpec.activeFill)}${scaleTag}}${w.w}{\\1c${fill}\\fscx100\\fscy100}`;
        })
        .join(" ");

    /** Word-boundary intervals across the group window (karaoke timing). */
    const wordCuts = (): { t0: number; t1: number; active: number | null }[] => {
      const cuts: { t0: number; t1: number; active: number | null }[] = [];
      let cursor = g.startMs;
      for (const [i, w] of words.entries()) {
        const t0 = Math.max(cursor, Math.min(w.startMs, g.endMs));
        const t1 = Math.max(t0, Math.min(w.endMs, g.endMs));
        if (t0 > cursor) cuts.push({ t0: cursor, t1: t0, active: null });
        if (t1 > t0) cuts.push({ t0, t1, active: i });
        cursor = Math.max(cursor, t1);
      }
      if (cursor < g.endMs) cuts.push({ t0: cursor, t1: g.endMs, active: null });
      return cuts.filter((c) => Math.round(c.t1 / 10) > Math.round(c.t0 / 10));
    };

    if (styleSpec.activeBox) {
      // block: the brand box rides a LOWER layer whose text is fully
      // transparent (only the active word's BorderStyle=3 run-box shows), so
      // the box's padding sits BEHIND neighboring words instead of covering
      // them; the stroked base line renders once above it — the active word
      // keeps its stroke and sits on its own brand box.
      const hidden = "{\\1a&HFF&\\3a&HFF&\\4a&HFF&}";
      const shown = "{\\1a&HFF&\\3a&H00&\\4a&HFF&}";
      for (const cut of wordCuts()) {
        if (cut.active === null) continue;
        const boxText = words.map((w, i) => `${i === cut.active ? shown : hidden}${w.w}`).join(" ");
        events.push(
          dialogue({ layer: 0, startMs: cut.t0, endMs: cut.t1, style: CAPTION_BOX_STYLE, text: `${posTag}{\\bord${boxPad}}${boxText}` })
        );
      }
      events.push(dialogue({ layer: 1, startMs: g.startMs, endMs: g.endMs, style: CAPTION_STYLE, text: `${posTag}${lineText(null)}` }));
      continue;
    }

    if (!styleSpec.activeFill) {
      // minimal: one event for the whole line window.
      events.push(dialogue({ layer: 0, startMs: g.startMs, endMs: g.endMs, style: CAPTION_STYLE, text: `${posTag}${lineText(null)}` }));
      continue;
    }

    // beam: per-interval events — the full line re-renders with the spoken
    // word brand-filled + subtly scaled (word-level karaoke fill).
    for (const cut of wordCuts()) {
      events.push(
        dialogue({ layer: 0, startMs: cut.t0, endMs: cut.t1, style: CAPTION_STYLE, text: `${posTag}${lineText(cut.active)}` })
      );
    }
  }
  return events;
}

/**
 * The rich build API: ASS document + the lint findings + the resolved hook
 * plan (the burn stage persists these into ai_metadata.textBurn).
 */
export function buildClipTextTrack(spec: ClipTextTrackSpec): {
  ass: string;
  findings: ClipTextFinding[];
  hookPlan: HookPlan | null;
  captionStyle: ClipCaptionStyle;
  styleVersion: string;
} {
  const prepared = prepareTextTrack(spec);
  const scale = clipTextScale(spec.videoHeight);
  const capSize = Math.round(CLIP_TEXT_STYLES.caption.sizePx * scale);
  const capStroke = Math.max(1, Math.round(CLIP_TEXT_STYLES.caption.strokePx * scale));
  const fill = assColor(CLIP_TEXT_STYLES.fill);
  const stroke = assColor(CLIP_TEXT_STYLES.stroke);
  const shadowBack = assColor(CLIP_TEXT_STYLES.stroke, CLIP_TEXT_STYLES.shadowAlphaByte);
  const boxFill = assColor(CLIP_CAPTION_STYLE_SPECS[prepared.captionStyle].boxFill);

  const header = [
    "[Script Info]",
    `; WiseSel clip text track — ${CLIP_TEXT_STYLE_VERSION} (generated; do not edit)`,
    "ScriptType: v4.00+",
    `PlayResX: ${spec.videoWidth}`,
    `PlayResY: ${spec.videoHeight}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styleLine({
      name: HOOK_STYLE,
      fontFamily: CLIP_TEXT_STYLES.fonts.hook.family,
      bold: CLIP_TEXT_STYLES.fonts.hook.bold,
      sizePx: prepared.hookPlan?.sizePx ?? Math.round(CLIP_TEXT_STYLES.hookSingleLine.sizePx * scale),
      primary: fill,
      outline: stroke,
      back: shadowBack,
      outlinePx: prepared.hookPlan?.strokePx ?? Math.max(1, Math.round(CLIP_TEXT_STYLES.hookSingleLine.strokePx * scale)),
      shadowPx: prepared.hookPlan?.shadowPx ?? Math.round(CLIP_TEXT_STYLES.hookSingleLine.shadowPx * scale),
      borderStyle: 1,
      align: 5,
    }),
    styleLine({
      name: CAPTION_STYLE,
      fontFamily: CLIP_TEXT_STYLES.fonts.caption.family,
      bold: CLIP_TEXT_STYLES.fonts.caption.bold,
      sizePx: capSize,
      primary: fill,
      outline: stroke,
      back: shadowBack,
      outlinePx: capStroke,
      shadowPx: 0, // T-2: captions carry stroke, no shadow
      borderStyle: 1,
      align: 5,
    }),
    styleLine({
      name: CAPTION_BOX_STYLE,
      fontFamily: CLIP_TEXT_STYLES.fonts.caption.family,
      bold: CLIP_TEXT_STYLES.fonts.caption.bold,
      sizePx: capSize,
      primary: fill,
      outline: boxFill, // BorderStyle=3: the outline color IS the box fill
      back: shadowBack,
      outlinePx: Math.max(2, Math.round(CLIP_TEXT_STYLES.boxPadPx * scale)),
      shadowPx: 0,
      borderStyle: 3,
      align: 5,
    }),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events = [...buildCaptionEvents(prepared), ...buildHookEvents(prepared)];
  return {
    ass: [...header, ...events].join("\n") + "\n",
    findings: prepared.findings,
    hookPlan: prepared.hookPlan,
    captionStyle: prepared.captionStyle,
    styleVersion: CLIP_TEXT_STYLE_VERSION,
  };
}

/** The directive-named thin wrapper: `buildAssDocument(spec) → string`. */
export function buildAssDocument(spec: ClipTextTrackSpec): string {
  return buildClipTextTrack(spec).ass;
}
