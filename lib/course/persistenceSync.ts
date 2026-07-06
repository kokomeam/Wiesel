/**
 * Client-agnostic Supabase ↔ CourseDocument sync.
 *
 * The SAME reconcile is used by the browser autosave (lib/editor/
 * coursePersistence.ts) and the server-side AI agent (lib/ai/serverPersistence.ts),
 * so human and AI edits persist through one identical path. Both receive a
 * `SupabaseClient<Database>` (browser or server) — RLS scopes everything to the
 * signed-in author regardless of which client runs the query.
 *
 * Strategy — full-snapshot reconcile (matches the editor's autosave):
 *   1. update the `courses` row (only the author-owned columns)
 *   2. upsert modules → lessons → blocks   (parents before children)
 *   3. delete orphans blocks → lessons → modules   (children before parents)
 * Idempotent; ids ARE the rows' primary keys, so there is no diffing to do.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { blockToInsert, courseDocFromRows, courseDocToRows } from "./persistence";
import type { CourseDocument, LessonBlock } from "./types";

type DB = SupabaseClient<Database>;

/** Load a course + its whole tree and reconstruct the editor document. Returns
 *  null ONLY when the course genuinely doesn't exist / RLS hides it (data null,
 *  no error). THROWS on any read error: a transient RLS/transport/timeout failure
 *  must NEVER masquerade as an empty tree, or a downstream full reconcile would
 *  orphan-delete every real row of the course (see reconcileCourseDoc step 3). */
export async function loadCourseDoc(
  supabase: DB,
  courseId: string
): Promise<CourseDocument | null> {
  const { data: course, error: courseErr } = await supabase
    .from("courses")
    .select("*")
    .eq("id", courseId)
    .maybeSingle();
  if (courseErr) throw new Error(`loadCourseDoc: failed to read course ${courseId}: ${courseErr.message}`);
  if (!course) return null;

  const [
    { data: modules, error: modErr },
    { data: lessons, error: lessonErr },
    { data: blocks, error: blockErr },
  ] = await Promise.all([
    supabase.from("modules").select("*").eq("course_id", courseId),
    supabase.from("lessons").select("*").eq("course_id", courseId),
    supabase.from("blocks").select("*").eq("course_id", courseId),
  ]);
  const treeErr = modErr ?? lessonErr ?? blockErr;
  if (treeErr) throw new Error(`loadCourseDoc: failed to read course ${courseId} tree: ${treeErr.message}`);

  return courseDocFromRows(course, modules ?? [], lessons ?? [], blocks ?? []);
}

/**
 * Upsert a SINGLE block row without touching any other row. For narrow server
 * paths (e.g. the visual-generate endpoint) that must persist exactly ONE block:
 * a full `reconcileCourseDoc` there would upsert a seconds-old whole-course
 * snapshot AND orphan-delete anything a concurrent autosave wrote in the meantime,
 * so those paths write only their own block.
 */
export async function upsertBlock(
  supabase: DB,
  courseId: string,
  lessonId: string,
  block: LessonBlock,
  signal?: AbortSignal
): Promise<string | null> {
  let query = supabase.from("blocks").upsert(blockToInsert(block, lessonId, courseId));
  if (signal) query = query.abortSignal(signal);
  const { error } = await query;
  return error?.message ?? null;
}

/** Delete rows of `table` for this course whose id is no longer present. */
async function deleteOrphans(
  supabase: DB,
  table: "modules" | "lessons" | "blocks",
  courseId: string,
  keepIds: string[],
  signal?: AbortSignal
): Promise<string | null> {
  let query = supabase.from(table).delete().eq("course_id", courseId);
  if (keepIds.length) query = query.not("id", "in", `(${keepIds.join(",")})`);
  if (signal) query = query.abortSignal(signal);
  const { error } = await query;
  return error?.message ?? null;
}

/** Scoped orphan purge (agent reconcile): delete a lesson's blocks whose id is no
 *  longer present — only within that ONE lesson, never course-wide. */
async function deleteOrphanBlocksInLesson(
  supabase: DB,
  lessonId: string,
  keepIds: string[],
  signal?: AbortSignal
): Promise<string | null> {
  let query = supabase.from("blocks").delete().eq("lesson_id", lessonId);
  if (keepIds.length) query = query.not("id", "in", `(${keepIds.join(",")})`);
  if (signal) query = query.abortSignal(signal);
  const { error } = await query;
  return error?.message ?? null;
}

/** Scoped orphan purge (agent reconcile, module-build only): delete a CREATED
 *  module's lessons whose id is no longer present — only within that module. */
async function deleteOrphanLessonsInModule(
  supabase: DB,
  moduleId: string,
  keepIds: string[],
  signal?: AbortSignal
): Promise<string | null> {
  let query = supabase.from("lessons").delete().eq("module_id", moduleId);
  if (keepIds.length) query = query.not("id", "in", `(${keepIds.join(",")})`);
  if (signal) query = query.abortSignal(signal);
  const { error } = await query;
  return error?.message ?? null;
}

/** One full reconcile of `doc` into the DB. Returns an error message, or null
 *  on success. An optional `signal` lets the browser autosave ABORT an in-flight
 *  reconcile (so a stale flush can't clobber a concurrent Reject). */
export async function reconcileCourseDoc(
  supabase: DB,
  doc: CourseDocument,
  ownerId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const { course, modules, lessons, blocks } = courseDocToRows(doc, ownerId);
  const sig = <T extends { abortSignal(s: AbortSignal): T }>(q: T): T => (signal ? q.abortSignal(signal) : q);

  // 1. course row — only the editor-owned columns (never status/visibility/
  //    price/tags, which the author sets elsewhere).
  const { error: courseErr } = await sig(
    supabase
      .from("courses")
      .update({
        title: course.title,
        description: course.description,
        audience: course.audience,
        level: course.level,
        plan: course.plan,
        theme: course.theme,
      })
      .eq("id", doc.id)
  );
  if (courseErr) return courseErr.message;

  // 2. upsert parents → children
  if (modules.length) {
    const { error } = await sig(supabase.from("modules").upsert(modules));
    if (error) return error.message;
  }
  if (lessons.length) {
    const { error } = await sig(supabase.from("lessons").upsert(lessons));
    if (error) return error.message;
  }
  if (blocks.length) {
    const { error } = await sig(supabase.from("blocks").upsert(blocks));
    if (error) return error.message;
  }

  // 3. delete orphans children → parents
  return (
    (await deleteOrphans(supabase, "blocks", doc.id, blocks.map((b) => b.id!), signal)) ??
    (await deleteOrphans(supabase, "lessons", doc.id, lessons.map((l) => l.id!), signal)) ??
    (await deleteOrphans(supabase, "modules", doc.id, modules.map((m) => m.id!), signal))
  );
}

/** What an agent run touched — modules it created + lessons it authored. The
 *  agent's scoped reconcile writes ONLY this subtree. Structurally matches
 *  `AgentTouchScope` (lib/ai/changeSetDiff.ts), kept local so lib/course doesn't
 *  depend on lib/ai. */
export interface ReconcileScope {
  newModuleIds: string[];
  touchedLessonIds: string[];
  /** Touched lessons the agent CREATED this run — always written (exempt from the
   *  delete-wins prune, since their DB-absence means "not yet persisted"). */
  newLessonIds: string[];
}

/**
 * SCOPED reconcile for the AI agent. Unlike the full `reconcileCourseDoc`, this
 * writes ONLY the subtree the agent touched this run and **never orphan-deletes
 * modules** — so a module the user deleted mid-run is neither re-inserted nor
 * shielded from deletion (the resurrection bug). Concretely:
 *   - upsert only the agent's CREATED modules + AUTHORED lessons + their blocks,
 *   - prune blocks only within a touched lesson, and lessons only within a
 *     module the agent CREATED (never a pre-existing module),
 *   - delete-wins: a touched lesson whose pre-existing module the user deleted
 *     mid-run is SKIPPED (re-read of fresh DB state), so no FK error / no revive,
 *   - never touch the `courses` row.
 * The full reconcile (browser autosave / Reject) stays authoritative over
 * structure — only the human path may delete modules.
 */
export async function reconcileCourseDocScoped(
  supabase: DB,
  doc: CourseDocument,
  ownerId: string,
  scope: ReconcileScope,
  signal?: AbortSignal
): Promise<string | null> {
  const newModuleIds = new Set(scope.newModuleIds);
  const touchedLessonIds = new Set(scope.touchedLessonIds);
  const newLessonIds = new Set(scope.newLessonIds);
  if (newModuleIds.size === 0 && touchedLessonIds.size === 0) return null; // nothing the agent touched

  const { modules, lessons, blocks } = courseDocToRows(doc, ownerId);
  const sig = <T extends { abortSignal(s: AbortSignal): T }>(q: T): T => (signal ? q.abortSignal(signal) : q);

  // Delete-wins: only needed when a touched lesson sits in a PRE-EXISTING module
  // (an agent-created module is always written — the agent owns it). Re-read the
  // fresh DB so a lesson (or its module) the user deleted mid-run is skipped — and
  // not re-inserted. New-this-run lessons are exempt (their absence = not-yet-saved).
  const needsLiveCheck = lessons.some(
    (l) => touchedLessonIds.has(l.id!) && !newModuleIds.has(l.module_id!)
  );
  let liveModuleIds: Set<string> | null = null;
  let liveLessonIds: Set<string> | null = null;
  if (needsLiveCheck) {
    let dbDoc: CourseDocument | null;
    try {
      dbDoc = await loadCourseDoc(supabase, doc.id);
    } catch (e) {
      // A transient live-read failure must surface as an ERROR — never be treated
      // as "course gone", which would skip persisting the agent's authored subtree
      // and report success (the next incremental reconcile retries).
      return e instanceof Error ? e.message : "live-check read failed";
    }
    if (!dbDoc) return null; // course genuinely gone (deleted concurrently) — nothing to do
    liveModuleIds = new Set(dbDoc.modules.map((m) => m.id));
    liveLessonIds = new Set(dbDoc.modules.flatMap((m) => m.lessons.map((l) => l.id)));
  }

  const scopedLessons = lessons.filter((l) => {
    if (newModuleIds.has(l.module_id!)) return true; // agent's own new module
    if (!touchedLessonIds.has(l.id!)) return false;
    if (!liveModuleIds) return true; // no live check needed (only new-module lessons in scope)
    if (!liveModuleIds.has(l.module_id!)) return false; // module deleted mid-run → delete-wins
    // New-this-run lesson: write as long as its (existing) module is still there.
    if (newLessonIds.has(l.id!)) return true;
    // Pre-existing lesson: skip if the user deleted it mid-run (delete-wins).
    return liveLessonIds!.has(l.id!);
  });
  const scopedLessonIds = new Set(scopedLessons.map((l) => l.id!));
  const scopedModules = modules.filter((m) => newModuleIds.has(m.id!));
  const scopedBlocks = blocks.filter((b) => scopedLessonIds.has(b.lesson_id!));

  // 1. upsert parents → children (scoped subtree only; never the course row).
  if (scopedModules.length) {
    const { error } = await sig(supabase.from("modules").upsert(scopedModules));
    if (error) return error.message;
  }
  if (scopedLessons.length) {
    const { error } = await sig(supabase.from("lessons").upsert(scopedLessons));
    if (error) return error.message;
  }
  if (scopedBlocks.length) {
    const { error } = await sig(supabase.from("blocks").upsert(scopedBlocks));
    if (error) return error.message;
  }

  // 2. scoped orphan-deletes (NEVER modules):
  //    - blocks the agent removed within a touched lesson,
  //    - lessons the agent removed within a module it CREATED (module-build prune).
  for (const lessonId of scopedLessonIds) {
    const keep = scopedBlocks.filter((b) => b.lesson_id === lessonId).map((b) => b.id!);
    const err = await deleteOrphanBlocksInLesson(supabase, lessonId, keep, signal);
    if (err) return err;
  }
  for (const moduleId of newModuleIds) {
    const keep = scopedLessons.filter((l) => l.module_id === moduleId).map((l) => l.id!);
    const err = await deleteOrphanLessonsInModule(supabase, moduleId, keep, signal);
    if (err) return err;
  }
  return null;
}
