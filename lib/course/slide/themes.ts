/**
 * Built-in slide themes. A theme provides DEFAULTS — explicit element styles
 * always win (see styleResolver.ts). Stored on slides as a denormalized
 * SlideThemeRef snapshot so the document stays self-describing for AI.
 */

import type {
  FontFamilyId,
  FontScaleToken,
  SlideBackground,
  SlideThemeId,
  SlideThemeRef,
} from "../types";

export interface SlideTheme {
  id: SlideThemeId;
  name: string;
  accentColor: string;
  fontFamily: FontFamilyId;
  colors: {
    heading: string;
    body: string;
    muted: string;
    /** Default fill for callouts/shapes. */
    surface: string;
  };
  defaultBackground: SlideBackground;
  /** Optional per-theme semantic type scale (px in 1280×720 units). Falls back
   *  to DEFAULT_TYPE_SCALE — see `themeTypeScale`. */
  typeScale?: Record<FontScaleToken, number>;
  /** Curated swatches offered in pickers; also the "on palette" set for the
   *  TOO_MANY_COLORS lint. */
  palette: string[];
}

export const FONT_FAMILIES: Record<FontFamilyId, { label: string; css: string }> = {
  sans: {
    label: "Sans",
    css: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif",
  },
  serif: { label: "Serif", css: "Georgia, 'Times New Roman', serif" },
  mono: {
    label: "Mono",
    css: "var(--font-geist-mono), ui-monospace, 'SF Mono', monospace",
  },
  display: {
    label: "Display",
    css: "var(--font-display), Georgia, 'Times New Roman', serif",
  },
};

/** Shared default semantic type scale (logical px). Themes may override via
 *  `SlideTheme.typeScale`. One source of truth for the toolbar tokens, the AI,
 *  and the structured layouts. */
export const DEFAULT_TYPE_SCALE: Record<FontScaleToken, number> = {
  display: 56,
  title: 40,
  heading: 28,
  body: 20,
  caption: 15,
};

export function themeTypeScale(theme: SlideTheme): Record<FontScaleToken, number> {
  return theme.typeScale ?? DEFAULT_TYPE_SCALE;
}

/** Human labels for the size-token picker, largest → smallest. */
export const FONT_SCALE_OPTIONS: { id: FontScaleToken; label: string }[] = [
  { id: "display", label: "Display" },
  { id: "title", label: "Title" },
  { id: "heading", label: "Heading" },
  { id: "body", label: "Body" },
  { id: "caption", label: "Caption" },
];

export const SLIDE_THEMES: SlideTheme[] = [
  {
    id: "minimal-light",
    name: "Minimal Light",
    accentColor: "#ea580c",
    fontFamily: "sans",
    colors: {
      heading: "#171717",
      body: "#404040",
      muted: "#737373",
      surface: "#f5f5f5",
    },
    defaultBackground: { type: "solid", color: "#ffffff" },
    palette: [
      "#171717",
      "#404040",
      "#737373",
      "#ea580c",
      "#f59e0b",
      "#0ea5e9",
      "#10b981",
      "#7c2d12",
    ],
  },
  {
    id: "editorial-warm",
    name: "Editorial Warm",
    accentColor: "#ea580c",
    fontFamily: "sans",
    colors: {
      heading: "#431407",
      body: "#44403c",
      muted: "#78716c",
      surface: "#fff7ed",
    },
    defaultBackground: {
      type: "gradient",
      gradient: { from: "#fffaf3", to: "#ffeedd", direction: "to-br" },
    },
    palette: [
      "#431407",
      "#9a3412",
      "#ea580c",
      "#fb923c",
      "#44403c",
      "#78716c",
      "#0ea5e9",
      "#059669",
    ],
  },
  {
    id: "dark-classroom",
    name: "Dark Classroom",
    accentColor: "#fb923c",
    fontFamily: "sans",
    colors: {
      heading: "#fafafa",
      body: "#d4d4d8",
      muted: "#a1a1aa",
      surface: "#27272a",
    },
    defaultBackground: { type: "solid", color: "#18181b" },
    palette: [
      "#fafafa",
      "#d4d4d8",
      "#a1a1aa",
      "#fb923c",
      "#fbbf24",
      "#38bdf8",
      "#34d399",
      "#f87171",
    ],
  },
  {
    id: "competition-prep",
    name: "Competition Prep",
    accentColor: "#d97706",
    fontFamily: "sans",
    colors: {
      heading: "#1c1917",
      body: "#44403c",
      muted: "#78716c",
      surface: "#fef3c7",
    },
    defaultBackground: { type: "solid", color: "#fffbeb" },
    palette: [
      "#1c1917",
      "#44403c",
      "#78716c",
      "#d97706",
      "#059669",
      "#dc2626",
      "#ea580c",
      "#0284c7",
    ],
  },
  {
    id: "warm-notebook",
    name: "Warm Notebook",
    accentColor: "#9a3412",
    fontFamily: "serif",
    colors: {
      heading: "#431407",
      body: "#57534e",
      muted: "#a8a29e",
      surface: "#fef7ed",
    },
    defaultBackground: { type: "solid", color: "#faf6ef" },
    palette: [
      "#431407",
      "#57534e",
      "#a8a29e",
      "#9a3412",
      "#b45309",
      "#4d7c0f",
      "#0e7490",
      "#dc2626",
    ],
  },
];

export const DEFAULT_THEME_ID: SlideThemeId = "editorial-warm";

export function findTheme(id: string): SlideTheme {
  return SLIDE_THEMES.find((t) => t.id === id) ?? SLIDE_THEMES[0];
}

export function themeRef(theme: SlideTheme): SlideThemeRef {
  return {
    id: theme.id,
    name: theme.name,
    accentColor: theme.accentColor,
    fontFamily: theme.fontFamily,
  };
}

export interface GradientPreset {
  name: string;
  from: string;
  to: string;
  direction: "to-r" | "to-br" | "to-b" | "to-tr";
}

export const GRADIENT_PRESETS: GradientPreset[] = [
  { name: "Warm dawn", from: "#fffaf3", to: "#ffeedd", direction: "to-br" },
  { name: "Deep ink", from: "#292524", to: "#0c0a09", direction: "to-b" },
  { name: "Sunrise", from: "#fff7ed", to: "#ffedd5", direction: "to-tr" },
  { name: "Mint air", from: "#f0fdf4", to: "#dcfce7", direction: "to-br" },
  { name: "Sky wash", from: "#f0f9ff", to: "#e0f2fe", direction: "to-r" },
  { name: "Graphite", from: "#27272a", to: "#18181b", direction: "to-b" },
];
