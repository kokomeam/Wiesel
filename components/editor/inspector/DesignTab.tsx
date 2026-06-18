"use client";

/**
 * Inspector · Design tab. Slide selected → layout/theme/background pickers.
 * Element selected → typography, colors, frame, stacking. Lecture → tone.
 * Everything else gets a quiet empty state.
 */

import { useState } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Eye,
  EyeOff,
  Italic,
  Lock,
  LockOpen,
  Underline,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  moveElementPatch,
  reorderElementPatch,
  styleElementPatch,
  updateElementPatch,
  updateStylePatch,
} from "@/lib/course/commands";
import { findTheme, FONT_FAMILIES, FONT_SCALE_OPTIONS } from "@/lib/course/slide/themes";
import { SHADOW_PRESETS, shadowPresetName } from "@/lib/course/slide/styleResolver";
import { useEditorStore } from "@/lib/course/store";
import type {
  FontFamilyId,
  FontScaleToken,
  FontWeight,
  LectureTextBlock,
  Selection,
  Slide,
  SlideElement,
} from "@/lib/course/types";
import { BackgroundPanel } from "../slide/BackgroundPanel";
import { ColorSwatchPicker } from "../slide/ColorSwatchPicker";
import {
  growAwareResizePatch,
  growAwareStylePatches,
  isTextLike,
} from "../slide/elements/measureTextLike";
import { LayoutPicker } from "../slide/LayoutPicker";
import { ThemePicker } from "../slide/ThemePicker";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-stone-300">
        {label}
      </p>
      {children}
    </div>
  );
}

export function PillGroup<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly T[];
  value: T | undefined;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          role="radio"
          aria-checked={value === opt}
          onClick={() => onChange(opt)}
          className={cn(
            "rounded-lg px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
            value === opt
              ? "bg-brand-50 text-brand-700 ring-1 ring-brand-200"
              : "bg-stone-50 text-stone-500 hover:bg-stone-100"
          )}
        >
          {opt.replace("_", " ")}
        </button>
      ))}
    </div>
  );
}

function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] font-medium uppercase text-stone-300">
        {label}
      </span>
      <input
        type="number"
        value={draft ?? Math.round(value)}
        min={min}
        max={max}
        aria-label={label}
        onFocus={() => setDraft(String(Math.round(value)))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) {
            const n = Number(draft);
            if (Number.isFinite(n) && n !== value) onCommit(n);
          }
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-full rounded-lg border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
      />
    </label>
  );
}

export function EmptyTabState({ message }: { message: string }) {
  return <p className="py-2 text-xs leading-relaxed text-stone-400">{message}</p>;
}

function ElementDesign({
  el,
  blockId,
  slideId,
  themeId,
}: {
  el: SlideElement;
  blockId: string;
  slideId: string;
  themeId: string;
}) {
  const apply = useEditorStore((s) => s.apply);
  const applyMany = useEditorStore((s) => s.applyMany);
  const theme = findTheme(themeId);
  const [opacityDraft, setOpacityDraft] = useState<number | null>(null);

  const textish = isTextLike(el);

  function style(s: Parameters<typeof styleElementPatch>[3]) {
    if (isTextLike(el)) {
      // Reflow: style changes that make the content taller grow the box.
      applyMany(growAwareStylePatches(blockId, slideId, el, themeId, s), "human");
      return;
    }
    apply(styleElementPatch(blockId, slideId, el.id, s), "human");
  }

  /** Frame commits keep text boxes at least content-tall (grow-only). */
  function resize(frame: { x: number; y: number; width: number; height: number }) {
    apply(growAwareResizePatch(blockId, slideId, el, themeId, frame), "human");
  }

  return (
    <>
      {textish && (
        <>
          <Field label="Font">
            <div className="flex gap-1.5">
              <select
                value={el.style.fontFamily ?? theme.fontFamily}
                aria-label="Font family"
                onChange={(e) => style({ fontFamily: e.target.value as FontFamilyId })}
                className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-brand-300"
              >
                {Object.entries(FONT_FAMILIES).map(([id, f]) => (
                  <option key={id} value={id}>
                    {f.label}
                  </option>
                ))}
              </select>
              <select
                value={el.style.fontScale ?? (el.type === "heading" ? "title" : "body")}
                aria-label="Text size"
                onChange={(e) => style({ fontScale: e.target.value as FontScaleToken })}
                className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2 py-1 text-xs text-stone-700 outline-none focus:border-brand-300"
              >
                {FONT_SCALE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </Field>
          <Field label="Weight">
            <PillGroup
              options={["regular", "medium", "semibold", "bold"] as const}
              value={el.style.fontWeight ?? (el.type === "heading" ? "semibold" : "regular")}
              label="Font weight"
              onChange={(fontWeight: FontWeight) => style({ fontWeight })}
            />
          </Field>
          <Field label="Style & alignment">
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  [Bold, "Bold", el.style.fontWeight === "bold", () =>
                    style({ fontWeight: el.style.fontWeight === "bold" ? "regular" : "bold" })],
                  [Italic, "Italic", el.style.italic === true, () => style({ italic: !el.style.italic })],
                  [Underline, "Underline", el.style.underline === true, () =>
                    style({ underline: !el.style.underline })],
                ] as const
              ).map(([Icon, label, active, onClick]) => (
                <button
                  key={label}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={active}
                  onClick={onClick}
                  className={cn(
                    "grid size-7 place-items-center rounded-lg transition-colors",
                    active
                      ? "bg-brand-50 text-brand-700"
                      : "text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                  )}
                >
                  <Icon className="size-3.5" />
                </button>
              ))}
              <span className="mx-1 h-4 w-px bg-stone-200" aria-hidden />
              {(
                [
                  ["left", AlignLeft],
                  ["center", AlignCenter],
                  ["right", AlignRight],
                  ["justify", AlignJustify],
                ] as const
              ).map(([align, Icon]) => (
                <button
                  key={align}
                  type="button"
                  title={`Align text ${align}`}
                  aria-label={`Align text ${align}`}
                  aria-pressed={(el.style.textAlign ?? "left") === align}
                  onClick={() => style({ textAlign: align })}
                  className={cn(
                    "grid size-7 place-items-center rounded-lg transition-colors",
                    (el.style.textAlign ?? "left") === align
                      ? "bg-brand-50 text-brand-700"
                      : "text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                  )}
                >
                  <Icon className="size-3.5" />
                </button>
              ))}
            </div>
          </Field>
          <Field label="Vertical alignment">
            <PillGroup
              options={["top", "middle", "bottom"] as const}
              value={el.style.verticalAlign ?? "top"}
              label="Vertical text alignment"
              onChange={(verticalAlign) => style({ verticalAlign })}
            />
          </Field>
          <Field label="Text color">
            <ColorSwatchPicker
              label="Text color"
              value={el.style.color}
              palette={theme.palette}
              allowClear
              onChange={(color) => style({ color })}
            />
          </Field>
        </>
      )}

      <Field label="Fill">
        <ColorSwatchPicker
          label="Fill color"
          value={el.style.backgroundColor}
          palette={[theme.colors.surface, "#ffffff", ...theme.palette.slice(2, 8)]}
          allowClear
          onChange={(backgroundColor) => style({ backgroundColor })}
        />
      </Field>

      <Field label="Stroke">
        <ColorSwatchPicker
          label="Stroke color"
          value={el.style.borderColor}
          palette={theme.palette}
          allowClear
          onChange={(borderColor) => style({ borderColor })}
        />
        <div className="mt-2 flex items-end gap-2">
          <NumberField
            label="Width"
            value={el.style.borderWidth ?? 0}
            min={0}
            max={24}
            onCommit={(borderWidth) => style({ borderWidth })}
          />
          <div className="min-w-0 flex-[2]">
            <p className="mb-0.5 text-[10px] font-medium uppercase text-stone-300">Style</p>
            <PillGroup
              options={["solid", "dashed", "dotted"] as const}
              value={el.style.borderStyle ?? "solid"}
              label="Stroke style"
              onChange={(borderStyle) => style({ borderStyle })}
            />
          </div>
        </div>
      </Field>

      <Field label="Shadow">
        <PillGroup
          options={["none", "subtle", "medium", "strong"] as const}
          value={(shadowPresetName(el.style.shadow) ?? undefined) as
            | "none"
            | "subtle"
            | "medium"
            | "strong"
            | undefined}
          label="Shadow preset"
          onChange={(preset) => style({ shadow: SHADOW_PRESETS[preset] })}
        />
        {shadowPresetName(el.style.shadow) === null && (
          <p className="mt-1 text-[10px] text-stone-400">
            Custom shadow values set by AI — picking a preset replaces them.
          </p>
        )}
      </Field>

      <Field label="Corners & opacity">
        <div className="flex items-end gap-2">
          <NumberField
            label="Radius"
            value={el.style.borderRadius ?? 0}
            min={0}
            max={120}
            onCommit={(borderRadius) => style({ borderRadius })}
          />
          <div className="min-w-0 flex-1">
            <p className="mb-0.5 flex justify-between text-[10px] font-medium uppercase text-stone-300">
              Opacity
              <span>{Math.round((opacityDraft ?? el.style.opacity ?? 1) * 100)}%</span>
            </p>
            <input
              type="range"
              min={10}
              max={100}
              aria-label="Opacity"
              value={Math.round((opacityDraft ?? el.style.opacity ?? 1) * 100)}
              onChange={(e) => setOpacityDraft(Number(e.target.value) / 100)}
              onPointerUp={() => {
                if (opacityDraft !== null) {
                  style({ opacity: opacityDraft });
                  setOpacityDraft(null);
                }
              }}
              className="w-full accent-brand-600"
            />
          </div>
        </div>
      </Field>

      <Field label="Position & size">
        <div className="grid grid-cols-4 gap-1.5">
          <NumberField
            label="X"
            value={el.x}
            onCommit={(x) => apply(moveElementPatch(blockId, slideId, el.id, x, el.y), "human")}
          />
          <NumberField
            label="Y"
            value={el.y}
            onCommit={(y) => apply(moveElementPatch(blockId, slideId, el.id, el.x, y), "human")}
          />
          <NumberField
            label="W"
            value={el.width}
            onCommit={(width) =>
              resize({ x: el.x, y: el.y, width, height: el.height })
            }
          />
          <NumberField
            label="H"
            value={el.height}
            onCommit={(height) =>
              resize({ x: el.x, y: el.y, width: el.width, height })
            }
          />
        </div>
      </Field>

      <Field label="Stacking">
        <div className="flex flex-wrap items-center gap-1">
          {(
            [
              ["forward", ChevronUp, "Bring forward"],
              ["backward", ChevronDown, "Send backward"],
              ["front", ChevronsUp, "Bring to front"],
              ["back", ChevronsDown, "Send to back"],
            ] as const
          ).map(([direction, Icon, label]) => (
            <button
              key={direction}
              type="button"
              title={label}
              aria-label={label}
              onClick={() =>
                apply(reorderElementPatch(blockId, slideId, el.id, direction), "human")
              }
              className="grid size-7 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
            >
              <Icon className="size-3.5" />
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-stone-200" aria-hidden />
          <button
            type="button"
            title={el.locked ? "Unlock" : "Lock"}
            aria-label={el.locked ? "Unlock element" : "Lock element"}
            aria-pressed={el.locked === true}
            onClick={() =>
              apply(
                updateElementPatch(blockId, slideId, el.id, { locked: !el.locked }),
                "human"
              )
            }
            className={cn(
              "grid size-7 place-items-center rounded-lg transition-colors",
              el.locked
                ? "bg-brand-50 text-brand-700"
                : "text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            )}
          >
            {el.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
          </button>
          <button
            type="button"
            title={el.visible === false ? "Show" : "Hide"}
            aria-label={el.visible === false ? "Show element" : "Hide element"}
            aria-pressed={el.visible === false}
            onClick={() =>
              apply(
                updateElementPatch(blockId, slideId, el.id, {
                  visible: el.visible === false ? true : false,
                }),
                "human"
              )
            }
            className="grid size-7 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
          >
            {el.visible === false ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        </div>
      </Field>
    </>
  );
}

export function DesignTab({
  selection,
  node,
}: {
  selection: Selection;
  node: unknown;
}) {
  const apply = useEditorStore((s) => s.apply);

  if (selection.kind === "slide") {
    const slide = node as Slide;
    return (
      <div className="space-y-5">
        <LayoutPicker slide={slide} blockId={selection.blockId} className="w-full" />
        <div className="border-t border-stone-100 pt-4">
          <ThemePicker slide={slide} blockId={selection.blockId} className="w-full" />
        </div>
        <div className="border-t border-stone-100 pt-4">
          <BackgroundPanel slide={slide} blockId={selection.blockId} className="w-full" />
        </div>
      </div>
    );
  }

  if (selection.kind === "element") {
    const el = node as SlideElement;
    const doc = useEditorStore.getState().doc;
    const themeId =
      doc.modules
        .flatMap((m) => m.lessons)
        .flatMap((l) => l.blocks)
        .filter((b) => b.id === selection.blockId)
        .flatMap((b) => (b.type === "slide_deck" ? b.slides : []))
        .find((s) => s.id === selection.slideId)?.style.theme.id ?? "editorial-warm";
    return (
      <ElementDesign
        el={el}
        blockId={selection.blockId}
        slideId={selection.slideId}
        themeId={themeId}
      />
    );
  }

  if (selection.kind === "block") {
    const block = node as { type?: string };
    if (block.type === "lecture_text") {
      const lecture = node as LectureTextBlock;
      return (
        <Field label="Tone">
          <PillGroup
            options={["beginner", "concise", "detailed", "socratic"] as const}
            value={lecture.tone}
            label="Lecture tone"
            onChange={(tone) =>
              apply(updateStylePatch({ kind: "block", blockId: lecture.id }, { tone }), "human")
            }
          />
        </Field>
      );
    }
  }

  return (
    <EmptyTabState message="Nothing to design here — select a slide or an element on a slide." />
  );
}
