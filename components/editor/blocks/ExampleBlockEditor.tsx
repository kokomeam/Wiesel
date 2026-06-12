"use client";

/**
 * Worked example block: context → steps → explanation → takeaway, all inline
 * editable via UPDATE_TEXT block fields.
 */

import { updateTextPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { ExampleBlock } from "@/lib/course/types";
import { AIActionButton } from "../AIActionButton";
import { InlineText, InlineTextArea } from "../InlineText";

export function ExampleBlockEditor({
  block,
  lessonId,
}: {
  block: ExampleBlock;
  lessonId: string;
}) {
  const apply = useEditorStore((s) => s.apply);
  const blockSelection = { kind: "block", id: block.id, lessonId } as const;

  function commitField(field: string, value: string, itemId?: string) {
    apply(
      updateTextPatch({ kind: "block_field", blockId: block.id, field, itemId }, value),
      "human"
    );
  }

  return (
    <div className="space-y-3.5">
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
          Context
        </p>
        <InlineTextArea
          value={block.context}
          aria-label="Example context"
          placeholder="Set the scene — what's the problem?"
          onCommit={(v) => commitField("context", v)}
          className="text-sm leading-relaxed text-stone-700"
        />
      </div>

      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
          Steps
        </p>
        <ol className="space-y-1.5">
          {block.steps.map((step, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-stone-100 text-[10px] font-semibold text-stone-500">
                {i + 1}
              </span>
              <InlineText
                value={step}
                aria-label={`Step ${i + 1}`}
                onCommit={(v) => commitField("step", v, String(i))}
                className="text-sm text-stone-700"
              />
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => commitField("add_step", "New step")}
              className="ml-8 text-xs text-stone-400 transition-colors hover:text-brand-600"
            >
              + step
            </button>
          </li>
        </ol>
      </div>

      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
          Why it works
        </p>
        <InlineTextArea
          value={block.explanation}
          aria-label="Example explanation"
          placeholder="Explain the underlying idea…"
          onCommit={(v) => commitField("explanation", v)}
          className="text-sm leading-relaxed text-stone-600"
        />
      </div>

      <div className="border-l-2 border-brand-300 bg-brand-50/50 py-2.5 pl-3 pr-3 rounded-r-xl">
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-brand-500">
          Takeaway
        </p>
        <InlineTextArea
          value={block.takeaway}
          aria-label="Example takeaway"
          placeholder="The one thing to remember…"
          onCommit={(v) => commitField("takeaway", v)}
          className="text-sm font-medium text-stone-700"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-stone-100 pt-3">
        <AIActionButton prompt="Make this more concrete" label="Make more concrete" selection={blockSelection} />
        <AIActionButton prompt="Add another example" selection={blockSelection} />
      </div>
    </div>
  );
}
