/**
 * Phase 2 test against LIVE Supabase: the single event stream → funnel summary →
 * the agent's observe tools. No service-role key needed (the author can insert
 * analytics_event + subscriber rows under RLS).
 * Run: `npx tsx scripts/verify-marketing-analytics.ts`
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { fixedClock } from "@/lib/marketing/services/mock";
import { executeMarketingTool } from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { getAnalyticsSummary } from "@/lib/marketing/analytics";

let pass = 0,
  fail = 0;
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
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

async function main() {
  const { url, anon } = loadEnv();
  const email = `mkt-an-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
  console.log("# provisioned author");

  const courseId = crypto.randomUUID();
  const campaignId = crypto.randomUUID();
  await supabase.from("courses").insert({ id: courseId, author_id: userId, title: "Analytics test course" });
  await supabase.from("marketing_campaign").insert({ id: campaignId, course_id: courseId, name: "C" });
  console.log("# seeded course + campaign");

  // seed the event stream
  const ev = (type: string, anon_id?: string) => ({
    course_id: courseId,
    campaign_id: campaignId,
    type,
    anonymous_id: anon_id ?? null,
  });
  const events = [
    ...Array.from({ length: 10 }, (_, i) => ev("page_view", `anon-${i % 5}`)),
    ...Array.from({ length: 5 }, () => ev("email_sent")),
    ...Array.from({ length: 3 }, () => ev("email_open")),
    ev("email_click"),
    ev("enrollment"),
  ];
  const { error: evErr } = await supabase.from("analytics_event").insert(events);
  if (evErr) throw new Error(`events: ${evErr.message}`);

  // seed subscribers across statuses
  const sub = (status: string) => ({
    campaign_id: campaignId,
    course_id: courseId,
    email: `s-${crypto.randomUUID().slice(0, 8)}@example.com`,
    status,
  });
  const subs = [sub("lead"), sub("lead"), sub("lead"), sub("subscribed"), sub("engaged"), sub("engaged"), sub("enrolled")];
  const { error: subErr } = await supabase.from("subscriber").insert(subs);
  if (subErr) throw new Error(`subs: ${subErr.message}`);
  console.log("# seeded 15 events + 7 subscribers");

  // ── direct summary ────────────────────────────────────────────────────
  console.log("\n# getAnalyticsSummary");
  const s = await getAnalyticsSummary(supabase, courseId);
  check("views = 10", s.funnel.views === 10, String(s.funnel.views));
  check("leads = 7 (total subscribers)", s.funnel.leads === 7, String(s.funnel.leads));
  check("emailsSent = 5 / opens = 3 / clicks = 1", s.funnel.emailsSent === 5 && s.funnel.emailOpens === 3 && s.funnel.emailClicks === 1);
  check("enrollments = 1", s.funnel.enrollments === 1, String(s.funnel.enrollments));
  check("openRate = 3/5", Math.abs((s.rates.openRate ?? 0) - 0.6) < 1e-9);
  // Amendment 11: clickRate is PER DELIVERED (the primary engagement metric),
  // not per open — opens are MPP-inflated. No delivered events seeded → the
  // denominator falls back to sent (5).
  check("clickRate = 1/5 (per delivered)", Math.abs((s.rates.clickRate ?? 0) - 0.2) < 1e-9);
  check("open-rate caveat present (MPP honesty)", s.openRateCaveat.length > 0);
  check("viewToLead = 7/10", Math.abs((s.rates.viewToLead ?? 0) - 0.7) < 1e-9);
  check("byStatus lead=3 engaged=2 enrolled=1", s.subscribersByStatus.lead === 3 && s.subscribersByStatus.engaged === 2 && s.subscribersByStatus.enrolled === 1, JSON.stringify(s.subscribersByStatus));

  // ── observe tools (read, no gate) ─────────────────────────────────────
  console.log("\n# observe tools");
  const ctx: MarketingToolContext = {
    supabase,
    courseId,
    campaignId,
    ownerId: userId,
    services: createMarketingServices({ clock: fixedClock() }),
    requestedBy: "agent",
  };
  const obs = await executeMarketingTool("get_analytics_summary", {}, ctx);
  check("get_analytics_summary is a read (no ledger)", obs.status === "read" && obs.actionId === null);
  check("observe summary returns the funnel", (obs.data as { funnel: { views: number } }).funnel.views === 10);

  const q = await executeMarketingTool("query_analytics_events", { types: ["email_open"], sinceIso: null, limit: null }, ctx);
  check("query_analytics_events filters by type", (q.data as { events: unknown[] }).events.length === 3, String((q.data as { events: unknown[] }).events.length));

  const seg = await executeMarketingTool("get_subscriber_segments", {}, ctx);
  check("get_subscriber_segments totals 7", (seg.data as { total: number }).total === 7);

  await supabase.from("courses").delete().eq("id", courseId);
  console.log("\n# cleaned up");
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
