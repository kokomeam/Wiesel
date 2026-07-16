/**
 * Clip text styling — THE single-source constants for every burned/rendered
 * text layer (Hook Overlay + Karaoke Caption directive H-4 + typography
 * addendum T-1..T-4). Consumed by BOTH renderers:
 *
 *   - the ASS builder (`textTrack.ts`) → FFmpeg `subtitles=` burn for every
 *     real-footage path (provider face_track, in-house stacked_split /
 *     screen_action_zoom / audiogram)
 *   - the Remotion slide-short composition (native captions/overlays — MUST
 *     be indistinguishable, so it reads these same values; the divergence
 *     check in verify-clips-render scans for a second definition)
 *
 * NO inline magic values anywhere else: sizes, strokes, shadows, safe areas,
 * motion timings, and karaoke style presets all live here. Colors come ONLY
 * from lib/marketing/brand/tokens (D-1 — this file defines zero hex
 * literals). All pixel values are at the 1080×1920 reference and scale
 * proportionally BY HEIGHT for other canvases (the T-2 rule for 1:1).
 */

import { BRAND_TOKENS } from "@/lib/marketing/brand/tokens";
import type { ClipPlatform } from "./constants";

/** Stamped into ai_metadata.textBurn on every burn — bump on ANY styling
 *  change (the goldens must be regenerated in the same PR, T-6). */
export const CLIP_TEXT_STYLE_VERSION = "clip-text-v1";

/** The T-2 reference canvas. 9:16 verticals author here; other aspect
 *  ratios scale every constant by `videoHeight / CLIP_TEXT_REF_H`. */
export const CLIP_TEXT_REF_W = 1080;
export const CLIP_TEXT_REF_H = 1920;

/* ───────────────────────── hook animations (H-1) ───────────────────────── */

export const CLIP_HOOK_ANIMATIONS = [
  "slide_in_fade",
  "fade_in_out",
  "slide_across",
  "persistent",
] as const;
export type ClipHookAnimation = (typeof CLIP_HOOK_ANIMATIONS)[number];

export const CLIP_HOOK_ANIMATION_LABELS: Record<ClipHookAnimation, string> = {
  slide_in_fade: "Slide in, fade out",
  fade_in_out: "Fade in & out",
  slide_across: "Slide across",
  persistent: "Stay on screen",
};

/**
 * T-4 motion values (constants with the rationale each number came from):
 *  - slide_in_fade: 280ms entry (≈8 frames @30fps — fast enough to not delay
 *    the hook's read, slow enough to register as motion), ≈18% frame-width
 *    travel (enters from just off the reading path, not across the frame),
 *    2.5s default hold (a 6–10 word hook reads twice at ~200wpm), 240ms
 *    fade-out (exits before the viewer re-reads). libass `\move` is linear;
 *    at 280ms the ease-in vs linear difference is sub-frame — documented
 *    approximation, not a cut corner.
 *  - fade_in_out: 200ms each — the shortest fade that doesn't strobe.
 *  - slide_across: 3.2s linear traverse (the full read window for a moving
 *    target; linear per the addendum).
 *  - persistent: 200ms fade-in only, no exit.
 * Captions are NEVER animated positionally (T-4) — karaoke fill/scale only.
 */
export const CLIP_TEXT_MOTION = {
  slideInFade: { slideMs: 280, travelFrac: 0.18, holdMsDefault: 2_500, fadeOutMs: 240 },
  fadeInOut: { fadeInMs: 200, fadeOutMs: 200, holdMsDefault: 2_500 },
  slideAcross: { traverseMs: 3_200 },
  persistent: { fadeInMs: 200 },
  /** Caption line timing: a line lingers briefly after its last word (so
   *  short lines don't strobe) and a ≥800ms silence starts a new group. */
  caption: { lingerMs: 1_200, gapBreakMs: 800 },
} as const;

/* ───────────────────── karaoke caption styles (T-3) ────────────────────── */

export const CLIP_CAPTION_STYLES = ["beam", "block", "minimal"] as const;
export type ClipCaptionStyle = (typeof CLIP_CAPTION_STYLES)[number];

export const CLIP_CAPTION_STYLE_LABELS: Record<ClipCaptionStyle, string> = {
  beam: "Beam — brand fill on the spoken word",
  block: "Block — brand box behind the spoken word",
  minimal: "Minimal — plain white",
};

/** T-3: each preset is PURE DATA over the one karaoke renderer — adding a
 *  style is a data change plus a snapshot test. `activeScalePct` is the
 *  subtle live-word scale (beam's 1.06×); `activeBox` draws the brand-color
 *  background box behind the active word (block's bolder "creator" look). */
export interface ClipCaptionStyleSpec {
  /** Fill color of the ACTIVE word (null = no active-word treatment). */
  activeFill: string | null;
  /** Active-word scale in percent (100 = none). */
  activeScalePct: number;
  /** Brand-color background box behind the active word. */
  activeBox: boolean;
  /** Box fill when activeBox (brand); text on the box stays white. */
  boxFill: string;
}

export const CLIP_CAPTION_STYLE_SPECS: Record<ClipCaptionStyle, ClipCaptionStyleSpec> = {
  beam: {
    activeFill: BRAND_TOKENS.colors.brand,
    activeScalePct: 106,
    activeBox: false,
    boxFill: BRAND_TOKENS.colors.brand,
  },
  block: {
    activeFill: BRAND_TOKENS.colors.onDark,
    activeScalePct: 100,
    activeBox: true,
    boxFill: BRAND_TOKENS.colors.brand,
  },
  minimal: {
    activeFill: null,
    activeScalePct: 100,
    activeBox: false,
    boxFill: BRAND_TOKENS.colors.brand,
  },
};

/* ──────────────────────── fonts (T-1, bundled OFL) ─────────────────────── */

/**
 * Families are the bundled files' name-table families (parsed + asserted by
 * textFonts.ts — a silent fallback to DejaVu is a release blocker). The
 * defaults are the T-5 bake-off picks (comparison sheet:
 * docs/clip-text-bakeoff/); Montserrat ExtraBold + Inter SemiBold stay
 * bundled as the recorded alternates.
 */
export const CLIP_TEXT_FONTS = {
  hook: { family: "Archivo Black", file: "ArchivoBlack-Regular.ttf", bold: false },
  hookAlt: { family: "Montserrat ExtraBold", file: "Montserrat-ExtraBold.ttf", bold: false },
  caption: { family: "Inter", file: "Inter-Bold.ttf", bold: true },
  captionAlt: { family: "Inter SemiBold", file: "Inter-SemiBold.ttf", bold: false },
} as const;

/* ─────────────────────── the T-2 sizing table ──────────────────────────── */

export interface ClipTextLayerStyle {
  sizePx: number;
  /** Black outline — NON-OPTIONAL on both layers (the single constant that
   *  keeps text legible over slides, faces, and code alike — T-2). */
  strokePx: number;
  /** Soft drop shadow offset (0 = none). Softness rides a blur tag. */
  shadowPx: number;
}

/**
 * T-2 at 1080×1920 (these values WIN over the directive's placeholders).
 * Ranges in the table resolved to single constants at the bake-off:
 * hook 92px (of 88–96), captions 64px (of 62–68).
 */
export const CLIP_TEXT_STYLES = {
  /** Hook ≤6 words — one line. */
  hookSingleLine: { sizePx: 92, strokePx: 5, shadowPx: 3 } satisfies ClipTextLayerStyle,
  /** Hook 7–10 words — two balanced lines. */
  hookTwoLine: { sizePx: 72, strokePx: 5, shadowPx: 3 } satisfies ClipTextLayerStyle,
  /** T-7's ONE shrink step for a hook that still overflows two lines. */
  hookShrunk: { sizePx: 60, strokePx: 5, shadowPx: 3 } satisfies ClipTextLayerStyle,
  /** bofu_preview's lower-key persistent hook (H-5). */
  hookLowKey: { sizePx: 64, strokePx: 4, shadowPx: 2 } satisfies ClipTextLayerStyle,
  /** Captions — Bold, stroke, NO shadow (T-2). */
  caption: { sizePx: 64, strokePx: 4, shadowPx: 0 } satisfies ClipTextLayerStyle,
  /** End-card CTA (Remotion end card consumes this; ASS never draws it). */
  endCard: { sizePx: 72, strokePx: 4, shadowPx: 3 } satisfies ClipTextLayerStyle,

  /** Text fill: white default; brand accent permitted for ≤2 hook keywords. */
  fill: BRAND_TOKENS.colors.onDark,
  stroke: BRAND_TOKENS.colors.textStroke,
  accent: BRAND_TOKENS.colors.brand,

  fonts: CLIP_TEXT_FONTS,

  /** T-2 line discipline. */
  hookMaxLines: 2,
  captionMaxWordsPerLine: 4,
  captionMinWordsPerLine: 3,
  /** ≤2 hook words may take the brand accent (T-2). */
  hookAccentMaxWords: 2,

  /**
   * Width estimation for deterministic wrapping (no font metrics at build
   * time): average advance ÷ font size, MEASURED from real libass renders of
   * the bundled fonts (ink width ÷ chars ÷ fontsize on a 45-char pangram-ish
   * hook: Archivo caps 0.497, Archivo title 0.417, Inter Bold 0.386) plus an
   * ~8% safety margin. Used ONLY to decide line breaks/shrink — libass draws
   * the real glyphs; verify-clips-render re-measures and fails on drift.
   */
  avgCharWidthFrac: { hookUpper: 0.54, hookTitle: 0.46, caption: 0.42 },

  /** Block height per text line as a fraction of font size (position math). */
  lineHeightFrac: 1.16,
  /** Soft edges on outline+shadow (ASS \be) where shadowPx > 0 — the T-2
   *  "soft 3px drop". */
  shadowSoftness: 1.2,
  /** Shadow translucency (ASS alpha byte, 00=opaque..FF=invisible). */
  shadowAlphaByte: 0x60,
  /** Padding of the `block` karaoke style's brand box (ASS \bord under
   *  BorderStyle=3, video px at reference). */
  boxPadPx: 12,
} as const;

/* ─────────────── platform safe areas (H-4, 1080×1920 ref) ──────────────── */

export interface ClipTextSafeArea {
  /** Platform top chrome (camera hint / search / "Reels" header). */
  topPx: number;
  /** Bottom UI zone: username, caption, audio strip, progress bar. */
  bottomPx: number;
  /** Right action rail: like/comment/share/profile stack. */
  rightPx: number;
  /** Left breathing margin (no platform chrome, just legibility). */
  leftPx: number;
}

/**
 * Sources (values at 1080×1920, rounded up to be conservative — a diagram
 * lives in docs/clips.md § Burned text):
 *  - TikTok: the "safe areas" spec in TikTok's Video Editing/Ads guidelines —
 *    ~130px top, ~484px bottom, ~140px right at 1080-wide vertical.
 *  - Instagram/Facebook Reels: Meta's Reels safe-zone template — keep
 *    ~14% top and ~20% bottom (270/385px) clear of UI; action rail ~120px.
 *  - YouTube Shorts: the Shorts overlay mock in YouTube's creator docs —
 *    title/subscribe cluster ~300px bottom, rail ~130px, top ~120px.
 * These are UI-overlap avoidance constants, not exact chrome measurements —
 * platforms shift their chrome; tune here, tests re-verify containment.
 * NOTE: the directive names these tiktok/instagram_reels/youtube_shorts/
 * facebook_reels — keyed here by the canonical `ClipPlatform` ids (a clip on
 * `instagram`/`facebook` IS a Reel, the Phase 1.5 platform rule).
 */
export const CLIP_TEXT_SAFE_AREAS: Record<ClipPlatform, ClipTextSafeArea> = {
  tiktok: { topPx: 240, bottomPx: 500, rightPx: 144, leftPx: 60 },
  instagram: { topPx: 220, bottomPx: 420, rightPx: 128, leftPx: 60 },
  facebook: { topPx: 220, bottomPx: 420, rightPx: 128, leftPx: 60 },
  youtube_shorts: { topPx: 200, bottomPx: 320, rightPx: 132, leftPx: 60 },
};

/** Extra clearance kept between text and any safe-area edge. */
export const CLIP_TEXT_EDGE_GAP_PX = 24;

/* ─────────────────── preset text defaults (H-5 + T-2) ──────────────────── */

/** Keyed by packaging preset id (presets × layouts stay orthogonal — text
 *  defaults never read the layout). Type is structural (string key) to avoid
 *  a constants→presets import cycle; resolvePackaging validates membership. */
export interface ClipTextPresetDefaults {
  animation: ClipHookAnimation;
  captionStyle: ClipCaptionStyle;
  /** T-2 case rule: Title Case or ALL CAPS per preset. Captions always keep
   *  the transcript's own sentence case. */
  hookCase: "upper" | "title";
  /** Hook anchor as a fraction of video height (clamped into the safe area). */
  hookAnchorYFrac: number;
  /** bofu's lower-key hook renders at hookLowKey size regardless of length. */
  lowKeyHook: boolean;
}

export const CLIP_TEXT_PRESET_DEFAULTS: Record<string, ClipTextPresetDefaults> = {
  /** H-5: slide_in_fade, center-upper, bold, 2.5s hold. */
  tofu_hook: {
    animation: "slide_in_fade",
    captionStyle: "beam",
    hookCase: "upper",
    hookAnchorYFrac: 0.3,
    lowKeyHook: false,
  },
  /** H-5: fade_in_out, upper-third. */
  mofu_story: {
    animation: "fade_in_out",
    captionStyle: "beam",
    hookCase: "title",
    hookAnchorYFrac: 0.22,
    lowKeyHook: false,
  },
  /** H-5: persistent lower-key hook; T-3: minimal captions. */
  bofu_preview: {
    animation: "persistent",
    captionStyle: "minimal",
    hookCase: "title",
    hookAnchorYFrac: 0.14,
    lowKeyHook: true,
  },
};

export function clipTextPresetDefaults(preset: string): ClipTextPresetDefaults {
  return CLIP_TEXT_PRESET_DEFAULTS[preset] ?? CLIP_TEXT_PRESET_DEFAULTS.tofu_hook;
}

/* ───────────────────── position math (pure, tested) ────────────────────── */

/** Proportional scale for a non-reference canvas (T-2: BY HEIGHT — a 1:1
 *  1080×1080 canvas renders text at 1080/1920 of reference size). */
export function clipTextScale(videoHeight: number): number {
  return videoHeight / CLIP_TEXT_REF_H;
}

export interface SafeTextFrame {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The rectangle text may occupy on THIS video, in video pixels. */
export function safeTextFrame(
  platform: ClipPlatform,
  videoWidth: number,
  videoHeight: number
): SafeTextFrame {
  const area = CLIP_TEXT_SAFE_AREAS[platform];
  const s = clipTextScale(videoHeight);
  const gap = CLIP_TEXT_EDGE_GAP_PX * s;
  return {
    x0: area.leftPx * s + gap,
    y0: area.topPx * s + gap,
    x1: videoWidth - area.rightPx * s - gap,
    y1: videoHeight - area.bottomPx * s - gap,
  };
}

/**
 * Caption anchor: bottom-center of the caption block sits at the safe
 * frame's bottom edge (lower third by construction — every platform's
 * bottom zone ends above 2/3 height at reference).
 */
export function captionAnchor(
  platform: ClipPlatform,
  videoWidth: number,
  videoHeight: number
): { x: number; bottomY: number } {
  const frame = safeTextFrame(platform, videoWidth, videoHeight);
  // floor, not round: the anchor must stay INSIDE a fractional safe edge.
  return { x: Math.round((frame.x0 + frame.x1) / 2), bottomY: Math.floor(frame.y1) };
}

/**
 * Hook anchor: the preset's Y fraction, clamped so the whole block (of
 * `blockHeightPx`, video pixels) stays inside the safe frame. X is the safe
 * frame's center (both hooks and captions center — T-2).
 */
export function hookAnchor(
  platform: ClipPlatform,
  preset: string,
  videoWidth: number,
  videoHeight: number,
  blockHeightPx: number
): { x: number; y: number } {
  const frame = safeTextFrame(platform, videoWidth, videoHeight);
  const wanted = videoHeight * clipTextPresetDefaults(preset).hookAnchorYFrac;
  const y = Math.min(Math.max(wanted, frame.y0 + blockHeightPx / 2), frame.y1 - blockHeightPx / 2);
  return { x: Math.round((frame.x0 + frame.x1) / 2), y: Math.round(y) };
}

/** Usable text width (video px) inside the safe frame. */
export function usableTextWidth(
  platform: ClipPlatform,
  videoWidth: number,
  videoHeight: number
): number {
  const frame = safeTextFrame(platform, videoWidth, videoHeight);
  return Math.max(0, frame.x1 - frame.x0);
}
