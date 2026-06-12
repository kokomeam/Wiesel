/**
 * Pure design simplification — backs the SIMPLIFY_SLIDE_DESIGN patch and the
 * "too many font sizes / colors" lint fixes. Deterministic: same slide in,
 * same slide out.
 */

import type { Slide, SlideElement } from "../types";
import { findTheme } from "./themes";
import { themeTextColor } from "./styleResolver";

/** Distinct explicit font sizes across elements, ascending. */
export function explicitFontSizes(elements: SlideElement[]): number[] {
  return [...new Set(elements.flatMap((el) => (el.style.fontSize !== undefined ? [el.style.fontSize] : [])))].sort(
    (a, b) => a - b
  );
}

/** Distinct explicit colors (text + background) not in the theme palette. */
export function offPaletteColors(slide: Slide): string[] {
  const palette = new Set(findTheme(slide.style.theme.id).palette.map((c) => c.toLowerCase()));
  const used = new Set<string>();
  for (const el of slide.elements) {
    for (const c of [el.style.color, el.style.backgroundColor, el.style.borderColor]) {
      if (c && !palette.has(c.toLowerCase())) used.add(c.toLowerCase());
    }
  }
  return [...used];
}

/**
 * Calm a slide down:
 *  - snap explicit font sizes to at most 3 tiers (smallest/middle/largest)
 *  - replace off-palette text colors with the theme's heading/body color
 *  - drop off-palette backgrounds back to the theme surface (callouts) or none
 *  - normalize line heights to the theme defaults
 */
export function simplifySlideDesign(slide: Slide): Slide {
  const theme = findTheme(slide.style.theme.id);
  const sizes = explicitFontSizes(slide.elements);

  let snap: (n: number) => number = (n) => n;
  if (sizes.length > 3) {
    const tiers = [sizes[0], sizes[Math.floor(sizes.length / 2)], sizes[sizes.length - 1]];
    snap = (n) =>
      tiers.reduce((best, t) => (Math.abs(t - n) < Math.abs(best - n) ? t : best), tiers[0]);
  }

  const palette = new Set(theme.palette.map((c) => c.toLowerCase()));

  const elements = slide.elements.map((el): SlideElement => {
    const style = { ...el.style };
    if (style.fontSize !== undefined) style.fontSize = snap(style.fontSize);
    if (style.color && !palette.has(style.color.toLowerCase())) {
      style.color = themeTextColor(el, theme);
    }
    if (style.backgroundColor && !palette.has(style.backgroundColor.toLowerCase())) {
      if (el.type === "callout" || el.type === "shape") style.backgroundColor = theme.colors.surface;
      else delete style.backgroundColor;
    }
    delete style.lineHeight;
    delete style.letterSpacing;
    return { ...el, style };
  });

  return { ...slide, elements };
}
