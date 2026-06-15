"use client";

/**
 * Knowledge-check block: a drag-sortable question list plus add-question / AI
 * controls. Deliberately low-stakes — no timers, attempt caps, passing scores,
 * difficulty, or points. Questions confirm understanding and show an
 * explanation as immediate feedback. Every edit flows through the patch
 * pipeline.
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
import { addQuestionPatch, reorderQuestionPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { QuestionKind, QuizBlock } from "@/lib/course/types";
import { AIActionButton } from "../AIActionButton";
import { QuestionCard } from "./QuestionCard";

const kinds: { kind: QuestionKind; label: string }[] = [
  { kind: "multiple_choice", label: "Multiple choice" },
  { kind: "multi_select", label: "Multiple select" },
  { kind: "true_false", label: "True / False" },
  { kind: "short_answer", label: "Short answer" },
];

export function QuizEditor({ block, lessonId }: { block: QuizBlock; lessonId: string }) {
  const apply = useEditorStore((s) => s.apply);
  const blockSelection = { kind: "block", id: block.id, lessonId } as const;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const toIndex = block.questions.findIndex((q) => q.id === String(over.id));
    if (toIndex === -1) return;
    apply(reorderQuestionPatch(block.id, String(active.id), toIndex), "human");
  }

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-stone-400">
        <span className="inline-block size-1.5 rounded-full bg-emerald-400" aria-hidden />
        Ungraded — checks understanding, never blocks progress.
      </p>

      {block.questions.length === 0 ? (
        <p className="rounded-xl bg-stone-50 px-4 py-6 text-center text-sm text-stone-400">
          No questions yet — add one below or ask the AI to generate some.
        </p>
      ) : (
        <>
          <p className="text-[11px] font-medium text-stone-400">
            {block.questions.length} question{block.questions.length === 1 ? "" : "s"}
          </p>
          <DndContext
            id={`quiz-${block.id}`}
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={block.questions.map((q) => q.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="divide-y divide-stone-100">
                {block.questions.map((q, i) => (
                  <QuestionCard key={q.id} question={q} quizId={block.id} index={i} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-stone-100 pt-3">
        {kinds.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              apply(addQuestionPatch(block.id, kind), "human");
            }}
            className="inline-flex items-center gap-1 rounded-full bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100"
          >
            <Plus className="size-3" />
            {label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-stone-200" aria-hidden />
        <AIActionButton prompt="Generate 3 questions" selection={blockSelection} />
        <AIActionButton prompt="Add explanations" selection={blockSelection} />
      </div>
    </div>
  );
}
