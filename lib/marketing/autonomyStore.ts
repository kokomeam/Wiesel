/**
 * IO companion to the pure policy engine (autonomy.ts): loads/saves the
 * per-course autonomy settings row and maintains the segment send history that
 * powers the first-send-to-new-segment guardrail.
 *
 * NO ROW is a valid state and means the defaults: assisted mode, EMPTY policy,
 * 24h revert window. The settings row is created lazily on first save.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import {
  DEFAULT_AUTONOMY_SETTINGS,
  DEFAULT_REVERT_WINDOW_HOURS,
  parseMode,
  parsePolicy,
  type AutonomySettings,
} from "./autonomy";

type DB = SupabaseClient<Database>;

export async function loadAutonomySettings(supabase: DB, courseId: string): Promise<AutonomySettings> {
  const { data } = await supabase
    .from("marketing_autonomy_settings")
    .select("mode, policy, revert_window_hours")
    .eq("course_id", courseId)
    .maybeSingle();
  if (!data) return { ...DEFAULT_AUTONOMY_SETTINGS };
  return {
    mode: parseMode(data.mode),
    policy: parsePolicy(data.policy),
    revertWindowHours:
      typeof data.revert_window_hours === "number" && data.revert_window_hours >= 1
        ? data.revert_window_hours
        : DEFAULT_REVERT_WINDOW_HOURS,
  };
}

export async function upsertAutonomySettings(
  supabase: DB,
  courseId: string,
  patch: Partial<AutonomySettings>
): Promise<AutonomySettings> {
  const current = await loadAutonomySettings(supabase, courseId);
  const next: AutonomySettings = {
    mode: patch.mode ?? current.mode,
    policy: patch.policy ?? current.policy,
    revertWindowHours: patch.revertWindowHours ?? current.revertWindowHours,
  };
  const { error } = await supabase.from("marketing_autonomy_settings").upsert(
    {
      course_id: courseId,
      mode: next.mode,
      policy: next.policy as unknown as Json,
      revert_window_hours: next.revertWindowHours,
    },
    { onConflict: "course_id" }
  );
  if (error) throw new Error(`autonomy settings save failed: ${error.message}`);
  return next;
}

/** Has this course ever completed a send to `segmentKey`? */
export async function hasSegmentBeenSent(supabase: DB, courseId: string, segmentKey: string): Promise<boolean> {
  const { data } = await supabase
    .from("marketing_segment_send")
    .select("id")
    .eq("course_id", courseId)
    .eq("segment_key", segmentKey)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Record that a segment send actually EXECUTED (auto-approved or
 * human-approved — both teach the first-send guardrail). Upsert on
 * (course_id, segment_key): first send inserts, later sends bump
 * last_sent_at + send_count.
 */
export async function recordSegmentSend(
  supabase: DB,
  fields: { courseId: string; campaignId: string | null; segmentKey: string; nowIso: string }
): Promise<void> {
  const { data: existing } = await supabase
    .from("marketing_segment_send")
    .select("id, send_count")
    .eq("course_id", fields.courseId)
    .eq("segment_key", fields.segmentKey)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("marketing_segment_send")
      .update({ last_sent_at: fields.nowIso, send_count: existing.send_count + 1 })
      .eq("id", existing.id);
    return;
  }

  const { error } = await supabase.from("marketing_segment_send").insert({
    course_id: fields.courseId,
    campaign_id: fields.campaignId,
    segment_key: fields.segmentKey,
    first_sent_at: fields.nowIso,
    last_sent_at: fields.nowIso,
  });
  // A concurrent insert can win the unique(course_id, segment_key) race —
  // fall back to the bump path so the send is still counted.
  if (error) {
    const { data: raced } = await supabase
      .from("marketing_segment_send")
      .select("id, send_count")
      .eq("course_id", fields.courseId)
      .eq("segment_key", fields.segmentKey)
      .maybeSingle();
    if (raced) {
      await supabase
        .from("marketing_segment_send")
        .update({ last_sent_at: fields.nowIso, send_count: raced.send_count + 1 })
        .eq("id", raced.id);
    }
  }
}
