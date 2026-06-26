/**
 * Analytics read tools — the agent's OBSERVE surface. Same aggregation the
 * dashboard renders, so the agent and the creator reason over identical numbers.
 */

import { z } from "zod";
import { getAnalyticsSummary, queryAnalyticsEvents } from "../analytics";
import { defineMarketingTool } from "./types";

const ANALYTICS_EVENT_TYPES = [
  "page_view",
  "form_submit",
  "free_lesson_capture",
  "email_sent",
  "email_open",
  "email_click",
  "email_bounce",
  "email_unsubscribe",
  "enrollment",
] as const;

const getAnalyticsSummaryTool = defineMarketingTool({
  name: "get_analytics_summary",
  description:
    "Get the marketing funnel for this course (views → leads → opens → clicks → enrollments + rates + subscribers by status). The observe-step snapshot.",
  params: z.object({}),
  reversibility: "read",
  async execute(_args, ctx) {
    const summary = await getAnalyticsSummary(ctx.supabase, ctx.courseId);
    const f = summary.funnel;
    return {
      summary: `Funnel — ${f.views} views · ${f.leads} leads · ${f.emailOpens} opens · ${f.emailClicks} clicks · ${f.enrollments} enrollments.`,
      data: summary,
    };
  },
});

const queryAnalyticsEventsTool = defineMarketingTool({
  name: "query_analytics_events",
  description:
    "Fetch a bounded, filtered slice of the raw event stream (by type and/or since a timestamp) for drill-downs.",
  params: z.object({
    types: z.array(z.enum(ANALYTICS_EVENT_TYPES)).nullable(),
    sinceIso: z.string().nullable(),
    limit: z.number().int().min(1).max(500).nullable(),
  }),
  reversibility: "read",
  async execute(args, ctx) {
    const events = await queryAnalyticsEvents(ctx.supabase, ctx.courseId, {
      types: args.types ?? undefined,
      sinceIso: args.sinceIso ?? undefined,
      limit: args.limit ?? undefined,
    });
    return { summary: `${events.length} event(s).`, data: { events } };
  },
});

const getSubscriberSegmentsTool = defineMarketingTool({
  name: "get_subscriber_segments",
  description: "Get subscriber counts by lifecycle status (lead/subscribed/engaged/enrolled/…).",
  params: z.object({}),
  reversibility: "read",
  async execute(_args, ctx) {
    const summary = await getAnalyticsSummary(ctx.supabase, ctx.courseId);
    return {
      summary: `${summary.totalSubscribers} subscribers across ${Object.keys(summary.subscribersByStatus).length} statuses.`,
      data: { byStatus: summary.subscribersByStatus, total: summary.totalSubscribers },
    };
  },
});

export const analyticsTools = [
  getAnalyticsSummaryTool,
  queryAnalyticsEventsTool,
  getSubscriberSegmentsTool,
];
