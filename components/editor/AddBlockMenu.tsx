"use client";

/**
 * Insert-a-block control. "between" renders a quiet hover divider; "end"
 * renders a dashed button. Both open the same type menu and emit one
 * ADD_BLOCK patch.
 */

import { useState } from "react";
import {
  AlignLeft,
  Dumbbell,
  Lightbulb,
  Link2,
  ListChecks,
  NotebookText,
  Plus,
  Presentation,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { addBlockPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { BlockType } from "@/lib/course/types";
import { useEscapeToClose } from "./QualityHintBadge";

const options: { type: BlockType; label: string; hint: string; icon: typeof Plus }[] = [
  { type: "slide_deck", label: "Slide deck", hint: "Visual presentation", icon: Presentation },
  { type: "lecture_text", label: "Lecture text", hint: "Written explanation", icon: AlignLeft },
  { type: "quiz", label: "Quiz", hint: "Auto-gradable questions", icon: ListChecks },
  { type: "homework", label: "Homework", hint: "Practice assignment", icon: NotebookText },
  { type: "example", label: "Worked example", hint: "Concrete walkthrough", icon: Lightbulb },
  { type: "exercise", label: "Exercise", hint: "Single practice task", icon: Dumbbell },
  { type: "resource", label: "Resources", hint: "Links & references", icon: Link2 },
];

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
  const apply = useEditorStore((s) => s.apply);
  useEscapeToClose(open, () => setOpen(false));

  function add(type: BlockType) {
    apply(addBlockPatch(lessonId, type, atIndex), "human");
    setOpen(false);
  }

  const menu = open && (
    <>
      <div className="fixed inset-0 z-20" aria-hidden onClick={() => setOpen(false)} />
      <div
        role="menu"
        aria-label="Add block"
        className="absolute left-1/2 z-30 mt-1 w-60 -translate-x-1/2 rounded-xl border border-stone-200/80 bg-white p-1.5 shadow-lg"
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
    </>
  );

  if (variant === "between") {
    return (
      <div className="group/add relative flex h-5 items-center justify-center">
        <div className="absolute inset-x-8 top-1/2 h-px bg-transparent transition-colors group-hover/add:bg-brand-200" />
        <button
          type="button"
          aria-label="Insert block here"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "relative z-10 grid size-5 place-items-center rounded-full border border-brand-200 bg-white text-brand-600 shadow-sm transition-opacity hover:bg-brand-50",
            open ? "opacity-100" : "opacity-0 group-hover/add:opacity-100"
          )}
        >
          <Plus className="size-3" />
        </button>
        {menu}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-stone-300 py-3.5 text-sm font-medium text-stone-500 transition-colors hover:border-brand-300 hover:text-brand-600"
      >
        <Plus className="size-4" />
        Add block
      </button>
      {menu}
    </div>
  );
}
