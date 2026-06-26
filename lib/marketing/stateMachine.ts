/**
 * The subscriber lifecycle state machine — a pure REDUCER over the event stream.
 *
 * Status is never set ad-hoc; it's derived by folding analytics events:
 *   form_submit / free_lesson_capture → lead
 *   email_sent                        → subscribed   (now an active recipient)
 *   email_open / email_click          → engaged
 *   enrollment                        → enrolled
 *   email_unsubscribe                 → unsubscribed (terminal, suppressed)
 *   email_bounce                      → bounced      (terminal, suppressed)
 *
 * Active statuses only ever advance (max rank); terminal statuses stick. This is
 * the single definition of "what does this event do to a subscriber," shared by
 * the ingest path, the scheduler/send runner, and any future enrollment flow.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { AnalyticsEventType, SubscriberStatus } from "./types";

type DB = SupabaseClient<Database>;

const RANK: Record<"lead" | "subscribed" | "engaged" | "enrolled", number> = {
  lead: 0,
  subscribed: 1,
  engaged: 2,
  enrolled: 3,
};

const TERMINAL: ReadonlySet<SubscriberStatus> = new Set(["unsubscribed", "bounced"]);

/** Pure: the subscriber's next status after `event`. */
export function reduceStatus(current: SubscriberStatus, event: AnalyticsEventType): SubscriberStatus {
  if (TERMINAL.has(current)) return current;
  if (event === "email_unsubscribe") return "unsubscribed";
  if (event === "email_bounce") return "bounced";

  const candidate: keyof typeof RANK | null =
    event === "email_sent"
      ? "subscribed"
      : event === "email_open" || event === "email_click"
        ? "engaged"
        : event === "enrollment"
          ? "enrolled"
          : event === "form_submit" || event === "free_lesson_capture"
            ? "lead"
            : null;
  if (!candidate) return current;

  const cur = RANK[current as keyof typeof RANK] ?? 0;
  return RANK[candidate] > cur ? candidate : current;
}

/** True if no send may target this subscriber. */
export function isSuppressed(status: SubscriberStatus): boolean {
  return TERMINAL.has(status);
}

/** Apply an event to a subscriber row, advancing its status if the reducer says
 *  so. Returns the resulting status (or null if the subscriber is gone). */
export async function applyEventToSubscriber(
  supabase: DB,
  subscriberId: string,
  event: AnalyticsEventType
): Promise<SubscriberStatus | null> {
  const { data } = await supabase
    .from("subscriber")
    .select("status")
    .eq("id", subscriberId)
    .maybeSingle();
  if (!data) return null;

  const current = data.status as SubscriberStatus;
  const next = reduceStatus(current, event);
  if (next === current) return current;

  const patch: Database["public"]["Tables"]["subscriber"]["Update"] = { status: next };
  if (next === "unsubscribed") patch.unsubscribed_at = new Date().toISOString();
  const { error } = await supabase.from("subscriber").update(patch).eq("id", subscriberId);
  if (error) throw new Error(`applyEventToSubscriber: ${error.message}`);
  return next;
}
