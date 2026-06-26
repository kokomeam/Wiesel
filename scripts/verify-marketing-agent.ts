/**
 * Phase 4 test against LIVE Supabase: the Marketing Agent loop driven by the
 * deterministic MOCK model client (no OpenAI key). Proves observe → act → gate:
 * reversible generation auto-stages; reads execute; an irreversible action
 * PAUSES the loop for approval and does not execute until approved.
 * Run: `npx tsx scripts/verify-marketing-agent.ts`
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { fixedClock } from "@/lib/marketing/services/mock";
import { runMarketingAgentTurn } from "@/lib/marketing/agent/loop";
import type { MarketingAgentEvent } from "@/lib/marketing/agent/events";
import { acceptMarketingAction, approveMarketingAction, executeMarketingTool } from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { loadLandingPage } from "@/lib/marketing/persistence";
import { loadAction } from "@/lib/marketing/gate";

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
  const email = `mkt-ag-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
  await supabase.from("courses").insert({
    id: courseId,
    author_id: userId,
    title: "Intro to Pottery",
    description: "Throw your first bowl.",
    plan: { outcomes: ["Center clay", "Pull walls"], prerequisites: [], teachingStyle: "calm" } as never,
  });
  await supabase.from("marketing_campaign").insert({ id: campaignId, course_id: courseId, name: "Launch" });
  await supabase.from("subscriber").insert({ campaign_id: campaignId, course_id: courseId, email: `s-${crypto.randomUUID().slice(0, 6)}@example.com`, status: "lead" });
  console.log("# seeded course + campaign + 1 lead");

  const services = createMarketingServices({ clock: fixedClock() });
  const baseCtx: MarketingToolContext = { supabase, courseId, campaignId, ownerId: userId, services, requestedBy: "user" };

  // pre-create a landing page (accepted) so the agent can publish a known id
  const gen = await executeMarketingTool("generate_landing_page", { title: null, ctaLabel: null }, baseCtx);
  const pageId = (gen.data as { pageId: string }).pageId;
  await acceptMarketingAction(supabase, gen.actionId!);

  // ── run 1: reversible chaining (generate a sequence) ──────────────────
  console.log("\n# agent run 1 — reversible generation auto-stages");
  const ev1: MarketingAgentEvent[] = [];
  const model1 = createMockModelClient(
    [{ text: "Drafting a launch sequence.", toolCalls: [{ name: "generate_email_sequence", arguments: {} }] }],
    { finalText: "Staged a 4-email launch sequence for your review." }
  );
  const r1 = await runMarketingAgentTurn({
    supabase, model: model1, courseId, campaignId, ownerId: userId, userMessage: "Set up my launch emails", services, emit: (e) => ev1.push(e),
  });
  check("emits an observation (observe step)", ev1.some((e) => e.type === "observation"));
  check("tool_result is 'staged' (reversible auto-staged)", ev1.some((e) => e.type === "tool_result" && e.status === "staged"));
  check("no approval_request for a reversible action", !ev1.some((e) => e.type === "approval_request"));
  check("run did NOT pause", r1.paused === false);
  check("done event is not paused", ev1.some((e) => e.type === "done" && e.paused === false));
  check("the model received the marketing tools", (model1.getCalls()[0]?.tools ?? []).some((t) => t.name === "generate_email_sequence"));
  check("system prompt carries the governance rule", (model1.getCalls()[0]?.system ?? "").includes("IRREVERSIBLE"));
  check("observe context rides in a leading developer message", model1.getCalls()[0]?.input?.[0] && "role" in model1.getCalls()[0]!.input[0] && (model1.getCalls()[0]!.input[0] as { role: string }).role === "developer");

  // ── run 2: read/observe tool ──────────────────────────────────────────
  console.log("\n# agent run 2 — read tool executes, no ledger");
  const ev2: MarketingAgentEvent[] = [];
  const model2 = createMockModelClient(
    [{ text: "Checking your funnel.", toolCalls: [{ name: "get_analytics_summary", arguments: {} }] }],
    { finalText: "Here's where things stand." }
  );
  await runMarketingAgentTurn({
    supabase, model: model2, courseId, campaignId, ownerId: userId, userMessage: "How am I doing?", services, emit: (e) => ev2.push(e),
  });
  check("read tool_result has status 'read'", ev2.some((e) => e.type === "tool_result" && e.status === "read"));

  // ── run 3: irreversible PAUSES the loop ───────────────────────────────
  console.log("\n# agent run 3 — irreversible publish PAUSES for approval");
  const ev3: MarketingAgentEvent[] = [];
  const model3 = createMockModelClient(
    [{ text: "I'll publish it — pending your OK.", toolCalls: [{ name: "publish_landing_page", arguments: { pageId } }] }],
    { finalText: "(should not be reached — loop pauses)" }
  );
  const r3 = await runMarketingAgentTurn({
    supabase, model: model3, courseId, campaignId, ownerId: userId, userMessage: "Publish the page", services, emit: (e) => ev3.push(e),
  });
  const approvalEvt = ev3.find((e) => e.type === "approval_request");
  check("emits an approval_request", !!approvalEvt && approvalEvt.type === "approval_request");
  check("run PAUSED", r3.paused === true);
  check("done event marked paused", ev3.some((e) => e.type === "done" && e.paused === true));
  check("page is STILL draft (not executed)", (await loadLandingPage(supabase, pageId))?.status === "draft");
  const actionId = approvalEvt && approvalEvt.type === "approval_request" ? approvalEvt.actionId : "";
  check("a pending action was recorded", (await loadAction(supabase, actionId))?.status === "pending");
  check("the agent only made ONE model call before pausing", model3.getCalls().length === 1, String(model3.getCalls().length));

  // approve → executes
  await approveMarketingAction(actionId, { supabase, ownerId: userId, services });
  check("approving publishes the page", (await loadLandingPage(supabase, pageId))?.status === "published");
  check("approved action is executed", (await loadAction(supabase, actionId))?.status === "executed");

  // ── conversation persisted ────────────────────────────────────────────
  const { count: msgCount } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("course_id", courseId);
  check("conversation messages persisted (history replayed each turn)", (msgCount ?? 0) >= 6, String(msgCount));

  await supabase.from("courses").delete().eq("id", courseId);
  console.log("\n# cleaned up");
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
