"use client";

/**
 * Shared "confirm, then delete" helpers for the manual delete affordances
 * (sidebar, course page, module page). Each pops the ConfirmDialog naming the
 * exact target, and only applies the destructive patch if the user agrees.
 * Returns whether the delete happened, so callers can react (e.g. navigate away
 * from a module they just removed).
 */

import { deleteLessonPatch, deleteModulePatch } from "@/lib/course/commands";
import { moduleDisplayName, moduleNumber } from "@/lib/course/moduleLabel";
import type { PatchResult } from "@/lib/course/patches";
import { findLesson, findModule } from "@/lib/course/queries";
import { useEditorStore } from "@/lib/course/store";
import type { CourseDocument } from "@/lib/course/types";
import { deleteLessonNow, deleteModuleNow } from "@/lib/editor/coursePersistence";
import { confirm } from "@/lib/editor/confirmStore";

type Apply = (patch: unknown, source: "human" | "ai") => PatchResult;

/**
 * During an agent run, autosave is paused and the live re-sync replaces the editor
 * doc from the DB — so a deleted module/lesson that hasn't been persisted reappears.
 * Persist the structural delete directly so the row is gone before the next sync.
 * Best-effort: the in-memory delete already happened and autosave will reconcile it
 * once the run ends; a failure here just risks a transient repaint, so we only log.
 */
async function persistStructuralDeleteDuringRun(
  kind: "module" | "lesson",
  courseId: string,
  id: string
): Promise<void> {
  if (!useEditorStore.getState().agentRunActive) return;
  const err = kind === "module" ? await deleteModuleNow(courseId, id) : await deleteLessonNow(courseId, id);
  if (err) console.error(`Immediate ${kind} delete failed (will reconcile after the run):`, err);
}

export async function confirmDeleteModule(
  doc: CourseDocument,
  apply: Apply,
  moduleId: string
): Promise<boolean> {
  const mod = findModule(doc, moduleId);
  if (!mod) return false;
  const label = moduleDisplayName(moduleNumber(doc, moduleId), mod.title);
  const lessons = mod.lessons.length;
  const ok = await confirm({
    title: "Delete this module?",
    tone: "danger",
    confirmLabel: "Delete module",
    message: (
      <>
        <b className="font-semibold text-stone-700">{label}</b>
        {lessons > 0
          ? ` and its ${lessons} lesson${lessons === 1 ? "" : "s"} will be permanently removed.`
          : " will be permanently removed."}{" "}
        This can&rsquo;t be undone.
      </>
    ),
  });
  if (ok) {
    apply(deleteModulePatch(moduleId), "human");
    await persistStructuralDeleteDuringRun("module", doc.id, moduleId);
  }
  return ok;
}

export async function confirmDeleteLesson(
  doc: CourseDocument,
  apply: Apply,
  lessonId: string
): Promise<boolean> {
  const hit = findLesson(doc, lessonId);
  if (!hit) return false;
  const blocks = hit.lesson.blocks.length;
  const ok = await confirm({
    title: "Delete this lesson?",
    tone: "danger",
    confirmLabel: "Delete lesson",
    message: (
      <>
        <b className="font-semibold text-stone-700">{hit.lesson.title}</b>
        {blocks > 0
          ? ` and its ${blocks} block${blocks === 1 ? "" : "s"} of content will be permanently removed.`
          : " will be permanently removed."}{" "}
        This can&rsquo;t be undone.
      </>
    ),
  });
  if (ok) {
    apply(deleteLessonPatch(lessonId), "human");
    await persistStructuralDeleteDuringRun("lesson", doc.id, lessonId);
  }
  return ok;
}
