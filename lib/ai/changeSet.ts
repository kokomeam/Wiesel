/**
 * Change-set staging: the highlight-and-approve trust layer.
 *
 * An agent turn's mutations are ALREADY applied + persisted (so the agent can
 * read its own edits on later loop steps and they survive reload). This module
 * records the per-block before/after snapshots so the editor can highlight the
 * affected blocks and the creator can Accept (clear the flag) or Reject (replay
 * the inverse through the same CoursePatch pipeline). The DB stays authoritative.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { applyCoursePatch, CoursePatchSchema, type CoursePatch } from "@/lib/course/patches";
import { findBlock } from "@/lib/course/queries";
import type { CourseDocument, LessonBlock } from "@/lib/course/types";
import type { BlockChange } from "./changeSetDiff";
import { loadCourseDoc, reconcileCourseDoc } from "./serverPersistence";

type DB = SupabaseClient<Database>;

export interface ChangeSetRef {
  changeSetId: string;
  count: number;
}

/** Persist one change-set + its per-block snapshots. Returns null if nothing
 *  changed (no change-set is created for an empty diff). */
export async function createChangeSet(
  supabase: DB,
  ctx: {
    courseId: string;
    lessonId?: string | null;
    conversationId?: string | null;
    messageId?: string | null;
    summary?: string | null;
  },
  changes: BlockChange[]
): Promise<ChangeSetRef | null> {
  if (changes.length === 0) return null;

  const { data, error } = await supabase
    .from("change_sets")
    .insert({
      course_id: ctx.courseId,
      lesson_id: ctx.lessonId ?? null,
      conversation_id: ctx.conversationId ?? null,
      message_id: ctx.messageId ?? null,
      summary: ctx.summary ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to create change set");

  const items = changes.map((c) => ({
    change_set_id: data.id,
    course_id: ctx.courseId,
    block_id: c.blockId,
    lesson_id: c.lessonId,
    op: c.op,
    before: (c.before ?? null) as unknown as Json,
    after: (c.after ?? null) as unknown as Json,
  }));
  const { error: itemsErr } = await supabase.from("change_set_items").insert(items);
  if (itemsErr) throw new Error(itemsErr.message);

  return { changeSetId: data.id, count: changes.length };
}

export interface PendingBlock {
  blockId: string;
  changeSetId: string;
  op: string;
}

/** Block ids with a PENDING change for this course — drives the editor
 *  highlight. */
export async function getPendingBlocks(supabase: DB, courseId: string): Promise<PendingBlock[]> {
  const { data: sets } = await supabase
    .from("change_sets")
    .select("id")
    .eq("course_id", courseId)
    .eq("status", "pending");
  const ids = (sets ?? []).map((s) => s.id);
  if (ids.length === 0) return [];

  const { data: items } = await supabase
    .from("change_set_items")
    .select("block_id,change_set_id,op")
    .in("change_set_id", ids);
  return (items ?? []).map((i) => ({ blockId: i.block_id, changeSetId: i.change_set_id, op: i.op }));
}

/** Accept: the edits already live in the DB — just resolve the change-set so the
 *  highlight clears. */
export async function acceptChangeSet(supabase: DB, changeSetId: string): Promise<void> {
  const { error } = await supabase
    .from("change_sets")
    .update({ status: "accepted", resolved_at: new Date().toISOString() })
    .eq("id", changeSetId)
    .eq("status", "pending");
  if (error) throw new Error(error.message);
}

/** The fields of a `change_set_items` row the revert needs. */
export interface RevertItem {
  block_id: string;
  lesson_id: string | null;
  op: string;
  before: unknown | null;
}

/**
 * Pure, ALL-OR-NOTHING inverse of a change-set: returns the restored document,
 * or an error describing the FIRST item that can't be reverted (so the caller
 * can abort without writing a half-reverted deck). Reusable by an
 * undo-last-AI-change seam — it never touches the DB.
 *   create → delete the created block (already-gone = goal met, skip)
 *   update → restore the `before` content in place
 *   delete → re-add the `before` block at its original position
 */
export function revertChangeSet(
  doc: CourseDocument,
  items: RevertItem[],
  nowIso: string
): { ok: true; doc: CourseDocument } | { ok: false; error: string } {
  let working = doc;
  for (const item of items) {
    let patch: CoursePatch | null = null;
    if (item.op === "create") {
      const hit = findBlock(working, item.block_id);
      // The created block is already absent — the desired end state is met.
      if (!hit) continue;
      patch = { action: "DELETE_BLOCK", lessonId: hit.lesson.id, blockId: item.block_id };
    } else if (item.op === "update") {
      if (!item.before)
        return { ok: false, error: `Can't revert update of ${item.block_id}: missing before-snapshot` };
      patch = { action: "SET_BLOCK_CONTENT", blockId: item.block_id, block: item.before as LessonBlock };
    } else if (item.op === "delete") {
      if (!item.before || !item.lesson_id)
        return { ok: false, error: `Can't revert delete of ${item.block_id}: missing before-snapshot or lesson` };
      const before = item.before as LessonBlock;
      patch = {
        action: "ADD_BLOCK",
        lessonId: item.lesson_id,
        block: before,
        // Restore to its original index so the revert is position-exact.
        atIndex: typeof before.order === "number" ? before.order : undefined,
      };
    } else {
      return { ok: false, error: `Unknown change op '${item.op}' for ${item.block_id}` };
    }
    // Validate the reconstructed patch (defense in depth) before applying.
    const safe = CoursePatchSchema.safeParse(patch);
    if (!safe.success)
      return { ok: false, error: `Invalid inverse patch for ${item.block_id}: ${safe.error.message}` };
    const res = applyCoursePatch(working, safe.data, nowIso);
    if (!res.ok) return { ok: false, error: `Failed to revert ${item.block_id}: ${res.error}` };
    working = res.doc;
  }
  return { ok: true, doc: working };
}

/**
 * Reject: atomically replay the inverse of every item through the SAME patch
 * pipeline, then reconcile the restored document and resolve the change-set. If
 * ANY item can't be reverted the whole operation aborts — nothing is written and
 * the change-set stays `pending` — so there are never half-reverted decks.
 * Idempotent: a non-pending change-set is a no-op.
 */
export async function rejectChangeSet(
  supabase: DB,
  changeSetId: string,
  ownerId: string
): Promise<void> {
  const { data: cs } = await supabase
    .from("change_sets")
    .select("course_id,status")
    .eq("id", changeSetId)
    .single();
  if (!cs) throw new Error("Change set not found");
  if (cs.status !== "pending") return;

  const { data: items } = await supabase
    .from("change_set_items")
    .select("block_id,lesson_id,op,before")
    .eq("change_set_id", changeSetId);

  const doc = await loadCourseDoc(supabase, cs.course_id);
  if (!doc) throw new Error("Course not found");
  const now = new Date().toISOString();

  // Compute the FULL restored doc first; only touch the DB if every item reverts.
  const reverted = revertChangeSet(doc, items ?? [], now);
  if (!reverted.ok) throw new Error(`Reject aborted (no changes applied): ${reverted.error}`);

  const err = await reconcileCourseDoc(supabase, reverted.doc, ownerId);
  if (err) throw new Error(err);

  const { error } = await supabase
    .from("change_sets")
    .update({ status: "rejected", resolved_at: now })
    .eq("id", changeSetId)
    .eq("status", "pending");
  if (error) throw new Error(error.message);
}
