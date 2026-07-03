/**
 * Pure element builders + a deterministic text-flow estimator for the
 * materialize-on-eject layer.
 *
 * "Materializing" a renderer-owned structured layout means re-emitting its
 * visible pieces as freeform `SlideElement`s on the SAME 1280×720 canvas, so
 * the existing element editor (drag / resize / snap / groups / inspector) can
 * edit them. Fidelity comes from reproducing each renderer's exact frame,
 * colour, font size and weight — `resolveElementStyle` honours raw `fontSize` /
 * `color` / `lineHeight` / `fontFamily`, the same values the structured
 * components hard-code, so the look carries over.
 *
 * Everything here is PURE except `newId` (crypto) — materialization runs only
 * in an event handler (the "Edit freely" click) and in tests, never in render,
 * exactly like the other factories.
 */

import { defaultAIMeta, manifestTypeForElementType } from "../../manifest";
import { newId } from "../../factories";
import { flattenToItems } from "../list";
import { findTheme, themeTypeScale, type SlideTheme } from "../themes";
import { SLIDE_H, SLIDE_W, type Frame } from "../geometry";
import { EYEBROW } from "../structured/styleConstants";
import type {
  CalloutVariant,
  ElementStyle,
  FontFamilyId,
  FontWeight,
  RichText,
  SlideElement,
  SlideListContent,
  TextRun,
} from "../../types";

/* ─────────────────────────── Context + colour ─────────────────────────── */

export interface MaterializeCtx {
  themeId: string;
  theme: SlideTheme;
  accent: string;
  ink: string;
  body: string;
  muted: string;
  /** Theme semantic type scale (px), shared with the structured renderers. */
  scale: ReturnType<typeof themeTypeScale>;
}

export function makeCtx(themeId: string): MaterializeCtx {
  const theme = findTheme(themeId);
  return {
    themeId,
    theme,
    accent: theme.accentColor,
    ink: theme.colors.heading,
    body: theme.colors.body,
    muted: theme.colors.muted,
    scale: themeTypeScale(theme),
  };
}

/** `#rrggbb` + alpha → rgba() string (matches the structured renderers' rules
 *  so accent decoration tints identically). Non-hex passes through. */
export function rgba(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ───────────────────────────── Frame bounding ─────────────────────────── */

/** Clamp a frame inside the canvas WITHOUT forcing a minimum size — thin
 *  decorative rules (h=3) must stay thin (unlike geometry.clampFrame, which
 *  floors at 24px for hand-inserted content). Width/height stay strictly
 *  positive so the element passes SlideElementSchema. */
export function boundFrame(f: Frame): Frame {
  const width = Math.max(1, Math.min(Math.round(f.width), SLIDE_W));
  const height = Math.max(1, Math.min(Math.round(f.height), SLIDE_H));
  return {
    width,
    height,
    x: Math.max(0, Math.min(Math.round(f.x), SLIDE_W - width)),
    y: Math.max(0, Math.min(Math.round(f.y), SLIDE_H - height)),
  };
}

/* ────────────────────────── Text measurement ──────────────────────────── */

/** Average glyph advance as a fraction of font size, by family. Deterministic
 *  approximation (no DOM) — the editor's hidden-twin measurer fixes exact
 *  heights on first edit; this only needs to place boxes without overlap. */
const CPL_FACTOR: Record<FontFamilyId, number> = {
  sans: 0.5,
  serif: 0.5,
  display: 0.52,
  mono: 0.6,
};

export interface TextMetrics {
  fontSizePx: number;
  lineHeight: number;
  widthPx: number;
  family?: FontFamilyId;
  /** Floor on the line count (e.g. a body box that should read as ≥2 lines). */
  minLines?: number;
}

export function estimateLines(text: string, m: TextMetrics): number {
  const factor = CPL_FACTOR[m.family ?? "sans"];
  const cpl = Math.max(1, Math.floor(m.widthPx / (m.fontSizePx * factor)));
  let lines = 0;
  for (const seg of (text || " ").split("\n")) {
    lines += Math.max(1, Math.ceil(seg.length / cpl));
  }
  return Math.max(m.minLines ?? 1, lines);
}

/** Estimated rendered height (px) of a text block at a given measure. */
export function estimateTextHeight(text: string, m: TextMetrics): number {
  return Math.ceil(estimateLines(text, m) * m.fontSizePx * m.lineHeight) + 4;
}

/** Estimated height of a bullet_list (TextLikeContent: gap 0.45em between
 *  items, each item one logical line that may wrap). */
export function estimateBulletListHeight(items: string[], m: TextMetrics): number {
  const gap = 0.45 * m.fontSizePx;
  let h = 0;
  items.forEach((it, i) => {
    h += estimateLines(it, m) * m.fontSizePx * m.lineHeight;
    if (i > 0) h += gap;
  });
  return Math.ceil(h) + 8;
}

/* ─────────────────────────── Flow accumulator ─────────────────────────── */

/** Stacks blocks top-to-bottom (mirrors a renderer's flex column): each
 *  `place` advances the cursor by an optional top margin then the block height
 *  and returns the block's top y. */
export class Flow {
  y: number;
  constructor(top: number) {
    this.y = top;
  }
  place(height: number, marginTop = 0): number {
    this.y += marginTop;
    const top = this.y;
    this.y += height;
    return top;
  }
  /** Total height consumed since `top`. */
  height(top: number): number {
    return this.y - top;
  }
}

/* ───────────────────────────── Element builders ───────────────────────── */

const WEIGHT_TOKENS: { at: number; token: FontWeight }[] = [
  { at: 700, token: "bold" },
  { at: 600, token: "semibold" },
  { at: 500, token: "medium" },
  { at: 0, token: "regular" },
];

/** Numeric CSS weight → the nearest ElementStyle token (300/400 → regular —
 *  light weights collapse to regular, a documented minor difference). */
export function weightToken(weight: number): FontWeight {
  return WEIGHT_TOKENS.find((w) => weight >= w.at)!.token;
}

function aiMeta(type: SlideElement["type"], role: string) {
  const meta = defaultAIMeta(manifestTypeForElementType(type));
  return { ...meta, purpose: meta.purpose || `Materialized ${role}` };
}

function withBase(
  type: SlideElement["type"],
  role: string,
  frame: Frame,
  style: ElementStyle,
  opts: { locked?: boolean; groupPath?: string[] }
) {
  const f = boundFrame(frame);
  return {
    id: newId("el"),
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    zIndex: 0, // re-stamped by materializeSlide in array order
    ...(opts.locked ? { locked: true } : {}),
    ...(opts.groupPath && opts.groupPath.length ? { groupPath: opts.groupPath } : {}),
    role,
    origin: "ai" as const,
    style,
    ai: aiMeta(type, role),
  };
}

export interface TextOpts {
  family?: FontFamilyId;
  fontSizePx: number;
  weight?: number;
  color: string;
  lineHeight?: number;
  align?: ElementStyle["textAlign"];
  valign?: ElementStyle["verticalAlign"];
  italic?: boolean;
  letterSpacing?: number;
  /** Box styling — lets a text element render as a pill/chip/callout box. */
  backgroundColor?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  padding?: number;
  groupPath?: string[];
  locked?: boolean;
  /** Pre-built rich runs (preserves bold/colour); text must equal concat(runs). */
  runs?: TextRun[];
}

function textStyle(o: TextOpts): ElementStyle {
  const s: ElementStyle = { fontSize: o.fontSizePx, color: o.color };
  if (o.family) s.fontFamily = o.family;
  if (o.weight !== undefined) s.fontWeight = weightToken(o.weight);
  if (o.lineHeight !== undefined) s.lineHeight = o.lineHeight;
  if (o.align) s.textAlign = o.align;
  if (o.valign) s.verticalAlign = o.valign;
  if (o.italic) s.italic = true;
  if (o.letterSpacing !== undefined) s.letterSpacing = o.letterSpacing;
  if (o.backgroundColor) s.backgroundColor = o.backgroundColor;
  if (o.borderColor) s.borderColor = o.borderColor;
  if (o.borderWidth !== undefined) s.borderWidth = o.borderWidth;
  if (o.borderRadius !== undefined) s.borderRadius = o.borderRadius;
  if (o.padding !== undefined) s.padding = o.padding;
  return s;
}

/** A `text` element. */
export function text(
  role: string,
  frame: Frame,
  value: string,
  o: TextOpts
): SlideElement {
  return {
    ...withBase("text", role, frame, textStyle(o), o),
    type: "text",
    text: value,
    ...(o.runs ? { runs: o.runs } : {}),
  };
}

/** A `heading` element (display titles). */
export function heading(
  role: string,
  frame: Frame,
  value: string,
  o: TextOpts
): SlideElement {
  return {
    ...withBase("heading", role, frame, textStyle(o), o),
    type: "heading",
    text: value,
    ...(o.runs ? { runs: o.runs } : {}),
  };
}

/** A `bullet_list` element from plain strings (renders as accent-dot disc list;
 *  the editor upgrades it to the rich model on first structural edit). */
export function bulletList(
  role: string,
  frame: Frame,
  items: string[],
  o: TextOpts
): SlideElement {
  return {
    ...withBase("bullet_list", role, frame, textStyle(o), o),
    type: "bullet_list",
    items,
  };
}

/** A `bullet_list` element backed by a RICH list (markers, nesting, per-item
 *  colors) — used to materialize designed lists (numbered + dash subpoints)
 *  while keeping them a single editable list. */
export function richList(
  role: string,
  frame: Frame,
  content: SlideListContent,
  o: { fontSizePx: number; color: string; lineHeight?: number; groupPath?: string[]; locked?: boolean }
): SlideElement {
  const style: ElementStyle = { fontSize: o.fontSizePx, color: o.color };
  if (o.lineHeight !== undefined) style.lineHeight = o.lineHeight;
  return {
    ...withBase("bullet_list", role, frame, style, { locked: o.locked, groupPath: o.groupPath }),
    type: "bullet_list",
    items: flattenToItems(content),
    list: content,
  };
}

export interface ImageOpts {
  alt: string;
  objectFit?: "cover" | "contain";
  borderRadius?: number;
  borderColor?: string;
  borderWidth?: number;
  backgroundColor?: string;
  caption?: string;
  groupPath?: string[];
}

/** An `image` element (move/resize/replace/duplicate via the existing editor;
 *  an empty src renders the editor's "Add image" placeholder). */
export function image(
  role: string,
  frame: Frame,
  src: string,
  o: ImageOpts
): SlideElement {
  const style: ElementStyle = {};
  if (o.borderRadius !== undefined) style.borderRadius = o.borderRadius;
  if (o.borderColor) style.borderColor = o.borderColor;
  if (o.borderWidth !== undefined) style.borderWidth = o.borderWidth;
  if (o.backgroundColor) style.backgroundColor = o.backgroundColor;
  return {
    ...withBase("image", role, frame, style, { groupPath: o.groupPath }),
    type: "image",
    src,
    alt: o.alt,
    objectFit: o.objectFit ?? "cover",
    ...(o.caption ? { caption: o.caption } : {}),
  };
}

export interface ShapeOpts {
  fill?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  opacity?: number;
  shadow?: ElementStyle["shadow"];
  locked?: boolean;
  groupPath?: string[];
}

function shapeEl(
  kind: "rectangle" | "ellipse",
  role: string,
  frame: Frame,
  o: ShapeOpts
): SlideElement {
  const style: ElementStyle = {};
  if (o.fill) style.backgroundColor = o.fill;
  if (o.borderColor) style.borderColor = o.borderColor;
  if (o.borderWidth !== undefined) style.borderWidth = o.borderWidth;
  if (o.borderRadius !== undefined) style.borderRadius = o.borderRadius;
  if (o.opacity !== undefined) style.opacity = o.opacity;
  if (o.shadow) style.shadow = o.shadow;
  return {
    ...withBase("shape", role, frame, style, { locked: o.locked, groupPath: o.groupPath }),
    type: "shape",
    shape: kind,
  };
}

/** A `shape` rectangle — card/box backgrounds and accent rules. */
export function rect(role: string, frame: Frame, o: ShapeOpts): SlideElement {
  return shapeEl("rectangle", role, frame, o);
}

/** A `shape` ellipse — circles (icon halos, dots). */
export function ellipse(role: string, frame: Frame, o: ShapeOpts): SlideElement {
  return shapeEl("ellipse", role, frame, o);
}

/** A `sticker` element — a lucide glyph in (by default) an accent-tint circle,
 *  the same treatment the structured layouts use. `circleColor: "transparent"`
 *  renders a bare glyph; a colour sets the halo fill. */
export function sticker(
  role: string,
  frame: Frame,
  stickerId: string,
  o: { glyphColor?: string; circleColor?: string; groupPath?: string[]; locked?: boolean } = {}
): SlideElement {
  const style: ElementStyle = {};
  if (o.glyphColor) style.color = o.glyphColor;
  if (o.circleColor !== undefined) style.backgroundColor = o.circleColor;
  return {
    ...withBase("sticker", role, frame, style, { locked: o.locked, groupPath: o.groupPath }),
    type: "sticker",
    stickerId,
  };
}

/** A pill badge — a `text` element styled as the structured Badge (bg + border +
 *  full radius + centred uppercase mono). Width is auto-sized to the label. */
export function pill(
  role: string,
  x: number,
  y: number,
  value: string,
  o: { accent: string; bg: string; border: string; fontSizePx: number; height: number; letterSpacing: number; groupPath?: string[] }
): SlideElement {
  const label = value.toUpperCase();
  const width = Math.ceil(label.length * o.fontSizePx * 0.64) + 28;
  return text(role, { x, y, width, height: o.height }, label, {
    family: "mono",
    fontSizePx: o.fontSizePx,
    weight: 600,
    color: o.accent,
    backgroundColor: o.bg,
    borderColor: o.border,
    borderWidth: 1,
    borderRadius: 999,
    letterSpacing: o.letterSpacing,
    align: "center",
    valign: "middle",
    lineHeight: 1,
    groupPath: o.groupPath,
  });
}

/** A numbered chip — a `text` element rendered as a filled circle with a centred
 *  number (the structured step/marker treatment). */
export function chip(
  role: string,
  x: number,
  y: number,
  label: string,
  o: { color: string; bg: string; size: number; fontSizePx: number; groupPath?: string[] }
): SlideElement {
  return text(role, { x, y, width: o.size, height: o.size }, label, {
    family: "mono",
    fontSizePx: o.fontSizePx,
    weight: 600,
    color: o.color,
    backgroundColor: o.bg,
    borderRadius: 999,
    align: "center",
    valign: "middle",
    lineHeight: 1,
    groupPath: o.groupPath,
  });
}

export interface CalloutOpts {
  variant?: CalloutVariant;
  fontSizePx?: number;
  color?: string;
  lineHeight?: number;
  groupPath?: string[];
}

/** A `callout` element — a single-element note/footnote affordance. */
export function callout(
  role: string,
  frame: Frame,
  value: string,
  o: CalloutOpts = {}
): SlideElement {
  const style: ElementStyle = {};
  if (o.fontSizePx !== undefined) style.fontSize = o.fontSizePx;
  if (o.color) style.color = o.color;
  if (o.lineHeight !== undefined) style.lineHeight = o.lineHeight;
  return {
    ...withBase("callout", role, frame, style, { groupPath: o.groupPath }),
    type: "callout",
    text: value,
    variant: o.variant ?? "tip",
  };
}

/* ──────────────────────────── RichText helpers ────────────────────────── */

export function rtText(v: RichText | undefined): string {
  return (v?.text ?? "").trim();
}

/** The recurring eyebrow primitive: a mono uppercase accent label + its short
 *  accent rule (the structured `Eyebrow`). Returns both elements. */
export function eyebrowRow(role: string, x: number, y: number, label: string, accent: string): SlideElement[] {
  const tw = Math.ceil(label.length * EYEBROW.fontSize * 0.62) + 6;
  return [
    text(role, { x, y, width: tw, height: 20 }, label.toUpperCase(), {
      family: "mono",
      fontSizePx: EYEBROW.fontSize,
      weight: EYEBROW.weight,
      color: accent,
      lineHeight: 1.2,
      letterSpacing: EYEBROW.fontSize * EYEBROW.letterSpacingEm,
    }),
    rect(`${role}.rule`, { x: x + tw + 12, y: y + 9, width: EYEBROW.ruleW, height: EYEBROW.ruleH }, {
      fill: rgba(accent, EYEBROW.ruleOpacity),
    }),
  ];
}

/** Convenience: a plain "—"-joined sub-item line used when folding nested
 *  outline/comparison detail into a single editable list. */
export function joinDetail(label: string, detail?: string): string {
  return detail && detail.trim() ? `${label} — ${detail.trim()}` : label;
}
