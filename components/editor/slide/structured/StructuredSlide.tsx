"use client";

/**
 * Dispatches a renderer-owned structured slide to its layout component (via
 * the render registry), behind a themed corner-blob + dot-grid backdrop
 * (renderer-owned decoration — never a per-slide AI choice). Clicking the
 * background selects the slide; text slots edit in place. The freeform
 * element canvas is bypassed entirely here. Store-free: selection rides the
 * editor bridge, so the read-only SlideView path ships no editor stores.
 */

import { aiAttrs } from "@/lib/course/aiAttributes";
import { findTheme } from "@/lib/course/slide/themes";
import type { Slide } from "@/lib/course/types";
import { useSlideEditorBridge } from "../editorBridge";
import { type StructuredCtx } from "./common";
import { renderStructuredLayout } from "./layoutRegistry";
import { StructuredBackdrop } from "./StructuredBackdrop";

export function StructuredSlide({
  slide,
  blockId = "",
  lessonId = "",
  interactive,
}: {
  slide: Slide;
  /** Optional in read-only renders — only selection/editing paths use them. */
  blockId?: string;
  lessonId?: string;
  interactive: boolean;
}) {
  const bridge = useSlideEditorBridge();
  const theme = findTheme(slide.style.theme.id);
  const template = slide.template;
  if (!template) return null;

  const ctx: StructuredCtx = {
    blockId,
    slideId: slide.id,
    interactive,
    accent: theme.accentColor,
    ink: theme.colors.heading,
    body: theme.colors.body,
    muted: theme.colors.muted,
  };

  return (
    <div
      className="absolute inset-0"
      {...(interactive
        ? aiAttrs({
            component: "structured-slide",
            type: "slide",
            id: slide.id,
            parentId: blockId,
            order: slide.order,
            purpose: slide.ai.purpose,
            label: `Structured slide (${template.layoutId})`,
          })
        : { "aria-hidden": true as const })}
      onClick={
        interactive && bridge
          ? (e) => {
              e.stopPropagation();
              bridge.select({ kind: "slide", id: slide.id, blockId, lessonId });
            }
          : undefined
      }
    >
      <StructuredBackdrop accent={theme.accentColor} />
      {renderStructuredLayout(template, ctx)}
    </div>
  );
}
