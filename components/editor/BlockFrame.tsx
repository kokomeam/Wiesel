"use client";

/**
 * Shared chrome for every lesson block: the single white card (inner editors
 * stay borderless to avoid boxes-in-boxes), selection ring, hover toolbar,
 * machine-readable attributes, and the quality-hint slot.
 */

import type { ReactNode } from "react";
import {
  AlignLeft,
  ChevronDown,
  ChevronUp,
  Dumbbell,
  Lightbulb,
  Link2,
  ListChecks,
  NotebookText,
  Presentation,
  Sparkles,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { aiAttrs } from "@/lib/course/aiAttributes";
import { deleteBlockPatch, reorderBlockPatch, updateBlockTitlePatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { BlockType, LessonBlock, QualityHint } from "@/lib/course/types";
import { InlineText } from "./InlineText";
import { QualityHintBadge } from "./QualityHintBadge";

const blockIcon: Record<BlockType, typeof Presentation> = {
  slide_deck: Presentation,
  lecture_text: AlignLeft,
  quiz: ListChecks,
  homework: NotebookText,
  exercise: Dumbbell,
  example: Lightbulb,
  resource: Link2,
};

const blockTypeLabel: Record<BlockType, string> = {
  slide_deck: "Slide deck",
  lecture_text: "Lecture",
  quiz: "Knowledge check",
  homework: "Practice exercise",
  exercise: "Exercise",
  example: "Example",
  resource: "Resources",
};

export function BlockFrame({
  block,
  lessonId,
  index,
  blockCount,
  hints = [],
  children,
}: {
  block: LessonBlock;
  lessonId: string;
  index: number;
  blockCount: number;
  hints?: QualityHint[];
  children: ReactNode;
}) {
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const apply = useEditorStore((s) => s.apply);

  const selected =
    (selection.kind === "block" && selection.id === block.id) ||
    (selection.kind === "slide" && selection.blockId === block.id);
  const Icon = blockIcon[block.type];

  function selectBlock() {
    select({ kind: "block", id: block.id, lessonId });
  }

  return (
    <section
      {...aiAttrs({
        component: "lesson-block",
        type: block.type,
        id: block.id,
        parentId: lessonId,
        order: block.order,
        purpose: block.ai.purpose,
        label: `${blockTypeLabel[block.type]} block: ${block.title ?? "untitled"}`,
      })}
      onClick={(e) => {
        e.stopPropagation();
        selectBlock();
      }}
      className={cn(
        "group rounded-2xl border bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition-shadow",
        selected
          ? "border-brand-300 ring-2 ring-brand-200/60"
          : "border-stone-200/80 hover:shadow-[0_2px_8px_rgba(16,24,40,0.06)]"
      )}
    >
      <header className="flex items-center gap-3 px-5 pt-4">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          <Icon className="size-3.5" />
          {blockTypeLabel[block.type]}
        </span>
        <div className="min-w-0 flex-1">
          <InlineText
            value={block.title ?? ""}
            placeholder="Untitled block"
            aria-label={`${blockTypeLabel[block.type]} title`}
            onCommit={(title) => apply(updateBlockTitlePatch(block.id, title), "human")}
            className="text-sm font-semibold text-stone-900"
          />
        </div>
        <QualityHintBadge hints={hints} />
        <div
          className={cn(
            "flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100",
            selected && "opacity-100"
          )}
        >
          <button
            type="button"
            title="AI actions (see inspector)"
            aria-label="Show AI actions for this block"
            onClick={(e) => {
              e.stopPropagation();
              selectBlock();
            }}
            className="grid size-7 place-items-center rounded-lg text-brand-600 transition-colors hover:bg-brand-50"
          >
            <Sparkles className="size-3.5" />
          </button>
          <button
            type="button"
            title="Move up"
            aria-label="Move block up"
            disabled={index === 0}
            onClick={(e) => {
              e.stopPropagation();
              apply(reorderBlockPatch(lessonId, block.id, index - 1), "human");
            }}
            className="grid size-7 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:opacity-30"
          >
            <ChevronUp className="size-3.5" />
          </button>
          <button
            type="button"
            title="Move down"
            aria-label="Move block down"
            disabled={index === blockCount - 1}
            onClick={(e) => {
              e.stopPropagation();
              apply(reorderBlockPatch(lessonId, block.id, index + 1), "human");
            }}
            className="grid size-7 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:opacity-30"
          >
            <ChevronDown className="size-3.5" />
          </button>
          <button
            type="button"
            title="Delete block"
            aria-label="Delete block"
            onClick={(e) => {
              e.stopPropagation();
              apply(deleteBlockPatch(lessonId, block.id), "human");
            }}
            className="grid size-7 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </header>
      <div className="px-5 pb-5 pt-3">{children}</div>
    </section>
  );
}
