"use client";

/**
 * Inspector · Content tab. The selected thing's words: course/lesson fields,
 * slide title + notes + element inventory, element text/alt/caption, and the
 * V1 quiz/homework summaries.
 */

import {
  Code2,
  Heading1,
  ImagePlus,
  Lightbulb,
  List,
  Minus,
  Square,
  Table2,
  Type,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import {
  changeDifficultyPatch,
  commitElementTextPatches,
  replaceImagePatch,
  updateElementPatch,
  updateSpeakerNotesPatch,
  updateTextPatch,
} from "@/lib/course/commands";
import { findSlide } from "@/lib/course/queries";
import { measureTextLikeHeight } from "../slide/elements/measureTextLike";
import type { TextLike } from "../slide/elements/TextLikeElement";
import { useEditorStore } from "@/lib/course/store";
import { useUIStore } from "@/lib/editor/uiStore";
import type {
  CourseDocument,
  CourseModule,
  HomeworkBlock,
  LessonNode,
  QuizBlock,
  QuizDifficulty,
  Selection,
  Slide,
  SlideElement,
} from "@/lib/course/types";
import { InlineText, InlineTextArea } from "../InlineText";
import { EmptyTabState, Field, PillGroup } from "./DesignTab";

const elementIcon: Record<SlideElement["type"], typeof Type> = {
  text: Type,
  heading: Heading1,
  bullet_list: List,
  code_block: Code2,
  image: ImagePlus,
  shape: Square,
  callout: Lightbulb,
  divider: Minus,
  table: Table2,
};

function elementSnippet(el: SlideElement): string {
  switch (el.type) {
    case "text":
    case "heading":
    case "callout":
      return el.text || "(empty)";
    case "bullet_list":
      return el.items[0] ?? "(empty list)";
    case "code_block":
      return el.code.split("\n")[0] ?? "";
    case "image":
      return el.alt || "(no alt text)";
    case "shape":
      return el.shape;
    case "divider":
      return el.orientation;
    case "table":
      return `${el.rows.length} rows`;
  }
}

function SlideContent({ slide, selection }: { slide: Slide; selection: Extract<Selection, { kind: "slide" }> }) {
  const apply = useEditorStore((s) => s.apply);
  const select = useEditorStore((s) => s.select);

  return (
    <>
      <Field label="Slide title (filmstrip label)">
        <InlineText
          value={slide.title ?? ""}
          aria-label="Slide title"
          placeholder="Untitled slide"
          onCommit={(v) =>
            apply(
              updateTextPatch(
                { kind: "slide", blockId: selection.blockId, slideId: slide.id, field: "title" },
                v
              ),
              "human"
            )
          }
          className="text-sm font-medium text-stone-800"
        />
      </Field>
      <Field label="Speaker notes">
        <InlineTextArea
          value={slide.speakerNotes ?? ""}
          aria-label="Speaker notes"
          placeholder="What will you say on this slide?"
          onCommit={(v) =>
            apply(updateSpeakerNotesPatch(selection.blockId, slide.id, v), "human")
          }
          className="text-xs leading-relaxed text-stone-600"
        />
      </Field>
      <Field label={`Elements (${slide.elements.length})`}>
        <ul className="space-y-0.5">
          {[...slide.elements]
            .sort((a, b) => b.zIndex - a.zIndex)
            .map((el) => {
              const Icon = elementIcon[el.type];
              return (
                <li key={el.id}>
                  <button
                    type="button"
                    onClick={() =>
                      select({
                        kind: "element",
                        id: el.id,
                        slideId: slide.id,
                        blockId: selection.blockId,
                        lessonId: selection.lessonId,
                      })
                    }
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-stone-50"
                  >
                    <Icon className="size-3.5 shrink-0 text-stone-400" />
                    <span className="min-w-0 flex-1 truncate text-xs text-stone-600">
                      {elementSnippet(el)}
                    </span>
                    {el.type === "image" && !el.alt && (
                      <span className="size-1.5 shrink-0 rounded-full bg-amber-400" title="Missing alt text" />
                    )}
                  </button>
                </li>
              );
            })}
        </ul>
      </Field>
    </>
  );
}

function ElementContent({
  el,
  selection,
}: {
  el: SlideElement;
  selection: Extract<Selection, { kind: "element" }>;
}) {
  const apply = useEditorStore((s) => s.apply);
  const applyMany = useEditorStore((s) => s.applyMany);
  const openImageDialog = useUIStore((s) => s.openImageDialog);
  const target = [selection.blockId, selection.slideId, el.id] as const;

  /** Text commits share the canvas auto-grow path (one undo: text + height). */
  function commitText(
    textLike: TextLike,
    updates: Parameters<typeof commitElementTextPatches>[3],
    draftValue: string
  ) {
    const hit = findSlide(useEditorStore.getState().doc, selection.blockId, selection.slideId);
    const themeId = hit?.slide.style.theme.id ?? "editorial-warm";
    applyMany(
      commitElementTextPatches(
        selection.blockId,
        selection.slideId,
        textLike,
        updates,
        measureTextLikeHeight(textLike, themeId, draftValue)
      ),
      "human"
    );
  }

  switch (el.type) {
    case "text":
    case "heading":
    case "callout":
      return (
        <>
          <Field label="Text">
            <InlineTextArea
              value={el.text}
              aria-label="Element text"
              onCommit={(text) => commitText(el, { text }, text)}
              className="text-xs leading-relaxed text-stone-700"
            />
          </Field>
          {el.type === "callout" && (
            <Field label="Callout variant">
              <PillGroup
                options={["info", "tip", "warning", "definition", "important"] as const}
                value={el.variant}
                label="Callout variant"
                onChange={(variant) =>
                  apply(updateElementPatch(...target, { variant }), "human")
                }
              />
            </Field>
          )}
        </>
      );

    case "bullet_list":
      return (
        <Field label="Bullets (one per line)">
          <InlineTextArea
            value={el.items.join("\n")}
            aria-label="Bullet items"
            onCommit={(v) =>
              commitText(
                el,
                { items: v.split("\n").filter((line) => line.trim().length > 0) },
                v
              )
            }
            className="text-xs leading-relaxed text-stone-700"
          />
        </Field>
      );

    case "code_block":
      return (
        <>
          <Field label="Language">
            <InlineText
              value={el.language}
              aria-label="Code language"
              onCommit={(language) =>
                apply(updateElementPatch(...target, { language }), "human")
              }
              className="text-xs text-stone-700"
            />
          </Field>
          <Field label="Code">
            <InlineTextArea
              value={el.code}
              aria-label="Code"
              onCommit={(code) => apply(updateElementPatch(...target, { code }), "human")}
              className="font-mono text-[11px] leading-relaxed text-stone-700"
            />
          </Field>
        </>
      );

    case "image":
      return (
        <>
          <Field label="Alt text">
            <InlineTextArea
              value={el.alt}
              aria-label="Image alt text"
              placeholder="Required — describe the image…"
              onCommit={(alt) => apply(updateElementPatch(...target, { alt }), "human")}
              className={cn(
                "text-xs leading-relaxed text-stone-700",
                !el.alt && "rounded-md ring-1 ring-amber-200"
              )}
            />
            {!el.alt && (
              <p className="mt-1 text-[10px] text-amber-600">
                Required for screen readers and AI agents.
              </p>
            )}
          </Field>
          <Field label="Caption">
            <InlineText
              value={el.caption ?? ""}
              aria-label="Image caption"
              placeholder="Optional caption…"
              onCommit={(caption) =>
                apply(updateElementPatch(...target, { caption }), "human")
              }
              className="text-xs text-stone-700"
            />
          </Field>
          <Field label="Attribution">
            <InlineText
              value={el.attribution ?? ""}
              aria-label="Image attribution"
              placeholder="Source / credit…"
              onCommit={(attribution) =>
                apply(updateElementPatch(...target, { attribution }), "human")
              }
              className="text-xs text-stone-700"
            />
          </Field>
          <Field label="Object fit">
            <PillGroup
              options={["cover", "contain"] as const}
              value={el.objectFit}
              label="Object fit"
              onChange={(objectFit) =>
                apply(updateElementPatch(...target, { objectFit }), "human")
              }
            />
          </Field>
          <div className="flex gap-1.5">
            <button
              type="button"
              data-ai-tool="replace-image"
              data-ai-action="REPLACE_IMAGE"
              aria-label="Replace this image"
              onClick={() =>
                openImageDialog({
                  blockId: selection.blockId,
                  slideId: selection.slideId,
                  elementCount: 0,
                  replaceElementId: el.id,
                })
              }
              className="flex-1 rounded-lg bg-stone-50 px-2 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100"
            >
              Replace image…
            </button>
            <button
              type="button"
              aria-label="Remove image (keep placeholder)"
              onClick={() =>
                apply(replaceImagePatch(selection.blockId, selection.slideId, el.id, "", ""), "human")
              }
              className="rounded-lg bg-stone-50 px-2 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:bg-rose-50 hover:text-rose-600"
            >
              Remove
            </button>
          </div>
        </>
      );

    case "shape":
      return (
        <Field label="Shape">
          <PillGroup
            options={["rectangle", "ellipse", "line", "arrow"] as const}
            value={el.shape}
            label="Shape kind"
            onChange={(shape) => apply(updateElementPatch(...target, { shape }), "human")}
          />
        </Field>
      );

    case "divider":
      return (
        <Field label="Orientation">
          <PillGroup
            options={["horizontal", "vertical"] as const}
            value={el.orientation}
            label="Divider orientation"
            onChange={(orientation) =>
              apply(updateElementPatch(...target, { orientation }), "human")
            }
          />
        </Field>
      );

    case "table":
      return (
        <EmptyTabState message="Table cells aren't editable in the canvas yet — ask the AI, or edit the JSON in the Metadata tab." />
      );
  }
}

const difficulties: QuizDifficulty[] = ["easy", "medium", "hard"];

export function ContentTab({
  selection,
  node,
  typeName,
}: {
  selection: Selection;
  node: unknown;
  typeName: string;
}) {
  const apply = useEditorStore((s) => s.apply);

  switch (selection.kind) {
    case "course": {
      const course = node as CourseDocument;
      return (
        <>
          <Field label="Description">
            <InlineTextArea
              value={course.description ?? ""}
              aria-label="Course description"
              placeholder="Describe the course…"
              onCommit={(v) =>
                apply(updateTextPatch({ kind: "course", field: "description" }, v), "human")
              }
              className="text-xs leading-relaxed text-stone-600"
            />
          </Field>
          <Field label="Audience">
            <InlineTextArea
              value={course.audience ?? ""}
              aria-label="Course audience"
              placeholder="Who is this for?"
              onCommit={(v) =>
                apply(updateTextPatch({ kind: "course", field: "audience" }, v), "human")
              }
              className="text-xs leading-relaxed text-stone-600"
            />
          </Field>
          <Field label="Level">
            <Badge tone="sky">{course.level ?? "unset"}</Badge>
          </Field>
        </>
      );
    }

    case "module": {
      const mod = node as CourseModule;
      return (
        <Field label="Description">
          <InlineTextArea
            value={mod.description ?? ""}
            aria-label="Module description"
            placeholder="What does this module cover?"
            onCommit={(v) =>
              apply(
                updateTextPatch({ kind: "module", id: mod.id, field: "description" }, v),
                "human"
              )
            }
            className="text-xs leading-relaxed text-stone-600"
          />
        </Field>
      );
    }

    case "lesson": {
      const lesson = node as LessonNode;
      return (
        <>
          <Field label="Objective">
            <InlineTextArea
              value={lesson.objective ?? ""}
              aria-label="Lesson objective"
              placeholder="What will learners be able to do?"
              onCommit={(v) =>
                apply(
                  updateTextPatch({ kind: "lesson", id: lesson.id, field: "objective" }, v),
                  "human"
                )
              }
              className="text-xs leading-relaxed text-stone-600"
            />
          </Field>
          <Field label="Contents">
            <p className="text-xs text-stone-600">
              {lesson.blocks.length} block{lesson.blocks.length === 1 ? "" : "s"}
              {lesson.estimatedMinutes ? ` · ~${lesson.estimatedMinutes} min` : ""}
            </p>
          </Field>
        </>
      );
    }

    case "slide":
      return <SlideContent slide={node as Slide} selection={selection} />;

    case "element":
      return <ElementContent el={node as SlideElement} selection={selection} />;

    case "block": {
      if (typeName === "quiz") {
        const block = node as QuizBlock;
        const mix = difficulties.map((d) => ({
          d,
          n: block.questions.filter((q) => q.difficulty === d).length,
        }));
        return (
          <>
            <Field label="Questions">
              <p className="text-xs text-stone-600">{block.questions.length} total</p>
              {block.questions.length > 0 && (
                <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-stone-100">
                  {mix.map(
                    ({ d, n }) =>
                      n > 0 && (
                        <div
                          key={d}
                          title={`${n} ${d}`}
                          style={{ width: `${(n / block.questions.length) * 100}%` }}
                          className={cn(
                            d === "easy" && "bg-emerald-300",
                            d === "medium" && "bg-amber-300",
                            d === "hard" && "bg-rose-300"
                          )}
                        />
                      )
                  )}
                </div>
              )}
            </Field>
            <Field label="Set all to">
              <div className="flex gap-1">
                {difficulties.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => apply(changeDifficultyPatch(block.id, d), "human")}
                    className="rounded-lg bg-stone-50 px-2.5 py-1 text-[11px] font-medium capitalize text-stone-500 transition-colors hover:bg-stone-100"
                  >
                    {d}
                  </button>
                ))}
              </div>
            </Field>
          </>
        );
      }
      if (typeName === "homework") {
        const block = node as HomeworkBlock;
        const points = block.rubric?.reduce((sum, r) => sum + r.points, 0) ?? 0;
        return (
          <Field label="Assignment">
            <p className="text-xs text-stone-600">
              {block.exercises.length} exercise{block.exercises.length === 1 ? "" : "s"}
              {block.rubric ? ` · rubric, ${points} pts` : " · no rubric"}
            </p>
          </Field>
        );
      }
      return (
        <EmptyTabState message="Edit this block's content directly in the workspace." />
      );
    }
  }
}
