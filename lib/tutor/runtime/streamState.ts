/**
 * TUTOR-1 Amendment A2 Wave 1 — the in-flight tutor-stream STATE writers.
 *
 * These four functions maintain the two nullable columns on `tutor_threads`
 * (`active_stream_id` + `active_response_id`) that record the CURRENTLY-STREAMING
 * turn for a (user, course) thread. Their only jobs are OBSERVABILITY and RESUME:
 * a reconnecting client reads the active stream id to rejoin, and a crash-recovery
 * pass reads the active response id.
 *
 * ── SCOPE (do not confuse the two id chains) ─────────────────────────────────
 *  • THIS file writes only the two IN-FLIGHT columns on `tutor_threads`. They are
 *    transient — set when a turn opens, captured when the provider assigns a
 *    response id, and CLEARED (both nulled) when the turn settles or aborts.
 *  • The COMPLETED-turn chain lives elsewhere: `tutor_turns.response_id`
 *    (append-only, immutable). These writers NEVER touch `tutor_turns`.
 *
 * ── BEST-EFFORT DISCIPLINE (mirrors emitTutorEvidence in service.ts) ─────────
 * A stream-state write must NEVER fail a turn. Every writer catches, logs one
 * JSON line `{tag:"tutor_stream_state", op, error}`, and returns; `readActiveStream`
 * returns null on any error. The turn's correctness never depends on these rows.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/** Log one best-effort failure as a single JSON line and swallow it. */
function logStreamStateError(op: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ tag: "tutor_stream_state", op, error: message }));
}

/**
 * Mark a thread's active stream id (turn opening). Best-effort — a failure logs
 * and returns; it never blocks the turn.
 */
export async function setActiveStream(
  admin: DB,
  args: { threadId: string; streamId: string }
): Promise<void> {
  try {
    const { error } = await admin
      .from("tutor_threads")
      .update({ active_stream_id: args.streamId })
      .eq("id", args.threadId);
    if (error) logStreamStateError("setActiveStream", error);
  } catch (err) {
    logStreamStateError("setActiveStream", err);
  }
}

/**
 * Capture the provider response id for the in-flight turn (crash-recovery
 * handle). Best-effort — a failure logs and returns.
 */
export async function captureActiveResponseId(
  admin: DB,
  args: { threadId: string; responseId: string }
): Promise<void> {
  try {
    const { error } = await admin
      .from("tutor_threads")
      .update({ active_response_id: args.responseId })
      .eq("id", args.threadId);
    if (error) logStreamStateError("captureActiveResponseId", error);
  } catch (err) {
    logStreamStateError("captureActiveResponseId", err);
  }
}

/**
 * Clear the in-flight state (turn settled or aborted) — nulls BOTH columns.
 * Best-effort — a failure logs and returns.
 */
export async function clearActiveStream(admin: DB, args: { threadId: string }): Promise<void> {
  try {
    const { error } = await admin
      .from("tutor_threads")
      .update({ active_stream_id: null, active_response_id: null })
      .eq("id", args.threadId);
    if (error) logStreamStateError("clearActiveStream", error);
  } catch (err) {
    logStreamStateError("clearActiveStream", err);
  }
}

/**
 * Read the in-flight stream state for a (user, course) thread — the resume-check
 * read. Returns null when there is no thread OR on ANY error (best-effort — a
 * failed read must never fail the turn; the caller degrades to a fresh stream).
 */
export async function readActiveStream(
  admin: DB,
  args: { userId: string; courseId: string }
): Promise<{ threadId: string; streamId: string | null; responseId: string | null } | null> {
  try {
    const { data, error } = await admin
      .from("tutor_threads")
      .select("id, active_stream_id, active_response_id")
      .eq("user_id", args.userId)
      .eq("course_id", args.courseId)
      .maybeSingle();
    if (error) {
      logStreamStateError("readActiveStream", error);
      return null;
    }
    if (!data) return null;
    return {
      threadId: data.id,
      streamId: data.active_stream_id,
      responseId: data.active_response_id,
    };
  } catch (err) {
    logStreamStateError("readActiveStream", err);
    return null;
  }
}
