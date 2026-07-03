"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/** Manual "refresh now" — the author-gated refresh_course_analytics RPC (the
 *  same recompute the nightly pg_cron job runs), then re-render the page. */
export async function refreshCourseAnalytics(courseId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("refresh_course_analytics", { cid: courseId });
  if (error) {
    // Author-gating failures land here too — log, don't crash the dashboard.
    console.error("[analytics] refresh failed", error.message);
    return;
  }
  revalidatePath(`/studio/${courseId}/analytics`);
}
