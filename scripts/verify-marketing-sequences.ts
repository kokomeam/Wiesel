/**
 * Slice 5 test against LIVE Supabase: the Email & sequences overview — per-touch
 * send/queue counts, recipients (who's on which email), and that emails render.
 * Author-scoped (mock provider + fixed clock). Run:
 *   npx tsx scripts/verify-marketing-sequences.ts
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { fixedClock } from "@/lib/marketing/services/mock";
import { acceptMarketingAction, approveMarketingAction, executeMarketingTool } from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { loadEmailSequence, loadSequenceRecipients, loadSequencesOverview } from "@/lib/marketing/persistence";
import { runSchedulerTick } from "@/lib/marketing/scheduler";
import { renderEmailHtml } from "@/lib/marketing/email/render";

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
  const email = `mkt-seq-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
  await supabase.from("courses").insert({ id: courseId, author_id: userId, title: "Bread Baking", plan: { outcomes: ["Mix dough", "Bake a loaf"], prerequisites: [], teachingStyle: "warm" } as never });
  await supabase.from("marketing_campaign").insert({ id: campaignId, course_id: courseId, name: "Launch" });
  await supabase.from("subscriber").insert([
    { campaign_id: campaignId, course_id: courseId, email: `a-${crypto.randomUUID().slice(0, 6)}@example.com`, status: "lead" },
    { campaign_id: campaignId, course_id: courseId, email: `b-${crypto.randomUUID().slice(0, 6)}@example.com`, status: "lead" },
  ]);
  console.log("# seeded course + campaign + 2 leads");

  const services = createMarketingServices({ clock: fixedClock() });
  const ctx: MarketingToolContext = { supabase, courseId, campaignId, ownerId: userId, services, requestedBy: "user" };

  // generate + activate + tick (deliver touch 0)
  const gen = await executeMarketingTool("generate_email_sequence", {}, ctx);
  const seqId = (gen.data as { sequenceId: string }).sequenceId;
  await acceptMarketingAction(supabase, gen.actionId!);
  const act = await executeMarketingTool("activate_sequence", { sequenceId: seqId }, ctx);
  await approveMarketingAction(act.actionId!, { supabase, ownerId: userId, services });
  await runSchedulerTick(supabase, services, { courseId });
  console.log("# generated → activated → ticked (touch 0 delivered)");

  // ── overview: counts + schedule ───────────────────────────────────────
  console.log("\n# sequences overview");
  const overview = await loadSequencesOverview(supabase, campaignId);
  check("overview lists the sequence", overview.length === 1 && overview[0].id === seqId);
  const seq = overview[0];
  check("4 touches with subjects + schedule", seq.touches.length === 4 && seq.touches.every((t) => t.subject.length > 0));
  check("touch 1 delay is +2 days", seq.touches[1].delaySeconds === 2 * 86400);
  check("enrolledCount = 2", seq.enrolledCount === 2, String(seq.enrolledCount));
  check("touch 0 shows 2 sent", seq.touches[0].sent === 2, String(seq.touches[0].sent));
  check("touch 1 shows 2 queued (who's on which email)", seq.touches[1].queued === 2, String(seq.touches[1].queued));

  // ── recipients: who's on which email ──────────────────────────────────
  console.log("\n# recipients");
  const recipients = await loadSequenceRecipients(supabase, seqId);
  check("2 recipients listed with email + position", recipients.length === 2 && recipients.every((r) => r.email.includes("@")));
  check("recipients advanced to touch 2 (position 1)", recipients.every((r) => r.currentPosition === 1), JSON.stringify(recipients.map((r) => r.currentPosition)));

  // ── email renders exactly as it sends ─────────────────────────────────
  console.log("\n# email preview renders");
  const full = await loadEmailSequence(supabase, seqId);
  const html = renderEmailHtml(full!.touches[0].body, { unsubscribeUrl: "https://x/unsub?sid=1" });
  check("rendered email is non-empty HTML", html.length > 100 && html.includes("<"));
  check("rendered email includes a working unsubscribe link", html.includes("Unsubscribe") && html.includes("unsub?sid=1"));

  await supabase.from("courses").delete().eq("id", courseId);
  console.log("\n# cleaned up");
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
