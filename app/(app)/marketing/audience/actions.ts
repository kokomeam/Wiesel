"use server";

/**
 * Dev/test controls for the subscribing+scheduling flow — author-scoped (no
 * service-role key needed; the author writes their own rows). Lets you seed a
 * lead and advance the scheduler so you can watch a subscriber move through the
 * funnel on the mock provider, no real email.
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { loadCampaignForCourse } from "@/lib/marketing/persistence";
import { runSchedulerTick } from "@/lib/marketing/scheduler";
import type { ActionResult } from "../actions";

const DAY_MS = 86_400_000;

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  return { supabase, ownerId: user.id };
}

/** Seed a throwaway lead (+ a form_submit event) so the funnel has someone in it. */
export async function seedSubscriberAction(courseId: string): Promise<ActionResult> {
  const { supabase } = await authed();
  const campaign = await loadCampaignForCourse(supabase, courseId);
  if (!campaign) return { message: "Create a campaign first — use Generate Kit." };
  const email = `test-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const { data: sub } = await supabase
    .from("subscriber")
    .insert({ campaign_id: campaign.id, course_id: courseId, email, name: "Test Lead", status: "lead", source: "dev" })
    .select("id")
    .single();
  if (sub) {
    await supabase.from("analytics_event").insert({
      course_id: courseId,
      campaign_id: campaign.id,
      subscriber_id: sub.id,
      type: "form_submit",
      source: "dev",
      props: { email },
    });
  }
  revalidatePath("/marketing/audience");
  return { message: `Seeded test lead ${email}.` };
}

/**
 * Advance the clock by N days and run one scheduler tick — delivers every send
 * that would be due by then (on the mock provider) so you can watch the whole
 * sequence play out without waiting real days.
 */
export async function tickSchedulerAction(courseId: string, advanceDays: number): Promise<ActionResult> {
  const { supabase } = await authed();
  const services = createMarketingServices();
  const nowMs = Date.now() + Math.max(0, advanceDays) * DAY_MS;
  const r = await runSchedulerTick(supabase, services, { courseId, nowMs });
  revalidatePath("/marketing/audience");
  revalidatePath("/marketing");
  return { message: `Ran scheduler (+${advanceDays}d): ${r.sent} sent · ${r.skipped} skipped · ${r.failed} failed.` };
}
