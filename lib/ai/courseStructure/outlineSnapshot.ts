/**
 * Course Structure — the deterministic course-tree snapshot.
 *
 * `buildOutlineSnapshot` is the grounding the structure model resolves targets
 * against: every module/lesson with its stable id, the "Module N:" display label,
 * and a deterministic `isEmpty` flag — but NO slide/block payloads, so it stays
 * small and (within a course) byte-stable for caching. `list_course_outline`
 * (a read tool) returns it; `runStructureAgentTurn` serializes it into the plan
 * context message.
 */

import { moduleDisplayName, moduleNumber } from "@/lib/course/moduleLabel";
import type { CourseDocument } from "@/lib/course/types";
import { isLessonEmpty } from "./structureTools";
import type { CourseOutlineSnapshot, SnapshotLesson } from "./types";

/** A compact, one-line description of what a lesson contains (block-type counts). */
function lessonContentSummary(blocks: { type: string }[]): string {
  if (blocks.length === 0) return "no content yet";
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, n]) => `${n} ${type.replace("_", " ")}`).join(", ");
}

/** Build the deterministic outline snapshot for the whole course. `selected` ties
 *  the docked lesson/module so the model can resolve "this lesson" / "this module". */
export function buildOutlineSnapshot(
  doc: CourseDocument,
  selected: { moduleId?: string; lessonId?: string } = {}
): CourseOutlineSnapshot {
  return {
    courseId: doc.id,
    courseTitle: doc.title,
    selected,
    modules: doc.modules.map((m, mi) => ({
      moduleId: m.id,
      number: moduleNumber(doc, m.id) || mi + 1,
      displayName: moduleDisplayName(moduleNumber(doc, m.id) || mi + 1, m.title),
      title: m.title,
      order: m.order,
      lessonCount: m.lessons.length,
      lessons: m.lessons.map((l, li): SnapshotLesson => ({
        lessonId: l.id,
        index: li,
        title: l.title,
        objective: l.objective ?? null,
        blockCount: l.blocks.length,
        isEmpty: isLessonEmpty(l),
        hasDeck: l.blocks.some((b) => b.type === "slide_deck" || b.type === "imported_deck"),
        contentSummary: lessonContentSummary(l.blocks),
      })),
    })),
  };
}

/** Render the snapshot as compact text for the plan context message — one line per
 *  lesson with its id, emptiness, and a content summary; the docked lesson/module
 *  is marked so "this lesson"/"this module" resolve. The model MUST use these exact
 *  ids (never invent them). */
export function serializeOutlineSnapshot(snapshot: CourseOutlineSnapshot): string {
  const lines: string[] = [`COURSE OUTLINE — "${snapshot.courseTitle}" (use these EXACT ids; never invent ids):`];
  if (snapshot.modules.length === 0) lines.push("  (no modules yet)");
  for (const m of snapshot.modules) {
    const here = m.moduleId === snapshot.selected.moduleId ? "  ◀ current module" : "";
    // Flag a module that still has no real title (default/empty) so a repair plan
    // knows to set one via rename_module.
    const untitled = !m.title.trim() || /^new module$/i.test(m.title.trim()) ? "  ⚠ NO TITLE" : "";
    lines.push(`• ${m.displayName}  [moduleId=${m.moduleId}]${here}${untitled}`);
    if (m.lessons.length === 0) lines.push("    (no lessons)");
    for (const l of m.lessons) {
      const flags = [l.isEmpty ? "EMPTY" : l.contentSummary, l.lessonId === snapshot.selected.lessonId ? "◀ current lesson" : ""]
        .filter(Boolean)
        .join(" · ");
      lines.push(`    - L${l.index + 1} "${l.title}"  [lessonId=${l.lessonId}]  (${flags})`);
    }
  }
  return lines.join("\n");
}

/** The lesson ids the snapshot marks EMPTY (for the delete_empty_lessons flow). */
export function emptyLessonIds(snapshot: CourseOutlineSnapshot, moduleId?: string): string[] {
  return snapshot.modules
    .filter((m) => !moduleId || m.moduleId === moduleId)
    .flatMap((m) => m.lessons.filter((l) => l.isEmpty).map((l) => l.lessonId));
}
