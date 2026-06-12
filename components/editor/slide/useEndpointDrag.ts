"use client";

/**
 * Endpoint drag for 2-point lines/arrows: each endpoint is its own handle;
 * dragging one keeps the other fixed. Transient geometry goes through the
 * shared dragStore (frame + points), ONE SET_LINE_ENDPOINTS patch commits
 * on pointer-up (the reducer derives the padded frame atomically).
 *
 *  - Endpoints snap to the same edge/center candidates as everything else
 *    (⌘/Ctrl/Alt bypasses).
 *  - Shift constrains the segment angle to 45° increments around the fixed
 *    endpoint (Google-Slides line behavior).
 */

import { useRef } from "react";
import type React from "react";
import { setLineEndpointsPatch } from "@/lib/course/commands";
import { SLIDE_H, SLIDE_W } from "@/lib/course/slide/geometry";
import {
  buildCandidates,
  snapEdges,
  type SnapCandidates,
} from "@/lib/course/slide/snap";
import { findSlide } from "@/lib/course/queries";
import { useEditorStore } from "@/lib/course/store";
import { useDragStore } from "@/lib/editor/dragStore";
import type { LineGeometry, SlideElement } from "@/lib/course/types";
import { SNAP_SCREEN_PX } from "./useElementDrag";

type LineShape = Extract<SlideElement, { type: "shape" }>;

const DEFAULT_POINTS: LineGeometry = { x1: 0, y1: 0.5, x2: 1, y2: 0.5 };

/** Absolute endpoints of a line/arrow element. */
export function absoluteEndpoints(el: LineShape): {
  p1: { x: number; y: number };
  p2: { x: number; y: number };
} {
  const p = el.points ?? DEFAULT_POINTS;
  return {
    p1: { x: el.x + p.x1 * el.width, y: el.y + p.y1 * el.height },
    p2: { x: el.x + p.x2 * el.width, y: el.y + p.y2 * el.height },
  };
}

interface EndpointGesture {
  which: "p1" | "p2";
  startClientX: number;
  startClientY: number;
  origin: { x: number; y: number };
  fixed: { x: number; y: number };
  cands: SnapCandidates;
  moved: boolean;
}

export function useEndpointDrag(
  el: LineShape,
  blockId: string,
  slideId: string,
  scale: number | null
) {
  const gesture = useRef<EndpointGesture | null>(null);

  function begin(e: React.PointerEvent, which: "p1" | "p2") {
    if (!scale || el.locked || e.button !== 0) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const { p1, p2 } = absoluteEndpoints(el);
    const hit = findSlide(useEditorStore.getState().doc, blockId, slideId);
    const others = (hit?.slide.elements ?? [])
      .filter((o) => o.id !== el.id && o.visible !== false)
      .map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height }));
    gesture.current = {
      which,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origin: which === "p1" ? p1 : p2,
      fixed: which === "p1" ? p2 : p1,
      cands: buildCandidates(others),
      moved: false,
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g || !scale) return;
    const dx = (e.clientX - g.startClientX) / scale;
    const dy = (e.clientY - g.startClientY) / scale;
    if (!g.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    g.moved = true;

    let px = Math.max(0, Math.min(g.origin.x + dx, SLIDE_W));
    let py = Math.max(0, Math.min(g.origin.y + dy, SLIDE_H));

    if (e.shiftKey) {
      // 45°-increment constraint around the FIXED endpoint
      const vx = px - g.fixed.x;
      const vy = py - g.fixed.y;
      const len = Math.hypot(vx, vy);
      if (len > 0) {
        const step = Math.PI / 4;
        const angle = Math.round(Math.atan2(vy, vx) / step) * step;
        px = g.fixed.x + Math.cos(angle) * len;
        py = g.fixed.y + Math.sin(angle) * len;
      }
    } else if (!(e.metaKey || e.ctrlKey || e.altKey)) {
      // snap the dragged endpoint like an edge pair at a zero-size frame
      const threshold = SNAP_SCREEN_PX / scale;
      const snap = snapEdges(
        { x: px, y: py, width: 0, height: 0 },
        { left: true, top: true },
        g.cands,
        threshold
      );
      if (snap.left !== undefined) px += snap.left;
      if (snap.top !== undefined) py += snap.top;
    }

    // transient frame = the live bbox of both endpoints (+ relative points)
    const a = { x: px, y: py };
    const b = g.fixed;
    const fx = Math.min(a.x, b.x);
    const fy = Math.min(a.y, b.y);
    const fw = Math.max(1, Math.abs(a.x - b.x));
    const fh = Math.max(1, Math.abs(a.y - b.y));
    const rel = (p: { x: number; y: number }) => ({
      x: (p.x - fx) / fw,
      y: (p.y - fy) / fh,
    });
    const ra = rel(a);
    const rb = rel(b);
    const points: LineGeometry =
      g.which === "p1"
        ? { x1: ra.x, y1: ra.y, x2: rb.x, y2: rb.y }
        : { x1: rb.x, y1: rb.y, x2: ra.x, y2: ra.y };

    const drag = useDragStore.getState();
    const frames = { [el.id]: { x: fx, y: fy, width: fw, height: fh, points } };
    if (!drag.session) drag.setSession({ blockId, slideId, frames, guides: [] });
    else drag.updateSession(frames, []);
  }

  function onPointerUp() {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const drag = useDragStore.getState();
    const t = drag.session?.frames[el.id];
    drag.setSession(null);
    if (!g.moved || !t || !t.points) return;
    const abs = (fx: number, fy: number) => ({
      x: t.x + fx * t.width,
      y: t.y + fy * t.height,
    });
    const p1 = abs(t.points.x1, t.points.y1);
    const p2 = abs(t.points.x2, t.points.y2);
    useEditorStore
      .getState()
      .apply(
        setLineEndpointsPatch(blockId, slideId, el.id, p1.x, p1.y, p2.x, p2.y),
        "human"
      );
  }

  return {
    startP1: (e: React.PointerEvent) => begin(e, "p1"),
    startP2: (e: React.PointerEvent) => begin(e, "p2"),
    onPointerMove,
    onPointerUp,
  };
}
