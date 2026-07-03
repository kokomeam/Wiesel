/**
 * Single source of truth for the structured layouts' decorative styling +
 * geometry. Both the React renderers (the `*Layout.tsx` components / `common.tsx`
 * primitives) AND the materialize-on-eject builders import from here, so the
 * ejected element-backed slide reproduces the renderer pixel-for-pixel and the
 * two can never drift.
 *
 * PURE (no React, no "use client") so the pure materializers can import it.
 * Values mirror the renderers verbatim — when you change a look here, both the
 * structured slide and its "Edit freely" version change together.
 */

/** `#rrggbb` + alpha → an `rgba()` string. Non-hex passes through unchanged.
 *  The canonical implementation — every other copy re-exports this. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ─────────────────────────── Card (common.tsx) ────────────────────────── */

export const CARD = {
  bg: "#ffffff",
  border: "rgba(120,113,108,0.16)",
  borderWidth: 1,
  radius: 20,
  /** CSS box-shadow string (the warm whisper). */
  shadow: "0 1px 2px rgba(68,48,28,0.05)",
} as const;

/** The peach tint a `concept_example` worked-example card uses (decor:"full"). */
export function cardTint(accent: string): string {
  return withAlpha(accent, 0.04);
}

/* ─────────────────────────── Badge pill (common.tsx) ──────────────────── */

export const BADGE = {
  radius: 999,
  fontSize: 12.5,
  weight: 600,
  /** em (renderer uses 0.1em); px = fontSize * 0.1. */
  letterSpacingEm: 0.1,
  height: 26,
} as const;
export function badgeBg(accent: string): string {
  return withAlpha(accent, 0.1);
}
export function badgeBorder(accent: string): string {
  return withAlpha(accent, 0.25);
}

/* ─────────────────────────── Eyebrow (common.tsx) ─────────────────────── */

export const EYEBROW = {
  fontSize: 14,
  weight: 600,
  letterSpacingEm: 0.12,
  ruleW: 40,
  ruleH: 2,
  ruleOpacity: 0.6,
  marginBottom: 18,
} as const;

/* ─────────────────────── concept_example geometry ─────────────────────── */

export const CE = {
  padX: 80,
  padTop: 64,
  padBottom: 44,
  colGap: 4,
  connectorW: 96,
  colW: 508,
  leftX: 80,
  rightX: 692, // padX + colW + colGap + connectorW + colGap
  cardPad: 28,
  // numbered step chip
  chip: 30,
  chipFont: 13,
  chipGap: 14,
  stepGap: 16,
  stepHeadingFont: 17,
  stepBodyFont: 14.5,
  // concept title
  titleSerif: 48,
  titleSans: 42,
  ruleW: 96,
  ruleH: 3,
  definitionFont: 21,
  // footnote callout
  footPadX: 18,
  footPadY: 12,
  footRadius: 14,
  footFont: 16,
  footMarginTop: 22,
} as const;
export function ceCardTintAlpha(): number {
  return 0.04;
}
export function ceRule(accent: string): string {
  return withAlpha(accent, 0.7);
}
export function ceChipBg(accent: string): string {
  return withAlpha(accent, 0.12);
}
export function ceFootBg(accent: string): string {
  return withAlpha(accent, 0.08);
}
export function ceFootBorder(accent: string): string {
  return withAlpha(accent, 0.2);
}

/* ─────────────────────── comparison_columns geometry ──────────────────── */

export const CC = {
  padX: 64,
  padTop: 52,
  padBottom: 40,
  gap: 26,
  barH: 6,
  cardPad: 26,
  titleFont: 40,
  nameFont: 23,
  pointLabelFont: 17,
  pointDetailFont: 14.5,
  footRadius: 14,
  footFont: 17,
} as const;
/** Index → option colour (A = theme accent, B = blue, C = teal). */
export function optionColor(index: number, accent: string): string {
  return [accent, "#2563eb", "#0d9488"][index] ?? accent;
}
export function ccDotBg(color: string): string {
  return withAlpha(color, 0.16);
}
export function ccFootBg(tint: string): string {
  return withAlpha(tint, 0.08);
}
export function ccFootBorder(tint: string): string {
  return withAlpha(tint, 0.22);
}

/* ─────────────────────────── outline_list geometry ────────────────────── */

export const OL = {
  barX: 80,
  barY: 64,
  barW: 64,
  barH: 6,
  titleX: 80,
  titleY: 92,
  titleW: 960,
  titleFont: 44,
  ruleY: 184,
  regionTop: 208,
  regionBottom: 48,
  markerGap: 18,
  rowGap: 18,
} as const;
export function olRule(accent: string): string {
  return withAlpha(accent, 0.35);
}
export function olSubMarker(accent: string): string {
  return withAlpha(accent, 0.7);
}

/* ─────────────────────── prose / image_supporting ─────────────────────── */

export const PROSE = {
  padX: 76,
  padTop: 56,
  maxW: 1000,
  titleFont: 46,
  bodyFont: 23,
  pointFont: 19,
  ruleX: 80,
  ruleY: 673,
  ruleW: 90,
  ruleH: 3,
} as const;
export function proseRule(accent: string): string {
  return withAlpha(accent, 0.6);
}

export const IMGS = {
  pad: 64,
  imgSide: 384,
  get imgX(): number {
    return 1280 - this.pad - this.imgSide; // 832
  },
  imgY: 150,
  get leftW(): number {
    return this.imgX - this.pad - 56; // 712
  },
  titleFont: 44,
  leadFont: 18,
  bulletFont: 16.5,
  imgRadius: 18,
  imgBorder: "rgba(120,113,108,0.16)",
} as const;
export function imgsTint(accent: string): string {
  return withAlpha(accent, 0.06);
}
export function imgsRule(accent: string): string {
  return withAlpha(accent, 0.8);
}
