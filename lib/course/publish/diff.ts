/**
 * Republish diff summary — PURE. Compares two publication snapshots by node
 * id + content hash and reports COUNTS of added/changed/removed lessons and
 * blocks (the spec'd concise summary — deliberately not a visual differ).
 */

import { stableStringify } from "./hash";
import type { PublicationSnapshot, PublishDiffSummary } from "./schemas";

interface NodeIndex {
  lessons: Map<string, string>;
  blocks: Map<string, string>;
}

/** Index every lesson/block by id → serialized content. A lesson's identity
 *  excludes its blocks (those are counted separately) but includes its module
 *  placement, so moving a lesson counts as "changed". */
function indexSnapshot(snapshot: PublicationSnapshot): NodeIndex {
  const lessons = new Map<string, string>();
  const blocks = new Map<string, string>();
  for (const m of snapshot.modules) {
    for (const l of m.lessons) {
      const { blocks: lessonBlocks, ...lessonIdentity } = l;
      lessons.set(l.id, stableStringify({ ...lessonIdentity, moduleId: m.id }));
      for (const b of lessonBlocks) {
        blocks.set(b.id, stableStringify({ ...b, lessonId: l.id }));
      }
    }
  }
  return { lessons, blocks };
}

function diffMaps(prev: Map<string, string>, next: Map<string, string>) {
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const [id, content] of next) {
    const before = prev.get(id);
    if (before === undefined) added++;
    else if (before !== content) changed++;
  }
  for (const id of prev.keys()) {
    if (!next.has(id)) removed++;
  }
  return { added, changed, removed };
}

export function summarizePublishDiff(
  prev: PublicationSnapshot | null,
  next: PublicationSnapshot
): PublishDiffSummary {
  const nextIndex = indexSnapshot(next);
  if (!prev) {
    return {
      firstPublish: true,
      lessons: { added: nextIndex.lessons.size, changed: 0, removed: 0 },
      blocks: { added: nextIndex.blocks.size, changed: 0, removed: 0 },
    };
  }
  const prevIndex = indexSnapshot(prev);
  return {
    firstPublish: false,
    lessons: diffMaps(prevIndex.lessons, nextIndex.lessons),
    blocks: diffMaps(prevIndex.blocks, nextIndex.blocks),
  };
}

export function diffIsEmpty(diff: PublishDiffSummary): boolean {
  const { lessons, blocks } = diff;
  return (
    lessons.added + lessons.changed + lessons.removed === 0 &&
    blocks.added + blocks.changed + blocks.removed === 0
  );
}
