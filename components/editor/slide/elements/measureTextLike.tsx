"use client";

/**
 * One-shot synchronous height measurement for text-like elements — used by
 * commit paths off the canvas (inspector), resize commits, and the lint
 * TEXT_CLIPPED check. Renders the SAME TextLikeContent markup as the stage
 * into a hidden host at the element's logical width, reads offsetHeight,
 * cleans up. The stage is transform-scaled, so logical px === CSS px here.
 *
 * Uses renderToStaticMarkup + innerHTML (NOT createRoot/flushSync): lint
 * runs during component render, where flushSync is forbidden — static
 * markup is synchronous and render-safe.
 */

import { renderToStaticMarkup } from "react-dom/server";
import {
  commitElementTextPatches,
  resizeElementPatch,
} from "@/lib/course/commands";
import { SLIDE_H, type Frame } from "@/lib/course/slide/geometry";
import type { CoursePatch } from "@/lib/course/patches";
import type { ElementStyle, SlideElement } from "@/lib/course/types";
import { ListContent } from "./ListElementView";
import { TextLikeContent, textLikeBoxStyle, textLikeValue, type TextLike } from "./TextLikeElement";

export function isTextLike(el: SlideElement): el is TextLike {
  return (
    el.type === "text" ||
    el.type === "heading" ||
    el.type === "callout" ||
    el.type === "bullet_list"
  );
}

export function measureTextLikeHeight(
  el: TextLike,
  themeId: string,
  value: string
): number {
  const host = document.createElement("div");
  host.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;";
  host.innerHTML = renderToStaticMarkup(
    <div style={{ ...textLikeBoxStyle(el, themeId), width: el.width, height: "auto" }}>
      {el.type === "bullet_list" || (el.type === "text" && el.list) ? (
        <ListContent el={el} themeId={themeId} />
      ) : (
        <TextLikeContent el={el} themeId={themeId} value={value} />
      )}
    </div>
  );
  document.body.appendChild(host);
  try {
    const box = host.firstElementChild;
    return box instanceof HTMLElement ? Math.ceil(box.offsetHeight) : el.height;
  } finally {
    host.remove();
  }
}

/* Cached measurement — lint and resize commits re-measure often, and the
 * reducer clones the doc per patch (no object identity), so cache by id +
 * a key of everything that affects text metrics. */
const heightCache = new Map<string, { key: string; height: number }>();

export function measuredContentHeight(el: TextLike, themeId: string): number {
  const value = textLikeValue(el);
  const key = JSON.stringify([
    el.width,
    value,
    el.style,
    themeId,
    el.type,
    el.type === "callout" ? el.variant : null,
    el.type === "bullet_list" || el.type === "text" ? el.list ?? null : null,
  ]);
  const hit = heightCache.get(el.id);
  if (hit && hit.key === key) return hit.height;
  const height = measureTextLikeHeight(el, themeId, value);
  heightCache.set(el.id, { key, height });
  return height;
}

/**
 * Style commit with Google-Slides reflow: if the new style makes the content
 * taller than the box, the box GROWS (one undo for style + height). Text is
 * never shrunk to fit — the box reformats instead (user-confirmed policy).
 */
export function growAwareStylePatches(
  blockId: string,
  slideId: string,
  el: TextLike,
  themeId: string,
  style: Partial<ElementStyle>
): CoursePatch[] {
  const probe = { ...el, style: { ...el.style, ...style } } as TextLike;
  return commitElementTextPatches(
    blockId,
    slideId,
    el,
    { style },
    measuredContentHeight(probe, themeId)
  );
}

/** Enforce the content min-height on a resize commit: a text box can never
 *  be committed shorter than its (re-wrapped) content. Grow-only. */
export function growTextFrame(el: TextLike, themeId: string, frame: Frame): Frame {
  const probe = { ...el, width: frame.width } as TextLike;
  const needed = Math.min(
    Math.ceil(measuredContentHeight(probe, themeId)),
    SLIDE_H - frame.y
  );
  return needed > frame.height ? { ...frame, height: needed } : frame;
}

/** Resize patch that respects the content min-height for text-like elements. */
export function growAwareResizePatch(
  blockId: string,
  slideId: string,
  el: SlideElement,
  themeId: string,
  frame: Frame
): CoursePatch {
  const f = isTextLike(el) ? growTextFrame(el, themeId, frame) : frame;
  return resizeElementPatch(blockId, slideId, el.id, f);
}
