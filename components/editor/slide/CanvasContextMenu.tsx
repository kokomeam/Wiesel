"use client";

/**
 * Right-click menu for the slide canvas (Google-Slides item set, v1 scope).
 * Opens via uiStore.contextMenu — ElementView/SlideStage populate the target;
 * actions run on the current selection when the target belongs to it, so
 * right-clicking one member of a multi-selection acts on all of it.
 * Mounted once at the editor-shell level.
 */

import { useEffect, useRef, useState } from "react";
import {
  BoxSelect,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Group,
  Scissors,
  Trash2,
  Ungroup,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { toolAttrs } from "@/lib/course/aiAttributes";
import {
  deleteElementPatch,
  duplicateElementsPatch,
  groupElementsPatch,
  reorderElementPatch,
  ungroupElementsPatch,
} from "@/lib/course/commands";
import { copyElementsToClipboards, pasteIntoSlide } from "@/lib/editor/clipboard";
import { findSlide } from "@/lib/course/queries";
import { groupIdsAt, unitKeysAt } from "@/lib/course/slide/groups";
import { useEditorStore } from "@/lib/course/store";
import { useUIStore } from "@/lib/editor/uiStore";
import { useEscapeToClose } from "../QualityHintBadge";

const MENU_W = 232;

function MenuItem({
  icon: Icon,
  label,
  shortcut,
  tool,
  action,
  danger,
  disabled,
  onClick,
}: {
  icon?: typeof Copy;
  label: string;
  shortcut?: string;
  tool: string;
  action: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      {...toolAttrs({ tool, action, targetType: "slide_element", label })}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-35",
        danger
          ? "text-stone-600 hover:bg-rose-50 hover:text-rose-600"
          : "text-stone-600 hover:bg-stone-100 hover:text-stone-900"
      )}
    >
      {Icon && <Icon className="size-3.5 shrink-0 text-stone-400" />}
      <span className="min-w-0 flex-1">{label}</span>
      {shortcut && (
        <span className="shrink-0 font-mono text-[10px] text-stone-400">{shortcut}</span>
      )}
    </button>
  );
}

function MenuDivider() {
  return <div aria-hidden className="mx-2 my-1 h-px bg-stone-100" />;
}

export function CanvasContextMenu() {
  const menu = useUIStore((s) => s.contextMenu);
  const close = useUIStore((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(320);

  useEscapeToClose(menu !== null, close);

  // Clamp into the viewport once we know the real height.
  useEffect(() => {
    if (menu && ref.current) setHeight(ref.current.offsetHeight);
  }, [menu]);

  if (!menu) return null;

  const x = Math.min(menu.x, window.innerWidth - MENU_W - 8);
  const y = Math.min(menu.y, window.innerHeight - height - 8);

  /** Ids the menu operates on: the selection when the target is part of it. */
  function targetIds(): string[] {
    if (!menu) return [];
    if (!menu.targetId) return [];
    const sel = useEditorStore.getState().selection;
    if (
      sel.kind === "elements" &&
      sel.slideId === menu.slideId &&
      sel.ids.includes(menu.targetId)
    ) {
      return sel.ids;
    }
    return [menu.targetId];
  }

  function targetElements() {
    if (!menu) return [];
    const hit = findSlide(useEditorStore.getState().doc, menu.blockId, menu.slideId);
    const ids = targetIds();
    return hit ? hit.slide.elements.filter((el) => ids.includes(el.id)) : [];
  }

  function run(fn: () => void) {
    fn();
    close();
  }

  const copy = () =>
    run(() => {
      const els = targetElements();
      if (els.length && menu) copyElementsToClipboards(els, menu.slideId);
    });

  const cut = () =>
    run(() => {
      const els = targetElements().filter((el) => !el.locked);
      if (!els.length || !menu) return;
      copyElementsToClipboards(els, menu.slideId);
      useEditorStore
        .getState()
        .applyMany(
          els.map((el) => deleteElementPatch(menu.blockId, menu.slideId, el.id)),
          "human"
        );
    });

  // Paste lands at the right-click point (GS); the shared path falls back
  // to the OS clipboard, so this stays enabled even with an empty in-memory
  // clipboard (a no-op when the OS one is empty/denied too).
  const paste = () =>
    run(() => {
      if (!menu) return;
      void pasteIntoSlide(
        menu.blockId,
        menu.slideId,
        menu.lessonId,
        menu.canvasPoint ?? undefined
      );
    });

  const selectAll = () =>
    run(() => {
      if (!menu) return;
      const hit = findSlide(useEditorStore.getState().doc, menu.blockId, menu.slideId);
      if (!hit) return;
      const all = hit.slide.elements
        .filter((el) => el.visible !== false && !el.locked)
        .map((el) => el.id);
      if (all.length === 0) return;
      useEditorStore.getState().select(
        all.length === 1
          ? { kind: "element", id: all[0], slideId: menu.slideId, blockId: menu.blockId, lessonId: menu.lessonId, scope: [] }
          : { kind: "elements", ids: all, slideId: menu.slideId, blockId: menu.blockId, lessonId: menu.lessonId, scope: [] }
      );
    });

  const duplicate = () =>
    run(() => {
      if (!menu) return;
      const els = targetElements();
      if (!els.length) return;
      const state = useEditorStore.getState();
      // One patch = one undo; group structure survives via remapped ids.
      const patch = duplicateElementsPatch(menu.blockId, menu.slideId, els);
      const result = state.apply(patch, "human");
      if (result.ok && patch.action === "DUPLICATE_ELEMENTS") {
        const ids = patch.newElementIds;
        state.select(
          ids.length === 1
            ? { kind: "element", id: ids[0], slideId: menu.slideId, blockId: menu.blockId, lessonId: menu.lessonId }
            : { kind: "elements", ids, slideId: menu.slideId, blockId: menu.blockId, lessonId: menu.lessonId }
        );
      }
    });

  /** Scope = the entered group path of the current selection (if any). */
  function selectionScope(): string[] {
    const sel = useEditorStore.getState().selection;
    return sel.kind === "element" || sel.kind === "elements" ? (sel.scope ?? []) : [];
  }

  const group = () =>
    run(() => {
      if (!menu) return;
      const els = targetElements();
      const scope = selectionScope();
      if (unitKeysAt(els, scope).size < 2) return;
      useEditorStore
        .getState()
        .apply(
          groupElementsPatch(menu.blockId, menu.slideId, els.map((el) => el.id), scope.length),
          "human"
        );
    });

  const ungroup = () =>
    run(() => {
      if (!menu) return;
      const groupIds = groupIdsAt(targetElements(), selectionScope());
      if (!groupIds.length) return;
      useEditorStore
        .getState()
        .applyMany(
          groupIds.map((gid) => ungroupElementsPatch(menu.blockId, menu.slideId, gid)),
          "human"
        );
    });

  const del = () =>
    run(() => {
      if (!menu) return;
      const els = targetElements().filter((el) => !el.locked);
      if (!els.length) return;
      useEditorStore
        .getState()
        .applyMany(
          els.map((el) => deleteElementPatch(menu.blockId, menu.slideId, el.id)),
          "human"
        );
    });

  const reorder = (direction: "forward" | "backward" | "front" | "back") =>
    run(() => {
      if (!menu) return;
      const els = targetElements();
      if (!els.length) return;
      // The reducer moves one element at a time, so application ORDER decides
      // whether a multi-selection keeps its internal stacking: toward the
      // front, push the bottom-most first; toward the back, the top-most.
      const ascending = direction === "front" || direction === "backward";
      const sorted = [...els].sort((a, b) =>
        ascending ? a.zIndex - b.zIndex : b.zIndex - a.zIndex
      );
      useEditorStore
        .getState()
        .applyMany(
          sorted.map((el) => reorderElementPatch(menu.blockId, menu.slideId, el.id, direction)),
          "human"
        );
    });

  const onElement = menu.targetId !== null;
  const targetEls = onElement ? targetElements() : [];
  const scope = selectionScope();
  const canGroup = unitKeysAt(targetEls, scope).size >= 2;
  const canUngroup = groupIdsAt(targetEls, scope).length > 0;

  return (
    <>
      <div
        className="fixed inset-0 z-[60]"
        aria-hidden
        onClick={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div
        ref={ref}
        role="menu"
        aria-label="Canvas context menu"
        data-ai-component="canvas-context-menu"
        className="fixed z-[61] rounded-xl border border-stone-200/80 bg-white p-1.5 shadow-[0_12px_40px_rgba(28,25,23,0.16)]"
        style={{ left: x, top: y, width: MENU_W }}
      >
        {onElement && (
          <>
            <MenuItem icon={Scissors} label="Cut" shortcut="⌘X" tool="context-cut" action="DELETE_SLIDE_ELEMENT" onClick={cut} />
            <MenuItem icon={Copy} label="Copy" shortcut="⌘C" tool="context-copy" action="COPY" onClick={copy} />
          </>
        )}
        <MenuItem
          icon={ClipboardPaste}
          label="Paste"
          shortcut="⌘V"
          tool="context-paste"
          action="ADD_SLIDE_ELEMENT"
          onClick={paste}
        />
        <MenuItem
          icon={BoxSelect}
          label="Select all"
          shortcut="⌘A"
          tool="context-select-all"
          action="SELECT"
          onClick={selectAll}
        />
        {onElement && (
          <>
            <MenuItem icon={CopyPlus} label="Duplicate" shortcut="⌘D" tool="context-duplicate" action="DUPLICATE_ELEMENTS" onClick={duplicate} />
            <MenuItem icon={Trash2} label="Delete" shortcut="⌫" tool="context-delete" action="DELETE_SLIDE_ELEMENT" danger onClick={del} />
            <MenuDivider />
            <MenuItem icon={Group} label="Group" shortcut="⌘G" tool="context-group" action="GROUP_ELEMENTS" disabled={!canGroup} onClick={group} />
            <MenuItem icon={Ungroup} label="Ungroup" shortcut="⇧⌘G" tool="context-ungroup" action="UNGROUP_ELEMENTS" disabled={!canUngroup} onClick={ungroup} />
            <MenuDivider />
            <MenuItem icon={ChevronsUp} label="Bring to front" tool="context-front" action="REORDER_SLIDE_ELEMENT" onClick={() => reorder("front")} />
            <MenuItem icon={ChevronUp} label="Bring forward" tool="context-forward" action="REORDER_SLIDE_ELEMENT" onClick={() => reorder("forward")} />
            <MenuItem icon={ChevronDown} label="Send backward" tool="context-backward" action="REORDER_SLIDE_ELEMENT" onClick={() => reorder("backward")} />
            <MenuItem icon={ChevronsDown} label="Send to back" tool="context-back" action="REORDER_SLIDE_ELEMENT" onClick={() => reorder("back")} />
          </>
        )}
      </div>
    </>
  );
}
