"use client";

/**
 * One homework exercise (sortable): title, prompt, optional hint, and a
 * solution that stays collapsed until revealed. Content edits target homework
 * block fields via UPDATE_TEXT; deletion uses DELETE_HOMEWORK_EXERCISE.
 */

import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, GripVertical, Lightbulb, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { aiAttrs } from "@/lib/course/aiAttributes";
import { deleteExercisePatch, updateTextPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { HomeworkExercise } from "@/lib/course/types";
import { InlineText, InlineTextArea } from "../InlineText";

export function ExerciseCard({
  exercise,
  homeworkId,
  index,
}: {
  exercise: HomeworkExercise;
  homeworkId: string;
  index: number;
}) {
  const apply = useEditorStore((s) => s.apply);
  const [showSolution, setShowSolution] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: exercise.id });

  function commitField(field: string, value: string) {
    apply(
      updateTextPatch(
        { kind: "block_field", blockId: homeworkId, field, itemId: exercise.id },
        value
      ),
      "human"
    );
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...aiAttrs({
        component: "homework-exercise",
        type: "exercise",
        id: exercise.id,
        parentId: homeworkId,
        order: index,
        purpose: "A practice task within a practice exercise.",
        label: `Exercise ${index + 1}: ${exercise.title}`,
      })}
      className={cn(
        "group/ex relative py-4 pl-6 first:pt-1 last:pb-1",
        isDragging && "z-10 opacity-80"
      )}
    >
      <span
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder exercise ${index + 1}`}
        className="absolute left-0 top-5 cursor-grab touch-none text-stone-300 opacity-0 transition-opacity hover:text-stone-500 group-hover/ex:opacity-100"
      >
        <GripVertical className="size-3.5" />
      </span>

      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-stone-400">{index + 1}.</span>
        <InlineText
          value={exercise.title}
          aria-label={`Exercise ${index + 1} title`}
          placeholder="Exercise title…"
          onCommit={(v) => commitField("exercise_title", v)}
          className="text-sm font-semibold text-stone-800"
        />
        <button
          type="button"
          title="Delete exercise"
          aria-label={`Delete exercise ${index + 1}`}
          onClick={(e) => {
            e.stopPropagation();
            apply(deleteExercisePatch(homeworkId, exercise.id), "human");
          }}
          className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-stone-300 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-600 group-hover/ex:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <InlineTextArea
        value={exercise.prompt}
        aria-label={`Exercise ${index + 1} prompt`}
        placeholder="Describe the task…"
        onCommit={(v) => commitField("exercise_prompt", v)}
        className="mt-1.5 text-sm leading-relaxed text-stone-600"
      />
      <div className="mt-2 flex items-start gap-2">
        <Lightbulb className="mt-1 size-3.5 shrink-0 text-stone-300" />
        <InlineTextArea
          value={exercise.hint ?? ""}
          aria-label={`Exercise ${index + 1} hint`}
          placeholder="Optional hint…"
          onCommit={(v) => commitField("exercise_hint", v)}
          className="text-xs text-stone-500"
        />
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setShowSolution((v) => !v);
        }}
        aria-expanded={showSolution}
        className="mt-2 flex items-center gap-1 text-xs font-medium text-stone-400 transition-colors hover:text-stone-600"
      >
        <ChevronRight className={cn("size-3 transition-transform", showSolution && "rotate-90")} />
        Solution
      </button>
      {showSolution && (
        <div className="mt-1.5 rounded-xl bg-stone-50 px-3 py-2.5">
          <InlineTextArea
            value={exercise.solution ?? ""}
            aria-label={`Exercise ${index + 1} solution`}
            placeholder="Write the solution key…"
            onCommit={(v) => commitField("exercise_solution", v)}
            className="text-xs leading-relaxed text-stone-600"
          />
        </div>
      )}
    </div>
  );
}
