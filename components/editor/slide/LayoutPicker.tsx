"use client";

/**
 * Visual layout picker: SVG mini-thumbnails of each layout's placeholders,
 * built-ins plus the user's saved layouts. Preserve-mode carries matched
 * content into the new layout's slots and drops stale leftovers (a single
 * undoable patch), so it applies instantly; "replace content" asks for an
 * inline confirmation first. "Save current slide as layout" captures the
 * slide's element frames as a reusable custom layout (stored locally).
 */

import { useState } from "react";
import { Save, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { toolAttrs } from "@/lib/course/aiAttributes";
import { applyLayoutPatch } from "@/lib/course/commands";
import {
  inferPlaceholdersFromSlide,
  SLIDE_LAYOUTS,
  type SlideLayoutDef,
} from "@/lib/course/slide/layouts";
import { useEditorStore } from "@/lib/course/store";
import { useUIStore } from "@/lib/editor/uiStore";
import type { Slide } from "@/lib/course/types";

export function LayoutThumbnail({ layout }: { layout: SlideLayoutDef }) {
  return (
    <svg viewBox="0 0 1280 720" className="w-full rounded-md bg-white" aria-hidden>
      <rect width="1280" height="720" fill="#fafafa" />
      {layout.placeholders.map((p, i) => (
        <rect
          key={i}
          x={p.x}
          y={p.y}
          width={p.width}
          height={p.height}
          rx={14}
          fill={
            p.type === "image"
              ? "#ede9fe"
              : p.type === "heading"
                ? "#d4d4d8"
                : p.type === "code_block"
                  ? "#3f3f46"
                  : p.type === "callout"
                    ? "#fef3c7"
                    : "#e5e5e7"
          }
        />
      ))}
    </svg>
  );
}

export function LayoutPicker({
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
  const customLayouts = useUIStore((s) => s.customLayouts);
  const saveCustomLayout = useUIStore((s) => s.saveCustomLayout);
  const deleteCustomLayout = useUIStore((s) => s.deleteCustomLayout);
  const [replaceMode, setReplaceMode] = useState(false);
  const [pending, setPending] = useState<SlideLayoutDef | null>(null);

  function applyLayout(layout: SlideLayoutDef, preserve: boolean) {
    apply(
      applyLayoutPatch(
        blockId,
        slide.id,
        layout.id,
        preserve,
        layout.placeholders.length,
        layout.id.startsWith("custom-") ? layout.placeholders : undefined
      ),
      "human"
    );
    setPending(null);
    onApplied?.();
  }

  function pick(layout: SlideLayoutDef) {
    if (replaceMode && slide.elements.length > 0) {
      setPending(layout);
    } else {
      applyLayout(layout, !replaceMode);
    }
  }

  function renderGrid(layouts: SlideLayoutDef[]) {
    return (
      <div className="grid grid-cols-3 gap-2">
        {layouts.map((layout) => (
          <div key={layout.id} className="group/layout relative">
            <button
              type="button"
              {...toolAttrs({
                tool: `apply-layout-${layout.id}`,
                action: "APPLY_SLIDE_LAYOUT",
                targetType: "slide",
                label: `Apply layout: ${layout.name}`,
              })}
              title={layout.description}
              onClick={() => pick(layout)}
              className={cn(
                "w-full rounded-lg p-1 ring-1 transition-shadow",
                slide.layout === layout.id
                  ? "ring-2 ring-brand-400"
                  : "ring-stone-200 hover:ring-brand-200"
              )}
            >
              <LayoutThumbnail layout={layout} />
              <span className="mt-1 block truncate text-center text-[10px] font-medium text-stone-500">
                {layout.name}
              </span>
            </button>
            {layout.id.startsWith("custom-") && (
              <button
                type="button"
                aria-label={`Delete saved layout ${layout.name}`}
                onClick={() => deleteCustomLayout(layout.id)}
                className="absolute right-1 top-1 hidden size-5 place-items-center rounded-md bg-white/90 text-stone-400 shadow-sm hover:text-rose-600 group-hover/layout:grid"
              >
                <Trash2 className="size-3" />
              </button>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("max-w-full", className ?? "w-[26rem]")}>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
        Layouts
      </p>
      {renderGrid(SLIDE_LAYOUTS)}

      {customLayouts.length > 0 && (
        <>
          <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
            Your layouts
          </p>
          {renderGrid(customLayouts)}
        </>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-stone-100 pt-3">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-stone-500">
          <input
            type="checkbox"
            checked={replaceMode}
            onChange={(e) => setReplaceMode(e.target.checked)}
            className="size-3.5 accent-brand-600"
          />
          Replace existing content
        </label>
        <button
          type="button"
          {...toolAttrs({
            tool: "save-custom-layout",
            action: "SAVE_CUSTOM_LAYOUT",
            targetType: "slide",
            label: "Save current slide as a reusable layout",
          })}
          onClick={() => {
            const count = useUIStore.getState().customLayouts.length + 1;
            saveCustomLayout({
              id: `custom-${slide.id}-${count}`,
              name: `My layout ${count}`,
              description: "Saved from a designed slide.",
              placeholders: inferPlaceholdersFromSlide(slide),
              ai: {
                bestFor: ["custom"],
                avoidWhen: [],
                qualityRules: [],
              },
            });
          }}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
        >
          <Save className="size-3.5" />
          Save as layout
        </button>
      </div>

      {pending && (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="min-w-0 flex-1">
            Replace {slide.elements.length} element
            {slide.elements.length === 1 ? "" : "s"} with &lsquo;{pending.name}&rsquo;?
          </span>
          <button
            type="button"
            onClick={() => applyLayout(pending, false)}
            className="rounded-md bg-amber-600 px-2 py-1 font-medium text-white hover:bg-amber-700"
          >
            Replace
          </button>
          <button
            type="button"
            onClick={() => setPending(null)}
            className="rounded-md px-2 py-1 font-medium hover:bg-amber-100"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
