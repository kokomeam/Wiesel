"use server";

/**
 * Server actions for the Marketing hub. Every mutation goes through the SAME
 * shared tool layer + gate the agent uses (executeMarketingTool / approve /
 * reject) — the hub is just one of the three surfaces. Author-scoped: the server
 * client carries the signed-in user's session, so RLS authorizes the writes.
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { loadCampaignForCourse, loadLandingPage } from "@/lib/marketing/persistence";
import { loadAction } from "@/lib/marketing/gate";
import {
  acceptMarketingAction,
  approveMarketingAction,
  executeMarketingTool,
  rejectMarketingAction,
} from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";

/** What every mutating action returns so the hub can show a clear confirmation
 *  + a link to the resulting artifact. */
export interface ActionResult {
  message: string;
  href?: string;
  hrefLabel?: string;
}

const services = () => createMarketingServices();

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  return { supabase, ownerId: user.id };
}

function ctxFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ownerId: string,
  courseId: string,
  campaignId: string | null
): MarketingToolContext {
  return { supabase, courseId, campaignId, ownerId, services: services(), requestedBy: "user" };
}

/** Create the campaign container (auto-accepted — it's setup, not a reviewable
 *  asset). Returns the new campaign id. */
export async function createCampaignAction(courseId: string, name: string): Promise<string> {
  const { supabase, ownerId } = await authed();
  const out = await executeMarketingTool(
    "create_campaign",
    { name, goal: null },
    ctxFor(supabase, ownerId, courseId, null)
  );
  if (out.actionId) await acceptMarketingAction(supabase, out.actionId);
  revalidatePath("/marketing");
  return (out.data as { campaignId: string }).campaignId;
}

/** Generate a landing page (creating the campaign first if needed). Leaves the
 *  page STAGED for review. */
export async function generateLandingPageAction(courseId: string): Promise<ActionResult> {
  const { supabase, ownerId } = await authed();
  let campaign = await loadCampaignForCourse(supabase, courseId);
  if (!campaign) {
    const created = await executeMarketingTool(
      "create_campaign",
      { name: "Launch campaign", goal: null },
      ctxFor(supabase, ownerId, courseId, null)
    );
    if (created.actionId) await acceptMarketingAction(supabase, created.actionId);
    campaign = await loadCampaignForCourse(supabase, courseId);
  }
  const out = await executeMarketingTool(
    "generate_landing_page",
    { title: null, ctaLabel: null },
    ctxFor(supabase, ownerId, courseId, campaign?.id ?? null)
  );
  revalidatePath("/marketing");
  const pageId = (out.data as { pageId?: string } | undefined)?.pageId;
  return {
    message: "Generated a landing page — staged for review.",
    href: pageId ? `/marketing/preview/${pageId}` : undefined,
    hrefLabel: pageId ? "Preview" : undefined,
  };
}

/**
 * "Generate Kit" — run the reversible generators back-to-back through the SAME
 * gate (landing page + launch sequence + behavioral followup). Everything lands
 * staged for review; nothing is published or sent.
 */
export async function generateKitAction(courseId: string): Promise<ActionResult> {
  const { supabase, ownerId } = await authed();
  let campaign = await loadCampaignForCourse(supabase, courseId);
  if (!campaign) {
    const c = await executeMarketingTool(
      "create_campaign",
      { name: "Launch campaign", goal: null },
      ctxFor(supabase, ownerId, courseId, null)
    );
    if (c.actionId) await acceptMarketingAction(supabase, c.actionId);
    campaign = await loadCampaignForCourse(supabase, courseId);
  }
  const ctx = ctxFor(supabase, ownerId, courseId, campaign?.id ?? null);
  await executeMarketingTool("generate_landing_page", { title: null, ctaLabel: null }, ctx);
  await executeMarketingTool("generate_email_sequence", {}, ctx);
  await executeMarketingTool("generate_followup", { triggerEvent: "page_view" }, ctx);
  revalidatePath("/marketing");
  return { message: "Generated a landing page, launch sequence, and followup — review them below." };
}

/** Keep a staged reversible change; link to the resulting artifact. */
export async function acceptStagedAction(actionId: string): Promise<ActionResult> {
  const { supabase } = await authed();
  const action = await loadAction(supabase, actionId);
  await acceptMarketingAction(supabase, actionId);
  revalidatePath("/marketing");
  if (action?.targetRef?.entity === "landing_page") {
    return { message: "Accepted — kept the change.", href: `/marketing/preview/${action.targetRef.id}`, hrefLabel: "Preview" };
  }
  return { message: "Accepted — kept the change." };
}

/** Reject a staged reversible change (atomic revert) or deny a pending one. */
export async function rejectStagedAction(actionId: string): Promise<ActionResult> {
  const { supabase } = await authed();
  await rejectMarketingAction(supabase, actionId);
  revalidatePath("/marketing");
  return { message: "Reverted — the draft was rolled back." };
}

/** Request publish (irreversible → records a pending approval). */
export async function publishPageAction(courseId: string, pageId: string): Promise<ActionResult> {
  const { supabase, ownerId } = await authed();
  const campaign = await loadCampaignForCourse(supabase, courseId);
  await executeMarketingTool(
    "publish_landing_page",
    { pageId },
    ctxFor(supabase, ownerId, courseId, campaign?.id ?? null)
  );
  revalidatePath("/marketing");
  return { message: "Publish requested — approve it under “Needs your approval.”" };
}

/** Request unpublish (irreversible → pending approval). */
export async function unpublishPageAction(courseId: string, pageId: string): Promise<ActionResult> {
  const { supabase, ownerId } = await authed();
  const campaign = await loadCampaignForCourse(supabase, courseId);
  await executeMarketingTool(
    "unpublish_landing_page",
    { pageId },
    ctxFor(supabase, ownerId, courseId, campaign?.id ?? null)
  );
  revalidatePath("/marketing");
  return { message: "Unpublish requested — approve it under “Needs your approval.”" };
}

/** Approve a pending irreversible action (runs the real effect). */
export async function approvePendingAction(actionId: string): Promise<ActionResult> {
  const { supabase, ownerId } = await authed();
  const action = await loadAction(supabase, actionId);
  await approveMarketingAction(actionId, { supabase, ownerId, services: services() });
  revalidatePath("/marketing");
  // For a publish, link straight to the now-live page.
  if (action?.toolName === "publish_landing_page" && action.targetRef?.id) {
    const page = await loadLandingPage(supabase, action.targetRef.id);
    if (page?.status === "published") {
      return { message: "Approved — the page is live.", href: `/p/${page.slug}`, hrefLabel: "View live" };
    }
  }
  return { message: "Approved." };
}

/** Deny a pending irreversible action. */
export async function denyPendingAction(actionId: string): Promise<ActionResult> {
  const { supabase } = await authed();
  await rejectMarketingAction(supabase, actionId);
  revalidatePath("/marketing");
  return { message: "Denied — nothing was sent or published." };
}
