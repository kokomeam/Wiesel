/**
 * Slide quality lint v2 — calm, deterministic heuristics with optional
 * one-click fixes. Fixes build their patches lazily so id generation stays
 * out of render. Both humans (QualityHintBadge "Fix" buttons) and the mock
 * AI ("improve design") consume these.
 */

import { contrastRatio, midpoint } from "./slide/contrast";
import { SLIDE_H } from "./slide/geometry";
import { explicitFontSizes, offPaletteColors } from "./slide/simplify";
import { effectiveBackdropHex, themeTextColor } from "./slide/styleResolver";
import { findLayout } from "./slide/layouts";
import { findTheme } from "./slide/themes";
import type { QualityHint, Slide, SlideElement } from "./types";

const MAX_VISIBLE_CHARS = 480;
const MAX_BULLETS = 5;
const MIN_CONTRAST = 3;
const MAX_FONT_SIZES = 3;
const MAX_OFF_PALETTE_COLORS = 4;
const CLIP_TOLERANCE_PX = 2;

/**
 * Client-registered DOM measurer for the TEXT_CLIPPED check. Lint stays
 * UI-free: the editor shell registers the real (DOM-rendering) measurer at
 * mount; while unregistered (SSR, tests) the check is skipped. Returns the
 * content height in logical px, or null for non-text elements.
 */
let measureContentHeight:
  | ((el: SlideElement, themeId: string) => number | null)
  | null = null;
export function registerLintTextMeasurer(
  fn: (el: SlideElement, themeId: string) => number | null
): void {
  measureContentHeight = fn;
}

export interface LintContext {
  blockId: string;
  /** Lazy speaker-notes generator (avoids lint → ai/templates cycle). */
  speakerNotesFor?: (slide: Slide) => string;
  /** Lazy alt-text generator for IMAGE_MISSING_ALT fixes. */
  altTextFor?: (slide: Slide, el: SlideElement) => string;
}

function visibleChars(el: SlideElement): number {
  switch (el.type) {
    case "heading":
    case "text":
      return el.text.length;
    case "callout":
      return el.text.length;
    case "bullet_list":
      return el.items.join("").length;
    case "code_block":
      return el.code.length;
    case "table":
      return el.rows.flat().join("").length;
    default:
      return 0;
  }
}

function slideBackdropHex(slide: Slide, el: SlideElement): string | null {
  const direct = effectiveBackdropHex(el, slide.style.background);
  if (direct) return direct;
  if (slide.style.background.type === "gradient") {
    const g = slide.style.background.gradient;
    return midpoint(g.from, g.to);
  }
  return null;
}

export function lintSlide(slide: Slide, ctx: LintContext): QualityHint[] {
  const hints: QualityHint[] = [];
  const elements = slide.elements.filter((el) => el.visible !== false);
  const theme = findTheme(slide.style.theme.id);

  /* TOO_MUCH_TEXT */
  const totalChars = elements.reduce((sum, el) => sum + visibleChars(el), 0);
  if (totalChars > MAX_VISIBLE_CHARS) {
    hints.push({
      code: "TOO_MUCH_TEXT",
      severity: "warn",
      message:
        "A lot of text for one slide — move detail to speaker notes or split it.",
    });
  }

  /* TOO_MANY_BULLETS */
  const crowded = elements.find(
    (el) => el.type === "bullet_list" && el.items.length > MAX_BULLETS
  );
  if (crowded && crowded.type === "bullet_list") {
    hints.push({
      code: "TOO_MANY_BULLETS",
      severity: "warn",
      message: `${crowded.items.length} bullets — keep at most ${MAX_BULLETS} and say the rest aloud.`,
      fix: {
        label: `Trim to ${MAX_BULLETS - 1} + speaker notes`,
        makePatches: () => {
          const kept = crowded.items.slice(0, MAX_BULLETS - 1);
          const overflow = crowded.items.slice(MAX_BULLETS - 1);
          const notes = [
            slide.speakerNotes?.trim(),
            `Also cover: ${overflow.join("; ")}`,
          ]
            .filter(Boolean)
            .join("\n");
          return [
            {
              action: "UPDATE_SLIDE_ELEMENT",
              blockId: ctx.blockId,
              slideId: slide.id,
              elementId: crowded.id,
              updates: { items: kept },
            },
            {
              action: "UPDATE_SPEAKER_NOTES",
              blockId: ctx.blockId,
              slideId: slide.id,
              speakerNotes: notes,
            },
          ];
        },
      },
    });
  }

  /* MISSING_TITLE */
  const hasHeading = elements.some((el) => el.type === "heading");
  if (!hasHeading && slide.layout !== "full_image_background") {
    hints.push({
      code: "MISSING_TITLE",
      severity: "warn",
      message: "No heading — slides scan better with a clear title.",
    });
  }

  /* NO_SPEAKER_NOTES */
  if (!slide.speakerNotes?.trim()) {
    hints.push({
      code: "NO_SPEAKER_NOTES",
      severity: "info",
      message: "No speaker notes yet — add a line on what to say here.",
      ...(ctx.speakerNotesFor && {
        fix: {
          label: "Write speaker notes",
          makePatches: () => [
            {
              action: "UPDATE_SPEAKER_NOTES",
              blockId: ctx.blockId,
              slideId: slide.id,
              speakerNotes: ctx.speakerNotesFor!(slide),
            },
          ],
        },
      }),
    });
  }

  /* MISSING_VISUAL */
  const hasVisual = elements.some(
    (el) => el.type === "image" || el.type === "shape" || el.type === "code_block" || el.type === "table"
  );
  if (!hasVisual && totalChars > 250) {
    hints.push({
      code: "MISSING_VISUAL",
      severity: "info",
      message: "Text-only slide — a diagram or image would carry this better.",
    });
  }

  /* IMAGE_MISSING_ALT */
  const blankAlt = elements.find(
    (el) => el.type === "image" && el.src && !el.alt.trim()
  );
  if (blankAlt && blankAlt.type === "image") {
    hints.push({
      code: "IMAGE_MISSING_ALT",
      severity: "warn",
      message: "An image is missing alt text — screen readers and AI need it.",
      ...(ctx.altTextFor && {
        fix: {
          label: "Generate alt text",
          makePatches: () => [
            {
              action: "GENERATE_ALT_TEXT",
              blockId: ctx.blockId,
              slideId: slide.id,
              elementId: blankAlt.id,
              alt: ctx.altTextFor!(slide, blankAlt),
            },
          ],
        },
      }),
    });
  }

  /* LOW_CONTRAST */
  for (const el of elements) {
    if (el.type !== "heading" && el.type !== "text" && el.type !== "bullet_list") continue;
    const fg = el.style.color ?? themeTextColor(el, theme);
    const bg = slideBackdropHex(slide, el);
    if (!bg) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio !== null && ratio < MIN_CONTRAST) {
      hints.push({
        code: "LOW_CONTRAST",
        severity: "warn",
        message: "Light text on a light background is hard to read from the back row.",
        fix: {
          label: "Use theme text color",
          makePatches: () => [
            {
              action: "UPDATE_SLIDE_ELEMENT",
              blockId: ctx.blockId,
              slideId: slide.id,
              elementId: el.id,
              updates: { style: { color: themeTextColor(el, theme) } },
            },
          ],
        },
      });
      break; // one low-contrast hint per slide is enough
    }
  }

  /* LAYOUT_MISMATCH */
  const layout = findLayout(slide.layout);
  if (layout) {
    const wantsImage = layout.placeholders.some((p) => p.type === "image");
    const hasRealImage = elements.some((el) => el.type === "image" && el.src);
    if (wantsImage && !hasRealImage) {
      hints.push({
        code: "LAYOUT_MISMATCH",
        severity: "info",
        message: `The '${layout.name}' layout expects an image — add one or switch layouts.`,
      });
    } else if (slide.layout === "title" && elements.length > 3) {
      hints.push({
        code: "LAYOUT_MISMATCH",
        severity: "info",
        message: "Title slides work best nearly empty — this one is getting busy.",
      });
    }
  }

  /* TEXT_CLIPPED — needs the client measurer; AI/import paths can produce
     boxes shorter than their content even though UI commits grow-enforce. */
  if (measureContentHeight) {
    for (const el of elements) {
      if (
        el.type !== "text" &&
        el.type !== "heading" &&
        el.type !== "callout" &&
        el.type !== "bullet_list"
      ) {
        continue;
      }
      const needed = measureContentHeight(el, slide.style.theme.id);
      if (needed !== null && needed > el.height + CLIP_TOLERANCE_PX) {
        const target = Math.min(Math.ceil(needed), SLIDE_H - el.y);
        hints.push({
          code: "TEXT_CLIPPED",
          severity: "warn",
          message: "Text is taller than its box — the overflow is invisible.",
          fix: {
            label: "Grow box to fit",
            makePatches: () => [
              {
                action: "RESIZE_SLIDE_ELEMENT",
                blockId: ctx.blockId,
                slideId: slide.id,
                elementId: el.id,
                x: el.x,
                y: el.y,
                width: el.width,
                height: target,
              },
            ],
          },
        });
        break; // one clipped-text hint per slide keeps the badge calm
      }
    }
  }

  /* TOO_MANY_FONT_SIZES */
  if (explicitFontSizes(elements).length > MAX_FONT_SIZES) {
    hints.push({
      code: "TOO_MANY_FONT_SIZES",
      severity: "info",
      message: "More than three font sizes — fewer sizes, clearer hierarchy.",
      fix: {
        label: "Simplify design",
        makePatches: () => [
          { action: "SIMPLIFY_SLIDE_DESIGN", blockId: ctx.blockId, slideId: slide.id },
        ],
      },
    });
  }

  /* TOO_MANY_COLORS */
  if (offPaletteColors(slide).length > MAX_OFF_PALETTE_COLORS) {
    hints.push({
      code: "TOO_MANY_COLORS",
      severity: "info",
      message: "Many one-off colors — staying on the theme palette reads calmer.",
      fix: {
        label: "Simplify design",
        makePatches: () => [
          { action: "SIMPLIFY_SLIDE_DESIGN", blockId: ctx.blockId, slideId: slide.id },
        ],
      },
    });
  }

  return hints;
}
