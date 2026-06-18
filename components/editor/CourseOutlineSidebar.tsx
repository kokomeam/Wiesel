"use client";

/**
 * Left column: course outline with drag-reorder. One DndContext covers both
 * scopes — modules, and lessons within each module (cross-module dragging is
 * deliberately out of scope; the REORDER_LESSON patch supports it for a
 * future iteration). Drops emit REORDER_MODULE / REORDER_LESSON patches.
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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BookOpen, GripVertical, PanelLeftClose, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { aiAttrs, toolAttrs } from "@/lib/course/aiAttributes";
import { addLessonPatch, addModulePatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import { useUIStore } from "@/lib/editor/uiStore";
import type { CourseModule, LessonNode } from "@/lib/course/types";
import { confirmDeleteLesson, confirmDeleteModule } from "./deleteConfirm";

function SortableLesson({
  lesson,
  module,
}: {
  lesson: LessonNode;
  module: CourseModule;
}) {
  const doc = useEditorStore((s) => s.doc);
  const apply = useEditorStore((s) => s.apply);
  const activeLessonId = useEditorStore((s) => s.activeLessonId);
  const openLesson = useEditorStore((s) => s.openLesson);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: lesson.id });

  const active = lesson.id === activeLessonId;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("group/lesson relative", isDragging && "z-10 opacity-80")}
    >
      <button
        type="button"
        {...aiAttrs({
          component: "course-outline-lesson",
          type: "lesson",
          id: lesson.id,
          parentId: module.id,
          order: lesson.order,
          purpose: lesson.objective,
          label: `Lesson: ${lesson.title}`,
          interactive: true,
        })}
        onClick={() => openLesson(lesson.id)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg py-1.5 pl-7 pr-7 text-left text-[13px] transition-colors",
          active
            ? "bg-brand-50 font-medium text-brand-700"
            : "text-stone-600 hover:bg-stone-50 hover:text-stone-900"
        )}
      >
        <span className="min-w-0 flex-1 truncate">{lesson.title}</span>
        {lesson.estimatedMinutes !== undefined && (
          <span
            className={cn(
              "shrink-0 text-[11px] transition-opacity group-hover/lesson:opacity-0",
              active ? "text-brand-400" : "text-stone-300"
            )}
          >
            {lesson.estimatedMinutes}m
          </span>
        )}
      </button>
      <span
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder ${lesson.title}`}
        className="absolute left-1.5 top-1/2 -translate-y-1/2 cursor-grab touch-none text-stone-300 opacity-0 transition-opacity hover:text-stone-500 group-hover/lesson:opacity-100"
      >
        <GripVertical className="size-3.5" />
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void confirmDeleteLesson(doc, apply, lesson.id);
        }}
        aria-label={`Delete lesson ${lesson.title}`}
        title="Delete lesson"
        className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-md text-stone-300 opacity-0 transition-opacity hover:bg-rose-50 hover:text-rose-600 focus-visible:opacity-100 group-hover/lesson:opacity-100"
      >
        <Trash2 className="size-3" />
      </button>
    </div>
  );
}

function SortableModule({ module, index }: { module: CourseModule; index: number }) {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const apply = useEditorStore((s) => s.apply);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: module.id });

  const selected = selection.kind === "module" && selection.id === module.id;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...aiAttrs({
        component: "course-outline-module",
        type: "module",
        id: module.id,
        order: module.order,
        purpose: module.description,
        label: `Module: ${module.title}`,
      })}
      className={cn("group/module mb-1", isDragging && "z-10 opacity-80")}
    >
      <div className="relative flex items-center">
        <span
          {...attributes}
          {...listeners}
          aria-label={`Drag to reorder ${module.title}`}
          className="absolute left-1.5 cursor-grab touch-none text-stone-300 opacity-0 transition-opacity hover:text-stone-500 group-hover/module:opacity-100"
        >
          <GripVertical className="size-3.5" />
        </span>
        <button
          type="button"
          onClick={() => select({ kind: "module", id: module.id })}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-7 pr-2 text-left transition-colors",
            // Modules carry a light-blue (sky) identity — distinct from the
            // warm-orange course/lesson accent — so the levels read apart.
            selected ? "bg-sky-50" : "hover:bg-stone-50"
          )}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs font-semibold tracking-tight",
              selected ? "text-sky-700" : "text-stone-700"
            )}
          >
            <span className={selected ? "text-sky-600" : "text-sky-500"}>
              Module {index + 1}:
            </span>{" "}
            {module.title}
          </span>
          <span className="shrink-0 text-[11px] text-stone-300 transition-opacity group-hover/module:opacity-0">
            {module.lessons.length}
          </span>
        </button>
        <span className="absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/module:opacity-100">
          <button
            type="button"
            title="Add lesson"
            aria-label={`Add lesson to ${module.title}`}
            onClick={() =>
              apply(addLessonPatch(module.id, module.lessons.length), "human")
            }
            className="grid size-5 place-items-center rounded-md text-stone-300 transition-colors hover:bg-stone-100 hover:text-brand-600"
          >
            <Plus className="size-3" />
          </button>
          <button
            type="button"
            title="Delete module"
            aria-label={`Delete module ${module.title}`}
            onClick={() => void confirmDeleteModule(doc, apply, module.id)}
            className="grid size-5 place-items-center rounded-md text-stone-300 transition-colors hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="size-3" />
          </button>
        </span>
      </div>
      <SortableContext
        items={module.lessons.map((l) => l.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="mt-0.5 space-y-0.5">
          {module.lessons.map((lesson) => (
            <SortableLesson key={lesson.id} lesson={lesson} module={module} />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

export function CourseOutlineSidebar() {
  const doc = useEditorStore((s) => s.doc);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const apply = useEditorStore((s) => s.apply);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    const moduleIds = doc.modules.map((m) => m.id);
    if (moduleIds.includes(activeId)) {
      const toIndex = moduleIds.indexOf(overId);
      if (toIndex === -1) return;
      apply({ action: "REORDER_MODULE", moduleId: activeId, toIndex }, "human");
      return;
    }

    const sourceModule = doc.modules.find((m) =>
      m.lessons.some((l) => l.id === activeId)
    );
    if (!sourceModule) return;
    const toIndex = sourceModule.lessons.findIndex((l) => l.id === overId);
    if (toIndex === -1) return; // cross-module drop: not supported yet
    apply({ action: "REORDER_LESSON", lessonId: activeId, toIndex }, "human");
  }

  return (
    <aside
      {...aiAttrs({
        component: "course-outline",
        type: "course",
        id: doc.id,
        purpose: "Navigable outline of the course's modules and lessons.",
        label: `Course outline: ${doc.title}`,
      })}
      className="flex w-72 shrink-0 flex-col border-r border-stone-200 bg-white"
    >
      <div className="mx-3 mt-3 flex items-center gap-1">
        <button
          type="button"
          onClick={() => select({ kind: "course" })}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors",
            selection.kind === "course" ? "bg-brand-50" : "hover:bg-stone-50"
          )}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand-100 text-brand-700">
            <BookOpen className="size-3.5" />
          </span>
          <span className="min-w-0">
            <span
              className={cn(
                "block truncate text-sm font-semibold",
                selection.kind === "course" ? "text-brand-700" : "text-stone-900"
              )}
            >
              {doc.title}
            </span>
            <span className="block text-[11px] capitalize text-stone-400">
              {doc.level} · {doc.modules.length} modules
            </span>
          </span>
        </button>
        <button
          type="button"
          {...toolAttrs({
            tool: "collapse-outline",
            action: "TOGGLE_PANEL",
            targetType: "panel",
            label: "Collapse the course outline",
          })}
          onClick={() => useUIStore.getState().togglePanel("outline")}
          className="grid size-6 shrink-0 place-items-center rounded-md text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-600"
        >
          <PanelLeftClose className="size-3.5" />
        </button>
      </div>

      <div className="mt-3 flex-1 overflow-y-auto px-3 pb-3 scrollbar-thin">
        {/* Stable id keeps dnd-kit's generated aria attributes identical
            between server render and client hydration. */}
        <DndContext
          id="course-outline-dnd"
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={doc.modules.map((m) => m.id)}
            strategy={verticalListSortingStrategy}
          >
            {doc.modules.map((module, index) => (
              <SortableModule key={module.id} module={module} index={index} />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      <div className="border-t border-stone-100 p-3">
        <button
          type="button"
          onClick={() => apply(addModulePatch(useEditorStore.getState().doc), "human")}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 py-2 text-xs font-medium text-stone-500 transition-colors hover:border-brand-300 hover:text-brand-600"
        >
          <Plus className="size-3.5" />
          Add module
        </button>
      </div>
    </aside>
  );
}
