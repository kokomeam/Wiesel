"use client";

/**
 * Image element. With a src: the image plus optional caption. Without one
 * (an unfilled layout placeholder): a quiet upload prompt that opens the
 * shared image dialog targeting this element.
 */

import { ImagePlus } from "lucide-react";
import type { SlideElement } from "@/lib/course/types";
import { SlideImage } from "../SlideImage";
import { useSlideEditorBridge } from "../editorBridge";

type ImageEl = Extract<SlideElement, { type: "image" }>;

export function ImageElementView({
  el,
  blockId,
  slideId,
  editable,
}: {
  el: ImageEl;
  blockId: string;
  slideId: string;
  editable: boolean;
}) {
  // null outside the editor canvas (read-only SlideView) — no upload prompt.
  const bridge = useSlideEditorBridge();

  if (!el.src) {
    const placeholderLook =
      "flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-stone-300/80 bg-stone-50/60 text-stone-400";
    const radius = { borderRadius: el.style.borderRadius ?? 12 };

    // Preview/thumbnail (and locked) renders: purely presentational — a
    // <button> here would nest inside the filmstrip's thumbnail <button>
    // and break HTML/hydration.
    if (!editable || !bridge) {
      return (
        <div aria-hidden className={placeholderLook} style={radius}>
          <ImagePlus className="size-6" />
          <span className="text-sm font-medium">Add image</span>
        </div>
      );
    }

    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          bridge.openImageDialog({
            blockId,
            slideId,
            elementCount: 0,
            replaceElementId: el.id,
          });
        }}
        aria-label="Add an image to this placeholder"
        className={`${placeholderLook} transition-colors hover:border-brand-300 hover:text-brand-600`}
        style={radius}
      >
        <ImagePlus className="size-6" />
        <span className="text-sm font-medium">Add image</span>
      </button>
    );
  }

  return (
    <figure
      className="relative h-full w-full overflow-hidden"
      style={{
        borderRadius: el.style.borderRadius ?? 0,
        backgroundColor: el.style.backgroundColor,
        opacity: el.style.opacity,
        ...(el.style.borderWidth && {
          border: `${el.style.borderWidth}px solid ${el.style.borderColor ?? "#e5e5e5"}`,
        }),
      }}
    >
      {/* PERF-1 D3: SlideImage branches — blob/data/object-URL uploads and
          SVG placeholders stay a plain <img>; stored Supabase URLs (e.g. a
          materialized image_supporting slide) ride next/image. Hint = the
          element's fraction of the 1280 logical canvas. */}
      <SlideImage
        src={el.src}
        alt={el.alt}
        draggable={false}
        className="select-none"
        objectFit={el.objectFit}
        sizes={`(max-width: 1280px) ${Math.max(1, Math.round((el.width / 1280) * 100))}vw, ${Math.round(el.width)}px`}
      />
      {el.caption && (
        <figcaption
          className="absolute inset-x-0 bottom-0 px-3 py-1.5 text-center"
          style={{
            fontSize: 14,
            color: "#fafafa",
            backgroundColor: "rgba(23, 23, 23, 0.55)",
          }}
        >
          {el.caption}
        </figcaption>
      )}
    </figure>
  );
}
