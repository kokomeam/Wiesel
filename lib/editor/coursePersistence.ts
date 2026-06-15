"use client";

/**
 * Client-side course persistence: debounced, autosave-style sync of the
 * editor's `CourseDocument` to the normalized Postgres tables, through the
 * browser Supabase client (RLS scopes everything to the signed-in author).
 *
 * Strategy — debounced full-snapshot reconcile (AUDIT.md #1):
 *   1. update the `courses` row (only the author-owned columns)
 *   2. upsert modules → lessons → blocks  (parents before children)
 *   3. delete orphans blocks → lessons → modules  (children before parents)
 * Idempotent and safe to repeat; the editor already carries stable UUID ids
 * that ARE the rows' primary keys, so there is no diffing to do.
 */

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { courseDocToRows } from "@/lib/course/persistence";
import { useEditorStore } from "@/lib/course/store";
import type { CourseDocument } from "@/lib/course/types";

const SAVE_DEBOUNCE_MS = 1000;

type Supabase = ReturnType<typeof createClient>;

/** Delete rows of `table` for this course whose id is no longer present. */
async function deleteOrphans(
  supabase: Supabase,
  table: "modules" | "lessons" | "blocks",
  courseId: string,
  keepIds: string[]
): Promise<string | null> {
  const base = supabase.from(table).delete().eq("course_id", courseId);
  const query =
    keepIds.length === 0
      ? base // nothing survives at this level — clear them all
      : base.not("id", "in", `(${keepIds.join(",")})`);
  const { error } = await query;
  return error?.message ?? null;
}

/** One full reconcile. Returns an error message, or null on success. */
export async function saveCourseDoc(
  supabase: Supabase,
  doc: CourseDocument,
  ownerId: string
): Promise<string | null> {
  const { course, modules, lessons, blocks } = courseDocToRows(doc, ownerId);

  // 1. course row — never touch status/visibility/price/tags (author may set
  //    those elsewhere); only the columns the editor owns.
  const { error: courseErr } = await supabase
    .from("courses")
    .update({
      title: course.title,
      description: course.description,
      audience: course.audience,
      level: course.level,
      plan: course.plan,
      theme: course.theme,
    })
    .eq("id", doc.id);
  if (courseErr) return courseErr.message;

  // 2. upsert parents → children
  if (modules.length) {
    const { error } = await supabase.from("modules").upsert(modules);
    if (error) return error.message;
  }
  if (lessons.length) {
    const { error } = await supabase.from("lessons").upsert(lessons);
    if (error) return error.message;
  }
  if (blocks.length) {
    const { error } = await supabase.from("blocks").upsert(blocks);
    if (error) return error.message;
  }

  // 3. delete orphans children → parents
  return (
    (await deleteOrphans(supabase, "blocks", doc.id, blocks.map((b) => b.id!))) ??
    (await deleteOrphans(supabase, "lessons", doc.id, lessons.map((l) => l.id!))) ??
    (await deleteOrphans(supabase, "modules", doc.id, modules.map((m) => m.id!)))
  );
}

/**
 * Autosave hook: mounts in the studio shell, watches the document, and
 * debounce-saves changes. Coalesces edits made during an in-flight save so
 * the latest state always wins, and reports progress via the store's
 * `saveStatus` (shown in the header).
 */
export function useCoursePersistence(ownerId: string) {
  const doc = useEditorStore((s) => s.doc);
  const courseId = useEditorStore((s) => s.courseId);
  const setSaveStatus = useEditorStore((s) => s.setSaveStatus);

  // One browser client for the editor's lifetime (lazy, render-safe).
  const [supabase] = useState(() => createClient());

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const pending = useRef<CourseDocument | null>(null);
  // Skip the first doc value after hydrate — it's the loaded state, not an edit.
  const primed = useRef(false);

  useEffect(() => {
    if (!courseId) return;
    if (!primed.current) {
      primed.current = true;
      return;
    }

    async function flush(next: CourseDocument) {
      saving.current = true;
      setSaveStatus("saving");
      const error = await saveCourseDoc(supabase, next, ownerId);
      saving.current = false;
      if (pending.current) {
        const queued = pending.current;
        pending.current = null;
        void flush(queued); // a newer edit landed mid-save — save it too
        return;
      }
      setSaveStatus(error ? "error" : "saved", new Date().toISOString());
      if (error) console.error("Course autosave failed:", error);
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (saving.current) {
        pending.current = doc; // coalesce — flushed when the current save ends
      } else {
        void flush(doc);
      }
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [doc, courseId, ownerId, setSaveStatus, supabase]);
}
