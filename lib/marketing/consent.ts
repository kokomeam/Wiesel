/**
 * Consent lapse (Amendment 7) — pending imports that never confirm expire from
 * eligibility after 30 days: the row is RETAINED (audit) but marked `lapsed`,
 * and a lapsed contact can never be marketed to (eligibility queries require
 * consent_status='confirmed').
 *
 * Applied as a sweep at each scheduler tick (the natural heartbeat — no new
 * cron surface). Lapse is measured from `consent_requested_at` when a
 * confirmation email went out, else from the row's creation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

export const CONSENT_LAPSE_DAYS = 30;

/** Mark pending subscribers older than the lapse window as `lapsed`. Returns
 *  how many lapsed. Idempotent — already-lapsed rows are untouched. */
export async function sweepLapsedConsent(supabase: DB, opts: { nowMs?: number } = {}): Promise<{ lapsed: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - CONSENT_LAPSE_DAYS * 24 * 3600 * 1000).toISOString();

  // Requested-and-never-confirmed → lapse from the request date.
  const { data: requested } = await supabase
    .from("subscriber")
    .update({ consent_status: "lapsed" })
    .eq("consent_status", "pending")
    .not("consent_requested_at", "is", null)
    .lte("consent_requested_at", cutoffIso)
    .select("id");

  // Never even requested → lapse from creation.
  const { data: unrequested } = await supabase
    .from("subscriber")
    .update({ consent_status: "lapsed" })
    .eq("consent_status", "pending")
    .is("consent_requested_at", null)
    .lte("created_at", cutoffIso)
    .select("id");

  return { lapsed: (requested?.length ?? 0) + (unrequested?.length ?? 0) };
}
