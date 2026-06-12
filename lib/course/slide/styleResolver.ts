/**
 * Resolves an element's effective visual style: theme defaults underneath,
 * explicit ElementStyle overrides on top. Output is inline-CSS because the
 * values are dynamic document data, not design tokens.
 */

import type { CSSProperties } from "react";
import type {
  ElementShadow,
  ElementStyle,
  SlideBackground,
  SlideElement,
  SlideElementType,
} from "../types";
import { FONT_FAMILIES, findTheme, type SlideTheme } from "./themes";

/* ───────────────────────────── Shadows ────────────────────────────────── */

/** Preset → model mapping; the Design tab exposes these four. */
export const SHADOW_PRESETS: Record<string, ElementShadow | undefined> = {
  none: undefined,
  subtle: { color: "#1c1917", blur: 8, offsetX: 0, offsetY: 2, opacity: 0.15 },
  medium: { color: "#1c1917", blur: 16, offsetX: 0, offsetY: 5, opacity: 0.22 },
  strong: { color: "#1c1917", blur: 28, offsetX: 0, offsetY: 10, opacity: 0.32 },
};

/** Which preset (if any) a stored shadow corresponds to — for active pills. */
export function shadowPresetName(shadow: ElementShadow | undefined): string | null {
  if (!shadow) return "none";
  for (const [name, preset] of Object.entries(SHADOW_PRESETS)) {
    if (
      preset &&
      preset.color === shadow.color &&
      preset.blur === shadow.blur &&
      preset.offsetX === shadow.offsetX &&
      preset.offsetY === shadow.offsetY &&
      preset.opacity === shadow.opacity
    ) {
      return name;
    }
  }
  return null; // custom values (AI/import) — no pill lights up
}

function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color; // non-hex (rgba/named): use as-is
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** CSS `filter: drop-shadow(...)` value — follows the rendered pixels
 *  (glyphs, shape geometry, image alpha), not the bounding box, so one rule
 *  works for every element type. */
export function shadowFilterCss(shadow: ElementShadow | undefined): string | undefined {
  if (!shadow) return undefined;
  return `drop-shadow(${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${withAlpha(shadow.color, shadow.opacity)})`;
}

const defaultFontSize: Record<SlideElementType, number> = {
  heading: 44,
  text: 22,
  bullet_list: 22,
  code_block: 18,
  callout: 20,
  table: 18,
  image: 16,
  shape: 16,
  divider: 16,
};

const defaultFontWeight: Record<string, number> = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
};

function isHeadingish(el: SlideElement): boolean {
  return el.type === "heading";
}

/** Effective text color before overrides (used by lint too). */
export function themeTextColor(el: SlideElement, theme: SlideTheme): string {
  return isHeadingish(el) ? theme.colors.heading : theme.colors.body;
}

/** Resolve the full effective text/box CSS for an element. */
export function resolveElementStyle(
  el: SlideElement,
  themeId: string
): CSSProperties {
  const theme = findTheme(themeId);
  const s = el.style;

  const css: CSSProperties = {
    fontFamily: FONT_FAMILIES[s.fontFamily ?? theme.fontFamily].css,
    fontSize: s.fontSize ?? defaultFontSize[el.type],
    fontWeight:
      defaultFontWeight[s.fontWeight ?? (isHeadingish(el) ? "semibold" : "regular")],
    color: s.color ?? themeTextColor(el, theme),
    textAlign: s.textAlign ?? "left",
    lineHeight: s.lineHeight ?? (isHeadingish(el) ? 1.15 : 1.45),
  };

  if (s.italic) css.fontStyle = "italic";
  if (s.underline) css.textDecoration = "underline";
  if (s.letterSpacing !== undefined) css.letterSpacing = `${s.letterSpacing}px`;
  if (s.backgroundColor) css.backgroundColor = s.backgroundColor;
  if (s.borderColor || s.borderWidth) {
    css.border = `${s.borderWidth ?? 1}px ${s.borderStyle ?? "solid"} ${s.borderColor ?? "transparent"}`;
  }
  if (s.borderRadius !== undefined) css.borderRadius = s.borderRadius;
  if (s.opacity !== undefined) css.opacity = s.opacity;
  if (s.padding !== undefined) css.padding = s.padding;

  return css;
}

/** Vertical alignment helper for text boxes (flex container). */
export function verticalAlignCss(style: ElementStyle): CSSProperties {
  const v = style.verticalAlign ?? "top";
  return {
    display: "flex",
    flexDirection: "column",
    justifyContent: v === "top" ? "flex-start" : v === "middle" ? "center" : "flex-end",
  };
}

/** CSS for the slide's background layer. */
export function resolveBackground(bg: SlideBackground): CSSProperties {
  switch (bg.type) {
    case "solid":
      return { backgroundColor: bg.color };
    case "gradient": {
      const dirMap = {
        "to-r": "to right",
        "to-br": "to bottom right",
        "to-b": "to bottom",
        "to-tr": "to top right",
      } as const;
      return {
        backgroundImage: `linear-gradient(${dirMap[bg.gradient.direction]}, ${bg.gradient.from}, ${bg.gradient.to})`,
      };
    }
    case "image":
      // The <img> + overlay are rendered as separate layers by SlideStage.
      return { backgroundColor: "#171717" };
  }
}

/** The slide's effective backdrop color for contrast checks: element bg →
 *  solid color → gradient midpoint → image (null = unknown, skip check
 *  unless an overlay pins it down). */
export function effectiveBackdropHex(
  el: SlideElement,
  bg: SlideBackground
): string | null {
  if (el.style.backgroundColor) return el.style.backgroundColor;
  switch (bg.type) {
    case "solid":
      return bg.color;
    case "gradient":
      return null; // handled by caller via midpoint() to keep imports tidy
    case "image":
      return bg.overlayColor && (bg.overlayOpacity ?? 0) > 0.5 ? bg.overlayColor : null;
  }
}
