"use client";

/**
 * The slide toolbar: Insert · Text style · Layout/Style · Arrange · AI.
 * Sticky within the workspace scroll only. Text and Arrange groups are
 * contextual — they light up when a (text-ish) element is selected. Every
 * control carries toolAttrs so AI agents can discover the editor's verbs
 * from the DOM.
 */

import { useCallback, useState, type ReactNode } from "react";
import {
  AlignCenter,
  AlignHorizontalJustifyCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowUpDown,
  Baseline,
  Bold,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Code2,
  Copy,
  Group,
  Heading1,
  ImagePlus,
  Italic,
  LayoutTemplate,
  Lightbulb,
  List,
  ListOrdered,
  Lock,
  LockOpen,
  PaintBucket,
  Palette,
  PencilRuler,
  Shapes,
  Smile,
  Sparkles,
  Trash2,
  Type,
  Underline,
  Ungroup,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { toolAttrs } from "@/lib/course/aiAttributes";
import {
  addElementPatch,
  addShapePatch,
  addStickerPatch,
  deleteElementPatch,
  duplicateElementPatch,
  groupElementsPatch,
  moveElementPatch,
  reorderElementPatch,
  setElementListPatch,
  setSlideContentPatch,
  styleElementPatch,
  ungroupElementsPatch,
  updateElementPatch,
} from "@/lib/course/commands";
import {
  effectiveMarkerKind,
  listFromElement,
  setListMarker,
  shiftAllLevels,
  textToList,
} from "@/lib/course/slide/list";
import { canMaterializeSlide, materializeSlide } from "@/lib/course/slide/materialize";
import { alignedX, alignedY } from "@/lib/course/slide/geometry";
import {
  alignToSelectionMoves,
  arrangeUnits,
  distributeMoves,
  type ElementMove,
} from "@/lib/course/slide/arrange";
import { groupIdsAt, unitKeysAt } from "@/lib/course/slide/groups";
import { STICKER_REGISTRY } from "@/lib/course/slide/stickers";
import { findTheme, FONT_FAMILIES, FONT_SCALE_OPTIONS } from "@/lib/course/slide/themes";
import { StickerGlyph } from "./elements/StickerElement";
import {
  growAwareStylePatches,
  isTextLike,
} from "./elements/measureTextLike";
import { getActiveRichEditor } from "./elements/richText";
import { useEditorStore } from "@/lib/course/store";
import { useUIStore } from "@/lib/editor/uiStore";
import type {
  FontFamilyId,
  FontScaleToken,
  Slide,
  SlideDeckBlock,
  SlideElement,
  SlideElementType,
} from "@/lib/course/types";
import { useEscapeToClose } from "../QualityHintBadge";
import { useAICommand } from "../useAICommand";
import { BackgroundPanel } from "./BackgroundPanel";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import { LayoutPicker } from "./LayoutPicker";
import { ThemePicker } from "./ThemePicker";

type PopoverKey =
  | "layout"
  | "background"
  | "theme"
  | "textColor"
  | "hAlign"
  | "vAlign"
  | "arrange"
  | "shapes"
  | "stickers"
  | "eject"
  | "list"
  | null;

function ToolButton({
  icon: Icon,
  label,
  tool,
  action,
  targetType,
  onClick,
  active,
  disabled,
  danger,
  text,
}: {
  icon: typeof Type;
  label: string;
  tool: string;
  action: string;
  targetType?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  text?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      {...toolAttrs({ tool, action, targetType, label })}
      // Editor-toolbar convention: never steal focus from the canvas or an
      // open text-edit session (rich-text commands need the live selection).
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-30",
        active
          ? "bg-brand-50 text-brand-700"
          : danger
            ? "text-stone-500 hover:bg-rose-50 hover:text-rose-600"
            : "text-stone-500 hover:bg-stone-100 hover:text-stone-800"
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {text && <span>{text}</span>}
    </button>
  );
}

function ShapeGlyph({ kind }: { kind: string }) {
  const stroke = "#78716c";
  switch (kind) {
    case "rectangle":
      return <svg viewBox="0 0 28 20" className="h-5 w-7"><rect x="2" y="2" width="24" height="16" fill="none" stroke={stroke} strokeWidth="1.8" /></svg>;
    case "rounded_rectangle":
      return <svg viewBox="0 0 28 20" className="h-5 w-7"><rect x="2" y="2" width="24" height="16" rx="6" fill="none" stroke={stroke} strokeWidth="1.8" /></svg>;
    case "ellipse":
      return <svg viewBox="0 0 28 20" className="h-5 w-7"><ellipse cx="14" cy="10" rx="12" ry="8" fill="none" stroke={stroke} strokeWidth="1.8" /></svg>;
    case "triangle":
      return <svg viewBox="0 0 28 20" className="h-5 w-7"><polygon points="14,2 26,18 2,18" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" /></svg>;
    case "line":
      return <svg viewBox="0 0 28 20" className="h-5 w-7"><line x1="3" y1="16" x2="25" y2="4" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" /></svg>;
    default:
      return <svg viewBox="0 0 28 20" className="h-5 w-7"><line x1="3" y1="10" x2="21" y2="10" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" /><polygon points="20,5 26,10 20,15" fill={stroke} /></svg>;
  }
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-stone-200" />;
}

const insertTools: { type: SlideElementType; icon: typeof Type; label: string }[] = [
  { type: "text", icon: Type, label: "Insert text" },
  { type: "heading", icon: Heading1, label: "Insert heading" },
  { type: "bullet_list", icon: List, label: "Insert bullet list" },
  { type: "code_block", icon: Code2, label: "Insert code block" },
  { type: "callout", icon: Lightbulb, label: "Insert callout" },
];

function isTextish(
  el: SlideElement | undefined
): el is Extract<SlideElement, { type: "text" | "heading" | "callout" | "bullet_list" }> {
  return (
    !!el &&
    (el.type === "text" ||
      el.type === "heading" ||
      el.type === "callout" ||
      el.type === "bullet_list")
  );
}

export function SlideToolbar({
  block,
  slide,
  lessonId,
}: {
  block: SlideDeckBlock;
  slide: Slide;
  lessonId: string;
}) {
  const apply = useEditorStore((s) => s.apply);
  const applyMany = useEditorStore((s) => s.applyMany);
  const select = useEditorStore((s) => s.select);
  const selection = useEditorStore((s) => s.selection);
  const openImageDialog = useUIStore((s) => s.openImageDialog);
  const zoom = useUIStore((s) => s.zoom);
  const zoomIn = useUIStore((s) => s.zoomIn);
  const zoomOut = useUIStore((s) => s.zoomOut);
  const setZoom = useUIStore((s) => s.setZoom);
  const { run, thinking } = useAICommand();
  const [popover, setPopover] = useState<PopoverKey>(null);
  useEscapeToClose(
    popover !== null,
    useCallback(() => setPopover(null), [])
  );

  const selectedEl =
    selection.kind === "element" &&
    selection.blockId === block.id &&
    selection.slideId === slide.id
      ? slide.elements.find((el) => el.id === selection.id)
      : undefined;

  /** Every selected element on this slide (single or multi) + entered scope. */
  const selectedEls =
    (selection.kind === "element" || selection.kind === "elements") &&
    selection.blockId === block.id &&
    selection.slideId === slide.id
      ? slide.elements.filter((el) =>
          selection.kind === "element"
            ? el.id === selection.id
            : selection.ids.includes(el.id)
        )
      : [];
  const scope =
    selection.kind === "element" || selection.kind === "elements"
      ? (selection.scope ?? [])
      : [];
  const canGroup = unitKeysAt(selectedEls, scope).size >= 2;
  const selectedGroupIds = groupIdsAt(selectedEls, scope);
  const units = arrangeUnits(selectedEls, scope);

  function applyMoves(moves: ElementMove[]) {
    if (moves.length === 0) return;
    applyMany(
      moves.map((m) => moveElementPatch(block.id, slide.id, m.id, m.x, m.y)),
      "human"
    );
    setPopover(null);
  }

  const textish = isTextish(selectedEl);
  const listEl =
    selectedEl?.type === "bullet_list" || (selectedEl?.type === "text" && selectedEl.list)
      ? selectedEl
      : undefined;
  const listContent = listEl ? listFromElement(listEl) : null;
  const allMarker = (kind: "disc" | "number") =>
    !!listContent && listContent.items.length > 0 && listContent.items.every((it) => effectiveMarkerKind(listContent, it) === kind);

  /** Quick toolbar toggle (also ⌘⇧8 / ⌘⇧7 in the editor): make the whole text/
   *  list element a bullet / numbered list, or turn it off if already that kind. */
  function toggleListMarker(kind: "disc" | "number") {
    if (!selectedEl) return;
    if (selectedEl.type === "text" && !selectedEl.list) {
      const all = new Set(selectedEl.text.split("\n").map((_, i) => i));
      apply(setElementListPatch(block.id, slide.id, selectedEl, textToList(selectedEl.text, selectedEl.runs, all, kind)), "human");
      return;
    }
    if (listEl) {
      const content = listFromElement(listEl);
      apply(setElementListPatch(block.id, slide.id, listEl, setListMarker(content, allMarker(kind) ? "none" : kind)), "human");
    }
  }

  const theme = findTheme(slide.style.theme.id);
  const slideSelection = {
    kind: "slide",
    id: slide.id,
    blockId: block.id,
    lessonId,
  } as const;

  // Structured (renderer-owned) slide → offer "Edit freely": materialize the
  // layout into editable elements through the validated SET_SLIDE_CONTENT patch.
  const isTemplate = !!slide.template;
  const canEject = canMaterializeSlide(slide);

  function editFreely() {
    const elements = materializeSlide(slide);
    if (!elements) return;
    // Keep the ambient structured backdrop (glow/dots) behind the elements.
    apply(setSlideContentPatch(block.id, slide.id, slide.template?.layoutId ?? slide.layout, elements, "structured"), "human");
    // Land on the now-freeform slide so the canvas + element tools are live.
    select({ kind: "slide", id: slide.id, blockId: block.id, lessonId });
    setPopover(null);
    useUIStore.getState().showFlash("Slide is now freely editable");
  }

  function styleSelected(style: Parameters<typeof styleElementPatch>[3]) {
    if (!selectedEl) return;
    if (isTextLike(selectedEl)) {
      // Reflow: bigger type may need a taller box — style + grow, one undo.
      applyMany(
        growAwareStylePatches(
          block.id,
          slide.id,
          selectedEl,
          slide.style.theme.id,
          style
        ),
        "human"
      );
      return;
    }
    apply(styleElementPatch(block.id, slide.id, selectedEl.id, style), "human");
  }

  function elementOp(patch: unknown) {
    apply(patch, "human");
  }

  function togglePopover(key: Exclude<PopoverKey, null>) {
    setPopover((cur) => (cur === key ? null : key));
  }

  // Semantic size token: the element's explicit token, else a sensible default
  // for its type (legacy raw-px elements show their nearest token until re-set).
  const effectiveScale: FontScaleToken | "" =
    textish && selectedEl
      ? (selectedEl.style.fontScale ?? (selectedEl.type === "heading" ? "title" : "body"))
      : "";
  const effectiveFamily =
    textish && selectedEl
      ? (selectedEl.style.fontFamily ?? theme.fontFamily)
      : theme.fontFamily;

  let popoverContent: ReactNode = null;
  if (popover === "list" && listEl) {
    const content = listFromElement(listEl);
    const markers: { kind: Parameters<typeof setListMarker>[1]; glyph: string; label: string }[] = [
      { kind: "disc", glyph: "•", label: "Bullet" },
      { kind: "circle", glyph: "○", label: "Circle" },
      { kind: "dash", glyph: "—", label: "Dash" },
      { kind: "square", glyph: "▪", label: "Square" },
      { kind: "number", glyph: "1.", label: "Numbered" },
      { kind: "none", glyph: "·", label: "None" },
    ];
    popoverContent = (
      <div className="w-60">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">List style</p>
        <div className="grid grid-cols-3 gap-1.5">
          {markers.map((m) => (
            <button
              key={m.kind}
              type="button"
              {...toolAttrs({ tool: `list-marker-${m.kind}`, action: "UPDATE_SLIDE_ELEMENT", targetType: "slide_element", label: `${m.label} list` })}
              onClick={() => {
                apply(setElementListPatch(block.id, slide.id, listEl, setListMarker(content, m.kind)), "human");
                setPopover(null);
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors",
                content.defaultMarkerKind === m.kind ? "bg-brand-50 text-brand-700" : "bg-stone-50 text-stone-600 hover:bg-stone-100"
              )}
            >
              <span className="w-4 text-center font-mono">{m.glyph}</span>
              {m.label}
            </button>
          ))}
        </div>
        <p className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-wide text-stone-400">Indent (whole list)</p>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            {...toolAttrs({ tool: "list-outdent", action: "UPDATE_SLIDE_ELEMENT", targetType: "slide_element", label: "Outdent the list" })}
            onClick={() => apply(setElementListPatch(block.id, slide.id, listEl, shiftAllLevels(content, -1)), "human")}
            className="rounded-lg bg-stone-50 px-2 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100"
          >
            ⇤ Outdent
          </button>
          <button
            type="button"
            {...toolAttrs({ tool: "list-indent", action: "UPDATE_SLIDE_ELEMENT", targetType: "slide_element", label: "Indent the list" })}
            onClick={() => apply(setElementListPatch(block.id, slide.id, listEl, shiftAllLevels(content, 1)), "human")}
            className="rounded-lg bg-stone-50 px-2 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100"
          >
            Indent ⇥
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-stone-400">
          Tip: while editing, Tab / Shift+Tab indents a single line and Enter adds a bullet.
        </p>
      </div>
    );
  } else if (popover === "eject") {
    popoverContent = (
      <div className="w-72">
        <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-stone-800">
          <PencilRuler className="size-4 text-brand-600" />
          Edit freely
        </p>
        <p className="mb-3 text-xs leading-relaxed text-stone-500">
          This unlocks moving and resizing every object on the slide. Future AI
          layout regeneration may no longer preserve the original template
          exactly.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setPopover(null)}
            className="rounded-full px-3 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100"
          >
            Cancel
          </button>
          <button
            type="button"
            data-ai-tool="edit-freely-confirm"
            data-ai-action="SET_SLIDE_CONTENT"
            onClick={editFreely}
            className="rounded-full bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700"
          >
            Edit freely
          </button>
        </div>
      </div>
    );
  } else if (popover === "layout") {
    popoverContent = (
      <LayoutPicker slide={slide} blockId={block.id} onApplied={() => setPopover(null)} />
    );
  } else if (popover === "background") {
    popoverContent = <BackgroundPanel slide={slide} blockId={block.id} />;
  } else if (popover === "theme") {
    popoverContent = (
      <ThemePicker slide={slide} blockId={block.id} onApplied={() => setPopover(null)} />
    );
  } else if (popover === "shapes") {
    const entries = [
      ["rectangle", "Rectangle"],
      ["rounded_rectangle", "Rounded rectangle"],
      ["ellipse", "Ellipse"],
      ["triangle", "Triangle"],
      ["line", "Line"],
      ["arrow", "Arrow"],
    ] as const;
    popoverContent = (
      <div className="w-64">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          Insert shape
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          {entries.map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              title={label}
              {...toolAttrs({
                tool: `insert-shape-${kind}`,
                action: "ADD_SLIDE_ELEMENT",
                targetType: "slide",
                label: `Insert ${label.toLowerCase()}`,
              })}
              onClick={() => {
                elementOp(
                  addShapePatch(block.id, slide.id, kind, slide.elements.length)
                );
                setPopover(null);
              }}
              className="flex flex-col items-center gap-1.5 rounded-lg bg-stone-50 px-2 py-2.5 transition-colors hover:bg-brand-50"
            >
              <ShapeGlyph kind={kind} />
              <span className="text-[10px] font-medium text-stone-600">{label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  } else if (popover === "stickers") {
    popoverContent = (
      <div className="w-72">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          Insert sticker
        </p>
        <div className="grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto">
          {STICKER_REGISTRY.map((s) => (
            <button
              key={s.id}
              type="button"
              title={s.label}
              {...toolAttrs({
                tool: `insert-sticker-${s.id}`,
                action: "ADD_SLIDE_ELEMENT",
                targetType: "slide",
                label: `Insert ${s.label} sticker`,
              })}
              onClick={() => {
                elementOp(addStickerPatch(block.id, slide.id, s.id, slide.elements.length));
                setPopover(null);
              }}
              className="flex flex-col items-center gap-1 rounded-lg bg-stone-50 px-1.5 py-2 transition-colors hover:bg-brand-50"
            >
              <span className="block size-7">
                <StickerGlyph id={s.id} accent={theme.accentColor} circleColor={null} iconRatio={1} />
              </span>
              <span className="w-full truncate text-center text-[9px] font-medium text-stone-600">
                {s.label}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  } else if (popover === "hAlign" && selectedEl) {
    const current = selectedEl.style.textAlign ?? "left";
    popoverContent = (
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          Text alignment
        </p>
        <div className="flex gap-1">
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
              {...toolAttrs({
                tool: `text-align-${align}`,
                action: "UPDATE_SLIDE_ELEMENT",
                targetType: "slide_element",
                label: `Align text ${align} within the box`,
              })}
              onClick={() => {
                styleSelected({ textAlign: align });
                setPopover(null);
              }}
              className={cn(
                "grid size-8 place-items-center rounded-lg transition-colors",
                current === align
                  ? "bg-brand-50 text-brand-700"
                  : "text-stone-500 hover:bg-stone-100 hover:text-stone-800"
              )}
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
      </div>
    );
  } else if (popover === "vAlign" && selectedEl) {
    const current = selectedEl.style.verticalAlign ?? "top";
    popoverContent = (
      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          Vertical alignment
        </p>
        <div className="flex gap-1">
          {(["top", "middle", "bottom"] as const).map((v) => (
            <button
              key={v}
              type="button"
              {...toolAttrs({
                tool: `text-valign-${v}`,
                action: "UPDATE_SLIDE_ELEMENT",
                targetType: "slide_element",
                label: `Align text to the ${v} of the box`,
              })}
              onClick={() => {
                styleSelected({ verticalAlign: v });
                setPopover(null);
              }}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                current === v
                  ? "bg-brand-50 text-brand-700"
                  : "text-stone-500 hover:bg-stone-100 hover:text-stone-800"
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
    );
  } else if (popover === "arrange" && selectedEls.length > 0) {
    popoverContent = (
      <div className="w-56">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          Group
        </p>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            disabled={!canGroup}
            {...toolAttrs({
              tool: "group-elements",
              action: "GROUP_ELEMENTS",
              targetType: "slide_element",
              label: "Group the selected elements",
            })}
            onClick={() => {
              apply(
                groupElementsPatch(
                  block.id,
                  slide.id,
                  selectedEls.map((el) => el.id),
                  scope.length
                ),
                "human"
              );
              setPopover(null);
            }}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-stone-50 px-2 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100 disabled:pointer-events-none disabled:opacity-35"
          >
            <Group className="size-3.5" />
            Group
          </button>
          <button
            type="button"
            disabled={selectedGroupIds.length === 0}
            {...toolAttrs({
              tool: "ungroup-elements",
              action: "UNGROUP_ELEMENTS",
              targetType: "slide_element",
              label: "Ungroup the selected group",
            })}
            onClick={() => {
              applyMany(
                selectedGroupIds.map((gid) =>
                  ungroupElementsPatch(block.id, slide.id, gid)
                ),
                "human"
              );
              setPopover(null);
            }}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-stone-50 px-2 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100 disabled:pointer-events-none disabled:opacity-35"
          >
            <Ungroup className="size-3.5" />
            Ungroup
          </button>
        </div>
        {units.length >= 2 && (
          <>
            <p className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
              Align to selection
            </p>
            <div className="grid grid-cols-3 gap-1">
              {(
                [
                  ["h", "left"],
                  ["h", "center"],
                  ["h", "right"],
                  ["v", "top"],
                  ["v", "middle"],
                  ["v", "bottom"],
                ] as const
              ).map(([axis, align]) => (
                <button
                  key={`${axis}-${align}`}
                  type="button"
                  {...toolAttrs({
                    tool: `selection-align-${align}`,
                    action: "MOVE_SLIDE_ELEMENT",
                    targetType: "slide_element",
                    label: `Align selected objects to the selection's ${align}`,
                  })}
                  onClick={() => applyMoves(alignToSelectionMoves(units, axis, align))}
                  className="rounded-lg bg-stone-50 px-2 py-1.5 text-xs font-medium capitalize text-stone-600 transition-colors hover:bg-stone-100"
                >
                  {align}
                </button>
              ))}
            </div>
            <p className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
              Distribute
            </p>
            <div className="grid grid-cols-2 gap-1">
              {(
                [
                  ["h", "Horizontally"],
                  ["v", "Vertically"],
                ] as const
              ).map(([axis, label]) => (
                <button
                  key={axis}
                  type="button"
                  disabled={units.length < 3}
                  {...toolAttrs({
                    tool: `distribute-${axis}`,
                    action: "MOVE_SLIDE_ELEMENT",
                    targetType: "slide_element",
                    label: `Distribute selected objects ${label.toLowerCase()} with equal gaps`,
                  })}
                  onClick={() => applyMoves(distributeMoves(units, axis))}
                  className="rounded-lg bg-stone-50 px-2 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100 disabled:pointer-events-none disabled:opacity-35"
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
        {selectedEl && (
          <>
        <p className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          Position on slide
        </p>
        <div className="grid grid-cols-3 gap-1">
          {(["left", "center", "right"] as const).map((a) => (
            <button
              key={a}
              type="button"
              {...toolAttrs({
                tool: `object-align-${a}`,
                action: "MOVE_SLIDE_ELEMENT",
                targetType: "slide_element",
                label: `Align object to slide ${a}`,
              })}
              onClick={() => {
                elementOp(
                  moveElementPatch(
                    block.id,
                    slide.id,
                    selectedEl.id,
                    alignedX(selectedEl, a),
                    selectedEl.y
                  )
                );
                setPopover(null);
              }}
              className="rounded-lg bg-stone-50 px-2 py-1.5 text-xs font-medium capitalize text-stone-600 transition-colors hover:bg-stone-100"
            >
              {a}
            </button>
          ))}
          {(["top", "middle", "bottom"] as const).map((a) => (
            <button
              key={a}
              type="button"
              {...toolAttrs({
                tool: `object-align-${a}`,
                action: "MOVE_SLIDE_ELEMENT",
                targetType: "slide_element",
                label: `Align object to slide ${a}`,
              })}
              onClick={() => {
                elementOp(
                  moveElementPatch(
                    block.id,
                    slide.id,
                    selectedEl.id,
                    selectedEl.x,
                    alignedY(selectedEl, a)
                  )
                );
                setPopover(null);
              }}
              className="rounded-lg bg-stone-50 px-2 py-1.5 text-xs font-medium capitalize text-stone-600 transition-colors hover:bg-stone-100"
            >
              {a}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-stone-400">
          Moves the box itself. Text alignment inside the box lives in the
          text toolbar.
        </p>
          </>
        )}
      </div>
    );
  } else if (popover === "textColor" && selectedEl) {
    popoverContent = (
      <div className="w-64">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          Text color
        </p>
        <ColorSwatchPicker
          label="Text color"
          value={selectedEl.style.color}
          palette={theme.palette}
          allowClear
          onChange={(color) => {
            const rich = getActiveRichEditor();
            if (rich && color) return rich.exec("foreColor", color);
            styleSelected({ color });
          }}
        />
      </div>
    );
  }

  return (
    // Toolbar clicks act on the current selection — don't let them bubble to
    // BlockFrame and change it.
    <div className="sticky top-2 z-30" onClick={(e) => e.stopPropagation()}>
      <div
        role="toolbar"
        aria-label="Slide toolbar"
        data-ai-component="slide-toolbar"
        className="flex flex-wrap items-center gap-0.5 rounded-xl border border-stone-200/80 bg-white/95 px-1.5 py-1 shadow-[0_2px_10px_rgba(16,24,40,0.06)] backdrop-blur"
      >
        {/* Edit freely — only for a renderer-owned structured slide. */}
        {isTemplate && (
          <>
            <button
              type="button"
              title={
                canEject
                  ? "Edit freely — make every object movable and resizable"
                  : "Free editing for this layout is coming soon"
              }
              disabled={!canEject}
              data-ai-tool="edit-freely"
              data-ai-action="SET_SLIDE_CONTENT"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => togglePopover("eject")}
              className={cn(
                "flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40",
                popover === "eject"
                  ? "bg-brand-600 text-white"
                  : "bg-brand-50 text-brand-700 hover:bg-brand-100"
              )}
            >
              <PencilRuler className="size-3.5 shrink-0" />
              Edit freely
            </button>
            <Divider />
          </>
        )}

        {/* Insert */}
        {insertTools.map(({ type, icon, label }) => (
          <ToolButton
            key={type}
            icon={icon}
            label={label}
            tool={`insert-${type}`}
            action="ADD_SLIDE_ELEMENT"
            targetType="slide"
            onClick={() =>
              elementOp(addElementPatch(block.id, slide.id, type, slide.elements.length))
            }
          />
        ))}
        <ToolButton
          icon={Shapes}
          label="Insert a shape"
          tool="open-shape-picker"
          action="ADD_SLIDE_ELEMENT"
          targetType="slide"
          active={popover === "shapes"}
          onClick={() => togglePopover("shapes")}
        />
        <ToolButton
          icon={Smile}
          label="Insert a sticker (icon)"
          tool="open-sticker-picker"
          action="ADD_SLIDE_ELEMENT"
          targetType="slide"
          active={popover === "stickers"}
          onClick={() => togglePopover("stickers")}
        />
        <ToolButton
          icon={ImagePlus}
          label="Insert image into selected slide"
          tool="insert-image"
          action="INSERT_IMAGE"
          targetType="slide"
          onClick={() =>
            openImageDialog({
              blockId: block.id,
              slideId: slide.id,
              elementCount: slide.elements.length,
            })
          }
        />

        <Divider />

        {/* Text style */}
        <select
          value={effectiveFamily}
          disabled={!textish}
          aria-label="Font family"
          data-ai-tool="font-family"
          data-ai-action="UPDATE_SLIDE_ELEMENT"
          onChange={(e) => styleSelected({ fontFamily: e.target.value as FontFamilyId })}
          className="h-7 rounded-md bg-transparent px-1 text-xs font-medium text-stone-600 outline-none transition-colors hover:bg-stone-100 disabled:opacity-30"
        >
          {Object.entries(FONT_FAMILIES).map(([id, f]) => (
            <option key={id} value={id}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          value={effectiveScale}
          disabled={!textish}
          aria-label="Text size"
          title="Text size (semantic scale)"
          data-ai-tool="font-scale"
          data-ai-action="UPDATE_SLIDE_ELEMENT"
          onChange={(e) => styleSelected({ fontScale: e.target.value as FontScaleToken })}
          className="h-7 w-[5.5rem] rounded-md bg-transparent px-1 text-xs font-medium text-stone-600 outline-none transition-colors hover:bg-stone-100 disabled:opacity-30"
        >
          {FONT_SCALE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <ToolButton
          icon={Bold}
          label="Bold (selection while editing, whole box otherwise)"
          tool="text-bold"
          action="UPDATE_SLIDE_ELEMENT"
          disabled={!textish}
          active={textish && selectedEl?.style.fontWeight === "bold"}
          onClick={() => {
            const rich = getActiveRichEditor();
            if (rich) return rich.exec("bold");
            styleSelected({
              fontWeight: selectedEl?.style.fontWeight === "bold" ? "regular" : "bold",
            });
          }}
        />
        <ToolButton
          icon={Italic}
          label="Italic (selection while editing, whole box otherwise)"
          tool="text-italic"
          action="UPDATE_SLIDE_ELEMENT"
          disabled={!textish}
          active={textish && selectedEl?.style.italic === true}
          onClick={() => {
            const rich = getActiveRichEditor();
            if (rich) return rich.exec("italic");
            styleSelected({ italic: !selectedEl?.style.italic });
          }}
        />
        <ToolButton
          icon={Underline}
          label="Underline (selection while editing, whole box otherwise)"
          tool="text-underline"
          action="UPDATE_SLIDE_ELEMENT"
          disabled={!textish}
          active={textish && selectedEl?.style.underline === true}
          onClick={() => {
            const rich = getActiveRichEditor();
            if (rich) return rich.exec("underline");
            styleSelected({ underline: !selectedEl?.style.underline });
          }}
        />
        <ToolButton
          icon={Baseline}
          label="Text color"
          tool="text-color"
          action="UPDATE_SLIDE_ELEMENT"
          disabled={!textish}
          active={popover === "textColor"}
          onClick={() => togglePopover("textColor")}
        />
        <ToolButton
          icon={
            textish && selectedEl?.style.textAlign === "center"
              ? AlignCenter
              : textish && selectedEl?.style.textAlign === "right"
                ? AlignRight
                : textish && selectedEl?.style.textAlign === "justify"
                  ? AlignJustify
                  : AlignLeft
          }
          label="Text alignment (within the box)"
          tool="open-text-align"
          action="UPDATE_SLIDE_ELEMENT"
          targetType="slide_element"
          disabled={!textish}
          active={popover === "hAlign"}
          onClick={() => togglePopover("hAlign")}
        />
        <ToolButton
          icon={ArrowUpDown}
          label="Vertical text alignment (within the box)"
          tool="open-text-valign"
          action="UPDATE_SLIDE_ELEMENT"
          targetType="slide_element"
          disabled={!textish}
          active={popover === "vAlign"}
          onClick={() => togglePopover("vAlign")}
        />
        {textish && (
          <>
            <ToolButton
              icon={List}
              label="Bulleted list (⌘⇧8)"
              tool="toggle-bullet-list"
              action="UPDATE_SLIDE_ELEMENT"
              targetType="slide_element"
              active={allMarker("disc")}
              onClick={() => toggleListMarker("disc")}
            />
            <ToolButton
              icon={ListOrdered}
              label="Numbered list (⌘⇧7)"
              tool="toggle-numbered-list"
              action="UPDATE_SLIDE_ELEMENT"
              targetType="slide_element"
              active={allMarker("number")}
              onClick={() => toggleListMarker("number")}
            />
          </>
        )}
        {listEl && (
          <ToolButton
            icon={ChevronDown}
            label="More list styles — markers & indent"
            tool="open-list-style"
            action="UPDATE_SLIDE_ELEMENT"
            targetType="slide_element"
            active={popover === "list"}
            onClick={() => togglePopover("list")}
          />
        )}

        <Divider />

        {/* Layout / style */}
        <ToolButton
          icon={LayoutTemplate}
          label="Change slide layout"
          tool="open-layout-picker"
          action="APPLY_SLIDE_LAYOUT"
          targetType="slide"
          active={popover === "layout"}
          onClick={() => togglePopover("layout")}
          text="Layout"
        />
        <ToolButton
          icon={PaintBucket}
          label="Change slide background"
          tool="open-background-panel"
          action="UPDATE_SLIDE_BACKGROUND"
          targetType="slide"
          active={popover === "background"}
          onClick={() => togglePopover("background")}
        />
        <ToolButton
          icon={Palette}
          label="Change slide theme"
          tool="open-theme-picker"
          action="APPLY_SLIDE_THEME"
          targetType="slide"
          active={popover === "theme"}
          onClick={() => togglePopover("theme")}
        />
        <ToolButton
          icon={AlignHorizontalJustifyCenter}
          label="Arrange — align, group, and ungroup objects"
          tool="open-arrange-menu"
          action="MOVE_SLIDE_ELEMENT"
          targetType="slide_element"
          disabled={selectedEls.length === 0}
          active={popover === "arrange"}
          onClick={() => togglePopover("arrange")}
          text="Arrange"
        />

        {/* Element actions — always present (constant toolbar height; no
            canvas jump on selection), disabled without an element. */}
        <Divider />
        {(
          <>
            <ToolButton
              icon={ChevronUp}
              label="Bring forward"
              tool="bring-forward"
              action="REORDER_SLIDE_ELEMENT"
              disabled={!selectedEl}
              onClick={() => {
                if (selectedEl) elementOp(reorderElementPatch(block.id, slide.id, selectedEl.id, "forward"));
              }}
            />
            <ToolButton
              icon={ChevronDown}
              label="Send backward"
              tool="send-backward"
              action="REORDER_SLIDE_ELEMENT"
              disabled={!selectedEl}
              onClick={() => {
                if (selectedEl) elementOp(reorderElementPatch(block.id, slide.id, selectedEl.id, "backward"));
              }}
            />
            <ToolButton
              icon={ChevronsUp}
              label="Bring to front"
              tool="bring-to-front"
              action="REORDER_SLIDE_ELEMENT"
              disabled={!selectedEl}
              onClick={() => {
                if (selectedEl) elementOp(reorderElementPatch(block.id, slide.id, selectedEl.id, "front"));
              }}
            />
            <ToolButton
              icon={ChevronsDown}
              label="Send to back"
              tool="send-to-back"
              action="REORDER_SLIDE_ELEMENT"
              disabled={!selectedEl}
              onClick={() => {
                if (selectedEl) elementOp(reorderElementPatch(block.id, slide.id, selectedEl.id, "back"));
              }}
            />
            <ToolButton
              icon={Copy}
              label="Duplicate element"
              tool="duplicate-element"
              action="DUPLICATE_SLIDE_ELEMENT"
              disabled={!selectedEl}
              onClick={() => {
                if (selectedEl) elementOp(duplicateElementPatch(block.id, slide.id, selectedEl.id));
              }}
            />
            <ToolButton
              icon={selectedEl?.locked ? Lock : LockOpen}
              label={selectedEl?.locked ? "Unlock element" : "Lock element"}
              tool="toggle-element-lock"
              action="UPDATE_SLIDE_ELEMENT"
              active={selectedEl?.locked === true}
              disabled={!selectedEl}
              onClick={() => {
                if (selectedEl)
                  elementOp(
                    updateElementPatch(block.id, slide.id, selectedEl.id, {
                      locked: !selectedEl.locked,
                    })
                  );
              }}
            />
            <ToolButton
              icon={Trash2}
              label="Delete element"
              tool="delete-element"
              action="DELETE_SLIDE_ELEMENT"
              danger
              disabled={!selectedEl}
              onClick={() => {
                if (selectedEl) elementOp(deleteElementPatch(block.id, slide.id, selectedEl.id));
              }}
            />
          </>
        )}

        <span className="flex-1" />

        {/* Zoom */}
        <ToolButton
          icon={ZoomOut}
          label="Zoom out (⌘−)"
          tool="zoom-out"
          action="ZOOM_CANVAS"
          onClick={zoomOut}
        />
        <button
          type="button"
          title="Reset zoom (⌘0)"
          data-ai-tool="zoom-reset"
          data-ai-action="ZOOM_CANVAS"
          onClick={() => setZoom(1)}
          className="h-7 min-w-11 rounded-md px-1 text-center font-mono text-[11px] font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
        >
          {Math.round(zoom * 100)}%
        </button>
        <ToolButton
          icon={ZoomIn}
          label="Zoom in (⌘+)"
          tool="zoom-in"
          action="ZOOM_CANVAS"
          onClick={zoomIn}
        />

        <Divider />

        {/* AI */}
        <div
          className={cn(
            "flex items-center gap-0.5 rounded-lg bg-brand-50/70 px-1 py-0.5",
            thinking && "animate-pulse"
          )}
        >
          {(
            [
              ["improve-design", "Improve this slide's design", "Improve"],
              ["declutter", "Make this slide less cluttered", "Declutter"],
              ["generate-visual", "Generate a visual", "Visual"],
              ["speaker-notes", "Write speaker notes", "Notes"],
            ] as const
          ).map(([tool, prompt, label]) => (
            <button
              key={tool}
              type="button"
              disabled={thinking}
              title={prompt}
              {...toolAttrs({
                tool: `ai-${tool}`,
                action: "AI_COMMAND",
                targetType: "slide",
                label: prompt,
              })}
              onClick={() => run(prompt, slideSelection)}
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-brand-700 transition-colors hover:bg-brand-100 disabled:opacity-50"
            >
              <Sparkles className="size-3" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {popoverContent && (
        <>
          <div className="fixed inset-0 z-30" aria-hidden onClick={() => setPopover(null)} />
          <div className="absolute left-0 top-full z-40 mt-1.5 max-h-[26rem] overflow-y-auto rounded-2xl border border-stone-200/80 bg-white p-4 shadow-xl scrollbar-thin">
            {popoverContent}
          </div>
        </>
      )}
    </div>
  );
}
