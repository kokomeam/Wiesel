/**
 * Campaign tools. `create_campaign` is the reversible root action that every
 * other tool scopes to (MVP = one campaign per course).
 */

import { z } from "zod";
import { defineMarketingTool, MarketingToolError } from "./types";

const createCampaign = defineMarketingTool({
  name: "create_campaign",
  description:
    "Create the marketing campaign container for this course (the home for its landing pages, sequences, list, and analytics).",
  params: z.object({
    name: z.string().min(1).max(80),
    goal: z.string().max(200).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "create_campaign",
  // A create has no prior state → Reject deletes the created campaign.
  async execute(args, ctx) {
    const { data, error } = await ctx.supabase
      .from("marketing_campaign")
      .insert({ course_id: ctx.courseId, name: args.name, goal: args.goal ?? null })
      .select("id")
      .single();
    if (error || !data) throw new MarketingToolError(`create_campaign: ${error?.message}`);
    return {
      summary: `Created campaign "${args.name}".`,
      data: { campaignId: data.id },
      target: { entity: "campaign", id: data.id },
    };
  },
});

export const campaignTools = [createCampaign];
