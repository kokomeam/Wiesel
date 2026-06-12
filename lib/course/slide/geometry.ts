/**
 * Slide coordinate system. All element frames live in a fixed logical
 * 1280×720 (16:9) space; the canvas CSS-scales it to fit the viewport.
 * Single source of truth — nothing else hard-codes these numbers.
 */

import type { SlideElement, SlideElementType } from "../types";

export const SLIDE_W = 1280;
export const SLIDE_H = 720;

export const MIN_ELEMENT_W = 40;
export const MIN_ELEMENT_H = 24;

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Clamp a frame fully inside the canvas at minimum size. */
export function clampFrame(f: Frame): Frame {
  const width = Math.max(MIN_ELEMENT_W, Math.min(f.width, SLIDE_W));
  const height = Math.max(MIN_ELEMENT_H, Math.min(f.height, SLIDE_H));
  return {
    width,
    height,
    x: Math.max(0, Math.min(f.x, SLIDE_W - width)),
    y: Math.max(0, Math.min(f.y, SLIDE_H - height)),
  };
}

const defaultSizes: Record<SlideElementType, { width: number; height: number }> = {
  heading: { width: 880, height: 90 },
  text: { width: 640, height: 120 },
  bullet_list: { width: 720, height: 260 },
  code_block: { width: 720, height: 280 },
  image: { width: 480, height: 320 },
  shape: { width: 280, height: 180 },
  callout: { width: 420, height: 130 },
  divider: { width: 560, height: 8 },
  table: { width: 760, height: 280 },
};

/** A sensible starting frame for a freshly inserted element; cascades by
 *  +28/+28 per existing element so stacked inserts don't overlap exactly. */
export function defaultFrameFor(type: SlideElementType, existingCount: number): Frame {
  const size = defaultSizes[type];
  const cascade = (existingCount % 6) * 28;
  return clampFrame({
    x: 120 + cascade,
    y: 140 + cascade,
    width: size.width,
    height: size.height,
  });
}

/** X coordinate that aligns a frame to a canvas edge/center. */
export function alignedX(frame: Frame, align: "left" | "center" | "right"): number {
  const MARGIN = 72;
  switch (align) {
    case "left":
      return MARGIN;
    case "center":
      return Math.round((SLIDE_W - frame.width) / 2);
    case "right":
      return SLIDE_W - frame.width - MARGIN;
  }
}

/** Y coordinate that aligns a frame to a canvas edge/center. */
export function alignedY(frame: Frame, align: "top" | "middle" | "bottom"): number {
  const MARGIN = 56;
  switch (align) {
    case "top":
      return MARGIN;
    case "middle":
      return Math.round((SLIDE_H - frame.height) / 2);
    case "bottom":
      return SLIDE_H - frame.height - MARGIN;
  }
}

/** Next zIndex above everything on the slide. */
export function topZ(elements: SlideElement[]): number {
  return elements.reduce((max, el) => Math.max(max, el.zIndex), -1) + 1;
}
