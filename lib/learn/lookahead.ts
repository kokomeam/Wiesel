/**
 * Slide-asset lookahead (PERF-1 C5) — PURE, no DOM, no React.
 *
 * Slide *data* rides the page payload, so advancing a deck is instant client
 * state (~3 ms) — except on image slides, which cold-fetch their full-res PNG
 * on arrival. These helpers enumerate every image URL a slide can render so
 * the player can warm the browser cache for the next slides while the learner
 * reads the current one. The DOM wiring (new Image(), concurrency, save-data
 * gate) lives in the player component; this module only decides WHICH urls.
 */

import type { Slide } from "@/lib/course/types";

/** Warmable = something the network would actually fetch. Empty string is the
 *  "pending generation / awaiting upload" sentinel; blob:/data: need no warm
 *  (and blob: URLs never survive into a published snapshot anyway). */
function isWarmableUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  return !url.startsWith("data:") && !url.startsWith("blob:");
}

/**
 * Every image URL `slide` renders, in paint order (background first), deduped.
 * Mirrors SlideStage: the background layer always draws; when a structured
 * `template` is present it is the source of truth and freeform `elements` are
 * NOT rendered (so their images are deliberately excluded).
 */
export function collectSlideImageUrls(slide: Slide): string[] {
  const urls: string[] = [];
  const push = (url: string | undefined | null) => {
    if (isWarmableUrl(url) && !urls.includes(url)) urls.push(url);
  };

  const bg = slide.style.background;
  if (bg.type === "image") push(bg.imageSrc);

  if (slide.template) {
    const t = slide.template;
    if (
      t.layoutId === "illustration" ||
      t.layoutId === "image_reference" ||
      t.layoutId === "image_supporting"
    ) {
      push(t.content.imageUrl);
    }
    return urls;
  }

  for (const el of slide.elements) {
    if (el.type === "image" && el.visible !== false) push(el.src);
  }
  return urls;
}

/**
 * Ordered, deduped URL list for the `ahead` slides after `currentIndex`
 * (nearest slide's urls first — it will be needed soonest). Clamps at the deck
 * end and excludes anything the CURRENT slide already renders (those fetches
 * are in flight via its own <img> tags).
 */
export function planLookahead(
  slides: Slide[],
  currentIndex: number,
  opts?: { ahead?: number }
): string[] {
  const ahead = opts?.ahead ?? 2;
  if (slides.length === 0 || ahead <= 0) return [];

  const current = slides[currentIndex];
  const currentUrls = new Set(current ? collectSlideImageUrls(current) : []);

  const start = Math.max(currentIndex + 1, 0);
  const end = Math.min(currentIndex + ahead, slides.length - 1);
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    for (const url of collectSlideImageUrls(slides[i])) {
      if (!currentUrls.has(url) && !out.includes(url)) out.push(url);
    }
  }
  return out;
}
