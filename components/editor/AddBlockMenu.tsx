"use client";

/**
 * Insert-a-block control. "between" renders a quiet hover divider; "end"
 * renders a dashed button. Both open the same type menu and emit one
 * ADD_BLOCK patch. The menu is portalled to the document body and positioned
 * with `fixed` (mirroring CanvasContextMenu) so the workspace's
 * overflow-y-auto can't crop it. It opens above the trigger when there isn't
 * room below (e.g. when "Add block" is the last row of a long lesson) — the
 * open-up case anchors the menu's bottom edge, so no height measurement is
 * needed.
 */

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlignLeft,
  Dumbbell,
  Lightbulb,
  Link2,
  ListChecks,
  NotebookText,
  Plus,
  Presentation,
  Video,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { addBlockPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { BlockType } from "@/lib/course/types";
import { AddSlideDeckChoice } from "./lesson/AddSlideDeckChoice";
import { useEscapeToClose } from "./QualityHintBadge";

const options: { type: BlockType; label: string; hint: string; icon: typeof Plus }[] = [
  { type: "slide_deck", label: "Slide deck", hint: "Visual presentation", icon: Presentation },
  { type: "video", label: "Video lesson", hint: "Record or upload", icon: Video },
  { type: "lecture_text", label: "Lecture text", hint: "Written explanation", icon: AlignLeft },
  { type: "quiz", label: "Knowledge check", hint: "Check understanding", icon: ListChecks },
  { type: "homework", label: "Practice exercise", hint: "Self-paced practice", icon: NotebookText },
  { type: "example", label: "Worked example", hint: "Concrete walkthrough", icon: Lightbulb },
  { type: "exercise", label: "Exercise", hint: "Single practice task", icon: Dumbbell },
  { type: "resource", label: "Resources", hint: "Links & references", icon: Link2 },
];

const MENU_W = 240; // matches w-60
const MENU_H_EST = 368; // ~8 options; only used to choose the flip direction

type MenuPos = { left: number; top?: number; bottom?: number };

export function AddBlockMenu({
  lessonId,
  atIndex,
  variant,
}: {
  lessonId: string;
  atIndex?: number;
  variant: "between" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [deckChooserOpen, setDeckChooserOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const apply = useEditorStore((s) => s.apply);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEscapeToClose(open, () => setOpen(false));

  function add(type: BlockType) {
    setOpen(false);
    // "Slide deck" opens a secondary chooser (create native vs. import a file);
    // every other block type inserts directly.
    if (type === "slide_deck") {
      setDeckChooserOpen(true);
      return;
    }
    apply(addBlockPatch(lessonId, type, atIndex), "human");
  }

  // Measure the trigger and choose the menu's anchor in the click handler
  // (never in an effect). Open-down pins `top`; open-up pins `bottom` to the
  // trigger's top edge, so the exact menu height never matters.
  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const btn = triggerRef.current;
    if (btn) {
      const r = btn.getBoundingClientRect();
      const gap = 4;
      const left = Math.round(
        Math.min(
          Math.max(r.left + r.width / 2, MENU_W / 2 + 8),
          window.innerWidth - MENU_W / 2 - 8
        )
      );
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const openUp = spaceBelow < MENU_H_EST && r.top - 8 > spaceBelow;
      setPos(
        openUp
          ? { left, bottom: Math.round(window.innerHeight - r.top + gap) }
          : { left, top: Math.round(r.bottom + gap) }
      );
    }
    setOpen(true);
  }

  const menu =
    open &&
    pos &&
    createPortal(
      <>
        <div className="fixed inset-0 z-[60]" aria-hidden onClick={() => setOpen(false)} />
        <div
          role="menu"
          aria-label="Add block"
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: MENU_W }}
          className="fixed z-[61] -translate-x-1/2 rounded-xl border border-stone-200/80 bg-white p-1.5 shadow-lg"
        >
          {options.map((opt) => (
            <button
              key={opt.type}
              type="button"
              role="menuitem"
              onClick={() => add(opt.type)}
              className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-stone-50"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-500">
                <opt.icon className="size-3.5" />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-stone-800">{opt.label}</span>
                <span className="block text-[11px] text-stone-400">{opt.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </>,
      document.body
    );

  const deckChooser = (
    <AddSlideDeckChoice
      open={deckChooserOpen}
      lessonId={lessonId}
      atIndex={atIndex}
      onClose={() => setDeckChooserOpen(false)}
    />
  );

  if (variant === "between") {
    return (
      <div className="group/add relative flex h-5 items-center justify-center">
        <div className="absolute inset-x-8 top-1/2 h-px bg-transparent transition-colors group-hover/add:bg-brand-200" />
        <button
          ref={triggerRef}
          type="button"
          aria-label="Insert block here"
          onClick={toggle}
          className={cn(
            "relative z-10 grid size-5 place-items-center rounded-full border border-brand-200 bg-white text-brand-600 shadow-sm transition-opacity hover:bg-brand-50",
            open ? "opacity-100" : "opacity-0 group-hover/add:opacity-100"
          )}
        >
          <Plus className="size-3" />
        </button>
        {menu}
        {deckChooser}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-stone-300 py-3.5 text-sm font-medium text-stone-500 transition-colors hover:border-brand-300 hover:text-brand-600"
      >
        <Plus className="size-4" />
        Add block
      </button>
      {menu}
      {deckChooser}
    </div>
  );
}
