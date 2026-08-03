/**
 * Connected-account event emission — rides the SINGLE analytics_event stream
 * (the social/events.ts precedent). Best-effort: an analytics hiccup never
 * fails the linking flow. analytics_event.course_id is NOT NULL, so emission
 * carries the hub's course context and SKIPS (silently) when the creator has
 * no course yet — the lifecycle rows in social_account remain the source of
 * truth; events are telemetry.
 *
 * The type union extends lib/marketing/types.ts AnalyticsEventType and the
 * DB check constraint TOGETHER (migration 20260723120000) — the
 * consequential-updates rule; verify-accounts.ts drift-guards it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { AnalyticsEventType } from "../types";

type DB = SupabaseClient<Database>;

export type SocialAccountEventType = Extract<
  AnalyticsEventType,
  "social_account_linked" | "social_account_expired" | "social_account_revoked"
>;

export async function emitAccountEvent(
  supabase: DB,
  courseId: string | null,
  type: SocialAccountEventType,
  props: Record<string, unknown>
): Promise<void> {
  if (!courseId) return; // no course context yet — telemetry only, skip
  try {
    await supabase.from("analytics_event").insert({
      course_id: courseId,
      type,
      source: "social_accounts",
      props: props as Json,
    });
  } catch {
    // best-effort — never crash the linking path on analytics
  }
}
