/**
 * Landing-page tools.
 *
 *   generate_landing_page  — REVERSIBLE create: fills the section slot-schema
 *                            from the course plan → a draft page. Reject deletes.
 *   update_landing_section — REVERSIBLE update: rewrite one section's slots.
 *                            The gate snapshots the page first → Reject restores.
 *   publish_landing_page   — IRREVERSIBLE: flips a page LIVE on /p/[slug].
 *   unpublish_landing_page — IRREVERSIBLE: takes a live page down.
 *
 * Phase 1 swaps `generate_landing_page`'s deterministic generator for the LLM
 * one behind the same call; the tool contract + the gate routing are unchanged.
 */

import { z } from "zod";
import { generateLandingSections, slugify } from "../generators";
import {
  loadCampaignForCourse,
  loadCourseMarketingContext,
  loadLandingPage,
  sectionsToJson,
  themeToJson,
} from "../persistence";
import { LandingSectionSchema, SECTION_VARIANTS } from "../schemas";
import type { LandingSection, LandingTheme } from "../types";
import { defineMarketingTool, MarketingToolError } from "./types";

async function requireCampaignId(ctx: { campaignId: string | null; courseId: string; supabase: import("./types").DB }): Promise<string> {
  if (ctx.campaignId) return ctx.campaignId;
  const c = await loadCampaignForCourse(ctx.supabase, ctx.courseId);
  if (!c) throw new MarketingToolError("No campaign yet — call create_campaign first.");
  return c.id;
}

const generateLandingPage = defineMarketingTool({
  name: "generate_landing_page",
  description:
    "Generate a complete landing/sales page (typed sections) from the course's syllabus. Stages as a reviewable draft; does not publish.",
  params: z.object({
    title: z.string().min(1).max(120).nullable(),
    ctaLabel: z.string().min(1).max(32).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "generate_landing_page",
  async execute(args, ctx) {
    const campaignId = await requireCampaignId(ctx);
    const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
    if (!course) throw new MarketingToolError("Course not found");

    const sections = generateLandingSections(course, { ctaLabel: args.ctaLabel ?? undefined });
    const title = args.title ?? course.title;
    // Per-PAGE salt (not the course id) so multiple pages for one course get
    // distinct slugs and never collide on the unique constraint.
    const slug = slugify(course.title, crypto.randomUUID().slice(0, 6));

    const { data, error } = await ctx.supabase
      .from("landing_page")
      .insert({
        campaign_id: campaignId,
        course_id: ctx.courseId,
        slug,
        title,
        status: "draft",
        sections: sectionsToJson(sections),
      })
      .select("id")
      .single();
    if (error || !data) throw new MarketingToolError(`generate_landing_page: ${error?.message}`);

    return {
      summary: `Drafted a landing page "${title}" with ${sections.length} sections (→ /p/${slug}).`,
      data: { pageId: data.id, slug, sectionCount: sections.length },
      target: { entity: "landing_page", id: data.id },
    };
  },
});

const updateLandingSection = defineMarketingTool({
  name: "update_landing_section",
  description:
    "Edit a landing page's CONTENT: replace one section (matched by section id) with new typed slot values. Use get_landing_page first to read the section, then send it back modified. Stages as reversible.",
  params: z.object({
    pageId: z.string().min(1),
    section: LandingSectionSchema,
  }),
  reversibility: "reversible",
  actionKind: "update_landing_section",
  existingTarget(args) {
    return { entity: "landing_page", id: args.pageId };
  },
  async execute(args, ctx) {
    const page = await loadLandingPage(ctx.supabase, args.pageId);
    if (!page) throw new MarketingToolError(`Landing page ${args.pageId} not found`);
    const idx = page.sections.findIndex((s) => s.id === args.section.id);
    if (idx < 0) throw new MarketingToolError(`Section ${args.section.id} not found on this page`);

    const next = [...page.sections];
    next[idx] = args.section;
    const { error } = await ctx.supabase
      .from("landing_page")
      .update({ sections: sectionsToJson(next) })
      .eq("id", args.pageId);
    if (error) throw new MarketingToolError(`update_landing_section: ${error.message}`);

    return {
      summary: `Updated the "${args.section.kind}" section of "${page.title}".`,
      target: { entity: "landing_page", id: args.pageId },
    };
  },
});

const publishLandingPage = defineMarketingTool({
  name: "publish_landing_page",
  description:
    "Publish a landing page LIVE on its public /p/[slug] route. Irreversible (outward-facing) — requires approval.",
  params: z.object({ pageId: z.string().min(1) }),
  reversibility: "irreversible",
  actionKind: "publish_landing_page",
  async execute(args, ctx) {
    const page = await loadLandingPage(ctx.supabase, args.pageId);
    if (!page) throw new MarketingToolError(`Landing page ${args.pageId} not found`);

    // Preview only — no write — until a human approves.
    if (!ctx.approved) {
      return {
        summary: `Publish "${page.title}" live at /p/${page.slug}.`,
        target: { entity: "landing_page", id: page.id },
        approvalPreview: {
          title: page.title,
          slug: page.slug,
          url: `/p/${page.slug}`,
          sectionCount: page.sections.length,
        },
      };
    }

    const { error } = await ctx.supabase
      .from("landing_page")
      .update({ status: "published", published_at: ctx.services.clock.now() })
      .eq("id", args.pageId);
    if (error) throw new MarketingToolError(`publish_landing_page: ${error.message}`);
    return {
      summary: `Published "${page.title}" — now live at /p/${page.slug}.`,
      data: { url: `/p/${page.slug}` },
      target: { entity: "landing_page", id: page.id },
    };
  },
});

const unpublishLandingPage = defineMarketingTool({
  name: "unpublish_landing_page",
  description: "Take a live landing page down. Irreversible (outward-facing) — requires approval.",
  params: z.object({ pageId: z.string().min(1) }),
  reversibility: "irreversible",
  actionKind: "unpublish_landing_page",
  async execute(args, ctx) {
    const page = await loadLandingPage(ctx.supabase, args.pageId);
    if (!page) throw new MarketingToolError(`Landing page ${args.pageId} not found`);
    if (!ctx.approved) {
      return {
        summary: `Take "${page.title}" offline (it will no longer be reachable at /p/${page.slug}).`,
        target: { entity: "landing_page", id: page.id },
        approvalPreview: { title: page.title, slug: page.slug },
      };
    }
    const { error } = await ctx.supabase
      .from("landing_page")
      .update({ status: "unpublished" })
      .eq("id", args.pageId);
    if (error) throw new MarketingToolError(`unpublish_landing_page: ${error.message}`);
    return {
      summary: `Unpublished "${page.title}".`,
      target: { entity: "landing_page", id: page.id },
    };
  },
});

const setPageDesign = defineMarketingTool({
  name: "set_page_design",
  description:
    "Set a landing page's typed DESIGN tokens — colorTheme (warm|cool|mono|bold), typePairing (editorial|modern|classic), density (compact|normal|airy), buttonStyle (pill|rounded|square). The renderer owns all actual styling; never write CSS. Stages as reversible.",
  params: z.object({
    pageId: z.string().min(1),
    colorTheme: z.enum(["warm", "cool", "mono", "bold"]).nullable(),
    typePairing: z.enum(["editorial", "modern", "classic"]).nullable(),
    density: z.enum(["compact", "normal", "airy"]).nullable(),
    buttonStyle: z.enum(["pill", "rounded", "square"]).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "set_page_design",
  existingTarget(args) {
    return { entity: "landing_page", id: args.pageId };
  },
  async execute(args, ctx) {
    const page = await loadLandingPage(ctx.supabase, args.pageId);
    if (!page) throw new MarketingToolError(`Landing page ${args.pageId} not found`);
    const theme: LandingTheme = { ...page.theme };
    if (args.colorTheme) theme.colorTheme = args.colorTheme;
    if (args.typePairing) theme.typePairing = args.typePairing;
    if (args.density) theme.density = args.density;
    if (args.buttonStyle) theme.buttonStyle = args.buttonStyle;
    const { error } = await ctx.supabase
      .from("landing_page")
      .update({ theme: themeToJson(theme) })
      .eq("id", args.pageId);
    if (error) throw new MarketingToolError(`set_page_design: ${error.message}`);
    return {
      summary: `Updated the design of "${page.title}".`,
      target: { entity: "landing_page", id: args.pageId },
    };
  },
});

const setSectionVariant = defineMarketingTool({
  name: "set_section_variant",
  description:
    "Set the layout VARIANT of one section (hero: centered|split|minimal; outcomes: grid|list). Renderer-owned layout, not CSS. Stages as reversible.",
  params: z.object({
    pageId: z.string().min(1),
    sectionId: z.string().min(1),
    variant: z.string().min(1),
  }),
  reversibility: "reversible",
  actionKind: "set_section_variant",
  existingTarget(args) {
    return { entity: "landing_page", id: args.pageId };
  },
  async execute(args, ctx) {
    const page = await loadLandingPage(ctx.supabase, args.pageId);
    if (!page) throw new MarketingToolError(`Landing page ${args.pageId} not found`);
    const idx = page.sections.findIndex((s) => s.id === args.sectionId);
    if (idx < 0) throw new MarketingToolError(`Section ${args.sectionId} not found`);
    const section = page.sections[idx];
    const allowed = SECTION_VARIANTS[section.kind];
    if (!allowed || !allowed.includes(args.variant)) {
      throw new MarketingToolError(
        `Variant "${args.variant}" isn't valid for a ${section.kind} section. Allowed: ${(allowed ?? []).join(", ") || "(this section has no variants)"}.`
      );
    }
    const next = [...page.sections];
    next[idx] = { ...section, variant: args.variant } as LandingSection;
    const { error } = await ctx.supabase
      .from("landing_page")
      .update({ sections: sectionsToJson(next) })
      .eq("id", args.pageId);
    if (error) throw new MarketingToolError(`set_section_variant: ${error.message}`);
    return {
      summary: `Set the ${section.kind} section layout to "${args.variant}".`,
      target: { entity: "landing_page", id: args.pageId },
    };
  },
});

export const landingTools = [
  generateLandingPage,
  updateLandingSection,
  setPageDesign,
  setSectionVariant,
  publishLandingPage,
  unpublishLandingPage,
];
