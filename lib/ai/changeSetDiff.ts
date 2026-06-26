/**
 * Pure block-level diff between two CourseDocuments.
 *
 * After the agent applies a turn's patches, we diff the document as it was at
 * the START of the turn against its END state to produce the change-set's
 * per-block before/after snapshots (what the editor highlights and what Reject
 * restores). Block-centric by design: structural additions (a new module or
 * lesson) persist but aren't part of the per-block review surface.
 *
 * No DB, no React — trivially testable.
 */

import type { BlockType, CourseDocument, LessonBlock } from "@/lib/course/types";

export type BlockOp = "create" | "update" | "delete";

export interface BlockChange {
  blockId: string;
  op: BlockOp;
  before: LessonBlock | null;
  after: LessonBlock | null;
  lessonId: string;
  blockType: BlockType;
}

function indexBlocks(
  doc: CourseDocument
): Map<string, { block: LessonBlock; lessonId: string }> {
  const map = new Map<string, { block: LessonBlock; lessonId: string }>();
  for (const mod of doc.modules) {
    for (const lesson of mod.lessons) {
      for (const block of lesson.blocks) {
        map.set(block.id, { block, lessonId: lesson.id });
      }
    }
  }
  return map;
}

/** Stable structural equality (blocks are plain JSON). */
function blocksEqual(a: LessonBlock, b: LessonBlock): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Block-level changes from `oldDoc` → `newDoc`. */
export function diffBlocks(
  oldDoc: CourseDocument,
  newDoc: CourseDocument
): BlockChange[] {
  const before = indexBlocks(oldDoc);
  const after = indexBlocks(newDoc);
  const changes: BlockChange[] = [];

  for (const [id, { block, lessonId }] of after) {
    const prev = before.get(id);
    if (!prev) {
      changes.push({ blockId: id, op: "create", before: null, after: block, lessonId, blockType: block.type });
    } else if (!blocksEqual(prev.block, block)) {
      changes.push({ blockId: id, op: "update", before: prev.block, after: block, lessonId, blockType: block.type });
    }
  }
  for (const [id, { block, lessonId }] of before) {
    if (!after.has(id)) {
      changes.push({ blockId: id, op: "delete", before: block, after: null, lessonId, blockType: block.type });
    }
  }
  return changes;
}

/** The block ids touched by a change set (what the editor highlights). */
export function changedBlockIds(changes: BlockChange[]): string[] {
  return changes.map((c) => c.blockId);
}

/**
 * The subtree an agent run actually touched, derived by diffing the run-START
 * baseline doc against the run's current doc. Both are the agent's OWN in-memory
 * states, so a concurrent human delete never appears here — that's what makes
 * "rows the agent touched" unambiguous (a module the agent created looks
 * identical to one the user deleted when diffing against the DB, but not when
 * diffing baseline → current). The scoped reconcile (`reconcileCourseDocScoped`)
 * writes ONLY this subtree, so it can never re-insert / shield a module the
 * agent never touched.
 */
export interface AgentTouchScope {
  /** Modules the agent CREATED this run (present in current, absent in baseline). */
  newModuleIds: string[];
  /** Lessons the agent authored/edited (a block change) or newly added this run. */
  touchedLessonIds: string[];
  /** The subset of `touchedLessonIds` the agent CREATED this run (absent in
   *  baseline). They must always be written — unlike a PRE-EXISTING touched lesson,
   *  their absence from the DB means "not persisted yet", not "user deleted it",
   *  so they are exempt from the reconcile's delete-wins prune. */
  newLessonIds: string[];
}

export function agentTouchScope(
  baseline: CourseDocument,
  current: CourseDocument
): AgentTouchScope {
  const baselineModuleIds = new Set(baseline.modules.map((m) => m.id));
  const baselineLessonIds = new Set(
    baseline.modules.flatMap((m) => m.lessons.map((l) => l.id))
  );

  const newModuleIds = current.modules
    .filter((m) => !baselineModuleIds.has(m.id))
    .map((m) => m.id);

  const touched = new Set<string>();
  const newLessons = new Set<string>();
  // Lessons with any block create / update / delete this run.
  for (const change of diffBlocks(baseline, current)) touched.add(change.lessonId);
  // Newly-added lessons (covers an empty new lesson that has no blocks yet).
  for (const m of current.modules) {
    for (const l of m.lessons) {
      if (!baselineLessonIds.has(l.id)) {
        touched.add(l.id);
        newLessons.add(l.id);
      }
    }
  }

  return { newModuleIds, touchedLessonIds: [...touched], newLessonIds: [...newLessons] };
}
