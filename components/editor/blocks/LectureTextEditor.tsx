"use client";

/**
 * Structured lecture text: typed paragraphs (paragraph / key idea / aside)
 * editing inline, with AI presets that flow through the shared pipeline.
 * Tone is shown here but changed in the inspector's style section.
 */

import { cn } from "@/lib/cn";
import { updateTextPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { LectureTextBlock } from "@/lib/course/types";
import { AIActionButton } from "../AIActionButton";
import { InlineTextArea } from "../InlineText";

const kindLabel = { key_idea: "Key idea", aside: "Aside" } as const;

export function LectureTextEditor({
  block,
  lessonId,
}: {
  block: LectureTextBlock;
  lessonId: string;
}) {
  const apply = useEditorStore((s) => s.apply);
  const blockSelection = { kind: "block", id: block.id, lessonId } as const;

  return (
    <div className="space-y-3">
      {block.paragraphs.map((para) => (
        <div
          key={para.id}
          className={cn(
            para.kind === "key_idea" && "border-l-2 border-brand-300 pl-3",
            para.kind === "aside" && "rounded-xl bg-stone-50 px-3 py-2.5"
          )}
        >
          {para.kind !== "paragraph" && (
            <p
              className={cn(
                "mb-1 text-[10px] font-semibold uppercase tracking-wide",
                para.kind === "key_idea" ? "text-brand-500" : "text-stone-400"
              )}
            >
              {kindLabel[para.kind]}
            </p>
          )}
          <InlineTextArea
            value={para.text}
            aria-label={`Lecture ${para.kind.replace("_", " ")}`}
            placeholder="Write a paragraph…"
            onCommit={(value) =>
              apply(
                updateTextPatch(
                  {
                    kind: "block_field",
                    blockId: block.id,
                    field: "paragraph_text",
                    itemId: para.id,
                  },
                  value
                ),
                "human"
              )
            }
            className={cn(
              "text-sm leading-relaxed text-stone-700",
              para.kind === "aside" && "italic text-stone-500"
            )}
          />
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-1.5 border-t border-stone-100 pt-3">
        <AIActionButton prompt="Simplify this for beginners" label="Simplify" selection={blockSelection} />
        <AIActionButton prompt="Add an analogy" selection={blockSelection} />
        <AIActionButton prompt="Add an example" selection={blockSelection} />
        <span className="ml-auto text-[11px] text-stone-400">
          tone: <span className="font-medium text-stone-500">{block.tone}</span>
        </span>
      </div>
    </div>
  );
}
