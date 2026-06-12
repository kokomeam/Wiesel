"use client";

/**
 * Slide theme picker: the five built-in themes as mini previews. Row click
 * themes the current slide; the layers icon applies it to the whole deck.
 */

import { Layers } from "lucide-react";
import { cn } from "@/lib/cn";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { applyThemePatch } from "@/lib/course/commands";
import { FONT_FAMILIES, SLIDE_THEMES } from "@/lib/course/slide/themes";
import { resolveBackground } from "@/lib/course/slide/styleResolver";
import { useEditorStore } from "@/lib/course/store";
import type { Slide } from "@/lib/course/types";

export function ThemePicker({
  slide,
  blockId,
  onApplied,
  className,
}: {
  slide: Slide;
  blockId: string;
  onApplied?: () => void;
  className?: string;
}) {
  const apply = useEditorStore((s) => s.apply);

  return (
    <div className={cn("max-w-full", className ?? "w-64")}>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
        Theme
      </p>
      <div className="space-y-1.5">
        {SLIDE_THEMES.map((theme) => {
          const active = slide.style.theme.id === theme.id;
          return (
            <div key={theme.id} className="flex items-center gap-1.5">
              <button
                type="button"
                {...toolAttrs({
                  tool: `apply-theme-${theme.id}`,
                  action: "APPLY_SLIDE_THEME",
                  targetType: "slide",
                  label: `Apply theme ${theme.name} to this slide`,
                })}
                onClick={() => {
                  apply(applyThemePatch(blockId, theme.id, slide.id), "human");
                  onApplied?.();
                }}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1.5 ring-1 transition-shadow",
                  active ? "ring-2 ring-brand-400" : "ring-stone-200 hover:ring-brand-200"
                )}
              >
                <span
                  className="relative grid h-9 w-14 shrink-0 place-items-center overflow-hidden rounded-md ring-1 ring-black/5"
                  style={resolveBackground(theme.defaultBackground)}
                >
                  <span
                    className="text-[11px] font-semibold"
                    style={{
                      color: theme.colors.heading,
                      fontFamily: FONT_FAMILIES[theme.fontFamily].css,
                    }}
                  >
                    Aa
                  </span>
                  <span
                    className="absolute bottom-1 right-1 size-1.5 rounded-full"
                    style={{ backgroundColor: theme.accentColor }}
                  />
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-xs font-medium text-stone-800">
                    {theme.name}
                  </span>
                  <span className="block text-[10px] capitalize text-stone-400">
                    {FONT_FAMILIES[theme.fontFamily].label} · {theme.defaultBackground.type}
                  </span>
                </span>
              </button>
              <button
                type="button"
                title={`Apply ${theme.name} to all slides`}
                {...toolAttrs({
                  tool: `apply-theme-${theme.id}-deck`,
                  action: "APPLY_SLIDE_THEME",
                  targetType: "slide_deck",
                  label: `Apply theme ${theme.name} to every slide in the deck`,
                })}
                onClick={() => {
                  apply(applyThemePatch(blockId, theme.id), "human");
                  onApplied?.();
                }}
                className="grid size-7 shrink-0 place-items-center rounded-lg text-stone-300 transition-colors hover:bg-stone-100 hover:text-brand-600"
              >
                <Layers className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-stone-400">
        Themes set defaults — your explicit text styles stay put. Use the layers
        button to retheme the whole deck.
      </p>
    </div>
  );
}
