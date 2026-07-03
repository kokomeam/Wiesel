"use client";

/**
 * One positioned element on the stage: absolute frame, per-type renderer,
 * selection outline + 8 resize handles, drag-to-move. Spreads aiAttrs so the
 * DOM stays machine-readable. Coordinates are logical px — the whole stage
 * is transform-scaled, so no per-element math.
 */

import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { aiAttrs } from "@/lib/course/aiAttributes";
import { manifestTypeForElement } from "@/lib/course/manifest";
import { findSlide } from "@/lib/course/queries";
import { pathOf, unitClosureIds } from "@/lib/course/slide/groups";
import { shadowFilterCss } from "@/lib/course/slide/styleResolver";
import { useEditorStore } from "@/lib/course/store";
import { useDragStore } from "@/lib/editor/dragStore";
import { useUIStore } from "@/lib/editor/uiStore";
import type { SlideElement } from "@/lib/course/types";
import { CodeElement } from "./elements/CodeElement";
import { ImageElementView } from "./elements/ImageElementView";
import { ListElement } from "./elements/ListElementView";
import {
  DividerElementView,
  ShapeElementView,
  TableElementView,
} from "./elements/MiscElements";
import { StickerElement } from "./elements/StickerElement";
import { TextLikeElement } from "./elements/TextLikeElement";
import { useElementDrag, type ResizeHandle } from "./useElementDrag";
import { absoluteEndpoints, useEndpointDrag } from "./useEndpointDrag";

type LineShape = Extract<SlideElement, { type: "shape" }>;

export const HANDLES: { handle: ResizeHandle; className: string }[] = [
  { handle: "nw", className: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize" },
  { handle: "n", className: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize" },
  { handle: "ne", className: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize" },
  { handle: "e", className: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize" },
  { handle: "se", className: "bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize" },
  { handle: "s", className: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize" },
  { handle: "sw", className: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize" },
  { handle: "w", className: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize" },
];

function ElementBody({
  el,
  blockId,
  slideId,
  themeId,
  editable,
  soleSelected,
}: {
  el: SlideElement;
  blockId: string;
  slideId: string;
  themeId: string;
  editable: boolean;
  soleSelected: boolean;
}) {
  switch (el.type) {
    case "text":
      // A text box with a toggled list edits/renders through the list path;
      // plain text keeps the rich-text editor.
      if (el.list) {
        return (
          <ListElement el={el} blockId={blockId} slideId={slideId} themeId={themeId} editable={editable} soleSelected={soleSelected} />
        );
      }
      return (
        <TextLikeElement el={el} blockId={blockId} slideId={slideId} themeId={themeId} editable={editable} soleSelected={soleSelected} />
      );
    case "heading":
    case "callout":
      return (
        <TextLikeElement
          el={el}
          blockId={blockId}
          slideId={slideId}
          themeId={themeId}
          editable={editable}
          soleSelected={soleSelected}
        />
      );
    case "bullet_list":
      return (
        <ListElement
          el={el}
          blockId={blockId}
          slideId={slideId}
          themeId={themeId}
          editable={editable}
          soleSelected={soleSelected}
        />
      );
    case "code_block":
      return <CodeElement el={el} blockId={blockId} slideId={slideId} editable={editable} />;
    case "image":
      return (
        <ImageElementView el={el} blockId={blockId} slideId={slideId} editable={editable} />
      );
    case "shape":
      return <ShapeElementView el={el} themeId={themeId} />;
    case "divider":
      return <DividerElementView el={el} themeId={themeId} />;
    case "table":
      return <TableElementView el={el} themeId={themeId} />;
    case "sticker":
      return <StickerElement el={el} themeId={themeId} />;
  }
}

export function ElementView({
  el,
  blockId,
  slideId,
  lessonId,
  themeId,
  scale,
  interactive,
}: {
  el: SlideElement;
  blockId: string;
  slideId: string;
  lessonId: string;
  themeId: string;
  scale: number | null;
  interactive: boolean;
}) {
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);

  /** Current entered-group scope (only meaningful on this slide). */
  function currentScope(): string[] {
    const sel = useEditorStore.getState().selection;
    return (sel.kind === "element" || sel.kind === "elements") &&
      sel.slideId === slideId
      ? (sel.scope ?? [])
      : [];
  }

  function selectIds(ids: string[], scope: string[]) {
    if (ids.length === 0) {
      select({ kind: "slide", id: slideId, blockId, lessonId });
    } else if (ids.length === 1) {
      select({ kind: "element", id: ids[0], slideId, blockId, lessonId, scope });
    } else {
      select({ kind: "elements", ids, slideId, blockId, lessonId, scope });
    }
  }

  /** This element's unit (itself, or its whole group closure) at a scope. */
  function unitIds(scope: string[]): string[] {
    const hit = findSlide(useEditorStore.getState().doc, blockId, slideId);
    return hit ? unitClosureIds(hit.slide.elements, el, scope) : [el.id];
  }

  const drag = useElementDrag(el, blockId, slideId, scale, {
    // Click (no drag) on a multi-selection collapses to the clicked unit —
    // Google Slides' deferred collapse, decided on pointer-UP so a drag of
    // the whole selection never destroys it on pointer-down.
    onClickWithoutDrag: (e) => {
      if (e.shiftKey) return;
      const sel = useEditorStore.getState().selection;
      if (sel.kind !== "elements" || sel.slideId !== slideId || !sel.ids.includes(el.id))
        return;
      const scope = sel.scope ?? [];
      const unit = unitIds(scope);
      if (unit.length < sel.ids.length) selectIds(unit, scope);
    },
  });
  // Transient gesture frame (this element may be a multi-move participant).
  const transient = useDragStore((s) =>
    s.session && s.session.slideId === slideId ? s.session.frames[el.id] : undefined
  );

  const lineish =
    el.type === "shape" && (el.shape === "line" || el.shape === "arrow");
  const endpointDrag = useEndpointDrag(el as LineShape, blockId, slideId, scale);

  const inSingle =
    interactive && selection.kind === "element" && selection.id === el.id;
  const inMulti =
    interactive &&
    selection.kind === "elements" &&
    selection.slideId === slideId &&
    selection.ids.includes(el.id);
  const selected = inSingle || inMulti;
  const frame = transient ?? el;
  const hidden = el.visible === false;

  if (hidden && !interactive) return null;

  return (
    <div
      {...aiAttrs({
        component: "slide-element",
        type: manifestTypeForElement(el),
        id: el.id,
        parentId: slideId,
        order: el.zIndex,
        purpose: el.ai.purpose,
        label: `${el.type.replace("_", " ")} element: ${el.ai.purpose}`,
      })}
      data-ai-selected={selected || undefined}
      onPointerDown={(e) => {
        if (!interactive) return;
        e.stopPropagation();
        // Primary button only: a right-click must NOT start a move gesture —
        // its pointer-up would run the deferred collapse and shrink a
        // multi-selection to one element before the context menu acts on it.
        if (e.button !== 0) return;
        const scope = currentScope();
        if (e.shiftKey) {
          // Shift-click toggles this element's UNIT (whole group closure at
          // the current scope) in/out of the selection. No drag starts.
          const sel = useEditorStore.getState().selection;
          const current: Set<string> =
            sel.kind === "elements" && sel.slideId === slideId
              ? new Set(sel.ids)
              : sel.kind === "element" && sel.slideId === slideId
                ? new Set([sel.id])
                : new Set();
          const unit = unitIds(scope);
          const inSel = unit.every((id) => current.has(id));
          if (inSel) unit.forEach((id) => current.delete(id));
          else unit.forEach((id) => current.add(id));
          selectIds([...current], scope);
          return;
        }
        // Already part of the selection: keep it — the gesture moves the
        // whole selection; collapse happens on pointer-up if it's a click.
        if (!selected) {
          selectIds(unitIds(scope), scope);
        }
        drag.startMove(e);
      }}
      onDoubleClick={(e) => {
        if (!interactive) return;
        // Descend into this element's group one level (Google Slides "enter
        // group"). Text editing double-clicks stopPropagation before this
        // when the element is the sole selection.
        const scope = currentScope();
        const path = pathOf(el);
        if (path.length > scope.length) {
          e.stopPropagation();
          const newScope = path.slice(0, scope.length + 1);
          selectIds(unitIds(newScope), newScope);
        }
      }}
      onPointerMove={interactive ? drag.onPointerMove : undefined}
      onPointerUp={interactive ? drag.onPointerUp : undefined}
      onContextMenu={
        interactive
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              // Google Slides: right-click selects the element under the
              // cursor unless it's already part of the selection.
              if (!selected) {
                select({ kind: "element", id: el.id, slideId, blockId, lessonId });
              }
              // Derive the logical point from THIS element's rect — correct
              // at any zoom/scroll without touching stage internals.
              const rect = e.currentTarget.getBoundingClientRect();
              const sEff = rect.width / frame.width;
              useUIStore.getState().openContextMenu({
                x: e.clientX,
                y: e.clientY,
                blockId,
                slideId,
                lessonId,
                targetId: el.id,
                canvasPoint:
                  sEff > 0
                    ? {
                        x: frame.x + (e.clientX - rect.left) / sEff,
                        y: frame.y + (e.clientY - rect.top) / sEff,
                      }
                    : null,
              });
            }
          : undefined
      }
      className={cn(
        "absolute",
        interactive && !el.locked && "cursor-move",
        interactive && el.locked && "cursor-default",
        hidden && "opacity-30",
        transient && "will-change-transform"
      )}
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        zIndex: el.zIndex,
        ...(el.rotation ? { transform: `rotate(${el.rotation}deg)` } : {}),
      }}
    >
      {/* drop-shadow on a wrapper (not the outer frame) so the selection
          ring and resize handles never inherit the shadow */}
      {(() => {
        // endpoint drags reshape `points` live — feed the transient geometry
        // (frame too: the line renderer's viewBox tracks width/height)
        const bodyEl =
          transient?.points && el.type === "shape"
            ? ({
                ...el,
                x: transient.x,
                y: transient.y,
                width: transient.width,
                height: transient.height,
                points: transient.points,
              } as SlideElement)
            : el;
        const body = (
          <ElementBody
            el={bodyEl}
            blockId={blockId}
            slideId={slideId}
            themeId={themeId}
            editable={interactive && !el.locked}
            soleSelected={inSingle}
          />
        );
        return el.style.shadow ? (
          <div className="h-full w-full" style={{ filter: shadowFilterCss(el.style.shadow) }}>
            {body}
          </div>
        ) : (
          body
        );
      })()}

      {interactive && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute -inset-px rounded-sm transition-[box-shadow]",
            selected
              ? "shadow-[0_0_0_2px_#a78bfa]"
              : "hover:shadow-[0_0_0_1.5px_rgba(167,139,250,0.45)]"
          )}
        />
      )}

      {selected && el.locked && (
        <span className="absolute -right-2 -top-2 grid size-5 place-items-center rounded-full border border-stone-200 bg-white text-stone-400 shadow-sm">
          <Lock className="size-3" />
        </span>
      )}

      {/* 2-point lines get endpoint handles instead of the resize box. */}
      {inSingle && !el.locked && lineish && scale && (() => {
        const lineEl = {
          ...(el as LineShape),
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          ...(transient?.points ? { points: transient.points } : {}),
        } as LineShape;
        const { p1, p2 } = absoluteEndpoints(lineEl);
        const visual = Math.min(12 / scale, 24);
        const dot = (key: "start" | "end", p: { x: number; y: number }, onDown: (e: React.PointerEvent) => void) => (
          <span
            key={key}
            role="presentation"
            data-ai-tool={`line-endpoint-${key}`}
            onPointerDown={onDown}
            onPointerMove={endpointDrag.onPointerMove}
            onPointerUp={endpointDrag.onPointerUp}
            className="absolute z-10 block cursor-crosshair rounded-full border-2 border-brand-500 bg-white shadow-sm"
            style={{
              width: visual,
              height: visual,
              left: p.x - frame.x - visual / 2,
              top: p.y - frame.y - visual / 2,
            }}
          />
        );
        return (
          <>
            {dot("start", p1, endpointDrag.startP1)}
            {dot("end", p2, endpointDrag.startP2)}
          </>
        );
      })()}

      {/* Per-element resize handles only for a sole selection — multi-select
          gets a bounding-box transform instead. */}
      {inSingle && !el.locked && !lineish && (
        <>
          {HANDLES.map(({ handle, className }) => {
            // Handles live inside the scaled stage; size them in logical px
            // so they render at a constant ~10px on screen.
            const visual = scale ? Math.min(10 / scale, 22) : 10;
            return (
              <span
                key={handle}
                role="presentation"
                onPointerDown={drag.startResize(handle)}
                onPointerMove={drag.onPointerMove}
                onPointerUp={drag.onPointerUp}
                className={cn(
                  "absolute z-10 block rounded-full border border-brand-400 bg-white shadow-sm",
                  className
                )}
                style={{ width: visual, height: visual }}
              />
            );
          })}
        </>
      )}
    </div>
  );
}
