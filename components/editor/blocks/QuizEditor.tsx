"use client";

/**
 * Quiz block: collapsible settings bar, a drag-sortable question list, and
 * add-question / AI controls. Every edit flows through the patch pipeline.
 */

import { useState } from "react";
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
import { ChevronDown, Plus, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";
import { resolveQuizSettings, quizTotalPoints } from "@/lib/course/assessments";
import { addQuestionPatch, reorderQuestionPatch, updateQuizSettingsPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { QuestionKind, QuizBlock, QuizSettings, ShowAnswersPolicy } from "@/lib/course/types";
import { AIActionButton } from "../AIActionButton";
import { NumberField, Toggle } from "./controls";
import { QuestionCard } from "./QuestionCard";

const kinds: { kind: QuestionKind; label: string }[] = [
  { kind: "multiple_choice", label: "Multiple choice" },
  { kind: "multi_select", label: "Multiple select" },
  { kind: "true_false", label: "True / False" },
  { kind: "short_answer", label: "Short answer" },
];

const showAnswerLabels: Record<ShowAnswersPolicy, string> = {
  immediately: "Immediately",
  after_submit: "After submit",
  after_due: "After due date",
  never: "Never",
};

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-xs text-stone-500">{label}</span>
      {children}
    </label>
  );
}

function QuizSettingsBar({ block }: { block: QuizBlock }) {
  const apply = useEditorStore((s) => s.apply);
  const [open, setOpen] = useState(false);
  const s = resolveQuizSettings(block.settings);

  function update(patch: Partial<QuizSettings>) {
    apply(updateQuizSettingsPatch(block.id, patch), "human");
  }

  const summary = [
    s.timeLimitMinutes ? `${s.timeLimitMinutes} min` : "Untimed",
    s.attemptsAllowed ? `${s.attemptsAllowed} attempt${s.attemptsAllowed === 1 ? "" : "s"}` : "Unlimited",
    `pass ${s.passingScore}%`,
  ].join(" · ");

  return (
    <div className="rounded-xl border border-stone-200/80 bg-stone-50/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <SlidersHorizontal className="size-3.5 text-stone-400" />
        <span className="text-xs font-medium text-stone-600">Quiz settings</span>
        <span className="truncate text-[11px] text-stone-400">· {summary}</span>
        <ChevronDown
          className={cn("ml-auto size-3.5 text-stone-400 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="grid gap-2.5 border-t border-stone-200/70 px-3 py-3 sm:grid-cols-2">
          <SettingRow label="Time limit">
            <NumberField
              value={s.timeLimitMinutes}
              suffix="min"
              placeholder="∞"
              aria-label="Time limit in minutes"
              onCommit={(n) => update({ timeLimitMinutes: n })}
            />
          </SettingRow>
          <SettingRow label="Attempts">
            <NumberField
              value={s.attemptsAllowed}
              placeholder="∞"
              min={1}
              aria-label="Attempts allowed"
              onCommit={(n) => update({ attemptsAllowed: n })}
            />
          </SettingRow>
          <SettingRow label="Passing score">
            <NumberField
              value={s.passingScore}
              suffix="%"
              aria-label="Passing score percent"
              onCommit={(n) => update({ passingScore: n ?? undefined })}
            />
          </SettingRow>
          <SettingRow label="Show answers">
            <select
              value={s.whenToShowAnswers}
              aria-label="When to show answers"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => update({ whenToShowAnswers: e.target.value as ShowAnswersPolicy })}
              className="rounded-lg border border-stone-200 bg-white px-2 py-1 text-xs text-stone-700 outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-200/60"
            >
              {(Object.keys(showAnswerLabels) as ShowAnswersPolicy[]).map((k) => (
                <option key={k} value={k}>
                  {showAnswerLabels[k]}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow label="Shuffle questions">
            <Toggle
              checked={s.shuffleQuestions}
              aria-label="Shuffle questions"
              onChange={(v) => update({ shuffleQuestions: v })}
            />
          </SettingRow>
          <SettingRow label="Shuffle options">
            <Toggle
              checked={s.shuffleOptions}
              aria-label="Shuffle options"
              onChange={(v) => update({ shuffleOptions: v })}
            />
          </SettingRow>
        </div>
      )}
    </div>
  );
}

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

  const totalPoints = quizTotalPoints(block.questions);

  return (
    <div className="space-y-3">
      <QuizSettingsBar block={block} />

      {block.questions.length === 0 ? (
        <p className="rounded-xl bg-stone-50 px-4 py-6 text-center text-sm text-stone-400">
          No questions yet — add one below or ask the AI to generate some.
        </p>
      ) : (
        <>
          <p className="text-[11px] font-medium text-stone-400">
            {block.questions.length} question{block.questions.length === 1 ? "" : "s"} · {totalPoints} pts
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
        <AIActionButton prompt="Make this quiz harder" label="Make harder" selection={blockSelection} />
        <AIActionButton prompt="Add explanations" selection={blockSelection} />
      </div>
    </div>
  );
}
