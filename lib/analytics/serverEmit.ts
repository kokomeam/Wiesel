/**
 * Server-side emitter for the AUTHORITATIVE analytics events (Milestone 3
 * hybrid model): quiz_submitted, homework_submitted, lesson_completed. These
 * fire from the existing service-role writers the moment the source row
 * lands, so they can't be lost to a closed tab and they carry real row ids.
 *
 * Idempotency: callers pass the stable row uuid (attempt / submission /
 * learn_progress id) as clientEventId — a retried request upserts into the
 * same client_event_id and no-ops.
 *
 * NEVER throws: analytics must not break grading/submission/progress. A
 * failed emit is logged and swallowed (the rollups cross-check the source
 * tables anyway, so a dropped event can't corrupt dashboard numbers).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  buildEvent,
  mapEventToColumns,
  type AnalyticsEventInput,
  type CommsDeliveryEvent,
  type EventContext,
} from "./events";

type DB = SupabaseClient<Database>;

export async function emitServerEvent(
  admin: DB,
  userId: string,
  ctx: EventContext,
  input: AnalyticsEventInput,
  clientEventId: string
): Promise<void> {
  try {
    const event = buildEvent(ctx, input, { clientEventId });
    const { error } = await admin
      .from("learning_events")
      .upsert([mapEventToColumns(event, userId)], {
        onConflict: "client_event_id",
        ignoreDuplicates: true,
      });
    if (error) {
      console.error("[analytics] server emit failed", input.eventType, error.message);
    }
  } catch (err) {
    console.error("[analytics] server emit failed", input.eventType, err);
  }
}

export type CommsEmitOutcome = "inserted" | "duplicate" | "error";

/**
 * Emit one comms delivery event (Milestone 7 — the Resend webhook is the only
 * caller). Unlike emitServerEvent this REPORTS the outcome: the webhook uses
 * "duplicate" (same Svix-derived clientEventId already landed) to flag a
 * redelivery, and "error" to 500 so Svix retries — a delivery event must not
 * be silently dropped the way best-effort engagement telemetry can be.
 */
export async function emitCommsDeliveryEvent(
  admin: DB,
  userId: string,
  event: CommsDeliveryEvent
): Promise<CommsEmitOutcome> {
  const { data, error } = await admin
    .from("learning_events")
    .upsert([mapEventToColumns(event, userId)], {
      onConflict: "client_event_id",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) {
    console.error("[analytics] comms emit failed", event.eventType, error.message);
    return "error";
  }
  return (data ?? []).length > 0 ? "inserted" : "duplicate";
}
