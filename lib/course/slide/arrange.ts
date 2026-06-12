/**
 * Pure align/distribute math for multi-selections (Google Slides "Arrange").
 *
 * Everything works on UNITS — a lone element, or a whole group closure at
 * the current scope — so aligning never tears a group apart. Locked
 * elements receive no moves (consistent with drag/nudge), but still shape
 * the selection bounding box.
 */

import type { Frame } from "./geometry";
import type { SlideElement } from "../types";
import { unitKeyAt } from "./groups";

export type SelectionHAlign = "left" | "center" | "right";
export type SelectionVAlign = "top" | "middle" | "bottom";

export interface ArrangeUnit {
  key: string;
  members: SlideElement[];
  bbox: Frame;
}

function union(frames: { x: number; y: number; width: number; height: number }[]): Frame {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of frames) {
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.width);
    maxY = Math.max(maxY, f.y + f.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Partition selected elements into units at the current scope. */
export function arrangeUnits(members: SlideElement[], scope: string[]): ArrangeUnit[] {
  const byKey = new Map<string, SlideElement[]>();
  for (const el of members) {
    const key = unitKeyAt(el, scope);
    const arr = byKey.get(key);
    if (arr) arr.push(el);
    else byKey.set(key, [el]);
  }
  return [...byKey.entries()].map(([key, els]) => ({
    key,
    members: els,
    bbox: union(els),
  }));
}

export interface ElementMove {
  id: string;
  x: number;
  y: number;
}

function unitMoves(units: ArrangeUnit[], delta: (u: ArrangeUnit) => { dx: number; dy: number }): ElementMove[] {
  const moves: ElementMove[] = [];
  for (const u of units) {
    const { dx, dy } = delta(u);
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) continue;
    for (const m of u.members) {
      if (m.locked) continue;
      moves.push({ id: m.id, x: m.x + dx, y: m.y + dy });
    }
  }
  return moves;
}

/** Align every unit's edge/center to the SELECTION bounding box. */
export function alignToSelectionMoves(
  units: ArrangeUnit[],
  axis: "h" | "v",
  align: SelectionHAlign | SelectionVAlign
): ElementMove[] {
  const sel = union(units.map((u) => u.bbox));
  return unitMoves(units, (u) => {
    if (axis === "h") {
      const dx =
        align === "left"
          ? sel.x - u.bbox.x
          : align === "center"
            ? sel.x + sel.width / 2 - (u.bbox.x + u.bbox.width / 2)
            : sel.x + sel.width - (u.bbox.x + u.bbox.width);
      return { dx, dy: 0 };
    }
    const dy =
      align === "top"
        ? sel.y - u.bbox.y
        : align === "middle"
          ? sel.y + sel.height / 2 - (u.bbox.y + u.bbox.height / 2)
          : sel.y + sel.height - (u.bbox.y + u.bbox.height);
    return { dx: 0, dy };
  });
}

/** Equal gaps between adjacent units; the outermost units stay put.
 *  Needs ≥3 units to mean anything. */
export function distributeMoves(units: ArrangeUnit[], axis: "h" | "v"): ElementMove[] {
  if (units.length < 3) return [];
  const sorted = [...units].sort((a, b) =>
    axis === "h"
      ? a.bbox.x + a.bbox.width / 2 - (b.bbox.x + b.bbox.width / 2)
      : a.bbox.y + a.bbox.height / 2 - (b.bbox.y + b.bbox.height / 2)
  );
  const size = (u: ArrangeUnit) => (axis === "h" ? u.bbox.width : u.bbox.height);
  const pos = (u: ArrangeUnit) => (axis === "h" ? u.bbox.x : u.bbox.y);

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = pos(last) + size(last) - pos(first);
  const total = sorted.reduce((sum, u) => sum + size(u), 0);
  const gap = (span - total) / (sorted.length - 1);

  let cursor = pos(first) + size(first) + gap;
  const targets = new Map<string, number>();
  for (const u of sorted.slice(1, -1)) {
    targets.set(u.key, cursor);
    cursor += size(u) + gap;
  }
  return unitMoves(sorted, (u) => {
    const target = targets.get(u.key);
    if (target === undefined) return { dx: 0, dy: 0 };
    return axis === "h" ? { dx: target - u.bbox.x, dy: 0 } : { dx: 0, dy: target - u.bbox.y };
  });
}
