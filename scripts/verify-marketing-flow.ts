/**
 * Phase 1 end-to-end test against LIVE Supabase: generate → publish → public-read
 * → lead capture. No OpenAI key needed (deterministic generator).
 * Run: `npx tsx scripts/verify-marketing-flow.ts`
 *
 * The generate→publish→public-read flow needs no extra secret. The INGEST
 * portion (anonymous lead capture / pageview) needs SUPABASE_SERVICE_ROLE_KEY;
 * it runs automatically when the key is in .env.local, and is cleanly SKIPPED
 * (not failed) until then.
 *
 * Throwaway *@example.com users can't be deleted with the anon key — clean them
 * in Supabase → Auth. The course is deleted at the end (cascades).
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { fixedClock } from "@/lib/marketing/services/mock";
import {
  acceptMarketingAction,
  approveMarketingAction,
  executeMarketingTool,
} from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { loadLandingPage } from "@/lib/marketing/persistence";
import { captureLead, recordPageView } from "@/lib/marketing/ingest";

let pass = 0,
  fail = 0,
  skipped = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}
function skip(name: string) {
  skipped++;
  console.log(`  ⊘ SKIP ${name}`);
}

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return {
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    // The service-role secret is intentionally kept OUT of .env.local (see the
    // header comment there). Read it from the runtime env so it can be passed
    // inline — `SUPABASE_SERVICE_ROLE_KEY=… npm run verify:marketing:flow` — or
    // injected by the host in prod, exactly like the app does.
    service: process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

async function provision(url: string, anon: string) {
  const email = `mkt-flow-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const supabase = createClient<Database>(url, anon);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  return { supabase, userId: data.user.id };
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env");

  const { supabase, userId } = await provision(url, anon);
  console.log("# provisioned author");

  const courseId = crypto.randomUUID();
  const moduleId = crypto.randomUUID();
  await supabase.from("courses").insert({
    id: courseId,
    author_id: userId,
    title: "Ship Your First iOS App",
    description: "Go from zero to a published app — no CS degree required.",
    audience: "hobbyists",
    level: "beginner",
    price_cents: 4900,
    plan: {
      outcomes: ["Build a SwiftUI screen", "Persist data locally", "Submit to the App Store"],
      prerequisites: ["a Mac"],
      teachingStyle: "hands-on",
    } as never,
  });
  await supabase.from("modules").insert({ id: moduleId, course_id: courseId, title: "Foundations", order: 0 });
  await supabase.from("lessons").insert([
    { id: crypto.randomUUID(), module_id: moduleId, course_id: courseId, title: "Xcode tour", order: 0 },
    { id: crypto.randomUUID(), module_id: moduleId, course_id: courseId, title: "Your first view", order: 1 },
  ]);
  console.log("# seeded course");

  const services = createMarketingServices({ clock: fixedClock() });
  const ctx: MarketingToolContext = {
    supabase,
    courseId,
    campaignId: null,
    ownerId: userId,
    services,
    requestedBy: "user",
  };

  // generate (creates campaign implicitly? no — tool needs campaign) → create campaign first
  console.log("\n# generate → accept");
  const camp = await executeMarketingTool("create_campaign", { name: "Launch", goal: null }, ctx);
  await acceptMarketingAction(supabase, camp.actionId!);
  const campaignId = (camp.data as { campaignId: string }).campaignId;
  const ctx2 = { ...ctx, campaignId };

  const gen = await executeMarketingTool("generate_landing_page", { title: null, ctaLabel: null }, ctx2);
  const pageId = (gen.data as { pageId: string }).pageId;
  const slug = (gen.data as { slug: string }).slug;
  await acceptMarketingAction(supabase, gen.actionId!);
  const draft = await loadLandingPage(supabase, pageId);
  check("page generated with grounded sections", (draft?.sections.length ?? 0) >= 6);
  check("page has a lead_capture section", !!draft?.sections.some((s) => s.kind === "lead_capture"));
  check("page is draft", draft?.status === "draft");

  // publish → pending → approve
  console.log("\n# publish → approve");
  const pub = await executeMarketingTool("publish_landing_page", { pageId }, ctx2);
  check("publish pends", pub.status === "pending_approval");
  check("still draft before approval", (await loadLandingPage(supabase, pageId))?.status === "draft");
  await approveMarketingAction(pub.actionId!, { supabase, ownerId: userId, services });
  check("approved → published", (await loadLandingPage(supabase, pageId))?.status === "published");

  // public read via anon
  console.log("\n# public read (anon, RLS)");
  const anonClient = createClient<Database>(url, anon);
  const { data: pubRow } = await anonClient.from("landing_page").select("*").eq("slug", slug).eq("status", "published").maybeSingle();
  check("anon reads the published page by slug", pubRow?.id === pageId);

  // ── INGEST (needs service role) ───────────────────────────────────────
  if (!service) {
    console.log("\n# ingest — SKIPPED (no SUPABASE_SERVICE_ROLE_KEY in .env.local)");
    ["pageview event recorded", "lead captured (subscriber + form_submit)", "free_lesson_capture event", "lead capture is idempotent", "invalid email rejected", "unpublished page rejects ingest"].forEach(skip);
  } else {
    console.log("\n# ingest — lead capture + pageview (service role)");
    const admin: SupabaseClient<Database> = createClient<Database>(url, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anonId = crypto.randomUUID();

    const pv = await recordPageView(admin, { slug, anonymousId: anonId });
    check("recordPageView ok", pv.ok === true);
    const { data: pvEvents } = await admin.from("analytics_event").select("id").eq("landing_page_id", pageId).eq("type", "page_view");
    check("pageview event recorded", (pvEvents ?? []).length === 1, `got ${pvEvents?.length}`);

    const email = `lead-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const lead = await captureLead(admin, { slug, email, name: "Pat", anonymousId: anonId, freeLesson: true, consentText: "ok" });
    check("captureLead ok + created", lead.ok === true && lead.result.created === true);
    const { data: subs } = await admin.from("subscriber").select("id,status,source,email").eq("campaign_id", campaignId);
    check("lead captured (subscriber, status lead)", (subs ?? []).length === 1 && subs![0].status === "lead", JSON.stringify(subs));
    check("subscriber source = free_lesson", subs?.[0]?.source === "free_lesson");
    const { data: fEvents } = await admin.from("analytics_event").select("type").eq("landing_page_id", pageId);
    const types = (fEvents ?? []).map((e) => e.type);
    check("form_submit + free_lesson_capture events", types.includes("form_submit") && types.includes("free_lesson_capture"));

    const lead2 = await captureLead(admin, { slug, email, name: "Pat", anonymousId: anonId, freeLesson: true });
    check("lead capture is idempotent (no dup subscriber)", lead2.ok === true && lead2.result.created === false);
    const { count } = await admin.from("subscriber").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).eq("email", email);
    check("still exactly one subscriber for that email", count === 1, `count ${count}`);

    const bad = await captureLead(admin, { slug, email: "not-an-email", freeLesson: false });
    check("invalid email rejected", bad.ok === false && bad.error === "Invalid email");

    // unpublish → ingest must refuse
    const unp = await executeMarketingTool("unpublish_landing_page", { pageId }, ctx2);
    await approveMarketingAction(unp.actionId!, { supabase, ownerId: userId, services });
    const afterUnpub = await captureLead(admin, { slug, email: `x-${crypto.randomUUID().slice(0, 6)}@example.com` });
    check("unpublished page rejects ingest", afterUnpub.ok === false, JSON.stringify(afterUnpub));
    const { data: anonAfter } = await anonClient.from("landing_page").select("id").eq("slug", slug).eq("status", "published").maybeSingle();
    check("anon can no longer read the unpublished page", anonAfter === null);
  }

  await supabase.from("courses").delete().eq("id", courseId);
  console.log("\n# cleaned up course");
  console.log(`\n=== ${pass} passed, ${fail} failed, ${skipped} skipped ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
