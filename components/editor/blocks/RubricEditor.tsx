"use client";

/**
 * Homework rubric editor: drag-sortable criteria, each with ordered qualitative
 * performance levels (label · description). Low-stakes — levels guide feedback
 * and self-checking, they carry no points. Every edit replaces the whole
 * criterion via UPDATE_RUBRIC_CRITERION (add/delete/reorder have their own
 * patches), so the document stays the single source of truth.
 */

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { aiAttrs } from "@/lib/course/aiAttributes";
import {
  addRubricCriterionPatch,
  deleteRubricCriterionPatch,
  reorderRubricCriterionPatch,
  updateRubricCriterionPatch,
} from "@/lib/course/commands";
import { createRubricLevel } from "@/lib/course/factories";
import { useEditorStore } from "@/lib/course/store";
import type { HomeworkBlock, RubricCriterion } from "@/lib/course/types";
import { InlineText } from "../InlineText";

function SortableCriterion({
  criterion,
  blockId,
  index,
}: {
  criterion: RubricCriterion;
  blockId: string;
  index: number;
}) {
  const apply = useEditorStore((s) => s.apply);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: criterion.id });

  function patch(next: RubricCriterion) {
    apply(updateRubricCriterionPatch(blockId, criterion.id, next), "human");
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...aiAttrs({
        component: "rubric-criterion",
        type: "rubric_criterion",
        id: criterion.id,
        parentId: blockId,
        order: index,
        label: `Rubric criterion: ${criterion.name}`,
      })}
      className={cn(
        "group/crit relative rounded-xl border border-stone-200/80 bg-white py-2.5 pl-6 pr-3",
        isDragging && "z-10 opacity-80"
      )}
    >
      <span
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder criterion ${index + 1}`}
        className="absolute left-1 top-3 cursor-grab touch-none text-stone-300 opacity-0 transition-opacity hover:text-stone-500 group-hover/crit:opacity-100"
      >
        <GripVertical className="size-3.5" />
      </span>

      <div className="flex items-center gap-2">
        <InlineText
          value={criterion.name}
          aria-label={`Criterion ${index + 1} name`}
          placeholder="Criterion name…"
          onCommit={(name) => patch({ ...criterion, name })}
          className="text-sm font-semibold text-stone-800"
        />
        <button
          type="button"
          title="Delete criterion"
          aria-label={`Delete criterion ${index + 1}`}
          onClick={(e) => {
            e.stopPropagation();
            apply(deleteRubricCriterionPatch(blockId, criterion.id), "human");
          }}
          className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-stone-300 transition-colors hover:bg-rose-50 hover:text-rose-600"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <InlineText
        value={criterion.description ?? ""}
        aria-label={`Criterion ${index + 1} description`}
        placeholder="What this criterion measures…"
        onCommit={(description) => patch({ ...criterion, description })}
        className="text-xs text-stone-500"
      />

      <ul className="mt-2 space-y-1">
        {criterion.levels.map((level) => (
          <li key={level.id} className="group/lvl flex items-center gap-2">
            <InlineText
              value={level.label}
              aria-label="Level label"
              placeholder="Label…"
              onCommit={(label) =>
                patch({
                  ...criterion,
                  levels: criterion.levels.map((l) =>
                    l.id === level.id ? { ...l, label } : l
                  ),
                })
              }
              className="max-w-[7rem] text-xs font-medium text-stone-700"
            />
            <InlineText
              value={level.description ?? ""}
              aria-label="Level description"
              placeholder="Describe this level…"
              onCommit={(description) =>
                patch({
                  ...criterion,
                  levels: criterion.levels.map((l) =>
                    l.id === level.id ? { ...l, description } : l
                  ),
                })
              }
              className="text-xs text-stone-500"
            />
            {criterion.levels.length > 1 && (
              <button
                type="button"
                aria-label="Remove level"
                onClick={(e) => {
                  e.stopPropagation();
                  patch({
                    ...criterion,
                    levels: criterion.levels.filter((l) => l.id !== level.id),
                  });
                }}
                className="shrink-0 text-stone-300 opacity-0 transition-opacity hover:text-rose-500 group-hover/lvl:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          patch({ ...criterion, levels: [...criterion.levels, createRubricLevel()] });
        }}
        className="mt-1 text-[11px] text-stone-400 transition-colors hover:text-brand-600"
      >
        + level
      </button>
    </div>
  );
}

export function RubricEditor({ block }: { block: HomeworkBlock }) {
  const apply = useEditorStore((s) => s.apply);
  const rubric = block.rubric ?? [];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const toIndex = rubric.findIndex((c) => c.id === String(over.id));
    if (toIndex === -1) return;
    apply(reorderRubricCriterionPatch(block.id, String(active.id), toIndex), "human");
  }

  return (
    <div className="rounded-xl bg-stone-50 px-4 py-3">
      <div className="mb-2 flex items-center">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">
          Rubric (optional)
        </p>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            apply(addRubricCriterionPatch(block.id), "human");
          }}
          className="ml-auto inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-stone-500 ring-1 ring-stone-200 transition-colors hover:text-brand-600"
        >
          <Plus className="size-3" />
          Criterion
        </button>
      </div>

      {rubric.length === 0 ? (
        <p className="py-2 text-center text-xs text-stone-400">
          No rubric yet — add a criterion to guide feedback or self-checking.
        </p>
      ) : (
        <DndContext
          id={`rubric-${block.id}`}
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={rubric.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">
              {rubric.map((criterion, i) => (
                <SortableCriterion
                  key={criterion.id}
                  criterion={criterion}
                  blockId={block.id}
                  index={i}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
