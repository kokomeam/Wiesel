"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { defaultCourseTheme } from "@/lib/course/persistence";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/database.types";

/**
 * Create a fresh empty course and open it. A server action (not a GET link)
 * so Next's Link prefetching can't spawn phantom courses on hover.
 */
export async function createNewCourse() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase
    .from("courses")
    .insert({
      author_id: user.id,
      title: "Untitled course",
      plan: { outcomes: [], prerequisites: [] } as Json,
      theme: defaultCourseTheme() as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not create course");

  redirect(`/studio?course=${data.id}`);
}

/**
 * Permanently delete a course and EVERYTHING under it. Deleting the `courses`
 * row cascades (ON DELETE CASCADE) to modules → lessons → blocks and to the AI
 * tables (conversations, messages, change_sets, change_set_items). RLS scopes
 * the delete to the signed-in author, so a non-owner can't remove it.
 */
export async function deleteCourse(courseId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("courses").delete().eq("id", courseId);
  if (error) throw new Error(error.message);

  revalidatePath("/studio");
}
