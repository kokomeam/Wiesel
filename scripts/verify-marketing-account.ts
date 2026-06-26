/**
 * Slice 4 test against LIVE Supabase: the account (creator) tier — one contact
 * across courses, account-level aggregation, and global unsubscribe cascade.
 * Needs SUPABASE_SERVICE_ROLE_KEY (ingest writes); read from env or .env.local.
 * Run: `npx tsx scripts/verify-marketing-account.ts`
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { fixedClock } from "@/lib/marketing/services/mock";
import { acceptMarketingAction, approveMarketingAction, executeMarketingTool } from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { captureLead, globalUnsubscribe } from "@/lib/marketing/ingest";
import { getAccountSummary } from "@/lib/marketing/analytics";

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
    service: process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

async function publishPageFor(
  supabase: SupabaseClient<Database>,
  courseId: string,
  ownerId: string,
  services: ReturnType<typeof createMarketingServices>
): Promise<string> {
  const ctx: MarketingToolContext = { supabase, courseId, campaignId: null, ownerId, services, requestedBy: "user" };
  const camp = await executeMarketingTool("create_campaign", { name: "Launch", goal: null }, ctx);
  await acceptMarketingAction(supabase, camp.actionId!);
  const campaignId = (camp.data as { campaignId: string }).campaignId;
  const ctx2 = { ...ctx, campaignId };
  const gen = await executeMarketingTool("generate_landing_page", { title: null, ctaLabel: null }, ctx2);
  const slug = (gen.data as { slug: string }).slug;
  await acceptMarketingAction(supabase, gen.actionId!);
  const pub = await executeMarketingTool("publish_landing_page", { pageId: (gen.data as { pageId: string }).pageId }, ctx2);
  await approveMarketingAction(pub.actionId!, { supabase, ownerId, services });
  return slug;
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!service) {
    console.log("# SKIPPED — no SUPABASE_SERVICE_ROLE_KEY (set it to run the account-tier ingest tests)");
    ["contact created on capture", "same email across courses = one contact", "account summary aggregates", "global unsubscribe cascades"].forEach((n) => {
      skipped++;
      console.log(`  ⊘ SKIP ${n}`);
    });
    console.log(`\n=== ${pass} passed, ${fail} failed, ${skipped} skipped ===`);
    process.exit(0);
  }

  const email = `mkt-acct-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup: ${await signup.text()}`);
  const supabase = createClient<Database>(url, anon);
  const { data: signin, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !signin.user) throw new Error(`signin: ${error?.message}`);
  const userId = signin.user.id;
  const admin = createClient<Database>(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  console.log("# provisioned author");

  // two courses
  const courseA = crypto.randomUUID();
  const courseB = crypto.randomUUID();
  await supabase.from("courses").insert([
    { id: courseA, author_id: userId, title: "Course A" },
    { id: courseB, author_id: userId, title: "Course B" },
  ]);
  const services = createMarketingServices({ clock: fixedClock() });
  const slugA = await publishPageFor(supabase, courseA, userId, services);
  const slugB = await publishPageFor(supabase, courseB, userId, services);
  console.log("# published a landing page on each course");

  const lead = `learner-${crypto.randomUUID().slice(0, 8)}@example.com`;

  // ── capture on A → contact created + linked ───────────────────────────
  console.log("\n# capture on course A");
  const r1 = await captureLead(admin, { slug: slugA, email: lead, name: "Sam" });
  check("captureLead ok", r1.ok === true);
  const { data: contactsAfterA } = await admin.from("audience_contact").select("id").eq("author_id", userId).eq("email", lead);
  check("one account contact created", (contactsAfterA ?? []).length === 1, String(contactsAfterA?.length));
  const { data: subA } = await admin.from("subscriber").select("contact_id").eq("course_id", courseA).eq("email", lead).maybeSingle();
  check("course-A subscriber linked to the contact", !!subA?.contact_id);

  // ── capture SAME email on B → same contact, new subscription ──────────
  console.log("\n# capture the same person on course B");
  await captureLead(admin, { slug: slugB, email: lead, name: "Sam" });
  const { data: contactsAfterB } = await admin.from("audience_contact").select("id").eq("author_id", userId).eq("email", lead);
  check("still ONE contact across both courses (unified identity)", (contactsAfterB ?? []).length === 1, String(contactsAfterB?.length));
  const { data: subB } = await admin.from("subscriber").select("contact_id").eq("course_id", courseB).eq("email", lead).maybeSingle();
  check("course-B subscriber linked to the SAME contact", subB?.contact_id === subA?.contact_id);

  // ── account summary aggregates across courses ─────────────────────────
  console.log("\n# account summary");
  const summary = await getAccountSummary(supabase, userId);
  check("account audience = 1 distinct person", summary.totalContacts === 1, String(summary.totalContacts));
  check("account funnel sums per-course leads (2 subscriptions)", summary.funnel.leads === 2, String(summary.funnel.leads));
  check("account summary lists both courses", summary.courses.length === 2);

  // ── global unsubscribe cascades across courses ────────────────────────
  console.log("\n# global unsubscribe");
  const { data: subARow } = await admin.from("subscriber").select("id").eq("course_id", courseA).eq("email", lead).single();
  await globalUnsubscribe(admin, subARow!.id);
  const { data: bothSubs } = await admin.from("subscriber").select("status").eq("email", lead);
  check("BOTH course subscriptions are unsubscribed", (bothSubs ?? []).every((s) => s.status === "unsubscribed"), JSON.stringify(bothSubs));
  const { data: contact } = await admin.from("audience_contact").select("unsubscribed_at").eq("author_id", userId).eq("email", lead).single();
  check("the contact is globally unsubscribed", !!contact?.unsubscribed_at);

  await supabase.from("courses").delete().in("id", [courseA, courseB]);
  console.log("\n# cleaned up");
  console.log(`\n=== ${pass} passed, ${fail} failed, ${skipped} skipped ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
