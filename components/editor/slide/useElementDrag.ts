"use client";

/**
 * Hand-rolled pointer drag/resize for slide elements.
 *
 * One gesture = one undoable commit: transient frames live in the shared
 * dragStore (so every participating ElementView and the SlideStage overlay
 * render them), and exactly one MOVE/RESIZE patch per touched element lands
 * on pointer-up via applyMany. Movement under 3 logical px counts as a click.
 *
 * Professional-transform behavior:
 *  - Smart guides + snapping (slide edges/center + sibling edges/centers),
 *    threshold ≈ 6 SCREEN px converted through the stage scale.
 *    Hold Cmd/Ctrl or Alt to bypass snapping.
 *  - Shift on a corner handle locks the aspect ratio (anchored at the
 *    opposite corner); snapping then follows the dominant axis only.
 *  - Moving an element of the current multi-selection moves the whole
 *    selection; deltas clamp by the selection BOUNDING BOX (per-element
 *    clamping would shear the arrangement); locked members stay put.
 */

import { useRef } from "react";
import type React from "react";
import { moveElementPatch } from "@/lib/course/commands";
import {
  MIN_ELEMENT_H,
  MIN_ELEMENT_W,
  SLIDE_H,
  SLIDE_W,
  type Frame,
} from "@/lib/course/slide/geometry";
import {
  buildCandidates,
  snapEdges,
  snapMove,
  type SnapCandidates,
} from "@/lib/course/slide/snap";
import { findSlide } from "@/lib/course/queries";
import { useEditorStore } from "@/lib/course/store";
import { useDragStore, type GuideLine } from "@/lib/editor/dragStore";
import type { SlideElement } from "@/lib/course/types";
import { growAwareResizePatch } from "./elements/measureTextLike";

export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const SNAP_SCREEN_PX = 6;

interface Gesture {
  kind: "move" | "resize";
  handle?: ResizeHandle;
  startClientX: number;
  startClientY: number;
  /** Original frames of every participating element (move: possibly many). */
  origins: Record<string, Frame>;
  cands: SnapCandidates;
  moved: boolean;
}

function frameOf(el: SlideElement): Frame {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

function clampTransient(f: Frame): Frame {
  const width = Math.max(MIN_ELEMENT_W, Math.min(f.width, SLIDE_W));
  const height = Math.max(MIN_ELEMENT_H, Math.min(f.height, SLIDE_H));
  return {
    width,
    height,
    x: Math.max(0, Math.min(f.x, SLIDE_W - width)),
    y: Math.max(0, Math.min(f.y, SLIDE_H - height)),
  };
}

/** Clamp a uniform (dx,dy) so the union bbox of all origins stays on-canvas. */
function clampDeltaToBBox(origins: Record<string, Frame>, dx: number, dy: number) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const f of Object.values(origins)) {
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.width);
    maxY = Math.max(maxY, f.y + f.height);
  }
  return {
    dx: Math.max(-minX, Math.min(dx, SLIDE_W - maxX)),
    dy: Math.max(-minY, Math.min(dy, SLIDE_H - maxY)),
    bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } as Frame,
  };
}

export function isCorner(handle: ResizeHandle): boolean {
  return handle.length === 2;
}

export function rawResize(orig: Frame, handle: ResizeHandle, dx: number, dy: number): Frame {
  let { x, y, width, height } = orig;
  if (handle.includes("e")) width = orig.width + dx;
  if (handle.includes("s")) height = orig.height + dy;
  if (handle.includes("w")) {
    width = orig.width - dx;
    x = orig.x + dx;
  }
  if (handle.includes("n")) {
    height = orig.height - dy;
    y = orig.y + dy;
  }
  return { x, y, width, height };
}

/** Re-anchor a frame after its width/height changed, keeping the corner
 *  opposite the handle fixed. */
export function anchor(orig: Frame, handle: ResizeHandle, width: number, height: number): Frame {
  return {
    width,
    height,
    x: handle.includes("w") ? orig.x + orig.width - width : orig.x,
    y: handle.includes("n") ? orig.y + orig.height - height : orig.y,
  };
}

function enforceMin(orig: Frame, handle: ResizeHandle, f: Frame): Frame {
  let { width, height } = f;
  width = Math.max(MIN_ELEMENT_W, width);
  height = Math.max(MIN_ELEMENT_H, height);
  return clampTransient(anchor(orig, handle, width, height));
}

/** Which elements move together when this element is dragged. */
function moveParticipants(el: SlideElement, blockId: string, slideId: string): SlideElement[] {
  const { doc, selection } = useEditorStore.getState();
  if (
    selection.kind === "elements" &&
    selection.blockId === blockId &&
    selection.slideId === slideId &&
    selection.ids.includes(el.id)
  ) {
    const hit = findSlide(doc, blockId, slideId);
    if (hit) {
      const members = hit.slide.elements.filter(
        (e) => selection.ids.includes(e.id) && !e.locked
      );
      if (members.length > 0) return members;
    }
  }
  return el.locked ? [] : [el];
}

export interface ElementDragOptions {
  /** Fired on pointer-up when the gesture never crossed the 3px click
   *  threshold — selection-collapse decisions live with the caller. */
  onClickWithoutDrag?: (e: React.PointerEvent) => void;
}

export function useElementDrag(
  el: SlideElement,
  blockId: string,
  slideId: string,
  scale: number | null,
  opts?: ElementDragOptions
) {
  const gesture = useRef<Gesture | null>(null);

  function begin(e: React.PointerEvent, kind: Gesture["kind"], handle?: ResizeHandle) {
    if (!scale) return;
    if (e.button !== 0) return; // primary button only

    if (kind === "resize" && el.locked) return;
    const participants =
      kind === "move" ? moveParticipants(el, blockId, slideId) : el.locked ? [] : [el];
    if (participants.length === 0) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);

    // Snap candidates: every visible element on the slide that is NOT moving.
    const participantIds = new Set(participants.map((p) => p.id));
    const hit = findSlide(useEditorStore.getState().doc, blockId, slideId);
    const others = (hit?.slide.elements ?? [])
      .filter((o) => !participantIds.has(o.id) && o.visible !== false)
      .map(frameOf);

    gesture.current = {
      kind,
      handle,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origins: Object.fromEntries(participants.map((p) => [p.id, frameOf(p)])),
      cands: buildCandidates(others),
      moved: false,
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g || !scale) return;
    const rawDx = (e.clientX - g.startClientX) / scale;
    const rawDy = (e.clientY - g.startClientY) / scale;
    if (!g.moved && Math.abs(rawDx) < 3 && Math.abs(rawDy) < 3) return;
    g.moved = true;

    const bypassSnap = e.metaKey || e.ctrlKey || e.altKey;
    const threshold = SNAP_SCREEN_PX / scale;
    const drag = useDragStore.getState();
    const frames: Record<string, Frame> = {};
    let guides: GuideLine[] = [];

    if (g.kind === "move") {
      const clamped = clampDeltaToBBox(g.origins, rawDx, rawDy);
      const bbox = clamped.bbox;
      let { dx, dy } = clamped;
      if (!bypassSnap) {
        const moved = { ...bbox, x: bbox.x + dx, y: bbox.y + dy };
        const snap = snapMove(moved, g.cands, threshold);
        const reclamped = clampDeltaToBBox(g.origins, dx + snap.dx, dy + snap.dy);
        dx = reclamped.dx;
        dy = reclamped.dy;
        guides = snap.guides;
      }
      for (const [id, orig] of Object.entries(g.origins)) {
        frames[id] = { ...orig, x: orig.x + dx, y: orig.y + dy };
      }
    } else {
      const handle = g.handle!;
      const orig = g.origins[el.id];
      let frame = rawResize(orig, handle, rawDx, rawDy);
      const aspectLock = e.shiftKey && isCorner(handle);
      const ratio = orig.width / Math.max(1, orig.height);

      if (aspectLock) {
        const horizDominant = Math.abs(rawDx) >= Math.abs(rawDy * ratio);
        if (horizDominant) {
          frame = anchor(orig, handle, frame.width, frame.width / ratio);
        } else {
          frame = anchor(orig, handle, frame.height * ratio, frame.height);
        }
      }

      if (!bypassSnap) {
        const edges = {
          left: handle.includes("w"),
          right: handle.includes("e"),
          top: handle.includes("n"),
          bottom: handle.includes("s"),
        };
        const snap = snapEdges(
          frame,
          aspectLock
            ? // dominant edge only — snapping both would break the ratio
              Math.abs(rawDx) >= Math.abs(rawDy * ratio)
              ? { left: edges.left, right: edges.right }
              : { top: edges.top, bottom: edges.bottom }
            : edges,
          g.cands,
          threshold
        );
        guides = snap.guides;
        let { x, y, width, height } = frame;
        if (snap.left !== undefined) {
          x += snap.left;
          width -= snap.left;
        }
        if (snap.right !== undefined) width += snap.right;
        if (snap.top !== undefined) {
          y += snap.top;
          height -= snap.top;
        }
        if (snap.bottom !== undefined) height += snap.bottom;
        frame = { x, y, width, height };
        if (aspectLock) {
          // re-derive the passive axis from the snapped dominant one
          const horizDominant = Math.abs(rawDx) >= Math.abs(rawDy * ratio);
          frame = horizDominant
            ? anchor(orig, handle, frame.width, frame.width / ratio)
            : anchor(orig, handle, frame.height * ratio, frame.height);
        }
      }

      frames[el.id] = enforceMin(orig, handle, frame);
    }

    if (!drag.session) {
      drag.setSession({ blockId, slideId, frames, guides });
    } else {
      drag.updateSession(frames, guides);
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const drag = useDragStore.getState();
    const frames = drag.session?.frames;
    drag.setSession(null);
    if (!g.moved) {
      opts?.onClickWithoutDrag?.(e);
      return;
    }
    if (!frames) return;

    const { applyMany, doc } = useEditorStore.getState();
    const themeId = findSlide(doc, blockId, slideId)?.slide.style.theme.id ?? "";
    const patches = Object.entries(frames).map(([id, frame]) =>
      g.kind === "move"
        ? moveElementPatch(blockId, slideId, id, frame.x, frame.y)
        : // text boxes never commit shorter than their (re-wrapped) content
          growAwareResizePatch(blockId, slideId, el, themeId, frame)
    );
    if (patches.length > 0) applyMany(patches, "human");
  }

  return {
    startMove: (e: React.PointerEvent) => begin(e, "move"),
    startResize: (handle: ResizeHandle) => (e: React.PointerEvent) =>
      begin(e, "resize", handle),
    onPointerMove,
    onPointerUp,
  };
}
