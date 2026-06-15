"use server";

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
