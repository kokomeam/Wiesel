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
