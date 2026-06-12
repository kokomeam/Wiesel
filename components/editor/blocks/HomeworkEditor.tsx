"use client";

/**
 * Homework block: instructions, exercise list, read-only rubric summary,
 * and AI presets.
 */

import { Plus } from "lucide-react";
import { addExercisePatch, updateTextPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { HomeworkBlock } from "@/lib/course/types";
import { AIActionButton } from "../AIActionButton";
import { InlineTextArea } from "../InlineText";
import { ExerciseCard } from "./ExerciseCard";

export function HomeworkEditor({
  block,
  lessonId,
}: {
  block: HomeworkBlock;
  lessonId: string;
}) {
  const apply = useEditorStore((s) => s.apply);
  const blockSelection = { kind: "block", id: block.id, lessonId } as const;

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
          Instructions
        </p>
        <InlineTextArea
          value={block.instructions}
          aria-label="Homework instructions"
          placeholder="What should students do?"
          onCommit={(v) =>
            apply(
              updateTextPatch(
                { kind: "block_field", blockId: block.id, field: "instructions" },
                v
              ),
              "human"
            )
          }
          className="text-sm leading-relaxed text-stone-700"
        />
      </div>

      <div className="divide-y divide-stone-100 border-t border-stone-100">
        {block.exercises.map((ex, i) => (
          <ExerciseCard key={ex.id} exercise={ex} homeworkId={block.id} index={i} />
        ))}
      </div>

      {block.rubric && block.rubric.length > 0 && (
        <div className="rounded-xl bg-stone-50 px-4 py-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
            Rubric · {block.rubric.reduce((sum, r) => sum + r.points, 0)} pts
          </p>
          <ul className="space-y-1.5">
            {block.rubric.map((criterion) => (
              <li key={criterion.id} className="flex items-baseline gap-2 text-xs">
                <span className="font-medium text-stone-700">{criterion.name}</span>
                <span className="text-stone-400">{criterion.description}</span>
                <span className="ml-auto shrink-0 font-semibold text-stone-500">
                  {criterion.points} pts
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-t border-stone-100 pt-3">
        <button
          type="button"
          onClick={() => apply(addExercisePatch(block.id), "human")}
          className="inline-flex items-center gap-1 rounded-full bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100"
        >
          <Plus className="size-3" />
          Exercise
        </button>
        <span className="mx-1 h-4 w-px bg-stone-200" aria-hidden />
        <AIActionButton prompt="Generate a practice set" selection={blockSelection} />
        <AIActionButton prompt="Create a solution key" selection={blockSelection} />
      </div>
    </div>
  );
}
