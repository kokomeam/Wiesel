/**
 * Click attribution (Amendment 5) — makes "Lead → enrollment rate" actually
 * computable per campaign/touch, which nothing in the shipped foundation could
 * do (clicks landed with no campaign/touch dimensions, and there was no
 * enrollment→click linkage at all).
 *
 * `recordAttributedClick` is called by the click-redirect route after
 * `verifyToken` succeeds: records `email_click` WITH campaign/touch/subscriber
 * dimensions. `recordEnrollmentEvent` is the seam a future checkout webhook
 * calls (there is no Stripe integration yet — enrollment stays "recorded as an
 * event; payment lives elsewhere", per the existing non-goal); it does the
 * last-click, 7-day-window lookup and stamps the winning campaign/touch onto
 * the enrollment event's props.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { applyEventToSubscriber } from "./stateMachine";

type DB = SupabaseClient<Database>;

const ATTRIBUTION_WINDOW_MS = 7 * 24 * 3600 * 1000;

export async function recordAttributedClick(
  supabase: DB,
  args: { courseId: string; campaignId?: string; touchId?: string; subscriberId: string }
): Promise<void> {
  const { data: sub } = await supabase.from("subscriber").select("campaign_id").eq("id", args.subscriberId).maybeSingle();
  await supabase.from("analytics_event").insert({
    course_id: args.courseId,
    campaign_id: args.campaignId ?? sub?.campaign_id ?? null,
    subscriber_id: args.subscriberId,
    type: "email_click",
    source: "email_link",
    props: { touchId: args.touchId ?? null, attributed: true } as Json,
  });
  await applyEventToSubscriber(supabase, args.subscriberId, "email_click");
}

/** Record an unattributed click — a broken/expired/tampered token still
 *  redirects (never a dead link), but carries no subscriber/campaign
 *  dimensions since we can't trust them. */
export async function recordUnattributedClick(supabase: DB, courseId: string): Promise<void> {
  await supabase.from("analytics_event").insert({
    course_id: courseId,
    type: "email_click",
    source: "email_link",
    props: { attributed: false } as Json,
  });
}

export interface AttributionResult {
  campaignId: string | null;
  touchId: string | null;
}

/**
 * Last-click attribution within a 7-day window (Amendment 5's default sign-off
 * decision). Looks back over this subscriber's `email_click` events, picks the
 * most recent one inside the window, and returns its campaign/touch — or nulls
 * if there's no qualifying click (an enrollment can still be recorded
 * unattributed).
 */
export async function lastClickAttribution(supabase: DB, courseId: string, subscriberId: string): Promise<AttributionResult> {
  const since = new Date(Date.now() - ATTRIBUTION_WINDOW_MS).toISOString();
  const { data } = await supabase
    .from("analytics_event")
    .select("campaign_id,props,occurred_at")
    .eq("course_id", courseId)
    .eq("subscriber_id", subscriberId)
    .eq("type", "email_click")
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return { campaignId: null, touchId: null };
  const props = (data.props as Record<string, unknown>) ?? {};
  return { campaignId: data.campaign_id, touchId: typeof props.touchId === "string" ? props.touchId : null };
}

/** The seam a real checkout webhook (or a test) calls when a lead enrolls.
 *  Stamps last-click attribution onto the event and advances the reducer. */
export async function recordEnrollmentEvent(
  supabase: DB,
  args: { courseId: string; subscriberId: string }
): Promise<AttributionResult> {
  const attribution = await lastClickAttribution(supabase, args.courseId, args.subscriberId);
  await supabase.from("analytics_event").insert({
    course_id: args.courseId,
    campaign_id: attribution.campaignId,
    subscriber_id: args.subscriberId,
    type: "enrollment",
    source: attribution.campaignId ? "attributed" : "unattributed",
    props: { touchId: attribution.touchId, attributionWindowDays: 7 } as Json,
  });
  await applyEventToSubscriber(supabase, args.subscriberId, "enrollment");
  return attribution;
}
