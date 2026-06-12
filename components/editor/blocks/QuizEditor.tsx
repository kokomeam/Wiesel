"use client";

/**
 * Quiz block: question list plus add-question controls and AI presets.
 */

import { Plus } from "lucide-react";
import { addQuestionPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { QuestionKind, QuizBlock } from "@/lib/course/types";
import { AIActionButton } from "../AIActionButton";
import { QuestionCard } from "./QuestionCard";

const kinds: { kind: QuestionKind; label: string }[] = [
  { kind: "multiple_choice", label: "Multiple choice" },
  { kind: "true_false", label: "True / False" },
  { kind: "short_answer", label: "Short answer" },
];

export function QuizEditor({ block, lessonId }: { block: QuizBlock; lessonId: string }) {
  const apply = useEditorStore((s) => s.apply);
  const blockSelection = { kind: "block", id: block.id, lessonId } as const;

  return (
    <div>
      {block.questions.length === 0 ? (
        <p className="rounded-xl bg-stone-50 px-4 py-6 text-center text-sm text-stone-400">
          No questions yet — add one below or ask the AI to generate some.
        </p>
      ) : (
        <div className="divide-y divide-stone-100">
          {block.questions.map((q, i) => (
            <QuestionCard key={q.id} question={q} quizId={block.id} index={i} />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-stone-100 pt-3">
        {kinds.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            onClick={() => apply(addQuestionPatch(block.id, kind), "human")}
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
