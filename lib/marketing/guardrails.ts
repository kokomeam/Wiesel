/**
 * Guardrail thresholds + per-creator sending ramp (Amendment 10) — concrete
 * numbers where the PRD only gestured at "auto-pause thresholds", plus shared-
 * domain protection so one careless creator can't burn deliverability for
 * everyone sending from the platform's Resend domain.
 *
 * Both are evaluated FROM THE EVENT STREAM / OUTBOX ONLY — no new counters
 * that can drift, same discipline as the rest of the suite.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";

type DB = SupabaseClient<Database>;

/** Sign-off defaults (Amendment 10). */
export const GUARDRAILS = {
  minSendsBeforeEvaluating: 50,
  hardBounceRateThreshold: 0.02,
  spamComplaintRateThreshold: 0.001,
  unsubscribeRateThreshold: 0.01,
} as const;

/** Sign-off defaults — a new-account ramp so a fresh sender can't blast
 *  thousands on day one. Measured from days since the author's FIRST send. */
export const SEND_RAMP: { days: number; cap: number }[] = [
  { days: 7, cap: 200 },
  { days: 14, cap: 500 },
  { days: Infinity, cap: 2000 },
];

export interface GuardrailTrip {
  metric: "hard_bounce_rate" | "spam_complaint_rate" | "unsubscribe_rate";
  value: number;
  threshold: number;
}

/** Evaluate a campaign's guardrails from its own send/event counts. Returns
 *  null when there aren't enough sends yet (small-sample protection — the
 *  Interpreter's "don't overclaim from small data" rule applies here too). */
export async function evaluateCampaignGuardrails(supabase: DB, campaignId: string): Promise<GuardrailTrip | null> {
  const { data: seq } = await supabase.from("email_sequence").select("id").eq("campaign_id", campaignId);
  const seqIds = (seq ?? []).map((s) => s.id);
  if (seqIds.length === 0) return null;

  const { count: sentCount } = await supabase
    .from("scheduled_send")
    .select("id", { count: "exact", head: true })
    .in("sequence_id", seqIds)
    .eq("status", "sent");
  const sent = sentCount ?? 0;
  if (sent < GUARDRAILS.minSendsBeforeEvaluating) return null;

  const { count: hardBounces } = await supabase
    .from("scheduled_send")
    .select("id", { count: "exact", head: true })
    .in("sequence_id", seqIds)
    .eq("bounce_type", "hard");

  const { data: subs } = await supabase.from("subscriber").select("id").eq("campaign_id", campaignId);
  const subIds = (subs ?? []).map((s) => s.id);
  let unsubs = 0;
  let complaints = 0;
  if (subIds.length) {
    const { count: u } = await supabase
      .from("analytics_event")
      .select("id", { count: "exact", head: true })
      .in("subscriber_id", subIds)
      .eq("type", "email_unsubscribe");
    unsubs = u ?? 0;
    const { count: c } = await supabase
      .from("analytics_event")
      .select("id", { count: "exact", head: true })
      .in("subscriber_id", subIds)
      .eq("type", "spam_complaint");
    complaints = c ?? 0;
  }

  const hardBounceRate = (hardBounces ?? 0) / sent;
  const complaintRate = complaints / sent;
  const unsubRate = unsubs / sent;

  if (hardBounceRate > GUARDRAILS.hardBounceRateThreshold) {
    return { metric: "hard_bounce_rate", value: hardBounceRate, threshold: GUARDRAILS.hardBounceRateThreshold };
  }
  if (complaintRate > GUARDRAILS.spamComplaintRateThreshold) {
    return { metric: "spam_complaint_rate", value: complaintRate, threshold: GUARDRAILS.spamComplaintRateThreshold };
  }
  if (unsubRate > GUARDRAILS.unsubscribeRateThreshold) {
    return { metric: "unsubscribe_rate", value: unsubRate, threshold: GUARDRAILS.unsubscribeRateThreshold };
  }
  return null;
}

/** Auto-pause a campaign that tripped a guardrail: sets status='paused',
 *  records the reason in config, and emits `campaign_auto_paused`. */
export async function autoPauseCampaign(supabase: DB, campaignId: string, courseId: string, trip: GuardrailTrip): Promise<void> {
  const { data: campaign } = await supabase.from("marketing_campaign").select("config").eq("id", campaignId).maybeSingle();
  const prevConfig = (campaign?.config as Record<string, unknown>) ?? {};
  const occurredAt = new Date().toISOString();
  await supabase
    .from("marketing_campaign")
    .update({
      status: "paused",
      config: { ...prevConfig, autoPauseReason: { metric: trip.metric, value: trip.value, threshold: trip.threshold, occurredAt } },
    })
    .eq("id", campaignId);
  await supabase.from("email_sequence").update({ status: "paused" }).eq("campaign_id", campaignId);
  await supabase.from("analytics_event").insert({
    course_id: courseId,
    campaign_id: campaignId,
    type: "campaign_auto_paused",
    source: "guardrail",
    props: { metric: trip.metric, value: trip.value, threshold: trip.threshold } as Json,
  });
}

/** Days since the author's first-ever send, across ALL their courses (0 if
 *  they've never sent). Determines which ramp tier applies. */
async function daysSinceFirstSend(supabase: DB, authorId: string): Promise<number> {
  const { data: courses } = await supabase.from("courses").select("id").eq("author_id", authorId);
  const courseIds = (courses ?? []).map((c) => c.id);
  if (courseIds.length === 0) return 0;
  const { data } = await supabase
    .from("scheduled_send")
    .select("sent_at")
    .in("course_id", courseIds)
    .eq("status", "sent")
    .order("sent_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!data?.sent_at) return 0;
  return (Date.now() - new Date(data.sent_at).getTime()) / 86400000;
}

async function sentTodayCount(supabase: DB, authorId: string): Promise<number> {
  const { data: courses } = await supabase.from("courses").select("id").eq("author_id", authorId);
  const courseIds = (courses ?? []).map((c) => c.id);
  if (courseIds.length === 0) return 0;
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase
    .from("scheduled_send")
    .select("id", { count: "exact", head: true })
    .in("course_id", courseIds)
    .eq("status", "sent")
    .gte("sent_at", startOfDay.toISOString());
  return count ?? 0;
}

export interface SendRamp {
  cap: number;
  sentToday: number;
  remaining: number;
}

/** The per-creator daily cap + how much of it is already used. Enforced at the
 *  scheduler tick: sends beyond the remaining allowance STAY QUEUED (never
 *  dropped) — one careless import can't burn deliverability for every creator
 *  sharing the platform's domain. */
export async function getAuthorSendRamp(supabase: DB, authorId: string): Promise<SendRamp> {
  const days = await daysSinceFirstSend(supabase, authorId);
  const tier = SEND_RAMP.find((t) => days <= t.days) ?? SEND_RAMP[SEND_RAMP.length - 1];
  const sentToday = await sentTodayCount(supabase, authorId);
  return { cap: tier.cap, sentToday, remaining: Math.max(0, tier.cap - sentToday) };
}
