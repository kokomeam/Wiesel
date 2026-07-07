/**
 * Social event emission — rides the SINGLE analytics_event stream (no new
 * table). Marketing events, not course-consumption events: course_id is the
 * hub's course context (manual-topic posts still carry it). Emission is
 * best-effort — an analytics hiccup never fails the user's operation.
 *
 * The type union extends lib/marketing/types.ts AnalyticsEventType and the DB
 * check constraint TOGETHER (migration 20260706120000) — the
 * consequential-updates rule.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { AnalyticsEventType } from "../types";

type DB = SupabaseClient<Database>;

export type SocialEventType = Extract<
  AnalyticsEventType,
  | "social_post_batch_generated"
  | "social_post_created"
  | "social_post_updated"
  | "social_post_revised_by_agent"
  | "social_post_status_changed"
  | "social_post_copied"
  | "social_post_downloaded"
  | "social_post_image_attached"
  | "social_post_image_removed"
  | "social_post_performance_logged"
  | "social_post_generation_failed"
  | "social_voice_profile_derived"
  | "social_voice_profile_edited"
>;

export async function emitSocialEvent(
  supabase: DB,
  courseId: string,
  type: SocialEventType,
  props: Record<string, unknown>
): Promise<void> {
  try {
    await supabase.from("analytics_event").insert({
      course_id: courseId,
      type,
      source: "social_posts",
      props: props as Json,
    });
  } catch {
    // best-effort — never crash the user path on analytics
  }
}
