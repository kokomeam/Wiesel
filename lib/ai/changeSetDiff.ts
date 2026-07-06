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

import type { BlockType, CourseDocument, CourseModule, LessonBlock, LessonNode } from "@/lib/course/types";

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

/* ───────────────────────── Structural diff (modules / lessons) ──────────────
 * The block diff above is the per-BLOCK review surface. The Course Structure
 * agent also creates / renames / moves / deletes whole lessons and modules; those
 * are diffed here so they become reviewable + reject-able change-set items too.
 * Pure + DB-free, mirroring diffBlocks. */

export type StructureNodeType = "module" | "lesson";

/**
 * Self-describing snapshot stored in `change_set_items.before/after` for a
 * structural item — carries everything `revertChangeSet` needs to invert the op
 * (the node itself for create/delete re-add, the changed metadata + position for
 * a rename/move). The `kind` tag makes the jsonb self-describing.
 */
export type StructureSnapshot =
  | { kind: "lesson"; lesson: LessonNode; moduleId: string; atIndex: number }
  | { kind: "lesson_meta"; title: string; objective: string | null; moduleId: string; index: number }
  | { kind: "module"; module: CourseModule; atIndex: number }
  | { kind: "module_meta"; title: string };

export interface StructureChange {
  nodeType: StructureNodeType;
  nodeId: string;
  op: BlockOp; // create | update(rename/move) | delete
  before: StructureSnapshot | null;
  after: StructureSnapshot | null;
}

function indexLessonsWithPosition(
  doc: CourseDocument
): Map<string, { lesson: LessonNode; moduleId: string; index: number }> {
  const map = new Map<string, { lesson: LessonNode; moduleId: string; index: number }>();
  for (const m of doc.modules) {
    m.lessons.forEach((l, i) => map.set(l.id, { lesson: l, moduleId: m.id, index: i }));
  }
  return map;
}

/**
 * Structural changes from `oldDoc` → `newDoc`. Reports module/lesson
 * create / delete / rename / cross-module-move. A pure same-module REORDER (only
 * the index shifts, e.g. as a side effect of a sibling create/delete) is NOT
 * reported — that would flood the review with index noise; reorders persist and
 * are visible in the outline. A CONTENT-only change to a lesson (its blocks) is
 * owned by `diffBlocks`, so it produces no StructureChange here.
 */
export function diffStructure(oldDoc: CourseDocument, newDoc: CourseDocument): StructureChange[] {
  const changes: StructureChange[] = [];

  // ── Modules ──
  const oldMods = new Map(oldDoc.modules.map((m, i) => [m.id, { module: m, atIndex: i }]));
  const newMods = new Map(newDoc.modules.map((m, i) => [m.id, { module: m, atIndex: i }]));
  // A created / deleted MODULE owns its whole subtree (lessons + their blocks) via its
  // snapshot — so we DON'T also emit per-lesson (or per-block) changes for it (that
  // would double-count and double-restore on revert).
  const createdModuleIds = new Set([...newMods.keys()].filter((id) => !oldMods.has(id)));
  const deletedModuleIds = new Set([...oldMods.keys()].filter((id) => !newMods.has(id)));
  for (const [id, { module, atIndex }] of newMods) {
    const prev = oldMods.get(id);
    if (!prev) {
      changes.push({ nodeType: "module", nodeId: id, op: "create", before: null, after: { kind: "module", module, atIndex } });
    } else if (prev.module.title !== module.title) {
      changes.push({
        nodeType: "module",
        nodeId: id,
        op: "update",
        before: { kind: "module_meta", title: prev.module.title },
        after: { kind: "module_meta", title: module.title },
      });
    }
  }
  for (const [id, { module, atIndex }] of oldMods) {
    if (!newMods.has(id)) changes.push({ nodeType: "module", nodeId: id, op: "delete", before: { kind: "module", module, atIndex }, after: null });
  }

  // ── Lessons (skip those owned by a created/deleted module) ──
  const oldL = indexLessonsWithPosition(oldDoc);
  const newL = indexLessonsWithPosition(newDoc);
  for (const [id, cur] of newL) {
    if (createdModuleIds.has(cur.moduleId)) continue; // owned by the module-create snapshot
    const prev = oldL.get(id);
    if (!prev) {
      changes.push({ nodeType: "lesson", nodeId: id, op: "create", before: null, after: { kind: "lesson", lesson: cur.lesson, moduleId: cur.moduleId, atIndex: cur.index } });
      continue;
    }
    // Update = rename (title/objective) or cross-module move. Bare index shifts are
    // ignored (see the doc comment) — but the index IS recorded for move-revert.
    const renamed = prev.lesson.title !== cur.lesson.title || (prev.lesson.objective ?? null) !== (cur.lesson.objective ?? null);
    const moved = prev.moduleId !== cur.moduleId;
    if (renamed || moved) {
      changes.push({
        nodeType: "lesson",
        nodeId: id,
        op: "update",
        before: { kind: "lesson_meta", title: prev.lesson.title, objective: prev.lesson.objective ?? null, moduleId: prev.moduleId, index: prev.index },
        after: { kind: "lesson_meta", title: cur.lesson.title, objective: cur.lesson.objective ?? null, moduleId: cur.moduleId, index: cur.index },
      });
    }
  }
  for (const [id, prev] of oldL) {
    if (deletedModuleIds.has(prev.moduleId)) continue; // owned by the module-delete snapshot
    if (!newL.has(id)) changes.push({ nodeType: "lesson", nodeId: id, op: "delete", before: { kind: "lesson", lesson: prev.lesson, moduleId: prev.moduleId, atIndex: prev.index }, after: null });
  }

  return changes;
}

/** The node ids touched by a structural change set (what the outline sidebar
 *  highlights). A deleted node is gone from the tree, so only create/update ids
 *  can highlight in place. */
export function changedNodeIds(changes: StructureChange[]): string[] {
  return changes.map((c) => c.nodeId);
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
