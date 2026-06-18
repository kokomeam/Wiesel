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
import type { CourseDocument } from "@/lib/course/types";
import { confirm } from "@/lib/editor/confirmStore";

type Apply = (patch: unknown, source: "human" | "ai") => PatchResult;

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
  if (ok) apply(deleteModulePatch(moduleId), "human");
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
  if (ok) apply(deleteLessonPatch(lessonId), "human");
  return ok;
}
