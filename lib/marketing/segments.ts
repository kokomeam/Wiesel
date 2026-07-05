/**
 * Behavioral segments + engagement score (Amendment 4) — pure queries over
 * `analytics_event` (+ the lifecycle reducer's materialized `subscriber.status`),
 * never a materialized list. This is also what fixes the original PRD's Screen
 * 2 orphan: a campaign can target "Clicked-not-enrolled (34)" because
 * `getLeadSegment` can actually produce that set.
 *
 * Engagement score is COMPUTED AT READ TIME, never stored — same philosophy as
 * the subscriber-status reducer: no second number that can drift from the one
 * event stream. No ML; a transparent, explainable heuristic.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { EngagementBucket, LeadSegmentKey } from "./types";

type DB = SupabaseClient<Database>;

export interface SegmentLead {
  subscriberId: string;
  email: string;
  name: string | null;
}

/** MPP caveat: Apple Mail Privacy Protection auto-fires tracking pixels, so
 *  "not_opened" / "opened_not_clicked" over-count real engagement for a large
 *  share of consumer inboxes. Surfaced on every open-based segment result. */
export const MPP_CAVEAT =
  "Approximate — Apple Mail Privacy Protection auto-opens many emails, inflating opens and undercounting true \"not opened\".";

export interface SegmentResult {
  segment: LeadSegmentKey;
  leads: SegmentLead[];
  caveat: string | null;
}

async function subscriberIdsWithEvent(
  supabase: DB,
  courseId: string,
  type: string,
  campaignId?: string | null
): Promise<Set<string>> {
  let q = supabase.from("analytics_event").select("subscriber_id").eq("course_id", courseId).eq("type", type);
  if (campaignId) q = q.eq("campaign_id", campaignId);
  const { data } = await q;
  return new Set((data ?? []).map((r) => r.subscriber_id).filter((x): x is string => !!x));
}

async function loadLeads(supabase: DB, courseId: string, ids: string[]): Promise<SegmentLead[]> {
  if (ids.length === 0) return [];
  const { data } = await supabase.from("subscriber").select("id,email,name").eq("course_id", courseId).in("id", ids);
  return (data ?? []).map((s) => ({ subscriberId: s.id, email: s.email, name: s.name }));
}

/**
 * Resolve one of the fixed MVP segments. `campaignId` scopes click/open sets to
 * one campaign's sends when provided (else course-wide). A plain-English →
 * segment mapper (Klaviyo Segments-AI style) is a stated LATER SEAM — MVP ships
 * exactly this fixed set, chosen because each is directly wired to a real
 * product moment (a follow-up rule trigger or the Analytics Interpreter).
 */
export async function getLeadSegment(
  supabase: DB,
  courseId: string,
  segment: LeadSegmentKey,
  opts: { campaignId?: string | null; source?: string | null } = {}
): Promise<SegmentResult> {
  switch (segment) {
    case "clicked_not_enrolled": {
      const clicked = await subscriberIdsWithEvent(supabase, courseId, "email_click", opts.campaignId);
      const enrolled = await subscriberIdsWithEvent(supabase, courseId, "enrollment", opts.campaignId);
      const ids = [...clicked].filter((id) => !enrolled.has(id));
      return { segment, leads: await loadLeads(supabase, courseId, ids), caveat: null };
    }
    case "opened_not_clicked": {
      const opened = await subscriberIdsWithEvent(supabase, courseId, "email_open", opts.campaignId);
      const clicked = await subscriberIdsWithEvent(supabase, courseId, "email_click", opts.campaignId);
      const ids = [...opened].filter((id) => !clicked.has(id));
      return { segment, leads: await loadLeads(supabase, courseId, ids), caveat: MPP_CAVEAT };
    }
    case "not_opened": {
      const sent = await subscriberIdsWithEvent(supabase, courseId, "email_sent", opts.campaignId);
      const opened = await subscriberIdsWithEvent(supabase, courseId, "email_open", opts.campaignId);
      const ids = [...sent].filter((id) => !opened.has(id));
      return { segment, leads: await loadLeads(supabase, courseId, ids), caveat: MPP_CAVEAT };
    }
    case "engaged_30d": {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const { data } = await supabase
        .from("analytics_event")
        .select("subscriber_id")
        .eq("course_id", courseId)
        .in("type", ["email_open", "email_click"])
        .gte("occurred_at", since);
      const ids = [...new Set((data ?? []).map((r) => r.subscriber_id).filter((x): x is string => !!x))];
      return { segment, leads: await loadLeads(supabase, courseId, ids), caveat: MPP_CAVEAT };
    }
    case "most_engaged": {
      const { data: subs } = await supabase.from("subscriber").select("id,email,name").eq("course_id", courseId);
      const scored = await Promise.all(
        (subs ?? []).map(async (s) => ({ s, score: (await engagementScore(supabase, courseId, s.id)).score })
        )
      );
      const ids = scored
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 50)
        .map((x) => x.s.id);
      return { segment, leads: await loadLeads(supabase, courseId, ids), caveat: MPP_CAVEAT };
    }
    case "by_source": {
      let q = supabase.from("subscriber").select("id,email,name").eq("course_id", courseId);
      if (opts.source) q = q.eq("source", opts.source);
      const { data } = await q;
      return {
        segment,
        leads: (data ?? []).map((s) => ({ subscriberId: s.id, email: s.email, name: s.name })),
        caveat: null,
      };
    }
    default:
      return { segment, leads: [], caveat: null };
  }
}

export interface EngagementScore {
  score: number;
  bucket: EngagementBucket;
  opens: number;
  clicks: number;
}

function bucketFor(score: number): EngagementBucket {
  if (score >= 8) return "hot";
  if (score >= 4) return "warm";
  if (score >= 1) return "cool";
  return "cold";
}

/**
 * score = Σ(opens×1 + clicks×3) with a 30-day half-life decay. Computed at
 * read time from `analytics_event` only — no stored score to drift (Amendment
 * 4b's explicit philosophy). Opens are labeled approximate wherever surfaced
 * (Amendment 11 — MPP inflates them).
 */
export async function engagementScore(supabase: DB, courseId: string, subscriberId: string): Promise<EngagementScore> {
  const { data } = await supabase
    .from("analytics_event")
    .select("type,occurred_at")
    .eq("course_id", courseId)
    .eq("subscriber_id", subscriberId)
    .in("type", ["email_open", "email_click"]);

  const nowMs = Date.now();
  const HALF_LIFE_MS = 30 * 24 * 3600 * 1000;
  let score = 0;
  let opens = 0;
  let clicks = 0;
  for (const row of data ?? []) {
    const ageMs = nowMs - new Date(row.occurred_at).getTime();
    const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
    if (row.type === "email_open") {
      opens++;
      score += 1 * decay;
    } else if (row.type === "email_click") {
      clicks++;
      score += 3 * decay;
    }
  }
  score = Math.round(score * 10) / 10;
  return { score, bucket: bucketFor(score), opens, clicks };
}

/** Bulk variant for the Leads table — ONE query over the course's open/click
 *  events, scores computed in memory (avoids N+1 per row). Same math as
 *  `engagementScore`. */
export async function engagementScores(supabase: DB, courseId: string): Promise<Map<string, EngagementScore>> {
  const { data } = await supabase
    .from("analytics_event")
    .select("subscriber_id,type,occurred_at")
    .eq("course_id", courseId)
    .in("type", ["email_open", "email_click"]);

  const nowMs = Date.now();
  const HALF_LIFE_MS = 30 * 24 * 3600 * 1000;
  const acc = new Map<string, { score: number; opens: number; clicks: number }>();
  for (const row of data ?? []) {
    if (!row.subscriber_id) continue;
    const entry = acc.get(row.subscriber_id) ?? { score: 0, opens: 0, clicks: 0 };
    const decay = Math.pow(0.5, (nowMs - new Date(row.occurred_at).getTime()) / HALF_LIFE_MS);
    if (row.type === "email_open") {
      entry.opens++;
      entry.score += 1 * decay;
    } else {
      entry.clicks++;
      entry.score += 3 * decay;
    }
    acc.set(row.subscriber_id, entry);
  }
  const out = new Map<string, EngagementScore>();
  for (const [id, e] of acc) {
    const score = Math.round(e.score * 10) / 10;
    out.set(id, { score, bucket: bucketFor(score), opens: e.opens, clicks: e.clicks });
  }
  return out;
}

/* ───────────────────── lead profile (Amendment 4a) ──────────────────────── */

export interface LeadProfileEvent {
  type: string;
  occurredAt: string;
  props: Record<string, unknown>;
}

export interface CampaignEngagement {
  campaignId: string | null;
  received: number;
  opened: number;
  clicked: number;
}

export interface LeadProfile {
  subscriberId: string;
  email: string;
  name: string | null;
  lifecycleStatus: string;
  source: string | null;
  consentStatus: string;
  consentText: string | null;
  consentRequestedAt: string | null;
  suppressed: boolean;
  suppressionReason: "unsubscribed" | "bounced" | null;
  engagement: EngagementScore;
  timeline: LeadProfileEvent[];
  perCampaign: CampaignEngagement[];
}

/** The Amendment 4a screen's full backing read — timeline newest-first,
 *  lifecycle status DISPLAYED from the reducer's materialized column (never
 *  re-derived here — one definition of status, in stateMachine.ts). */
export async function loadLeadProfile(supabase: DB, subscriberId: string): Promise<LeadProfile | null> {
  const { data: sub } = await supabase.from("subscriber").select("*").eq("id", subscriberId).maybeSingle();
  if (!sub) return null;

  const { data: events } = await supabase
    .from("analytics_event")
    .select("type,occurred_at,props,campaign_id")
    .eq("subscriber_id", subscriberId)
    .order("occurred_at", { ascending: false });

  const perCampaignMap = new Map<string | null, CampaignEngagement>();
  for (const e of events ?? []) {
    const key = e.campaign_id;
    const entry = perCampaignMap.get(key) ?? { campaignId: key, received: 0, opened: 0, clicked: 0 };
    if (e.type === "email_sent") entry.received++;
    if (e.type === "email_open") entry.opened++;
    if (e.type === "email_click") entry.clicked++;
    perCampaignMap.set(key, entry);
  }

  const engagement = await engagementScore(supabase, sub.course_id, subscriberId);
  const consent = (sub.consent as Record<string, unknown>) ?? {};

  return {
    subscriberId: sub.id,
    email: sub.email,
    name: sub.name,
    lifecycleStatus: sub.status,
    source: sub.source,
    consentStatus: sub.consent_status,
    consentText: typeof consent.text === "string" ? consent.text : null,
    consentRequestedAt: sub.consent_requested_at,
    suppressed: sub.status === "unsubscribed" || sub.status === "bounced",
    suppressionReason: sub.status === "unsubscribed" ? "unsubscribed" : sub.status === "bounced" ? "bounced" : null,
    engagement,
    timeline: (events ?? []).map((e) => ({
      type: e.type,
      occurredAt: e.occurred_at,
      props: (e.props as Record<string, unknown>) ?? {},
    })),
    perCampaign: [...perCampaignMap.values()],
  };
}
