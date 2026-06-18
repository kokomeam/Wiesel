"use client";

/**
 * Center column when a MODULE is selected: a clean overview of the module —
 * editable name (with the "Module N:" prefix), optional description, and the
 * list of lessons it contains, with a clear way to add more. Mirrors the
 * lesson workspace's "Add block" affordance at the module level.
 */

import { ChevronRight, FileText, Layers, Plus, Trash2 } from "lucide-react";
import { aiAttrs } from "@/lib/course/aiAttributes";
import { updateTextPatch } from "@/lib/course/commands";
import { createLesson } from "@/lib/course/factories";
import { moduleNumber, moduleNumberPrefix } from "@/lib/course/moduleLabel";
import { findModule } from "@/lib/course/queries";
import { useEditorStore } from "@/lib/course/store";
import type { LessonNode } from "@/lib/course/types";
import { confirmDeleteLesson, confirmDeleteModule } from "./deleteConfirm";
import { EditableName } from "./EditableName";
import { InlineTextArea } from "./InlineText";

function lessonMeta(lesson: LessonNode): string {
  const blocks = lesson.blocks.length;
  const parts = [`${blocks} block${blocks === 1 ? "" : "s"}`];
  if (lesson.estimatedMinutes) parts.push(`${lesson.estimatedMinutes} min`);
  return parts.join(" · ");
}

export function ModulePage({ moduleId }: { moduleId: string }) {
  const doc = useEditorStore((s) => s.doc);
  const apply = useEditorStore((s) => s.apply);
  const openLesson = useEditorStore((s) => s.openLesson);
  const select = useEditorStore((s) => s.select);

  const mod = findModule(doc, moduleId);
  if (!mod) {
    return (
      <div className="grid flex-1 place-items-center px-8">
        <div className="text-center">
          <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-sky-50">
            <Layers className="size-5 text-sky-600" />
          </div>
          <h2 className="text-sm font-semibold text-stone-900">Module not found</h2>
          <p className="mt-1 text-sm text-stone-400">Pick a module in the outline.</p>
        </div>
      </div>
    );
  }

  const n = moduleNumber(doc, moduleId);

  function addLesson() {
    if (!mod) return;
    const lesson = createLesson("New lesson", mod.lessons.length);
    const result = apply(
      { action: "ADD_LESSON", moduleId: mod.id, lesson },
      "human"
    );
    if (result.ok) openLesson(lesson.id); // jump straight into the new lesson
  }

  async function deleteThisModule() {
    if (await confirmDeleteModule(doc, apply, moduleId)) {
      select({ kind: "course" }); // module is gone — return to the course home
    }
  }

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-8 pb-10 pt-8">
        <header
          {...aiAttrs({
            component: "module-header",
            type: "module",
            id: mod.id,
            order: mod.order,
            purpose: mod.description,
            label: `Module: ${mod.title}`,
          })}
          className="mb-7"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-sky-600">
                <Layers className="size-3" />
                Module {n} of {doc.modules.length}
              </p>
              <EditableName
                value={mod.title}
                prefix={moduleNumberPrefix(n)}
                aria-label="Module name"
                placeholder="Module name"
                onCommit={(v) =>
                  apply(updateTextPatch({ kind: "module", id: mod.id, field: "title" }, v), "human")
                }
                className="text-2xl font-semibold tracking-tight text-stone-900"
              />
              <InlineTextArea
                value={mod.description ?? ""}
                aria-label="Module description"
                placeholder="Add a short description for this module…"
                onCommit={(v) =>
                  apply(
                    updateTextPatch({ kind: "module", id: mod.id, field: "description" }, v),
                    "human"
                  )
                }
                className="mt-1.5 text-sm text-stone-500"
              />
            </div>
            <button
              type="button"
              onClick={() => void deleteThisModule()}
              title="Delete module"
              className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-500 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
            >
              <Trash2 className="size-3.5" />
              Delete
            </button>
          </div>
        </header>

        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
            {mod.lessons.length} lesson{mod.lessons.length === 1 ? "" : "s"}
          </h2>
        </div>

        {mod.lessons.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-200 bg-white/60 px-8 py-14 text-center">
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-brand-50">
              <FileText className="size-5 text-brand-500" />
            </div>
            <h3 className="text-sm font-semibold text-stone-900">No lessons yet</h3>
            <p className="mx-auto mt-1 mb-5 max-w-sm text-sm text-stone-400">
              Lessons hold your slides, readings, quizzes, and practice. Add the
              first one to start building this module.
            </p>
            <div className="mx-auto max-w-xs">
              <button
                type="button"
                onClick={addLesson}
                className="flex w-full items-center justify-center gap-2 rounded-xl brand-gradient py-2.5 text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-opacity hover:opacity-95"
              >
                <Plus className="size-4" />
                Add lesson
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {mod.lessons.map((lesson, i) => (
              <div key={lesson.id} className="group relative">
                <button
                  type="button"
                  {...aiAttrs({
                    component: "module-lesson-row",
                    type: "lesson",
                    id: lesson.id,
                    parentId: mod.id,
                    order: lesson.order,
                    purpose: lesson.objective,
                    label: `Lesson: ${lesson.title}`,
                    interactive: true,
                  })}
                  onClick={() => openLesson(lesson.id)}
                  className="flex w-full items-center gap-4 rounded-xl border border-stone-200/80 bg-white px-4 py-3 text-left shadow-[0_1px_2px_rgba(68,48,28,0.04)] transition-colors hover:border-brand-200 hover:bg-brand-50/40"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-stone-100 text-xs font-semibold text-stone-500 transition-colors group-hover:bg-brand-100 group-hover:text-brand-700">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-stone-900">
                      {lesson.title}
                    </span>
                    <span className="block truncate text-xs text-stone-400">
                      {lesson.objective?.trim() || lessonMeta(lesson)}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-[11px] text-stone-300 transition-opacity group-hover:opacity-0 sm:block">
                    {lessonMeta(lesson)}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-stone-300 transition-all group-hover:opacity-0" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void confirmDeleteLesson(doc, apply, lesson.id);
                  }}
                  aria-label={`Delete ${lesson.title}`}
                  title="Delete lesson"
                  className="absolute right-3 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-stone-400 opacity-0 transition-all hover:bg-rose-50 hover:text-rose-600 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}

            <button
              type="button"
              onClick={addLesson}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 py-3 text-sm font-medium text-stone-500 transition-colors hover:border-brand-300 hover:bg-brand-50/30 hover:text-brand-600"
            >
              <Plus className="size-4" />
              Add lesson
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
