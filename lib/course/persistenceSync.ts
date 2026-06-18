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
import { courseDocFromRows, courseDocToRows } from "./persistence";
import type { CourseDocument } from "./types";

type DB = SupabaseClient<Database>;

/** Load a course + its whole tree and reconstruct the editor document. Returns
 *  null if the course doesn't exist or RLS hides it from the caller. */
export async function loadCourseDoc(
  supabase: DB,
  courseId: string
): Promise<CourseDocument | null> {
  const { data: course } = await supabase
    .from("courses")
    .select("*")
    .eq("id", courseId)
    .maybeSingle();
  if (!course) return null;

  const [{ data: modules }, { data: lessons }, { data: blocks }] = await Promise.all([
    supabase.from("modules").select("*").eq("course_id", courseId),
    supabase.from("lessons").select("*").eq("course_id", courseId),
    supabase.from("blocks").select("*").eq("course_id", courseId),
  ]);

  return courseDocFromRows(course, modules ?? [], lessons ?? [], blocks ?? []);
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
