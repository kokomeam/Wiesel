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

/** Settings + the row's `updated_at` (null = no row yet) — the optimistic
 *  token for the guarded save (UI-1 DEV-2). */
export interface AutonomySettingsWithMeta extends AutonomySettings {
  updatedAt: string | null;
}

export async function loadAutonomySettingsWithMeta(
  supabase: DB,
  courseId: string
): Promise<AutonomySettingsWithMeta> {
  const { data } = await supabase
    .from("marketing_autonomy_settings")
    .select("mode, policy, revert_window_hours, updated_at")
    .eq("course_id", courseId)
    .maybeSingle();
  if (!data) return { ...DEFAULT_AUTONOMY_SETTINGS, updatedAt: null };
  return {
    mode: parseMode(data.mode),
    policy: parsePolicy(data.policy),
    revertWindowHours:
      typeof data.revert_window_hours === "number" && data.revert_window_hours >= 1
        ? data.revert_window_hours
        : DEFAULT_REVERT_WINDOW_HOURS,
    updatedAt: data.updated_at,
  };
}

/**
 * Optimistic guarded save (UI-1 DEV-2, approved at CHECKPOINT-0): the update
 * only lands if the row's `updated_at` still matches what this client loaded
 * (the moddatetime trigger bumps it on every write) — a concurrent save from
 * another tab/surface returns `conflict` instead of being silently clobbered.
 * `expectedUpdatedAt: null` = first save → INSERT; losing a first-save race
 * (unique course_id) is a conflict too. No schema change: the guard rides
 * the existing `updated_at` column.
 */
export async function saveAutonomySettingsGuarded(
  supabase: DB,
  courseId: string,
  next: AutonomySettings,
  expectedUpdatedAt: string | null
): Promise<{ ok: true } | { ok: false; conflict: true }> {
  const row = {
    course_id: courseId,
    mode: next.mode,
    policy: next.policy as unknown as Json,
    revert_window_hours: next.revertWindowHours,
  };
  if (expectedUpdatedAt === null) {
    const { error } = await supabase.from("marketing_autonomy_settings").insert(row);
    if (error) {
      if (error.code === "23505") return { ok: false, conflict: true };
      throw new Error(`autonomy settings save failed: ${error.message}`);
    }
    return { ok: true };
  }
  const { data, error } = await supabase
    .from("marketing_autonomy_settings")
    .update(row)
    .eq("course_id", courseId)
    .eq("updated_at", expectedUpdatedAt)
    .select("course_id");
  if (error) throw new Error(`autonomy settings save failed: ${error.message}`);
  if (!data || data.length === 0) return { ok: false, conflict: true };
  return { ok: true };
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
