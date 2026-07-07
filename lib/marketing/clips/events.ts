/**
 * Clip event emission (Phase 1.5 PRD §12.5, M-A slice) — rides the SINGLE
 * analytics_event stream, best-effort (an analytics hiccup never fails the
 * user's operation). Snake_case names per repo convention (the PRD's dotted
 * names are documented as a deliberate deviation in docs/clips.md).
 *
 * The type union extends lib/marketing/types.ts AnalyticsEventType and the DB
 * check constraint TOGETHER (migration 20260707100000) — the
 * consequential-updates rule. Later milestones add their own event types with
 * their own migrations (jobs/ingest in M-B/C, kit/links in M-D).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { AnalyticsEventType } from "../types";

type DB = SupabaseClient<Database>;

export type ClipEventType = Extract<
  AnalyticsEventType,
  | "lesson_transcribed"
  | "clip_moments_generated"
  | "clip_moments_generation_failed"
  | "clip_moment_selected"
  | "clip_moment_dismissed"
>;

export async function emitClipEvent(
  supabase: DB,
  courseId: string,
  type: ClipEventType,
  props: Record<string, unknown>
): Promise<void> {
  try {
    await supabase.from("analytics_event").insert({
      course_id: courseId,
      type,
      source: "clips",
      props: props as Json,
    });
  } catch {
    // best-effort — never crash the user path on analytics
  }
}
