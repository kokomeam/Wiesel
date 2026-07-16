/**
 * SlideShortSpec (amendment FR-6) — the Zod input contract of the
 * WiseselSlideShortProvider: the span's audio source, the ordered slides
 * clipped to the span (REAL slide JSON from the lesson deck), clip-relative
 * word-level caption words, and the resolved packaging surface (preset +
 * hook + creator handle; brand tokens resolve inside the composition from
 * the ONE D-1 module — never serialized, so they can't drift).
 */

import { z } from "zod";
import { CLIP_PLATFORMS } from "../../constants";
import { CLIP_PACKAGING_PRESETS } from "../../presets";

/** One slide's visible window within the clip (CLIP-relative ms). The slide
 *  payload is the lesson's REAL `Slide` JSON (structured template or element
 *  slide) — validated structurally here, rendered by the composition's pure
 *  dispatch (the renderToStaticMarkup-proven layout components). */
export const SlideShortSlideSchema = z.object({
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().positive(),
  slide: z.record(z.string(), z.unknown()),
});
export type SlideShortSlide = z.infer<typeof SlideShortSlideSchema>;

export const SlideShortCaptionWordSchema = z.object({
  w: z.string(),
  /** CLIP-relative ms. */
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
});
export type SlideShortCaptionWord = z.infer<typeof SlideShortCaptionWordSchema>;

export const SlideShortSpecSchema = z.object({
  /** The pre-cut span's own media (audio rides it) — an http(s) URL the
   *  render Chrome can fetch (the precut Mux mp4). */
  mediaUrl: z.string().url(),
  durationMs: z.number().int().min(1_000),
  slides: z.array(SlideShortSlideSchema).min(1),
  captionWords: z.array(SlideShortCaptionWordSchema),
  hookText: z.string(),
  preset: z.enum(CLIP_PACKAGING_PRESETS),
  /** H-4: the primary target platform — hook/caption positions honor its
   *  safe area (CLIP_TEXT_SAFE_AREAS), same as the burn path. */
  platform: z.enum(CLIP_PLATFORMS),
  /** End-card CTA line (the candidate's own, else preset framing). */
  endCardCta: z.string().nullable(),
  creatorHandle: z.string().nullable(),
  courseTitle: z.string(),
});
export type SlideShortSpec = z.infer<typeof SlideShortSpecSchema>;

export const SLIDE_SHORT_FPS = 30;
export const SLIDE_SHORT_W = 1080;
export const SLIDE_SHORT_H = 1920;
/** Hook overlay ≤2s (FR-6). */
export const SLIDE_SHORT_HOOK_MS = 2_000;
/** End card window at the tail. */
export const SLIDE_SHORT_ENDCARD_MS = 2_200;
