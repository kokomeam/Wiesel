/**
 * Smart alignment guides + snapping (Canva/Google-Slides style). Pure math —
 * the gesture hook feeds frames in, gets a snapped delta plus the guide
 * lines to draw. Threshold is supplied by the caller in LOGICAL px (the hook
 * converts ~6 screen px through the current stage scale so snapping feels
 * identical at any zoom).
 */

import { SLIDE_H, SLIDE_W, type Frame } from "./geometry";
import type { GuideLine } from "@/lib/editor/dragStore";

interface AxisCandidate {
  /** Snap position along the axis (an x for vertical lines, y for horizontal). */
  pos: number;
  /** Extent of the source along the OTHER axis, for drawing the guide. */
  from: number;
  to: number;
}

export interface SnapCandidates {
  v: AxisCandidate[];
  h: AxisCandidate[];
  /** Raw frames of the non-participants — equal-gap detection needs them. */
  frames: Frame[];
}

/** Precompute once at gesture start: slide edges + center, plus the edges
 *  and centers of every non-participating visible element. */
export function buildCandidates(others: Frame[]): SnapCandidates {
  const v: AxisCandidate[] = [
    { pos: 0, from: 0, to: SLIDE_H },
    { pos: SLIDE_W / 2, from: 0, to: SLIDE_H },
    { pos: SLIDE_W, from: 0, to: SLIDE_H },
  ];
  const h: AxisCandidate[] = [
    { pos: 0, from: 0, to: SLIDE_W },
    { pos: SLIDE_H / 2, from: 0, to: SLIDE_W },
    { pos: SLIDE_H, from: 0, to: SLIDE_W },
  ];
  for (const f of others) {
    const ySpan = { from: f.y, to: f.y + f.height };
    const xSpan = { from: f.x, to: f.x + f.width };
    v.push({ pos: f.x, ...ySpan });
    v.push({ pos: f.x + f.width / 2, ...ySpan });
    v.push({ pos: f.x + f.width, ...ySpan });
    h.push({ pos: f.y, ...xSpan });
    h.push({ pos: f.y + f.height / 2, ...xSpan });
    h.push({ pos: f.y + f.height, ...xSpan });
  }
  return { v, h, frames: others };
}

/* ─────────────────────── Equal-gap spacing snap ────────────────────────
 * Canva/GS-style: while moving between two row/column neighbors, snap to
 * the point where both gaps are equal, and label each gap with a px chip. */

interface GapSnap {
  delta: number;
  guides: GuideLine[];
}

function snapGap(
  frame: Frame,
  others: Frame[],
  threshold: number,
  axis: "x" | "y"
): GapSnap | null {
  const lo = axis === "x" ? frame.x : frame.y;
  const size = axis === "x" ? frame.width : frame.height;
  const crossLo = axis === "x" ? frame.y : frame.x;
  const crossSize = axis === "x" ? frame.height : frame.width;

  // neighbors must overlap the moving frame on the cross axis (same row/col)
  const lane = others.filter((o) => {
    const oLo = axis === "x" ? o.y : o.x;
    const oSize = axis === "x" ? o.height : o.width;
    return oLo < crossLo + crossSize && oLo + oSize > crossLo;
  });

  let win: { before: Frame; after: Frame; delta: number } | null = null;
  for (const a of lane) {
    const aEnd = axis === "x" ? a.x + a.width : a.y + a.height;
    if (aEnd > lo) continue; // not strictly before
    for (const b of lane) {
      const bLo = axis === "x" ? b.x : b.y;
      if (bLo < lo + size) continue; // not strictly after
      const gapBefore = lo - aEnd;
      const gapAfter = bLo - (lo + size);
      const delta = (gapAfter - gapBefore) / 2;
      if (Math.abs(delta) <= threshold && (!win || Math.abs(delta) < Math.abs(win.delta))) {
        win = { before: a, after: b, delta };
      }
    }
  }
  if (!win) return null;

  const { before, after, delta } = win;
  const beforeEnd = axis === "x" ? before.x + before.width : before.y + before.height;
  const afterLo = axis === "x" ? after.x : after.y;
  const snappedLo = lo + delta;
  const gap = Math.round(snappedLo - beforeEnd);
  const mid = crossLo + crossSize / 2;
  // gap chips run ALONG the move axis: horizontal segments for x, vertical
  // for y — i.e. GuideLine axis "h" for x-gaps, "v" for y-gaps.
  const guideAxis = axis === "x" ? "h" : "v";
  return {
    delta,
    guides: [
      { axis: guideAxis, pos: mid, from: beforeEnd, to: snappedLo, label: `${gap}` },
      { axis: guideAxis, pos: mid, from: snappedLo + size, to: afterLo, label: `${gap}` },
    ],
  };
}

function best(
  positions: number[],
  candidates: AxisCandidate[],
  threshold: number
): { delta: number; candidate: AxisCandidate } | null {
  let win: { delta: number; candidate: AxisCandidate } | null = null;
  for (const pos of positions) {
    for (const c of candidates) {
      const delta = c.pos - pos;
      if (Math.abs(delta) <= threshold && (!win || Math.abs(delta) < Math.abs(win.delta))) {
        win = { delta, candidate: c };
      }
    }
  }
  return win;
}

/** Snap a moving frame (or selection bbox): returns the extra (dx,dy) to add
 *  and the guides to draw. */
export function snapMove(
  frame: Frame,
  cands: SnapCandidates,
  threshold: number
): { dx: number; dy: number; guides: GuideLine[] } {
  const guides: GuideLine[] = [];
  const vWin = best(
    [frame.x, frame.x + frame.width / 2, frame.x + frame.width],
    cands.v,
    threshold
  );
  const hWin = best(
    [frame.y, frame.y + frame.height / 2, frame.y + frame.height],
    cands.h,
    threshold
  );
  if (vWin) {
    guides.push({
      axis: "v",
      pos: vWin.candidate.pos,
      from: Math.min(vWin.candidate.from, frame.y),
      to: Math.max(vWin.candidate.to, frame.y + frame.height),
    });
  }
  if (hWin) {
    guides.push({
      axis: "h",
      pos: hWin.candidate.pos,
      from: Math.min(hWin.candidate.from, frame.x),
      to: Math.max(hWin.candidate.to, frame.x + frame.width),
    });
  }

  // Equal-gap spacing per axis, when no edge/center snap claimed that axis.
  let dx = vWin?.delta ?? 0;
  let dy = hWin?.delta ?? 0;
  if (!vWin) {
    const gx = snapGap(frame, cands.frames, threshold, "x");
    if (gx) {
      dx = gx.delta;
      guides.push(...gx.guides);
    }
  }
  if (!hWin) {
    const gy = snapGap(frame, cands.frames, threshold, "y");
    if (gy) {
      dy = gy.delta;
      guides.push(...gy.guides);
    }
  }
  return { dx, dy, guides };
}

/** Snap only the edges a resize handle is moving. Returns edge adjustments
 *  (deltas to add to that edge's position) and guides. */
export function snapEdges(
  frame: Frame,
  edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean },
  cands: SnapCandidates,
  threshold: number
): {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  guides: GuideLine[];
} {
  const guides: GuideLine[] = [];
  const out: { left?: number; right?: number; top?: number; bottom?: number } = {};

  const tryEdge = (
    axis: "v" | "h",
    pos: number,
    key: "left" | "right" | "top" | "bottom"
  ) => {
    const win = best([pos], axis === "v" ? cands.v : cands.h, threshold);
    if (!win) return;
    out[key] = win.delta;
    guides.push(
      axis === "v"
        ? {
            axis,
            pos: win.candidate.pos,
            from: Math.min(win.candidate.from, frame.y),
            to: Math.max(win.candidate.to, frame.y + frame.height),
          }
        : {
            axis,
            pos: win.candidate.pos,
            from: Math.min(win.candidate.from, frame.x),
            to: Math.max(win.candidate.to, frame.x + frame.width),
          }
    );
  };

  if (edges.left) tryEdge("v", frame.x, "left");
  if (edges.right) tryEdge("v", frame.x + frame.width, "right");
  if (edges.top) tryEdge("h", frame.y, "top");
  if (edges.bottom) tryEdge("h", frame.y + frame.height, "bottom");
  return { ...out, guides };
}
