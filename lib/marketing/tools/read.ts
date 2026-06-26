/**
 * Read tools — observe context, never mutate, never gated. These are the agent's
 * eyes (and the `get_analytics_summary` observe input lands here in Phase 2).
 */

import { z } from "zod";
import {
  listLandingPages,
  loadCampaignForCourse,
  loadCourseMarketingContext,
  loadLandingPage,
} from "../persistence";
import { defineMarketingTool, MarketingToolError } from "./types";

const getCampaignContext = defineMarketingTool({
  name: "get_campaign_context",
  description:
    "Get the current campaign + course summary (status, asset counts). Call this first to orient.",
  params: z.object({}),
  reversibility: "read",
  async execute(_args, ctx) {
    const campaign = ctx.campaignId
      ? await loadCampaignForCourse(ctx.supabase, ctx.courseId)
      : await loadCampaignForCourse(ctx.supabase, ctx.courseId);
    const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
    const pages = campaign ? await listLandingPages(ctx.supabase, campaign.id) : [];
    return {
      summary: campaign
        ? `Campaign "${campaign.name}" (${campaign.status}) · ${pages.length} landing page(s).`
        : "No campaign yet for this course.",
      data: {
        campaign,
        course: course && {
          title: course.title,
          audience: course.audience,
          level: course.level,
          moduleCount: course.modules.length,
        },
        landingPages: pages.map((p) => ({ id: p.id, title: p.title, slug: p.slug, status: p.status })),
      },
    };
  },
});

const getCoursePlan = defineMarketingTool({
  name: "get_course_plan",
  description:
    "Get the course's syllabus + plan (outcomes, prerequisites, teaching style, modules) to ground all marketing copy.",
  params: z.object({}),
  reversibility: "read",
  async execute(_args, ctx) {
    const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
    if (!course) throw new MarketingToolError("Course not found");
    return { summary: `Plan for "${course.title}" — ${course.outcomes.length} outcomes, ${course.modules.length} modules.`, data: course };
  },
});

const listLandingPagesTool = defineMarketingTool({
  name: "list_landing_pages",
  description: "List this campaign's landing pages with their status.",
  params: z.object({}),
  reversibility: "read",
  async execute(_args, ctx) {
    if (!ctx.campaignId) return { summary: "No campaign yet.", data: { pages: [] } };
    const pages = await listLandingPages(ctx.supabase, ctx.campaignId);
    return {
      summary: `${pages.length} landing page(s).`,
      data: { pages: pages.map((p) => ({ id: p.id, title: p.title, slug: p.slug, status: p.status })) },
    };
  },
});

const getLandingPageTool = defineMarketingTool({
  name: "get_landing_page",
  description: "Get one landing page's full typed sections by id.",
  params: z.object({ pageId: z.string().min(1) }),
  reversibility: "read",
  async execute(args, ctx) {
    const page = await loadLandingPage(ctx.supabase, args.pageId);
    if (!page) throw new MarketingToolError(`Landing page ${args.pageId} not found`);
    return {
      summary: `"${page.title}" (${page.status}) — ${page.sections.length} sections.`,
      data: page,
    };
  },
});

export const readTools = [
  getCampaignContext,
  getCoursePlan,
  listLandingPagesTool,
  getLandingPageTool,
];
