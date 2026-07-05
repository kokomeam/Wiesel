/**
 * Audience list-building suite — the "put my existing contacts on a list"
 * layer (tools + composite membership revert + the free-text question answer).
 *
 *   - build_audience_list: filter semantics (consent × funnel stage, suppressed
 *     always excluded), consent_confirmed at birth for confirmed-only lists,
 *     zero-match fail, revert removes the list entirely.
 *   - add_leads_to_list / remove_leads_from_list: idempotent adds, unknown ids
 *     ignored, and BYTE-FOR-BYTE membership restore on revert (the lead_list
 *     snapshotter is composite now).
 *   - import_leads revert regression: reverting an import restores the exact
 *     prior MEMBERSHIP (the old row-only snapshot silently kept the members)
 *     while course-level contact rows persist (intended semantics).
 *   - legacy row-only lead_list snapshots still restore (back-compat).
 *   - the agent can drive it (mock model → staged, run continues).
 *   - answeredMessage("__other__") hands the creator's own words to the agent.
 *
 * Run: `npx tsx scripts/verify-marketing-lists.ts`
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { runMarketingAgentTurn } from "@/lib/marketing/agent/loop";
import type { MarketingAgentEvent } from "@/lib/marketing/agent/events";
import { answeredMessage } from "@/lib/marketing/agent/resume";
import { restoreEntity } from "@/lib/marketing/entities";
import { loadAction } from "@/lib/marketing/gate";
import type { MarketingQuestionRow } from "@/lib/marketing/questions";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { createMockEmailProvider, fixedClock } from "@/lib/marketing/services/mock";
import { upsertAutonomySettings } from "@/lib/marketing/autonomyStore";
import {
  acceptMarketingAction,
  executeMarketingTool,
  getMarketingTool,
  rejectMarketingAction,
} from "@/lib/marketing/tools";
import { CONSENT_CONFIRMATION_TEXT } from "@/lib/marketing/tools/leads";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";

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

/* ─────────────────────────── pure checks ─────────────────────────── */

function pureChecks() {
  console.log("# registry — the audience tools exist with the right grade");
  for (const name of ["build_audience_list", "add_leads_to_list", "remove_leads_from_list"]) {
    const tool = getMarketingTool(name);
    check(`${name} is registered as reversible`, tool?.reversibility === "reversible");
  }

  console.log("\n# answeredMessage — the free-text ('__other__') answer path");
  const base = {
    id: "q", courseId: "c", campaignId: null, conversationId: "conv", toolCallId: "call",
    question: "Which lead list should I use?",
    options: [], status: "pending", answer: null, requestedBy: "agent", resolvedAt: null, createdAt: "",
  };
  const gateQ = { ...base, source: "gate", toolName: "send_broadcast", toolParams: { args: {}, paramKey: "status" } } as MarketingQuestionRow;
  const gateMsg = answeredMessage(gateQ, { value: "__other__", label: "make a new list instead", freeText: "make a new list from everyone who consented instead" });
  check(
    "gate-raised freeform answer hands over the creator's words verbatim",
    gateMsg.includes("make a new list from everyone who consented instead") && gateMsg.includes("send_broadcast")
  );
  check("…and never coerces it into an option value", !gateMsg.includes('"__other__"') && gateMsg.includes("Never invent an option"));
  const modelQ = { ...base, source: "model", toolName: null, toolParams: null } as MarketingQuestionRow;
  const modelMsg = answeredMessage(modelQ, { value: "__other__", label: "do something else", freeText: "actually pause the campaign first" });
  check("model-raised freeform answer may redirect the whole plan", modelMsg.includes("actually pause the campaign first") && modelMsg.includes("may change your plan"));
}

/* ─────────────────────────── live checks ─────────────────────────── */

async function liveChecks() {
  const { url, anon } = loadEnv();
  const email = `mkt-ls-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
    title: "Sourdough Basics",
    description: "Bake your first loaf.",
    plan: { outcomes: ["Feed a starter"], prerequisites: [], teachingStyle: "warm" } as never,
  });
  await supabase.from("marketing_campaign").insert({ id: campaignId, course_id: courseId, name: "Launch" });

  const mk = (tag: string, status: string, consent: string) => ({
    campaign_id: campaignId,
    course_id: courseId,
    email: `${tag}-${crypto.randomUUID().slice(0, 6)}@example.com`,
    status,
    consent_status: consent,
  });
  const seed = [
    mk("a", "lead", "confirmed"),
    mk("b", "lead", "pending"),
    mk("c", "engaged", "confirmed"),
    mk("d", "enrolled", "confirmed"),
    mk("e", "unsubscribed", "confirmed"), // suppressed — must NEVER match
  ];
  const { data: subs } = await supabase.from("subscriber").insert(seed).select("id,email,status");
  const byTag = (t: string) => subs!.find((s) => s.email.startsWith(`${t}-`))!;
  console.log("# seeded 5 contacts (3 confirmed, 1 pending, 1 suppressed)");

  const provider = createMockEmailProvider();
  const clock = fixedClock();
  const services = createMarketingServices({ email: provider, clock });
  const nowIso = () => clock.now();
  const ctx: MarketingToolContext = { supabase, courseId, campaignId, ownerId: userId, ownerEmail: email, services, requestedBy: "user" };
  const membersOf = async (listId: string) =>
    ((await supabase.from("lead_list_member").select("subscriber_id").eq("list_id", listId)).data ?? [])
      .map((m) => m.subscriber_id)
      .sort();

  /* build_audience_list */
  console.log("\n# build_audience_list — one step from contacts to mailable list");
  const built = await executeMarketingTool("build_audience_list", { name: "Mailable people", filter: { consent: "confirmed", status: "all" } }, ctx);
  check("staged (reversible — sends nothing)", built.status === "staged", built.status);
  const builtId = (built.data as { listId: string }).listId;
  check("confirmed×all matched exactly the 3 mailable contacts (suppressed excluded)", (built.data as { added: number }).added === 3);
  check(
    "membership rows are exactly those 3",
    (await membersOf(builtId)).join(",") === [byTag("a").id, byTag("c").id, byTag("d").id].sort().join(",")
  );
  const { data: builtRow } = await supabase.from("lead_list").select("consent_confirmed,source_type").eq("id", builtId).single();
  check("a confirmed-only list is consent-confirmed at birth (no false 'high risk')", builtRow?.consent_confirmed === true && builtRow.source_type === "custom");

  let zeroThrew = false;
  try {
    await executeMarketingTool("build_audience_list", { name: "Empty", filter: { consent: "pending", status: "enrolled" } }, ctx);
  } catch (e) {
    zeroThrew = e instanceof Error && e.message.includes("No existing contacts match");
  }
  check("zero-match build fails loudly instead of creating an empty list", zeroThrew);

  await rejectMarketingAction(supabase, built.actionId!, { nowIso: nowIso() });
  check("revert removes the built list entirely", (await supabase.from("lead_list").select("id").eq("id", builtId).maybeSingle()).data === null);
  check("…and its membership rows with it", (await membersOf(builtId)).length === 0);

  /* add_leads_to_list */
  console.log("\n# add_leads_to_list — filters, idempotency, exact revert");
  const created = await executeMarketingTool("create_lead_list", { name: "Working list", sourceType: "custom" }, ctx);
  await acceptMarketingAction(supabase, created.actionId!);
  const listId = (created.data as { listId: string }).listId;

  const add1 = await executeMarketingTool("add_leads_to_list", { listId, filter: { consent: "confirmed", status: "engaged" }, subscriberIds: null }, ctx);
  check("filter add: exactly the 1 engaged+confirmed contact", (add1.data as { added: number }).added === 1 && (await membersOf(listId)).join(",") === byTag("c").id);
  await acceptMarketingAction(supabase, add1.actionId!);

  const add2 = await executeMarketingTool("add_leads_to_list", { listId, filter: { consent: "confirmed", status: "engaged" }, subscriberIds: null }, ctx);
  check("re-adding the same slice is a no-op (skipped, not duplicated)", (add2.data as { added: number; skipped: number }).added === 0 && (add2.data as { skipped: number }).skipped === 1);
  await acceptMarketingAction(supabase, add2.actionId!);

  const preAdd = await membersOf(listId);
  const add3 = await executeMarketingTool(
    "add_leads_to_list",
    { listId, filter: null, subscriberIds: [byTag("a").id, byTag("b").id, crypto.randomUUID()] },
    ctx
  );
  check("explicit ids add both course contacts; unknown ids are ignored", (add3.data as { added: number }).added === 2);
  check("membership grew accordingly", (await membersOf(listId)).length === 3);
  await rejectMarketingAction(supabase, add3.actionId!, { nowIso: nowIso() });
  check("reverting the add restores the EXACT prior membership", (await membersOf(listId)).join(",") === preAdd.join(","));

  let emptyArgsThrew = false;
  try {
    await executeMarketingTool("add_leads_to_list", { listId, filter: null, subscriberIds: null }, ctx);
  } catch {
    emptyArgsThrew = true;
  }
  check("no filter AND no ids is rejected", emptyArgsThrew);

  /* remove_leads_from_list */
  console.log("\n# remove_leads_from_list — membership only, revertable");
  const preRemove = await membersOf(listId);
  const rem = await executeMarketingTool("remove_leads_from_list", { listId, subscriberIds: [byTag("c").id] }, ctx);
  check("remove drops the member", (await membersOf(listId)).length === preRemove.length - 1);
  check("…the contact row itself is kept (course-level person)", (await supabase.from("subscriber").select("id").eq("id", byTag("c").id).maybeSingle()).data !== null);
  await rejectMarketingAction(supabase, rem.actionId!, { nowIso: nowIso() });
  check("reverting the remove restores the exact prior membership", (await membersOf(listId)).join(",") === preRemove.join(","));

  /* import_leads revert regression (composite snapshot) */
  console.log("\n# import_leads revert — membership actually rolls back now");
  const preImport = await membersOf(listId);
  const imp = await executeMarketingTool(
    "import_leads",
    {
      listId,
      contacts: [
        { email: `imp1-${crypto.randomUUID().slice(0, 6)}@example.com`, name: null },
        { email: `imp2-${crypto.randomUUID().slice(0, 6)}@example.com`, name: null },
      ],
      consentConfirmationText: CONSENT_CONFIRMATION_TEXT,
    },
    ctx
  );
  check("import added 2 members", (await membersOf(listId)).length === preImport.length + 2);
  const importAction = await loadAction(supabase, imp.actionId!);
  check(
    "the before-snapshot is COMPOSITE (list + members)",
    Boolean(importAction?.beforeSnapshot && (importAction.beforeSnapshot as { list?: unknown }).list)
  );
  await rejectMarketingAction(supabase, imp.actionId!, { nowIso: nowIso() });
  check("reverting the import restores the exact prior membership", (await membersOf(listId)).join(",") === preImport.join(","));
  const { count: contactCount } = await supabase.from("subscriber").select("id", { count: "exact", head: true }).eq("course_id", courseId);
  check("imported contact rows persist as course-level people (intended)", (contactCount ?? 0) === 7, String(contactCount));

  /* legacy row-only snapshot back-compat */
  console.log("\n# legacy lead_list snapshots (bare row) still restore");
  const { data: rowNow } = await supabase.from("lead_list").select("*").eq("id", listId).single();
  await supabase.from("lead_list").update({ name: "Renamed by test" }).eq("id", listId);
  const preLegacy = await membersOf(listId);
  await restoreEntity(supabase, { entity: "lead_list", id: listId }, rowNow as unknown as Json);
  const { data: restored } = await supabase.from("lead_list").select("name").eq("id", listId).single();
  check("bare-row restore brings the row back", restored?.name === "Working list");
  check("…and leaves membership untouched (legacy semantics)", (await membersOf(listId)).join(",") === preLegacy.join(","));

  /* reversible in every mode (spot-check under auto) */
  await upsertAutonomySettings(supabase, courseId, { mode: "auto" });
  const underAuto = await executeMarketingTool("add_leads_to_list", { listId, filter: { consent: "pending", status: "all" }, subscriberIds: null }, ctx);
  check("membership edits stay 'staged' under auto mode (reversible never pends)", underAuto.status === "staged");
  await upsertAutonomySettings(supabase, courseId, { mode: "assisted" });

  /* the agent can drive it */
  console.log("\n# agent run — build_audience_list through the loop");
  const ev: MarketingAgentEvent[] = [];
  const model = createMockModelClient(
    [
      {
        text: "Building a mailable list from everyone who consented.",
        toolCalls: [
          { name: "build_audience_list", arguments: { name: "Consented mailing list", filter: { consent: "confirmed", status: "all" } } },
        ],
      },
    ],
    { finalText: "Done — the list is ready and revertable." }
  );
  const run = await runMarketingAgentTurn({
    supabase, model, courseId, campaignId, ownerId: userId, ownerEmail: email,
    userMessage: "Put everyone who consented on a mailing list", services, emit: (e) => ev.push(e),
  });
  check("agent's list build is a quiet staged result (no pause)", run.paused === false && ev.some((e) => e.type === "tool_result" && e.status === "staged" && e.summary.includes("Consented mailing list")));
  check("the system prompt now teaches the audience capability", (model.getCalls()[0]?.system ?? "").includes("build_audience_list"));

  await supabase.from("courses").delete().eq("id", courseId);
  console.log("\n# cleaned up");
}

async function main() {
  pureChecks();
  await liveChecks();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
