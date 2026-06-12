"use client";

/**
 * Slide background controls: solid swatches, gradient presets, image upload
 * with overlay color/opacity, and reset-to-theme.
 */

import { useState } from "react";
import { ImagePlus, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { updateBackgroundPatch } from "@/lib/course/commands";
import { findTheme, GRADIENT_PRESETS } from "@/lib/course/slide/themes";
import { useEditorStore } from "@/lib/course/store";
import { useUIStore } from "@/lib/editor/uiStore";
import type { Slide } from "@/lib/course/types";
import { ColorSwatchPicker } from "./ColorSwatchPicker";

export function BackgroundPanel({
  slide,
  blockId,
  className,
}: {
  slide: Slide;
  blockId: string;
  className?: string;
}) {
  const apply = useEditorStore((s) => s.apply);
  const openImageDialog = useUIStore((s) => s.openImageDialog);
  const theme = findTheme(slide.style.theme.id);
  const bg = slide.style.background;
  const [overlayDraft, setOverlayDraft] = useState<number | null>(null);

  function commit(background: Slide["style"]["background"]) {
    apply(updateBackgroundPatch(blockId, slide.id, background), "human");
  }

  return (
    <div className={cn("max-w-full", className ?? "w-72")}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          Background
        </p>
        <button
          type="button"
          {...toolAttrs({
            tool: "reset-background",
            action: "UPDATE_SLIDE_BACKGROUND",
            targetType: "slide",
            label: "Reset background to the theme default",
          })}
          onClick={() => commit(structuredClone(theme.defaultBackground))}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
        >
          <RotateCcw className="size-3" />
          Reset
        </button>
      </div>

      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-stone-300">
        Solid
      </p>
      <ColorSwatchPicker
        label="Solid background color"
        value={bg.type === "solid" ? bg.color : undefined}
        palette={["#ffffff", "#fafafa", theme.colors.surface, "#18181b", ...theme.palette.slice(3, 7)]}
        onChange={(color) => color && commit({ type: "solid", color })}
      />

      <p className="mb-1.5 mt-3 text-[10px] font-medium uppercase tracking-wide text-stone-300">
        Gradient
      </p>
      <div className="grid grid-cols-6 gap-1.5">
        {GRADIENT_PRESETS.map((preset) => {
          const active =
            bg.type === "gradient" &&
            bg.gradient.from === preset.from &&
            bg.gradient.to === preset.to;
          return (
            <button
              key={preset.name}
              type="button"
              title={preset.name}
              aria-label={`Gradient: ${preset.name}`}
              onClick={() =>
                commit({
                  type: "gradient",
                  gradient: {
                    from: preset.from,
                    to: preset.to,
                    direction: preset.direction,
                  },
                })
              }
              className={cn(
                "aspect-square rounded-md border border-stone-200/70",
                active && "ring-2 ring-brand-400 ring-offset-1"
              )}
              style={{
                backgroundImage: `linear-gradient(135deg, ${preset.from}, ${preset.to})`,
              }}
            />
          );
        })}
      </div>

      <p className="mb-1.5 mt-3 text-[10px] font-medium uppercase tracking-wide text-stone-300">
        Image
      </p>
      <button
        type="button"
        {...toolAttrs({
          tool: "background-image-upload",
          action: "UPDATE_SLIDE_BACKGROUND",
          targetType: "slide",
          label: "Upload a background image",
        })}
        onClick={() =>
          openImageDialog({
            blockId,
            slideId: slide.id,
            elementCount: slide.elements.length,
            forBackground: true,
          })
        }
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 py-2 text-xs font-medium text-stone-500 transition-colors hover:border-brand-300 hover:text-brand-600"
      >
        <ImagePlus className="size-3.5" />
        {bg.type === "image" ? "Replace background image" : "Upload background image"}
      </button>

      {bg.type === "image" && (
        <div className="mt-3 space-y-2.5 rounded-xl bg-stone-50 p-3">
          <div>
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-stone-400">
              Overlay color
            </p>
            <ColorSwatchPicker
              label="Overlay color"
              value={bg.overlayColor}
              palette={["#171717", "#2e1065", "#ffffff", theme.accentColor]}
              onChange={(overlayColor) =>
                commit({ ...bg, overlayColor: overlayColor ?? undefined })
              }
              allowClear
            />
          </div>
          <div>
            <p className="mb-1 flex justify-between text-[10px] font-medium uppercase tracking-wide text-stone-400">
              Overlay opacity
              <span>{Math.round((overlayDraft ?? bg.overlayOpacity ?? 0) * 100)}%</span>
            </p>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((overlayDraft ?? bg.overlayOpacity ?? 0) * 100)}
              aria-label="Overlay opacity"
              onChange={(e) => setOverlayDraft(Number(e.target.value) / 100)}
              onPointerUp={() => {
                if (overlayDraft !== null) {
                  commit({ ...bg, overlayOpacity: overlayDraft });
                  setOverlayDraft(null);
                }
              }}
              className="w-full accent-brand-600"
            />
          </div>
        </div>
      )}
    </div>
  );
}
