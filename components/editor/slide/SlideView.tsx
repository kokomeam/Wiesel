"use client";

/**
 * SlideView — the READ-ONLY slide renderer (PERF-1 D1). Same visual output as
 * the editor stage's `mode="thumbnail"` branch (fixed 1280×720 logical canvas,
 * ResizeObserver scale gate, background layers, z-ordered elements /
 * structured template), but with everything passed as props and NO editor
 * machinery: no lib/course/store, patches, schemas, factories, zod registry,
 * dragStore, uiStore, or clipboard in its import graph. This is what the
 * learner runtime and the filmstrip thumbnails ship; SlideStage renders it
 * internally for its read-only branch — ONE rendering implementation, two
 * entry points. Keep this import graph clean: adding an editor-store import
 * here reintroduces the ~590 KB learner-route leak (diagnosis A6 #3).
 */

import { cn } from "@/lib/cn";
import { aiAttrs } from "@/lib/course/aiAttributes";
import { manifestTypeForElement } from "@/lib/course/manifest";
import { SLIDE_H, SLIDE_W } from "@/lib/course/slide/geometry";
import { resolveBackground, shadowFilterCss } from "@/lib/course/slide/styleResolver";
import type { Slide, SlideElement } from "@/lib/course/types";
import { CodeElement } from "./elements/CodeElement";
import { ImageElementView } from "./elements/ImageElementView";
import { ListDisplay } from "./elements/ListView";
import {
  DividerElementView,
  ShapeElementView,
  TableElementView,
} from "./elements/MiscElements";
import { StickerElement } from "./elements/StickerElement";
import { TextLikeDisplay } from "./elements/TextLikeView";
import { StructuredBackdrop } from "./structured/StructuredBackdrop";
import { StructuredSlide } from "./structured/StructuredSlide";
import { useStageScale } from "./useStageScale";

/** Background fill / image / overlay stack (shared with the editor stage). */
export function BackgroundLayers({ slide }: { slide: Slide }) {
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

/** Per-type display dispatch — the same renderers the editor shows at rest
 *  (the editor's ElementBody adds the editing wrappers on top of these). */
function StaticElementBody({ el, themeId }: { el: SlideElement; themeId: string }) {
  switch (el.type) {
    case "text":
      return el.list ? (
        <ListDisplay el={el} themeId={themeId} />
      ) : (
        <TextLikeDisplay el={el} themeId={themeId} />
      );
    case "heading":
    case "callout":
      return <TextLikeDisplay el={el} themeId={themeId} />;
    case "bullet_list":
      return <ListDisplay el={el} themeId={themeId} />;
    case "code_block":
      return <CodeElement el={el} blockId="" slideId="" editable={false} />;
    case "image":
      return <ImageElementView el={el} blockId="" slideId="" editable={false} />;
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

/** One positioned element, chrome-free: the absolute frame + shadow wrapper
 *  ElementView renders around its body, minus selection/drag affordances. */
function StaticElement({ el, slideId, themeId }: { el: SlideElement; slideId: string; themeId: string }) {
  if (el.visible === false) return null;
  const body = <StaticElementBody el={el} themeId={themeId} />;
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
      className="absolute"
      style={{
        left: el.x,
        top: el.y,
        width: el.width,
        height: el.height,
        zIndex: el.zIndex,
        ...(el.rotation ? { transform: `rotate(${el.rotation}deg)` } : {}),
      }}
    >
      {/* drop-shadow on a wrapper so future chrome never inherits it (parity
          with ElementView) */}
      {el.style.shadow ? (
        <div className="h-full w-full" style={{ filter: shadowFilterCss(el.style.shadow) }}>
          {body}
        </div>
      ) : (
        body
      )}
    </div>
  );
}

export function SlideView({ slide, className }: { slide: Slide; className?: string }) {
  const { containerRef, scale } = useStageScale();
  const sortedElements = [...slide.elements].sort((a, b) => a.zIndex - b.zIndex);

  return (
    <div
      ref={containerRef}
      aria-hidden
      className={cn(
        "relative aspect-video w-full overflow-hidden",
        "pointer-events-none rounded-lg",
        className
      )}
    >
      {scale !== null && (
        <div
          data-stage-body
          className="relative origin-top-left"
          style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})` }}
          >
            <BackgroundLayers slide={slide} />
            {slide.template ? (
              <StructuredSlide slide={slide} interactive={false} />
            ) : (
              <>
                {/* Ambient themed backdrop kept after eject (glows bleed off
                    the canvas — a non-interactive layer, not an element). */}
                {slide.backdrop === "structured" && (
                  <StructuredBackdrop accent={slide.style.theme.accentColor} />
                )}
                {sortedElements.map((el) => (
                  <StaticElement
                    key={el.id}
                    el={el}
                    slideId={slide.id}
                    themeId={slide.style.theme.id}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
