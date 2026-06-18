"use client";

/**
 * Center column when the COURSE root is selected: the course "home" — an
 * overview of every module with a clear way to add more. Mirrors ModulePage's
 * lesson UX one level up: a prominent empty state when the course has no
 * modules yet, and a list of preview cards once it does (the gap the user
 * hit — a blank course gave no obvious way to add the first module).
 *
 * Modules carry a light-blue (sky) identity here and across the studio,
 * deliberately distinct from the warm-orange lesson/content accent so the two
 * levels read apart at a glance.
 */

import { ChevronRight, Layers, Plus, Trash2 } from "lucide-react";
import { aiAttrs } from "@/lib/course/aiAttributes";
import { updateTextPatch } from "@/lib/course/commands";
import { createModule } from "@/lib/course/factories";
import { useEditorStore } from "@/lib/course/store";
import type { CourseModule } from "@/lib/course/types";
import { confirmDeleteModule } from "./deleteConfirm";
import { EditableName } from "./EditableName";
import { InlineTextArea } from "./InlineText";

function moduleMeta(mod: CourseModule): string {
  const lessons = mod.lessons.length;
  const blocks = mod.lessons.reduce((n, l) => n + l.blocks.length, 0);
  const parts = [`${lessons} lesson${lessons === 1 ? "" : "s"}`];
  if (blocks) parts.push(`${blocks} block${blocks === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function CoursePage() {
  const doc = useEditorStore((s) => s.doc);
  const apply = useEditorStore((s) => s.apply);
  const select = useEditorStore((s) => s.select);

  function addModule() {
    const mod = createModule("New module", doc.modules.length);
    const result = apply({ action: "ADD_MODULE", module: mod }, "human");
    if (result.ok) select({ kind: "module", id: mod.id }); // jump into the new module
  }

  const count = doc.modules.length;

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-8 pb-10 pt-8">
        <header
          {...aiAttrs({
            component: "course-header",
            type: "course",
            id: doc.id,
            purpose: doc.description,
            label: `Course: ${doc.title}`,
          })}
          className="mb-7"
        >
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
            Course overview
          </p>
          <EditableName
            value={doc.title}
            aria-label="Course title"
            placeholder="Course title"
            onCommit={(v) =>
              apply(updateTextPatch({ kind: "course", field: "title" }, v), "human")
            }
            className="text-2xl font-semibold tracking-tight text-stone-900"
          />
          <InlineTextArea
            value={doc.description ?? ""}
            aria-label="Course description"
            placeholder="Add a short description for this course…"
            onCommit={(v) =>
              apply(updateTextPatch({ kind: "course", field: "description" }, v), "human")
            }
            className="mt-1.5 text-sm text-stone-500"
          />
        </header>

        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">
            {count} module{count === 1 ? "" : "s"}
          </h2>
        </div>

        {count === 0 ? (
          <div className="rounded-2xl border border-dashed border-sky-200 bg-sky-50/40 px-8 py-14 text-center">
            <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-sky-100 text-sky-600">
              <Layers className="size-5" />
            </div>
            <h3 className="text-sm font-semibold text-stone-900">No modules yet</h3>
            <p className="mx-auto mt-1 mb-5 max-w-sm text-sm text-stone-400">
              Modules group related lessons into chapters. Add the first one to
              start shaping your course.
            </p>
            <div className="mx-auto max-w-xs">
              <button
                type="button"
                onClick={addModule}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 py-2.5 text-sm font-medium text-white shadow-sm shadow-sky-600/25 transition-colors hover:bg-sky-700"
              >
                <Plus className="size-4" />
                Add module
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {doc.modules.map((mod, i) => (
              <div key={mod.id} className="group relative">
                <button
                  type="button"
                  {...aiAttrs({
                    component: "course-module-row",
                    type: "module",
                    id: mod.id,
                    order: mod.order,
                    purpose: mod.description,
                    label: `Module: ${mod.title}`,
                    interactive: true,
                  })}
                  onClick={() => select({ kind: "module", id: mod.id })}
                  className="flex w-full items-center gap-4 rounded-xl border border-stone-200/80 bg-white px-4 py-3 text-left shadow-[0_1px_2px_rgba(68,48,28,0.04)] transition-colors hover:border-sky-200 hover:bg-sky-50/40"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sky-100 text-xs font-semibold text-sky-700 transition-colors group-hover:bg-sky-200">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-stone-900">
                      <span className="text-sky-600">Module {i + 1}:</span>{" "}
                      {mod.title}
                    </span>
                    <span className="block truncate text-xs text-stone-400">
                      {mod.description?.trim() || moduleMeta(mod)}
                    </span>
                  </span>
                  <span className="hidden shrink-0 text-[11px] text-stone-300 transition-opacity group-hover:opacity-0 sm:block">
                    {moduleMeta(mod)}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-stone-300 transition-all group-hover:opacity-0" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void confirmDeleteModule(doc, apply, mod.id);
                  }}
                  aria-label={`Delete ${mod.title}`}
                  title="Delete module"
                  className="absolute right-3 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-stone-400 opacity-0 transition-all hover:bg-rose-50 hover:text-rose-600 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}

            <button
              type="button"
              onClick={addModule}
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 py-3 text-sm font-medium text-stone-500 transition-colors hover:border-sky-300 hover:bg-sky-50/30 hover:text-sky-600"
            >
              <Plus className="size-4" />
              Add module
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
