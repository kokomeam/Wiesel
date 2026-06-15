/**
 * "Module N:" display convention. Modules are always shown to creators AND
 * learners as `Module {n}: {name}`, where N is the module's 1-based position
 * — so the number stays correct automatically after reordering. Only the
 * name after the colon is stored/edited (`module.title`); the prefix is
 * always derived, never persisted.
 */

import type { CourseDocument } from "./types";

/** 1-based position of a module in the course (0 if not found). */
export function moduleNumber(doc: CourseDocument, moduleId: string): number {
  const i = doc.modules.findIndex((m) => m.id === moduleId);
  return i < 0 ? 0 : i + 1;
}

/** The non-editable prefix, e.g. "Module 1:". */
export function moduleNumberPrefix(n: number): string {
  return `Module ${n}:`;
}

/** Full display label, e.g. "Module 1: Foundations". */
export function moduleDisplayName(n: number, title: string): string {
  return `${moduleNumberPrefix(n)} ${title}`.trimEnd();
}
