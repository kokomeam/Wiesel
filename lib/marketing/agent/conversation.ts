/**
 * Marketing conversations reuse the shared conversations/messages tables, but
 * keyed by course with lesson_id NULL (the studio's helper is lesson-keyed).
 * History replay + message saves reuse lib/ai/conversations.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

export async function getOrCreateMarketingConversation(
  supabase: DB,
  courseId: string,
  existing?: string | null
): Promise<string> {
  if (existing) return existing;
  const { data: recent } = await supabase
    .from("conversations")
    .select("id")
    .eq("course_id", courseId)
    .is("lesson_id", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recent) return recent.id;

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({ course_id: courseId, lesson_id: null, title: "Marketing" })
    .select("id")
    .single();
  if (error || !created) throw new Error(error?.message ?? "Failed to create marketing conversation");
  return created.id;
}
