"use client";

/**
 * Center column: the selected lesson as a vertical stack of blocks, each
 * wrapped in BlockFrame and rendered by the editor registry. Insert points
 * appear between blocks; exercise/resource blocks get lightweight editors.
 */

import { Sparkles } from "lucide-react";
import { aiAttrs } from "@/lib/course/aiAttributes";
import { altTextFor, speakerNotesFor } from "@/lib/course/ai/templates";
import { updateTextPatch } from "@/lib/course/commands";
import { lintSlide } from "@/lib/course/lint";
import { findLesson } from "@/lib/course/queries";
import { useEditorStore } from "@/lib/course/store";
import type { LessonBlock, QualityHint } from "@/lib/course/types";
import { AddBlockMenu } from "./AddBlockMenu";
import { BlockFrame } from "./BlockFrame";
import { InlineText, InlineTextArea } from "./InlineText";
import { ExampleBlockEditor } from "./blocks/ExampleBlockEditor";
import { HomeworkEditor } from "./blocks/HomeworkEditor";
import { LectureTextEditor } from "./blocks/LectureTextEditor";
import { QuizEditor } from "./blocks/QuizEditor";
import { SlideDeckEditor } from "./blocks/SlideDeckEditor";

function StandaloneExerciseEditor({ block }: { block: Extract<LessonBlock, { type: "exercise" }> }) {
  const apply = useEditorStore((s) => s.apply);
  function commit(field: string, value: string) {
    apply(updateTextPatch({ kind: "block_field", blockId: block.id, field }, value), "human");
  }
  return (
    <div className="space-y-2.5">
      <InlineTextArea
        value={block.prompt}
        aria-label="Exercise prompt"
        placeholder="Describe the task…"
        onCommit={(v) => commit("prompt", v)}
        className="text-sm leading-relaxed text-stone-700"
      />
      <InlineTextArea
        value={block.hint ?? ""}
        aria-label="Exercise hint"
        placeholder="Optional hint…"
        onCommit={(v) => commit("hint", v)}
        className="text-xs text-stone-500"
      />
    </div>
  );
}

function ResourceView({ block }: { block: Extract<LessonBlock, { type: "resource" }> }) {
  if (block.links.length === 0) {
    return <p className="text-sm text-stone-400">No links yet.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {block.links.map((link) => (
        <li key={link.id} className="text-sm">
          <span className="font-medium text-brand-700">{link.label}</span>
          {link.note && <span className="text-stone-400"> — {link.note}</span>}
        </li>
      ))}
    </ul>
  );
}

function blockHints(block: LessonBlock): QualityHint[] {
  if (block.type !== "slide_deck") return [];
  return block.slides.flatMap((slide) =>
    lintSlide(slide, { blockId: block.id, speakerNotesFor, altTextFor })
  );
}

function BlockBody({ block, lessonId }: { block: LessonBlock; lessonId: string }) {
  switch (block.type) {
    case "slide_deck":
      return <SlideDeckEditor block={block} lessonId={lessonId} />;
    case "lecture_text":
      return <LectureTextEditor block={block} lessonId={lessonId} />;
    case "quiz":
      return <QuizEditor block={block} lessonId={lessonId} />;
    case "homework":
      return <HomeworkEditor block={block} lessonId={lessonId} />;
    case "example":
      return <ExampleBlockEditor block={block} lessonId={lessonId} />;
    case "exercise":
      return <StandaloneExerciseEditor block={block} />;
    case "resource":
      return <ResourceView block={block} />;
  }
}

export function LessonWorkspace() {
  const doc = useEditorStore((s) => s.doc);
  const activeLessonId = useEditorStore((s) => s.activeLessonId);
  const select = useEditorStore((s) => s.select);
  const apply = useEditorStore((s) => s.apply);

  const hit = findLesson(doc, activeLessonId);

  if (!hit) {
    return (
      <div className="grid flex-1 place-items-center px-8">
        <div className="text-center">
          <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-brand-50">
            <Sparkles className="size-5 text-brand-500" />
          </div>
          <h2 className="text-sm font-semibold text-stone-900">No lesson selected</h2>
          <p className="mt-1 text-sm text-stone-400">
            Pick a lesson in the outline, or add one to get started.
          </p>
        </div>
      </div>
    );
  }

  const { lesson, module } = hit;

  return (
    <div
      className="flex-1 overflow-y-auto scrollbar-thin"
      onClick={() => select({ kind: "lesson", id: lesson.id })}
    >
      <div className="mx-auto max-w-3xl px-8 pb-10 pt-8">
        <header
          {...aiAttrs({
            component: "lesson-header",
            type: "lesson",
            id: lesson.id,
            parentId: module.id,
            order: lesson.order,
            purpose: lesson.objective,
            label: `Lesson: ${lesson.title}`,
          })}
          className="mb-6"
        >
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
            {module.title}
            {lesson.estimatedMinutes ? ` · ${lesson.estimatedMinutes} min` : ""}
          </p>
          <InlineText
            value={lesson.title}
            aria-label="Lesson title"
            placeholder="Lesson title"
            onCommit={(v) =>
              apply(updateTextPatch({ kind: "lesson", id: lesson.id, field: "title" }, v), "human")
            }
            className="text-2xl font-semibold tracking-tight text-stone-900"
          />
          <InlineTextArea
            value={lesson.objective ?? ""}
            aria-label="Lesson objective"
            placeholder="Add a learning objective…"
            onCommit={(v) =>
              apply(
                updateTextPatch({ kind: "lesson", id: lesson.id, field: "objective" }, v),
                "human"
              )
            }
            className="mt-1 text-sm text-stone-500"
          />
        </header>

        {lesson.blocks.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-200 bg-white/60 px-8 py-14 text-center">
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-brand-50">
              <Sparkles className="size-5 text-brand-500" />
            </div>
            <h3 className="text-sm font-semibold text-stone-900">An empty canvas</h3>
            <p className="mx-auto mt-1 mb-5 max-w-sm text-sm text-stone-400">
              Add your first block below, or ask the AI — try{" "}
              <span className="font-medium text-stone-500">
                &ldquo;Add a quiz to this lesson&rdquo;
              </span>
              .
            </p>
            <div className="mx-auto max-w-xs">
              <AddBlockMenu lessonId={lesson.id} variant="end" />
            </div>
          </div>
        ) : (
          <div>
            {lesson.blocks.map((block, i) => (
              <div key={block.id}>
                <BlockFrame
                  block={block}
                  lessonId={lesson.id}
                  index={i}
                  blockCount={lesson.blocks.length}
                  hints={blockHints(block)}
                >
                  <BlockBody block={block} lessonId={lesson.id} />
                </BlockFrame>
                {i < lesson.blocks.length - 1 && (
                  <AddBlockMenu lessonId={lesson.id} atIndex={i + 1} variant="between" />
                )}
              </div>
            ))}
            <div className="mt-5">
              <AddBlockMenu lessonId={lesson.id} variant="end" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
