/**
 * Publish-governance event emission — rides the SINGLE analytics_event
 * stream (the accounts/events.ts precedent). Best-effort; skips silently
 * when the post has no course context (course_id NOT NULL on the stream).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { AnalyticsEventType } from "../types";

type DB = SupabaseClient<Database>;

export type PublishGovernanceEventType = Extract<
  AnalyticsEventType,
  | "social_publish_card_approved"
  | "social_publish_card_rejected"
  | "social_publish_approval_voided"
  | "social_post_published_api"
  | "social_post_unpublished_local"
>;

export async function emitPublishEvent(
  supabase: DB,
  courseId: string | null,
  type: PublishGovernanceEventType,
  props: Record<string, unknown>
): Promise<void> {
  if (!courseId) return;
  try {
    await supabase.from("analytics_event").insert({
      course_id: courseId,
      type,
      source: "social_publish",
      props: props as Json,
    });
  } catch {
    // telemetry only — never fail governance on analytics
  }
}
