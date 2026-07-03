"use client";

/**
 * The slide canvas: a fixed 1280×720 logical stage CSS-scaled to its
 * container. Renders background layers, z-ordered elements, then transient
 * chrome (snap guides). Thumbnails reuse it with mode="thumbnail".
 *
 * Stage keyboard (edit mode, element(s) selected, no input focused):
 *   arrows nudge 1px (Shift = 10, never snaps) · Delete removes ·
 *   Cmd/Ctrl+D duplicates · Cmd/Ctrl+C/X/V element clipboard ·
 *   Cmd/Ctrl+G groups, +Shift ungroups ·
 *   Escape steps the selection up (members → enclosing group → slide).
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { aiAttrs } from "@/lib/course/aiAttributes";
import {
  deleteElementPatch,
  duplicateElementsPatch,
  groupElementsPatch,
  moveElementPatch,
  ungroupElementsPatch,
} from "@/lib/course/commands";
import { copyElementsToClipboards, pasteIntoSlide } from "@/lib/editor/clipboard";
import { SLIDE_H, SLIDE_W } from "@/lib/course/slide/geometry";
import { resolveBackground } from "@/lib/course/slide/styleResolver";
import { findSlide } from "@/lib/course/queries";
import { expandToClosures, groupIdsAt, inScope, unitKeysAt } from "@/lib/course/slide/groups";
import { useEditorStore } from "@/lib/course/store";
import { useDragStore } from "@/lib/editor/dragStore";
import { useUIStore } from "@/lib/editor/uiStore";
import type { Slide, SlideElement } from "@/lib/course/types";
import { ElementView } from "./ElementView";
import { MultiSelectionBox } from "./MultiSelectionBox";
import { StructuredBackdrop } from "./structured/StructuredBackdrop";
import { StructuredSlide } from "./structured/StructuredSlide";
import { useStageScale } from "./useStageScale";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

function BackgroundLayers({ slide }: { slide: Slide }) {
  const bg = slide.style.background;
  return (
    <>
      <div className="absolute inset-0" style={resolveBackground(bg)} />
      {bg.type === "image" && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- dynamic user/object URLs */}
          <img
            src={bg.imageSrc}
            alt=""
            aria-hidden
            draggable={false}
            className="absolute inset-0 h-full w-full select-none object-cover"
          />
          {bg.overlayColor && (bg.overlayOpacity ?? 0) > 0 && (
            <div
              className="absolute inset-0"
              style={{ backgroundColor: bg.overlayColor, opacity: bg.overlayOpacity }}
            />
          )}
        </>
      )}
    </>
  );
}

/** Snap guide lines for the live gesture (rose, 1 screen px), plus px-gap
 *  measurement chips on equal-spacing guides. */
function GuideOverlay({ slideId, scale }: { slideId: string; scale: number }) {
  const guides = useDragStore((s) =>
    s.session && s.session.slideId === slideId ? s.session.guides : null
  );
  if (!guides || guides.length === 0) return null;
  const px = 1 / scale;
  return (
    <>
      {guides.map((g, i) => (
        <div key={i} aria-hidden className="contents">
          <div
            className="pointer-events-none absolute z-[999] bg-rose-500"
            style={
              g.axis === "v"
                ? { left: g.pos, top: g.from, width: px, height: g.to - g.from }
                : { top: g.pos, left: g.from, height: px, width: g.to - g.from }
            }
          />
          {g.label && (
            <div
              data-snap-chip
              className="pointer-events-none absolute z-[999] rounded bg-rose-500 font-mono font-medium text-white"
              style={{
                left: g.axis === "h" ? (g.from + g.to) / 2 : g.pos,
                top: g.axis === "h" ? g.pos : (g.from + g.to) / 2,
                transform: "translate(-50%, -130%)",
                fontSize: 11 / scale,
                lineHeight: 1.4,
                padding: `0 ${4 / scale}px`,
              }}
            >
              {g.label}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** Rubber-band selection rectangle (logical coords, inside the scaled stage). */
function MarqueeOverlay() {
  const rect = useDragStore((s) => s.marquee);
  if (!rect) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-[998] border border-brand-500 bg-brand-500/10"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    />
  );
}

export function SlideStage({
  slide,
  blockId,
  lessonId,
  mode,
  className,
}: {
  slide: Slide;
  blockId: string;
  lessonId: string;
  mode: "edit" | "thumbnail";
  className?: string;
}) {
  const select = useEditorStore((s) => s.select);
  const { containerRef, scale: fitScale } = useStageScale();
  const interactive = mode === "edit";
  /** Renderer-owned structured slides bypass the freeform element canvas
   *  (no marquee / element drag / stage keyboard). */
  const isTemplate = !!slide.template;
  const elementsInteractive = interactive && !isTemplate;
  const zoom = useUIStore((s) => (interactive ? s.zoom : 1));
  /** Effective scale = fit-to-container × user zoom. All logical↔screen
   *  math downstream uses this one number. */
  const scale = fitScale === null ? null : fitScale * zoom;
  /** The scroll body / scaled stage origin — coordinate math must use ITS
   *  rect (the container is just the scroll viewport once zoomed). */
  const innerRef = useRef<HTMLDivElement>(null);

  // Keep the viewport center stable across zoom changes.
  const prevZoom = useRef(zoom);
  useLayoutEffect(() => {
    const c = containerRef.current;
    if (!c || prevZoom.current === zoom) return;
    const ratio = zoom / prevZoom.current;
    c.scrollLeft = (c.scrollLeft + c.clientWidth / 2) * ratio - c.clientWidth / 2;
    c.scrollTop = (c.scrollTop + c.clientHeight / 2) * ratio - c.clientHeight / 2;
    prevZoom.current = zoom;
  }, [zoom, containerRef]);

  /** Marquee gesture (starts only on empty stage — elements stopPropagation). */
  const marqueeGesture = useRef<{
    startX: number;
    startY: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);

  function toLogical(e: React.PointerEvent) {
    const g = marqueeGesture.current;
    if (!g || !scale) return { x: 0, y: 0 };
    return { x: (e.clientX - g.left) / scale, y: (e.clientY - g.top) / scale };
  }

  function marqueeDown(e: React.PointerEvent) {
    if (!interactive || !scale) return;
    if (e.button !== 0) return; // right-click opens the menu, never a marquee
    // the inner (scaled) stage, not the container — once zoomed, the
    // container is just the scroll viewport
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect) return;
    marqueeGesture.current = {
      startX: (e.clientX - rect.left) / scale,
      startY: (e.clientY - rect.top) / scale,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function marqueeMove(e: React.PointerEvent) {
    const g = marqueeGesture.current;
    if (!g || !scale) return;
    const { x, y } = toLogical(e);
    if (!g.moved && Math.abs(x - g.startX) < 3 && Math.abs(y - g.startY) < 3) return;
    g.moved = true;
    useDragStore.getState().setMarquee({
      x: Math.min(g.startX, x),
      y: Math.min(g.startY, y),
      width: Math.abs(x - g.startX),
      height: Math.abs(y - g.startY),
    });
  }

  function marqueeUp() {
    const g = marqueeGesture.current;
    marqueeGesture.current = null;
    const rect = useDragStore.getState().marquee;
    useDragStore.getState().setMarquee(null);
    if (!g) return;
    if (!g.moved || !rect) {
      // plain click on empty stage: select the slide (previous behavior)
      select({ kind: "slide", id: slide.id, blockId, lessonId });
      return;
    }
    // Intersection hits (Google-Slides style), expanded to whole units AT
    // THE ENTERED-GROUP SCOPE — marquee inside a group stays inside it.
    // Hidden and locked elements are not marquee-selectable.
    const sel = useEditorStore.getState().selection;
    const scope =
      (sel.kind === "element" || sel.kind === "elements") && sel.slideId === slide.id
        ? (sel.scope ?? [])
        : [];
    const hitIds = slide.elements
      .filter(
        (el) =>
          el.visible !== false &&
          !el.locked &&
          inScope(el, scope) &&
          el.x < rect.x + rect.width &&
          el.x + el.width > rect.x &&
          el.y < rect.y + rect.height &&
          el.y + el.height > rect.y
      )
      .map((el) => el.id);
    const ids = expandToClosures(slide.elements, hitIds, scope);
    if (ids.length === 0) {
      select({ kind: "slide", id: slide.id, blockId, lessonId });
    } else if (ids.length === 1) {
      select({ kind: "element", id: ids[0], slideId: slide.id, blockId, lessonId, scope });
    } else {
      select({ kind: "elements", ids, slideId: slide.id, blockId, lessonId, scope });
    }
  }

  /* Stage keyboard — bound while this slide OR its elements are selected
     (the slide case exists for ⌘A select-all). */
  const keyboardActive = useEditorStore((s) => {
    const sel = s.selection;
    return (
      elementsInteractive &&
      ((sel.kind === "element" || sel.kind === "elements")
        ? sel.blockId === blockId && sel.slideId === slide.id
        : sel.kind === "slide" && sel.id === slide.id && sel.blockId === blockId)
    );
  });
  useEffect(() => {
    if (!keyboardActive) return;

    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const state = useEditorStore.getState();
      const sel = state.selection;

      // ⌘A — select every selectable element at the current scope (whole
      // slide, or the entered group's members). Locked/hidden excluded,
      // matching marquee semantics.
      if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const scopeA =
          (sel.kind === "element" || sel.kind === "elements") && sel.slideId === slide.id
            ? (sel.scope ?? [])
            : [];
        // read elements from the store — the effect closure's `slide` prop
        // can be stale (deps don't include the doc)
        const slideHit = findSlide(state.doc, blockId, slide.id);
        if (!slideHit) return;
        const all = slideHit.slide.elements
          .filter((el) => el.visible !== false && !el.locked && inScope(el, scopeA))
          .map((el) => el.id);
        if (all.length === 1) {
          state.select({ kind: "element", id: all[0], slideId: slide.id, blockId, lessonId, scope: scopeA });
        } else if (all.length > 1) {
          state.select({ kind: "elements", ids: all, slideId: slide.id, blockId, lessonId, scope: scopeA });
        }
        return;
      }

      // ⌘V — works with the slide selected too (cross-slide paste flow).
      // Async: falls back to the OS clipboard (cross-tab / reload / plain
      // text). The slide-paste shortcut in useEditorShortcuts never collides
      // — copying keeps exactly one of the two clipboards populated.
      if ((e.key === "v" || e.key === "V") && (e.metaKey || e.ctrlKey)) {
        if (useUIStore.getState().slideClipboard) return; // slide paste owns ⌘V
        e.preventDefault();
        void pasteIntoSlide(blockId, slide.id, lessonId);
        return;
      }

      if (sel.kind !== "element" && sel.kind !== "elements") return;
      const hit = findSlide(state.doc, sel.blockId, sel.slideId);
      if (!hit) return;
      const ids = sel.kind === "element" ? [sel.id] : sel.ids;
      const members = hit.slide.elements.filter((el) => ids.includes(el.id));
      if (members.length === 0) return;
      const movable = members.filter((el) => !el.locked);
      const mod = e.metaKey || e.ctrlKey;

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown": {
          if (movable.length === 0) return;
          e.preventDefault();
          const nudge = e.shiftKey ? 10 : 1;
          let dx = e.key === "ArrowLeft" ? -nudge : e.key === "ArrowRight" ? nudge : 0;
          let dy = e.key === "ArrowUp" ? -nudge : e.key === "ArrowDown" ? nudge : 0;
          // Clamp by the group bbox so arrangements never shear at edges.
          const minX = Math.min(...movable.map((m) => m.x));
          const minY = Math.min(...movable.map((m) => m.y));
          const maxX = Math.max(...movable.map((m) => m.x + m.width));
          const maxY = Math.max(...movable.map((m) => m.y + m.height));
          dx = Math.max(-minX, Math.min(dx, SLIDE_W - maxX));
          dy = Math.max(-minY, Math.min(dy, SLIDE_H - maxY));
          if (dx === 0 && dy === 0) return;
          state.applyMany(
            movable.map((m) =>
              moveElementPatch(sel.blockId, sel.slideId, m.id, m.x + dx, m.y + dy)
            ),
            "human"
          );
          break;
        }
        case "Backspace":
        case "Delete": {
          const deletable = movable;
          if (deletable.length === 0) return;
          e.preventDefault();
          state.applyMany(
            deletable.map((m) => deleteElementPatch(sel.blockId, sel.slideId, m.id)),
            "human"
          );
          break;
        }
        case "d":
        case "D":
          if (mod) {
            e.preventDefault();
            // One patch = one undo; group structure survives via remapped ids.
            const patch = duplicateElementsPatch(sel.blockId, sel.slideId, members);
            const result = state.apply(patch, "human");
            if (result.ok && patch.action === "DUPLICATE_ELEMENTS") {
              const newIds = patch.newElementIds;
              state.select(
                newIds.length === 1
                  ? { kind: "element", id: newIds[0], slideId: sel.slideId, blockId: sel.blockId, lessonId }
                  : { kind: "elements", ids: newIds, slideId: sel.slideId, blockId: sel.blockId, lessonId }
              );
            }
          }
          break;
        case "g":
        case "G":
          if (mod) {
            e.preventDefault();
            const scope = sel.scope ?? [];
            if (e.shiftKey) {
              const groupIds = groupIdsAt(members, scope);
              if (groupIds.length === 0) return;
              state.applyMany(
                groupIds.map((gid) =>
                  ungroupElementsPatch(sel.blockId, sel.slideId, gid)
                ),
                "human"
              );
            } else {
              if (unitKeysAt(members, scope).size < 2) return;
              state.apply(
                groupElementsPatch(
                  sel.blockId,
                  sel.slideId,
                  members.map((m) => m.id),
                  scope.length
                ),
                "human"
              );
            }
          }
          break;
        case "c":
        case "C":
          if (mod) {
            e.preventDefault();
            copyElementsToClipboards(members, sel.slideId);
          }
          break;
        case "x":
        case "X":
          if (mod && movable.length > 0) {
            e.preventDefault();
            copyElementsToClipboards(movable, sel.slideId);
            state.applyMany(
              movable.map((m) => deleteElementPatch(sel.blockId, sel.slideId, m.id)),
              "human"
            );
          }
          break;
        case "Escape": {
          // Walk UP the group ladder: entered scope → enclosing group
          // selection → … → slide.
          const scope = sel.scope ?? [];
          if (scope.length > 0) {
            const parentScope = scope.slice(0, -1);
            const closure = hit.slide.elements
              .filter((el) => scope.every((seg, i) => (el.groupPath ?? [])[i] === seg))
              .map((el) => el.id);
            if (closure.length >= 2) {
              state.select({
                kind: "elements",
                ids: closure,
                slideId: sel.slideId,
                blockId: sel.blockId,
                lessonId,
                scope: parentScope,
              });
              break;
            }
          }
          state.select({
            kind: "slide",
            id: sel.slideId,
            blockId: sel.blockId,
            lessonId,
          });
          break;
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keyboardActive, lessonId, blockId, slide.id]);

  const sortedElements = [...slide.elements].sort(
    (a: SlideElement, b: SlideElement) => a.zIndex - b.zIndex
  );

  return (
    <div
      ref={containerRef}
      {...(interactive
        ? aiAttrs({
            component: "slide-canvas",
            type: "slide",
            id: slide.id,
            parentId: blockId,
            order: slide.order,
            purpose: slide.ai.purpose,
            label: `Slide canvas: ${slide.title ?? `slide ${slide.order + 1}`}`,
          })
        : { "aria-hidden": true as const })}
      onPointerDown={elementsInteractive ? marqueeDown : undefined}
      onPointerMove={elementsInteractive ? marqueeMove : undefined}
      onPointerUp={elementsInteractive ? marqueeUp : undefined}
      // Keep canvas clicks from bubbling to BlockFrame, which would replace
      // the slide/element selection with the whole-block selection.
      onClick={interactive ? (e) => e.stopPropagation() : undefined}
      onContextMenu={
        elementsInteractive
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              const rect = innerRef.current?.getBoundingClientRect();
              if (!rect) return;
              const s = rect.width / SLIDE_W;
              useUIStore.getState().openContextMenu({
                x: e.clientX,
                y: e.clientY,
                blockId,
                slideId: slide.id,
                lessonId,
                targetId: null,
                canvasPoint: {
                  x: (e.clientX - rect.left) / s,
                  y: (e.clientY - rect.top) / s,
                },
              });
            }
          : undefined
      }
      className={cn(
        "relative aspect-video w-full",
        interactive && zoom > 1 ? "overflow-auto scrollbar-thin" : "overflow-hidden",
        interactive
          ? "rounded-xl shadow-[0_2px_16px_rgba(16,24,40,0.08)] ring-1 ring-stone-200/80"
          : "pointer-events-none rounded-lg",
        className
      )}
    >
      {scale !== null && (
        <div
          ref={innerRef}
          data-stage-body
          className="relative origin-top-left"
          style={{
            width: SLIDE_W * scale,
            height: SLIDE_H * scale,
          }}
        >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: SLIDE_W,
            height: SLIDE_H,
            transform: `scale(${scale})`,
          }}
        >
          <BackgroundLayers slide={slide} />
          {isTemplate ? (
            <StructuredSlide
              slide={slide}
              blockId={blockId}
              lessonId={lessonId}
              interactive={interactive}
            />
          ) : (
            <>
              {/* Ambient themed backdrop kept after eject (glows bleed off the
                  canvas, so it's a non-interactive layer, not an element). */}
              {slide.backdrop === "structured" && (
                <StructuredBackdrop accent={slide.style.theme.accentColor} />
              )}
              {sortedElements.map((el) => (
                <ElementView
                  key={el.id}
                  el={el}
                  blockId={blockId}
                  slideId={slide.id}
                  lessonId={lessonId}
                  themeId={slide.style.theme.id}
                  scale={scale}
                  interactive={interactive}
                />
              ))}
              {interactive && (
                <MultiSelectionBox slide={slide} blockId={blockId} scale={scale} />
              )}
              {interactive && <GuideOverlay slideId={slide.id} scale={scale} />}
              {interactive && <MarqueeOverlay />}
            </>
          )}
        </div>
        </div>
      )}
    </div>
  );
}
