/**
 * Analytics aggregation over the SINGLE event stream (`analytics_event`).
 *
 * The same summary renders the creator dashboard AND is the agent's observe-step
 * input (`get_analytics_summary`) — there is no second analytics pipeline. Reads
 * are author-scoped (RLS); cheap COUNT queries over the (course_id,type) and
 * (campaign_id,status) indexes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { countAudienceContacts, listAuthorCourses } from "./persistence";
import type { AnalyticsEventType, SubscriberStatus } from "./types";

type DB = SupabaseClient<Database>;

const SUBSCRIBER_STATUSES: SubscriberStatus[] = [
  "lead",
  "subscribed",
  "engaged",
  "enrolled",
  "unsubscribed",
  "bounced",
];

export interface AnalyticsSummary {
  /** Top-of-funnel through conversion. */
  funnel: {
    views: number;
    leads: number;
    emailsSent: number;
    emailOpens: number;
    emailClicks: number;
    enrollments: number;
  };
  /** Derived rates (0–1; null when the denominator is 0). */
  rates: {
    viewToLead: number | null;
    openRate: number | null;
    clickRate: number | null;
    leadToEnroll: number | null;
  };
  subscribersByStatus: Record<SubscriberStatus, number>;
  totalSubscribers: number;
}

async function countEvents(supabase: DB, courseId: string, type: AnalyticsEventType): Promise<number> {
  const { count } = await supabase
    .from("analytics_event")
    .select("id", { count: "exact", head: true })
    .eq("course_id", courseId)
    .eq("type", type);
  return count ?? 0;
}

async function countSubscribers(
  supabase: DB,
  courseId: string,
  status: SubscriberStatus
): Promise<number> {
  const { count } = await supabase
    .from("subscriber")
    .select("id", { count: "exact", head: true })
    .eq("course_id", courseId)
    .eq("status", status);
  return count ?? 0;
}

const rate = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export async function getAnalyticsSummary(supabase: DB, courseId: string): Promise<AnalyticsSummary> {
  const [views, emailsSent, emailOpens, emailClicks, enrollEvents] = await Promise.all([
    countEvents(supabase, courseId, "page_view"),
    countEvents(supabase, courseId, "email_sent"),
    countEvents(supabase, courseId, "email_open"),
    countEvents(supabase, courseId, "email_click"),
    countEvents(supabase, courseId, "enrollment"),
  ]);

  const statusCounts = await Promise.all(
    SUBSCRIBER_STATUSES.map((s) => countSubscribers(supabase, courseId, s))
  );
  const subscribersByStatus = Object.fromEntries(
    SUBSCRIBER_STATUSES.map((s, i) => [s, statusCounts[i]])
  ) as Record<SubscriberStatus, number>;
  const totalSubscribers = statusCounts.reduce((a, b) => a + b, 0);

  // Leads = distinct subscribers (idempotent on capture) — more honest than
  // raw form_submit events; enrollments = the materialized 'enrolled' state
  // (falls back to enrollment events if state hasn't been reduced yet).
  const leads = totalSubscribers;
  const enrollments = Math.max(subscribersByStatus.enrolled, enrollEvents);

  return {
    funnel: { views, leads, emailsSent, emailOpens, emailClicks, enrollments },
    rates: {
      viewToLead: rate(leads, views),
      openRate: rate(emailOpens, emailsSent),
      clickRate: rate(emailClicks, emailOpens),
      leadToEnroll: rate(enrollments, leads),
    },
    subscribersByStatus,
    totalSubscribers,
  };
}

export interface AccountSummary {
  /** Distinct people across ALL the creator's courses (the real audience size). */
  totalContacts: number;
  /** Aggregate funnel activity summed across the creator's courses. */
  funnel: AnalyticsSummary["funnel"];
  courses: { id: string; title: string; funnel: AnalyticsSummary["funnel"] }[];
}

const ZERO_FUNNEL: AnalyticsSummary["funnel"] = {
  views: 0,
  leads: 0,
  emailsSent: 0,
  emailOpens: 0,
  emailClicks: 0,
  enrollments: 0,
};

/** Account-level rollup across every course the creator owns. `totalContacts` is
 *  distinct people (audience_contact); the funnel sums per-course activity. */
export async function getAccountSummary(supabase: DB, authorId: string): Promise<AccountSummary> {
  const courses = await listAuthorCourses(supabase, authorId);
  const perCourse = await Promise.all(
    courses.map(async (c) => ({ id: c.id, title: c.title, funnel: (await getAnalyticsSummary(supabase, c.id)).funnel }))
  );
  const funnel = perCourse.reduce<AnalyticsSummary["funnel"]>(
    (acc, c) => ({
      views: acc.views + c.funnel.views,
      leads: acc.leads + c.funnel.leads,
      emailsSent: acc.emailsSent + c.funnel.emailsSent,
      emailOpens: acc.emailOpens + c.funnel.emailOpens,
      emailClicks: acc.emailClicks + c.funnel.emailClicks,
      enrollments: acc.enrollments + c.funnel.enrollments,
    }),
    { ...ZERO_FUNNEL }
  );
  const totalContacts = await countAudienceContacts(supabase, authorId);
  return { totalContacts, funnel, courses: perCourse };
}

export interface AnalyticsEventRow {
  id: string;
  type: AnalyticsEventType;
  occurredAt: string;
  subscriberId: string | null;
  landingPageId: string | null;
  source: string | null;
  props: Record<string, unknown>;
}

export interface QueryEventsFilter {
  types?: AnalyticsEventType[];
  sinceIso?: string;
  limit?: number;
}

/** A bounded, filtered slice of the event stream (for the agent + drill-downs). */
export async function queryAnalyticsEvents(
  supabase: DB,
  courseId: string,
  filter: QueryEventsFilter = {}
): Promise<AnalyticsEventRow[]> {
  const limit = Math.min(filter.limit ?? 100, 500);
  let q = supabase
    .from("analytics_event")
    .select("id,type,occurred_at,subscriber_id,landing_page_id,source,props")
    .eq("course_id", courseId)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (filter.types && filter.types.length) q = q.in("type", filter.types);
  if (filter.sinceIso) q = q.gte("occurred_at", filter.sinceIso);
  const { data } = await q;
  return (data ?? []).map((e) => ({
    id: e.id,
    type: e.type as AnalyticsEventType,
    occurredAt: e.occurred_at,
    subscriberId: e.subscriber_id,
    landingPageId: e.landing_page_id,
    source: e.source,
    props: (e.props as Record<string, unknown>) ?? {},
  }));
}
