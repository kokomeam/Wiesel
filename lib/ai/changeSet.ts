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
import { updateTextPatch } from "@/lib/course/commands";
import { applyCoursePatch, CoursePatchSchema, type CoursePatch } from "@/lib/course/patches";
import { findBlock, findLesson, findModule } from "@/lib/course/queries";
import type { CourseDocument, LessonBlock } from "@/lib/course/types";
import type { BlockChange, StructureChange, StructureSnapshot } from "./changeSetDiff";
import { loadCourseDoc, reconcileCourseDoc } from "./serverPersistence";

type DB = SupabaseClient<Database>;

export interface ChangeSetRef {
  changeSetId: string;
  count: number;
}

/** The changes one change-set records — block before/after snapshots AND/OR
 *  structural (module/lesson) ops. A turn may mix both (e.g. create a lesson and
 *  build its deck); they stage as ONE reviewable, atomically-reject-able unit. */
export interface ChangeSetChanges {
  blocks: BlockChange[];
  structure: StructureChange[];
}

/** Persist one change-set + its item snapshots (block + structural). Returns null
 *  if nothing changed (no change-set is created for an empty diff). */
export async function createChangeSet(
  supabase: DB,
  ctx: {
    courseId: string;
    lessonId?: string | null;
    conversationId?: string | null;
    messageId?: string | null;
    summary?: string | null;
    /** Maintenance runs: the originating finding's evidence, stamped on EVERY
     *  item so the review UI renders the evidence card. */
    evidence?: Json | null;
  },
  changes: ChangeSetChanges
): Promise<ChangeSetRef | null> {
  const total = changes.blocks.length + changes.structure.length;
  if (total === 0) return null;

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

  const blockItems = changes.blocks.map((c) => ({
    change_set_id: data.id,
    course_id: ctx.courseId,
    node_type: "block" as const,
    block_id: c.blockId,
    node_id: null,
    lesson_id: c.lessonId,
    op: c.op,
    before: (c.before ?? null) as unknown as Json,
    after: (c.after ?? null) as unknown as Json,
    evidence: ctx.evidence ?? null,
  }));
  const structureItems = changes.structure.map((c) => ({
    change_set_id: data.id,
    course_id: ctx.courseId,
    node_type: c.nodeType,
    block_id: null,
    node_id: c.nodeId,
    // A lesson item records its own id in lesson_id too (informational); a module
    // item has no single lesson.
    lesson_id: c.nodeType === "lesson" ? c.nodeId : null,
    op: c.op,
    before: (c.before ?? null) as unknown as Json,
    after: (c.after ?? null) as unknown as Json,
    evidence: ctx.evidence ?? null,
  }));
  const { error: itemsErr } = await supabase.from("change_set_items").insert([...blockItems, ...structureItems]);
  if (itemsErr) throw new Error(itemsErr.message);

  return { changeSetId: data.id, count: total };
}

export interface PendingBlock {
  blockId: string;
  changeSetId: string;
  op: string;
  /** Maintenance-run evidence (null on regular agent edits) — the review UI's
   *  evidence card. */
  evidence?: Json | null;
}

/** A pending structural (module/lesson) change — drives the outline-sidebar
 *  highlight + the AgentPanel "Structure changes" group. */
export interface PendingNode {
  nodeId: string;
  nodeType: "module" | "lesson";
  changeSetId: string;
  op: string;
}

/** The PENDING change-set ids for a course (shared by the block + node fetches). */
async function pendingChangeSetIds(supabase: DB, courseId: string): Promise<string[]> {
  const { data: sets } = await supabase
    .from("change_sets")
    .select("id")
    .eq("course_id", courseId)
    .eq("status", "pending");
  return (sets ?? []).map((s) => s.id);
}

/** Block ids with a PENDING change for this course — drives the editor
 *  highlight. Block items only (node_type='block'); structural items are
 *  surfaced by `getPendingNodes`. */
export async function getPendingBlocks(supabase: DB, courseId: string): Promise<PendingBlock[]> {
  const ids = await pendingChangeSetIds(supabase, courseId);
  if (ids.length === 0) return [];
  const { data: items } = await supabase
    .from("change_set_items")
    .select("block_id,change_set_id,op,node_type,evidence")
    .in("change_set_id", ids)
    .eq("node_type", "block");
  return (items ?? [])
    .filter((i): i is typeof i & { block_id: string } => !!i.block_id)
    .map((i) => ({ blockId: i.block_id, changeSetId: i.change_set_id, op: i.op, evidence: i.evidence ?? null }));
}

/** Module/lesson ids with a PENDING structural change for this course — drives the
 *  outline-sidebar highlight. */
export async function getPendingNodes(supabase: DB, courseId: string): Promise<PendingNode[]> {
  const ids = await pendingChangeSetIds(supabase, courseId);
  if (ids.length === 0) return [];
  const { data: items } = await supabase
    .from("change_set_items")
    .select("node_id,node_type,change_set_id,op")
    .in("change_set_id", ids)
    .in("node_type", ["module", "lesson"]);
  return (items ?? [])
    .filter((i): i is typeof i & { node_id: string; node_type: "module" | "lesson" } => !!i.node_id && (i.node_type === "module" || i.node_type === "lesson"))
    .map((i) => ({ nodeId: i.node_id, nodeType: i.node_type, changeSetId: i.change_set_id, op: i.op }));
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

/** The fields of a `change_set_items` row the revert needs. `node_type` absent ⇒
 *  a block item (back-compat: callers that build only block items may omit it). */
export interface RevertItem {
  block_id: string | null;
  lesson_id: string | null;
  op: string;
  before: unknown | null;
  node_type?: string | null;
  node_id?: string | null;
  after?: unknown | null;
}

/** Order items so structural inverses satisfy dependencies: re-add deleted
 *  modules → re-add deleted lessons → block reverts + structural updates → delete
 *  created lessons → delete created modules. (Re-add a parent before its children;
 *  delete children before their parent.) */
function revertPhase(item: RevertItem): number {
  const nt = item.node_type ?? "block";
  if (item.op === "delete" && nt === "module") return 0;
  if (item.op === "delete" && nt === "lesson") return 1;
  if (item.op === "create" && nt === "lesson") return 3;
  if (item.op === "create" && nt === "module") return 4;
  return 2; // block reverts (any op) + structural updates (rename/move)
}

/** Build the inverse CoursePatch(es) for one item against the working doc, or an
 *  error. An empty array = the desired end state is already met (skip). */
function inversePatches(
  working: CourseDocument,
  item: RevertItem
): { patches: CoursePatch[] } | { error: string } {
  const nt = item.node_type ?? "block";

  if (nt === "block") {
    if (!item.block_id) return { error: "block item missing block_id" };
    const blockId = item.block_id;
    if (item.op === "create") {
      const hit = findBlock(working, blockId);
      if (!hit) return { patches: [] }; // already absent — goal met
      return { patches: [{ action: "DELETE_BLOCK", lessonId: hit.lesson.id, blockId }] };
    }
    if (item.op === "update") {
      if (!item.before) return { error: `Can't revert update of ${blockId}: missing before-snapshot` };
      return { patches: [{ action: "SET_BLOCK_CONTENT", blockId, block: item.before as LessonBlock }] };
    }
    if (item.op === "delete") {
      if (!item.before || !item.lesson_id) return { error: `Can't revert delete of ${blockId}: missing before-snapshot or lesson` };
      const before = item.before as LessonBlock;
      return { patches: [{ action: "ADD_BLOCK", lessonId: item.lesson_id, block: before, atIndex: typeof before.order === "number" ? before.order : undefined }] };
    }
    return { error: `Unknown change op '${item.op}' for ${blockId}` };
  }

  if (nt === "lesson") {
    const lessonId = item.node_id ?? undefined;
    if (item.op === "create") {
      if (!lessonId || !findLesson(working, lessonId)) return { patches: [] }; // already gone
      return { patches: [{ action: "DELETE_LESSON", lessonId }] };
    }
    if (item.op === "delete") {
      // Already restored (e.g. by a parent module re-add) — goal met, skip.
      if (lessonId && findLesson(working, lessonId)) return { patches: [] };
      const snap = item.before as StructureSnapshot | null;
      if (!snap || snap.kind !== "lesson") return { error: `Can't revert lesson delete: missing snapshot` };
      return { patches: [{ action: "ADD_LESSON", moduleId: snap.moduleId, lesson: snap.lesson, atIndex: snap.atIndex }] };
    }
    if (item.op === "update") {
      if (!lessonId) return { error: "lesson update missing node_id" };
      const before = item.before as StructureSnapshot | null;
      const after = item.after as StructureSnapshot | null;
      if (!before || before.kind !== "lesson_meta") return { error: "lesson update missing before-snapshot" };
      const patches: CoursePatch[] = [];
      const a = after && after.kind === "lesson_meta" ? after : null;
      if (!a || a.title !== before.title) patches.push(updateTextPatch({ kind: "lesson", id: lessonId, field: "title" }, before.title));
      if (!a || (a.objective ?? null) !== (before.objective ?? null)) patches.push(updateTextPatch({ kind: "lesson", id: lessonId, field: "objective" }, before.objective ?? ""));
      if (a && a.moduleId !== before.moduleId) patches.push({ action: "REORDER_LESSON", lessonId, toModuleId: before.moduleId, toIndex: before.index });
      return { patches };
    }
    return { error: `Unknown lesson op '${item.op}'` };
  }

  if (nt === "module") {
    const moduleId = item.node_id ?? undefined;
    if (item.op === "create") {
      if (!moduleId || !findModule(working, moduleId)) return { patches: [] }; // already gone
      return { patches: [{ action: "DELETE_MODULE", moduleId }] };
    }
    if (item.op === "delete") {
      if (moduleId && findModule(working, moduleId)) return { patches: [] }; // already restored — skip
      const snap = item.before as StructureSnapshot | null;
      if (!snap || snap.kind !== "module") return { error: `Can't revert module delete: missing snapshot` };
      return { patches: [{ action: "ADD_MODULE", module: snap.module, atIndex: snap.atIndex }] };
    }
    if (item.op === "update") {
      if (!moduleId) return { error: "module update missing node_id" };
      const before = item.before as StructureSnapshot | null;
      if (!before || before.kind !== "module_meta") return { error: "module update missing before-snapshot" };
      return { patches: [updateTextPatch({ kind: "module", id: moduleId, field: "title" }, before.title)] };
    }
    return { error: `Unknown module op '${item.op}'` };
  }

  return { error: `Unknown node_type '${nt}'` };
}

/**
 * Pure, ALL-OR-NOTHING inverse of a change-set (blocks AND structural ops):
 * returns the restored document, or an error describing the FIRST item that can't
 * be reverted (so the caller aborts without writing a half-reverted course). Never
 * touches the DB. Items are processed in dependency order (re-add parents before
 * children; delete children before parents) so a rejected module-create deletes
 * its lessons/blocks cleanly and a rejected module-delete restores the whole subtree.
 *   block:  create → delete it (gone = skip) · update → restore before · delete → re-add
 *   lesson: create → delete it · delete → re-add at position · update → restore title/objective/module
 *   module: create → delete it · delete → re-add subtree · update → restore title
 */
export function revertChangeSet(
  doc: CourseDocument,
  items: RevertItem[],
  nowIso: string
): { ok: true; doc: CourseDocument } | { ok: false; error: string } {
  let working = doc;
  const ordered = items.map((item, i) => ({ item, i })).sort((a, b) => revertPhase(a.item) - revertPhase(b.item) || a.i - b.i);
  for (const { item } of ordered) {
    const label = item.node_id ?? item.block_id ?? "(item)";
    const built = inversePatches(working, item);
    if ("error" in built) return { ok: false, error: built.error };
    for (const patch of built.patches) {
      const safe = CoursePatchSchema.safeParse(patch);
      if (!safe.success) return { ok: false, error: `Invalid inverse patch for ${label}: ${safe.error.message}` };
      const res = applyCoursePatch(working, safe.data, nowIso);
      if (!res.ok) return { ok: false, error: `Failed to revert ${label}: ${res.error}` };
      working = res.doc;
    }
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

  const { data: items, error: itemsErr } = await supabase
    .from("change_set_items")
    .select("block_id,lesson_id,op,before,node_type,node_id,after")
    .eq("change_set_id", changeSetId);
  // A pending change-set ALWAYS has >=1 item (createChangeSet requires total>0), so a
  // failed/empty read must ABORT — never revert nothing and still mark the set
  // 'rejected', which would strand every staged edit in the DB, permanently
  // un-revertable while the highlight clears.
  if (itemsErr) throw new Error(`Reject aborted: could not load change-set items: ${itemsErr.message}`);
  if (!items || items.length === 0) throw new Error("Reject aborted: change-set has no items to revert");

  const doc = await loadCourseDoc(supabase, cs.course_id);
  if (!doc) throw new Error("Course not found");
  const now = new Date().toISOString();

  // Compute the FULL restored doc first; only touch the DB if every item reverts.
  const reverted = revertChangeSet(doc, items, now);
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
