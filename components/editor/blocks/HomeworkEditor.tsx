"use client";

/**
 * Homework block: a metadata row (deliverable type, time estimate),
 * instructions, a drag-sortable exercise list, the qualitative rubric editor,
 * and AI presets. Low-stakes practice — no points or due dates.
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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Plus } from "lucide-react";
import {
  addExercisePatch,
  reorderExercisePatch,
  updateHomeworkMetaPatch,
  updateTextPatch,
} from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { DeliverableType, HomeworkBlock } from "@/lib/course/types";
import { AIActionButton } from "../AIActionButton";
import { InlineTextArea } from "../InlineText";
import { NumberField, Segmented } from "./controls";
import { ExerciseCard } from "./ExerciseCard";
import { RubricEditor } from "./RubricEditor";

const deliverableOptions: { value: DeliverableType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "text_response", label: "Text" },
  { value: "file_upload", label: "File" },
  { value: "external_link", label: "Link" },
];

function MetaField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-stone-400">{label}</span>
      {children}
    </label>
  );
}

export function HomeworkEditor({
  block,
  lessonId,
}: {
  block: HomeworkBlock;
  lessonId: string;
}) {
  const apply = useEditorStore((s) => s.apply);
  const blockSelection = { kind: "block", id: block.id, lessonId } as const;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const toIndex = block.exercises.findIndex((e) => e.id === String(over.id));
    if (toIndex === -1) return;
    apply(reorderExercisePatch(block.id, String(active.id), toIndex), "human");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-stone-200/80 bg-stone-50/60 px-3 py-2.5">
        <MetaField label="Deliverable">
          <Segmented
            options={deliverableOptions}
            value={block.deliverableType}
            aria-label="Deliverable type"
            onChange={(deliverableType) =>
              apply(updateHomeworkMetaPatch(block.id, { deliverableType }), "human")
            }
          />
        </MetaField>
        <MetaField label="Est.">
          <NumberField
            value={block.estimatedMinutes}
            suffix="min"
            aria-label="Estimated minutes"
            onCommit={(n) =>
              apply(updateHomeworkMetaPatch(block.id, { estimatedMinutes: n ?? undefined }), "human")
            }
          />
        </MetaField>
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-stone-400">
          <span className="inline-block size-1.5 rounded-full bg-emerald-400" aria-hidden />
          Self-paced — no points, no due date.
        </span>
      </div>
      <p className="text-[11px] text-stone-400">
        A deliverable is optional: collect a submission for AI / creator feedback,
        or include a solution below so learners can self-check.
      </p>

      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
          Instructions
        </p>
        <InlineTextArea
          value={block.instructions}
          aria-label="Practice exercise instructions"
          placeholder="What should learners practice?"
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

      {block.exercises.length > 0 && (
        <DndContext
          id={`homework-${block.id}`}
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={block.exercises.map((e) => e.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="divide-y divide-stone-100 border-t border-stone-100">
              {block.exercises.map((ex, i) => (
                <ExerciseCard key={ex.id} exercise={ex} homeworkId={block.id} index={i} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <RubricEditor block={block} />

      <div className="flex flex-wrap items-center gap-1.5 border-t border-stone-100 pt-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            apply(addExercisePatch(block.id), "human");
          }}
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
