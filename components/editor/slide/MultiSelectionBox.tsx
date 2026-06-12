"use client";

/**
 * Bounding-box transform for multi-selections (Google Slides): one box
 * around every selected member with 8 handles; dragging a handle scales all
 * members proportionally about the opposite edge/corner. Transient frames
 * go through dragStore (members render them live); ONE applyMany commits on
 * pointer-up. Shift on a corner locks the bbox aspect ratio; snapping moves
 * only the dragged edge(s); Cmd/Ctrl/Alt bypasses. Handles disappear while
 * any member is locked — unlock to transform the group.
 */

import { useRef } from "react";
import type React from "react";
import { cn } from "@/lib/cn";
import { resizeElementPatch } from "@/lib/course/commands";
import {
  MIN_ELEMENT_H,
  MIN_ELEMENT_W,
  SLIDE_H,
  SLIDE_W,
  type Frame,
} from "@/lib/course/slide/geometry";
import { buildCandidates, snapEdges, type SnapCandidates } from "@/lib/course/slide/snap";
import { useEditorStore } from "@/lib/course/store";
import { growAwareResizePatch } from "./elements/measureTextLike";
import { useDragStore, type GuideLine } from "@/lib/editor/dragStore";
import type { Slide } from "@/lib/course/types";
import { HANDLES } from "./ElementView";
import {
  anchor,
  isCorner,
  rawResize,
  SNAP_SCREEN_PX,
  type ResizeHandle,
} from "./useElementDrag";

interface BoxGesture {
  handle: ResizeHandle;
  startClientX: number;
  startClientY: number;
  bbox: Frame;
  origins: Record<string, Frame>;
  cands: SnapCandidates;
  /** Scale floors so the SMALLEST member never drops below MIN_ELEMENT_*. */
  sxMin: number;
  syMin: number;
  moved: boolean;
}

function union(frames: Frame[]): Frame {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of frames) {
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.width);
    maxY = Math.max(maxY, f.y + f.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function MultiSelectionBox({
  slide,
  blockId,
  scale,
}: {
  slide: Slide;
  blockId: string;
  scale: number;
}) {
  const selection = useEditorStore((s) => s.selection);
  const session = useDragStore((s) =>
    s.session && s.session.slideId === slide.id ? s.session : null
  );
  const gesture = useRef<BoxGesture | null>(null);

  if (
    selection.kind !== "elements" ||
    selection.blockId !== blockId ||
    selection.slideId !== slide.id
  ) {
    return null;
  }
  const members = slide.elements.filter((el) => selection.ids.includes(el.id));
  if (members.length < 2) return null;
  const anyLocked = members.some((el) => el.locked);

  // The box follows transient frames during any gesture (move OR resize).
  const bbox = union(
    members.map((el) => session?.frames[el.id] ?? el)
  );

  function startResize(handle: ResizeHandle) {
    return (e: React.PointerEvent) => {
      if (anyLocked || e.button !== 0) return;
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      const origins = Object.fromEntries(
        members.map((el) => [el.id, { x: el.x, y: el.y, width: el.width, height: el.height }])
      );
      const memberIds = new Set(members.map((el) => el.id));
      const others = slide.elements
        .filter((o) => !memberIds.has(o.id) && o.visible !== false)
        .map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height }));
      gesture.current = {
        handle,
        startClientX: e.clientX,
        startClientY: e.clientY,
        bbox: union(Object.values(origins)),
        origins,
        cands: buildCandidates(others),
        // Floors capped at 1: a member already at/below MIN simply can't
        // shrink further, but the gesture stays usable.
        sxMin: Math.max(...members.map((m) => Math.min(1, MIN_ELEMENT_W / m.width))),
        syMin: Math.max(...members.map((m) => Math.min(1, MIN_ELEMENT_H / m.height))),
        moved: false,
      };
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g) return;
    const rawDx = (e.clientX - g.startClientX) / scale;
    const rawDy = (e.clientY - g.startClientY) / scale;
    if (!g.moved && Math.abs(rawDx) < 3 && Math.abs(rawDy) < 3) return;
    g.moved = true;

    const bypassSnap = e.metaKey || e.ctrlKey || e.altKey;
    const threshold = SNAP_SCREEN_PX / scale;
    const handle = g.handle;
    const orig = g.bbox;
    const aspectLock = e.shiftKey && isCorner(handle);
    const ratio = orig.width / Math.max(1, orig.height);
    const horizDominant = Math.abs(rawDx) >= Math.abs(rawDy * ratio);

    let frame = rawResize(orig, handle, rawDx, rawDy);
    if (aspectLock) {
      frame = horizDominant
        ? anchor(orig, handle, frame.width, frame.width / ratio)
        : anchor(orig, handle, frame.height * ratio, frame.height);
    }

    // Clamp the moving edge(s) to the slide (the anchored edges never move).
    {
      const right = frame.x + frame.width;
      const bottom = frame.y + frame.height;
      let { x, y } = frame;
      if (handle.includes("w") && x < 0) x = 0;
      if (handle.includes("n") && y < 0) y = 0;
      frame = {
        x,
        y,
        width: handle.includes("e") ? Math.min(right, SLIDE_W) - x : right - x,
        height: handle.includes("s") ? Math.min(bottom, SLIDE_H) - y : bottom - y,
      };
    }

    let guides: GuideLine[] = [];
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
          ? horizDominant
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
    }

    // Scale floors (shrinking only — growth is already slide-clamped), then
    // re-anchor; with aspect lock the two axes stay one factor.
    let sx = Math.max(frame.width / orig.width, g.sxMin);
    let sy = Math.max(frame.height / orig.height, g.syMin);
    if (aspectLock) {
      const s = horizDominant ? sx : sy;
      sx = Math.max(s, g.sxMin, g.syMin);
      sy = sx;
    }
    frame = anchor(orig, handle, orig.width * sx, orig.height * sy);

    const frames: Record<string, Frame> = {};
    for (const [id, om] of Object.entries(g.origins)) {
      frames[id] = {
        x: frame.x + (om.x - orig.x) * sx,
        y: frame.y + (om.y - orig.y) * sy,
        width: om.width * sx,
        height: om.height * sy,
      };
    }

    const drag = useDragStore.getState();
    if (!drag.session) drag.setSession({ blockId, slideId: slide.id, frames, guides });
    else drag.updateSession(frames, guides);
  }

  function onPointerUp() {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const drag = useDragStore.getState();
    const frames = drag.session?.frames;
    drag.setSession(null);
    if (!g.moved || !frames) return;
    const { applyMany } = useEditorStore.getState();
    const themeId = slide.style.theme.id;
    const byId = new Map(slide.elements.map((el) => [el.id, el]));
    applyMany(
      Object.entries(frames).map(([id, frame]) => {
        // Text members of a scaled group may wrap differently at their new
        // width — never commit them shorter than their content (grow-only;
        // note: unlike GS we don't scale font sizes on group resize, so a
        // narrowed text box grows taller instead of shrinking its type).
        const member = byId.get(id);
        return member
          ? growAwareResizePatch(blockId, slide.id, member, themeId, frame)
          : resizeElementPatch(blockId, slide.id, id, frame);
      }),
      "human"
    );
  }

  const visual = Math.min(10 / scale, 22);
  return (
    <div
      aria-hidden
      data-ai-component="multi-selection-box"
      className="pointer-events-none absolute z-[997]"
      style={{ left: bbox.x, top: bbox.y, width: bbox.width, height: bbox.height }}
    >
      <div className="absolute -inset-px rounded-sm shadow-[0_0_0_1px_rgba(167,139,250,0.9)]" />
      {!anyLocked &&
        HANDLES.map(({ handle, className }) => (
          <span
            key={handle}
            role="presentation"
            data-ai-tool={`bbox-resize-${handle}`}
            onPointerDown={startResize(handle)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className={cn(
              "pointer-events-auto absolute z-10 block rounded-full border border-brand-400 bg-white shadow-sm",
              className
            )}
            style={{ width: visual, height: visual }}
          />
        ))}
    </div>
  );
}
