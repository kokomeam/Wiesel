"use client";

/**
 * Image element. With a src: the image plus optional caption. Without one
 * (an unfilled layout placeholder): a quiet upload prompt that opens the
 * shared image dialog targeting this element.
 */

import { ImagePlus } from "lucide-react";
import { useUIStore } from "@/lib/editor/uiStore";
import type { SlideElement } from "@/lib/course/types";

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
  const openImageDialog = useUIStore((s) => s.openImageDialog);

  if (!el.src) {
    const placeholderLook =
      "flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-stone-300/80 bg-stone-50/60 text-stone-400";
    const radius = { borderRadius: el.style.borderRadius ?? 12 };

    // Preview/thumbnail (and locked) renders: purely presentational — a
    // <button> here would nest inside the filmstrip's thumbnail <button>
    // and break HTML/hydration.
    if (!editable) {
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
          openImageDialog({
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
      {/* eslint-disable-next-line @next/next/no-img-element -- dynamic user/object URLs */}
      <img
        src={el.src}
        alt={el.alt}
        draggable={false}
        className="h-full w-full select-none"
        style={{ objectFit: el.objectFit }}
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
