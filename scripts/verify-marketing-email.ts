/**
 * Phase 3 test against LIVE Supabase: email sequences + the subscriber state
 * machine + the scheduler (mock send). Author-scoped — no service-role/Resend
 * key needed (the mock provider + fixed clock drive the whole engine).
 * Run: `npx tsx scripts/verify-marketing-email.ts`
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { createMockEmailProvider, fixedClock } from "@/lib/marketing/services/mock";
import {
  approveMarketingAction,
  acceptMarketingAction,
  executeMarketingTool,
  rejectMarketingAction,
} from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { loadAudience, loadEmailSequence } from "@/lib/marketing/persistence";
import { processEventTrigger, runSchedulerTick } from "@/lib/marketing/scheduler";
import { reduceStatus } from "@/lib/marketing/stateMachine";
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

const DAY = 86400 * 1000;

async function main() {
  const { url, anon } = loadEnv();

  // pure state-machine checks first (no DB)
  console.log("# state machine (pure)");
  check("form_submit → lead", reduceStatus("lead", "form_submit") === "lead");
  check("email_sent advances lead → subscribed", reduceStatus("lead", "email_sent") === "subscribed");
  check("email_open advances → engaged", reduceStatus("subscribed", "email_open") === "engaged");
  check("enrollment → enrolled", reduceStatus("engaged", "enrollment") === "enrolled");
  check("never regresses (open on enrolled stays enrolled)", reduceStatus("enrolled", "email_open") === "enrolled");
  check("unsubscribe is terminal", reduceStatus("engaged", "email_unsubscribe") === "unsubscribed" && reduceStatus("unsubscribed", "email_open") === "unsubscribed");

  const email = `mkt-em-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
  console.log("\n# provisioned author");

  const courseId = crypto.randomUUID();
  const campaignId = crypto.randomUUID();
  await supabase.from("courses").insert({
    id: courseId,
    author_id: userId,
    title: "Watercolor for Beginners",
    description: "Loosen up and paint with confidence.",
    plan: { outcomes: ["Mix a basic palette", "Paint a simple landscape"], prerequisites: [], teachingStyle: "encouraging" } as never,
  });
  await supabase.from("marketing_campaign").insert({ id: campaignId, course_id: courseId, name: "Launch" });
  const subEmails = ["a", "b", "c"].map((x) => `sub-${x}-${crypto.randomUUID().slice(0, 6)}@example.com`);
  await supabase.from("subscriber").insert(
    subEmails.map((e) => ({ campaign_id: campaignId, course_id: courseId, email: e, status: "lead" }))
  );
  console.log("# seeded course + campaign + 3 leads");

  const clock = fixedClock("2026-06-19T00:00:00.000Z");
  const services = createMarketingServices({ email: createMockEmailProvider(), clock });
  const ctx: MarketingToolContext = { supabase, courseId, campaignId, ownerId: userId, services, requestedBy: "user" };

  // ── generate sequence (reversible) ────────────────────────────────────
  console.log("\n# generate_email_sequence → accept");
  const gen = await executeMarketingTool("generate_email_sequence", {}, ctx);
  check("sequence staged", gen.status === "staged");
  const seqId = (gen.data as { sequenceId: string }).sequenceId;
  await acceptMarketingAction(supabase, gen.actionId!);
  const seq = await loadEmailSequence(supabase, seqId);
  check("sequence has 4 touches", seq?.touches.length === 4, String(seq?.touches.length));
  check("touch 0 has delay 0; touch 1 delay 2d", seq?.touches[0].delaySeconds === 0 && seq?.touches[1].delaySeconds === 2 * 86400);

  // ── write_email_touch (reversible) + reject restores ──────────────────
  console.log("\n# write_email_touch + reject restores the sequence");
  const t0 = seq!.touches[0];
  const before = JSON.stringify(t0);
  const upd = await executeMarketingTool(
    "write_email_touch",
    { sequenceId: seqId, touchId: t0.id, position: null, delaySeconds: null, triggerEvent: null, subject: "CHANGED SUBJECT", previewText: null, body: { blocks: [{ kind: "paragraph", text: "changed" }] } },
    ctx
  );
  check("touch update staged", upd.status === "staged");
  const afterEdit = await loadEmailSequence(supabase, seqId);
  check("touch subject changed", afterEdit?.touches.find((t) => t.id === t0.id)?.subject === "CHANGED SUBJECT");
  await rejectMarketingAction(supabase, upd.actionId!);
  const afterReject = await loadEmailSequence(supabase, seqId);
  check("reject restores the touch byte-for-byte", JSON.stringify(afterReject?.touches.find((t) => t.id === t0.id)) === before, "touch differs");

  // ── activate (irreversible) → enroll + schedule ───────────────────────
  console.log("\n# activate_sequence → approve → enroll");
  const act = await executeMarketingTool("activate_sequence", { sequenceId: seqId }, ctx);
  check("activate pends with audience preview", act.status === "pending_approval" && (act.approvalPreview as { audience: number }).audience === 3);
  check("sequence still draft before approval", (await loadEmailSequence(supabase, seqId))?.status === "draft");
  await approveMarketingAction(act.actionId!, { supabase, ownerId: userId, services });
  check("sequence active after approval", (await loadEmailSequence(supabase, seqId))?.status === "active");
  const { count: enrCount } = await supabase.from("sequence_enrollment").select("id", { count: "exact", head: true }).eq("sequence_id", seqId);
  check("3 enrollments created", enrCount === 3, String(enrCount));
  const { count: dueCount } = await supabase.from("scheduled_send").select("id", { count: "exact", head: true }).eq("sequence_id", seqId).eq("status", "pending");
  check("3 sends scheduled (touch 0)", dueCount === 3, String(dueCount));

  // ── tick: deliver touch 0 ─────────────────────────────────────────────
  console.log("\n# scheduler tick — deliver touch 0");
  const tick1 = await runSchedulerTick(supabase, services, { courseId });
  check("tick sent 3 (touch 0)", tick1.sent === 3, JSON.stringify(tick1));
  const { count: sentEvents } = await supabase.from("analytics_event").select("id", { count: "exact", head: true }).eq("course_id", courseId).eq("type", "email_sent");
  check("3 email_sent events recorded", sentEvents === 3, String(sentEvents));
  const { count: subscribedCount } = await supabase.from("subscriber").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).in("status", ["subscribed", "engaged"]);
  check("subscribers advanced past 'lead' (email_sent reducer)", subscribedCount === 3, String(subscribedCount));
  const { count: nextScheduled } = await supabase.from("scheduled_send").select("id", { count: "exact", head: true }).eq("sequence_id", seqId).eq("status", "pending");
  check("touch 1 scheduled for each (3 pending)", nextScheduled === 3, String(nextScheduled));

  // ── idempotency: tick again now → nothing due ─────────────────────────
  const tick1b = await runSchedulerTick(supabase, services, { courseId });
  check("re-tick at same time sends nothing (idempotent)", tick1b.sent === 0, JSON.stringify(tick1b));

  // ── advance 2 days → touch 1 delivers ─────────────────────────────────
  console.log("\n# advance clock 2d → deliver touch 1");
  clock.advance(2 * DAY + 1000);
  const tick2 = await runSchedulerTick(supabase, services, { courseId });
  check("tick sent 3 (touch 1)", tick2.sent === 3, JSON.stringify(tick2));

  // ── suppression: unsubscribe one → its sends skip + enrollment cancels ─
  console.log("\n# suppression — unsubscribe stops the sequence");
  const { data: oneSub } = await supabase.from("subscriber").select("id").eq("campaign_id", campaignId).limit(1).single();
  await supabase.from("subscriber").update({ status: "unsubscribed" }).eq("id", oneSub!.id);
  clock.advance(2 * DAY + 1000); // touch 2 due
  const tick3 = await runSchedulerTick(supabase, services, { courseId });
  check("unsubscribed subscriber's send is skipped", tick3.skipped >= 1, JSON.stringify(tick3));
  const { data: cancelled } = await supabase.from("sequence_enrollment").select("status").eq("sequence_id", seqId).eq("subscriber_id", oneSub!.id).single();
  check("its enrollment is cancelled", cancelled?.status === "cancelled");

  // ── event-triggered followup ──────────────────────────────────────────
  console.log("\n# event-triggered followup");
  const fu = await executeMarketingTool("generate_followup", { triggerEvent: "page_view" }, ctx);
  const fuId = (fu.data as { sequenceId: string }).sequenceId;
  await acceptMarketingAction(supabase, fu.actionId!);
  const fuAct = await executeMarketingTool("activate_sequence", { sequenceId: fuId }, ctx);
  check("activating an event sequence enrolls nobody up-front", (fuAct.approvalPreview as { audience: number }).audience === 0);
  await approveMarketingAction(fuAct.actionId!, { supabase, ownerId: userId, services });
  // fire a page_view trigger for a fresh subscriber
  const { data: trigSub } = await supabase.from("subscriber").insert({ campaign_id: campaignId, course_id: courseId, email: `trig-${crypto.randomUUID().slice(0, 6)}@example.com`, status: "lead" }).select("id").single();
  const trig = await processEventTrigger(supabase, { courseId, subscriberId: trigSub!.id, eventType: "page_view", nowMs: clock.epochMs() });
  check("page_view enrolls the subscriber into the followup", trig.enrolled === 1, JSON.stringify(trig));
  clock.advance(3 * 3600 * 1000); // past the 2h followup delay
  const tick4 = await runSchedulerTick(supabase, services, { courseId });
  check("followup touch delivers after the trigger", tick4.sent >= 1, JSON.stringify(tick4));

  // ── broadcast (irreversible) ──────────────────────────────────────────
  console.log("\n# send_broadcast → approve");
  const bc = await executeMarketingTool("send_broadcast", { subject: "Quick update", body: { blocks: [{ kind: "paragraph", text: "Hello everyone." }] }, status: null }, ctx);
  check("broadcast pends with audience", bc.status === "pending_approval" && (bc.approvalPreview as { audience: number }).audience >= 1);
  await approveMarketingAction(bc.actionId!, { supabase, ownerId: userId, services });
  const summary = await getAnalyticsSummary(supabase, courseId);
  check("broadcast + sequence sends show in analytics", summary.funnel.emailsSent >= 7, String(summary.funnel.emailsSent));
  check("opens/clicks recorded by the mock provider", summary.funnel.emailOpens >= 1);

  // ── audience legibility (Slice 2) ─────────────────────────────────────
  console.log("\n# audience view — funnel position is legible");
  const audience = await loadAudience(supabase, courseId);
  check("audience lists subscribers", audience.length >= 1, String(audience.length));
  check("each subscriber exposes a lifecycle stage", audience.every((a) => typeof a.status === "string" && a.status.length > 0));
  check("an engaged/subscribed subscriber surfaces its enrollment position", audience.some((a) => a.enrollments.length > 0));

  await supabase.from("courses").delete().eq("id", courseId);
  console.log("\n# cleaned up");
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
