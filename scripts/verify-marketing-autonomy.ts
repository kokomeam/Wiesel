/**
 * The autonomy redesign's invariant suite — every non-negotiable pinned down.
 *
 *   1. A tool the registry doesn't recognize fails CLOSED (throws; and the
 *      pure engine never auto-approves an unknown name, even if allow-listed).
 *   2. Hard-denied tools (launch_campaign, cancel_campaign,
 *      send_consent_confirmations) stay pending_approval under EVERY mode and
 *      EVERY policy configuration.
 *   3. Denying a pending action guarantees the underlying effect never ran
 *      (provider send-count unchanged; entity untouched).
 *   4. In auto mode, ANY single guardrail failing routes to manual review —
 *      guardrails narrow, never widen; unconfigured fields fail closed.
 *   5. Reversible tools NEVER produce pending_approval, in any mode — they
 *      execute + log with a time-boxed Revert.
 *   6. The system-prompt governance language survives the redesign.
 *   Plus: the owner-test-email auto-log rule, the clarifying-question pause
 *   (gate-raised AND model-raised through ONE blocked shape), answer
 *   idempotency, resume-after-answer, the approve double-click race, and the
 *   segment send history (auto AND human-approved sends both teach it).
 *
 * Pure checks run first (no DB); live checks self-provision a throwaway
 * Supabase user. Run: `npx tsx scripts/verify-marketing-autonomy.ts`
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import {
  AUTO_APPROVABLE_TOOLS,
  EMPTY_POLICY,
  evaluateAutonomy,
  HARD_DENY_TOOLS,
  hourInTimeZone,
  KNOWN_IRREVERSIBLE_TOOLS,
  parsePolicy,
  type AutonomyFacts,
  type AutonomyMode,
  type AutonomyPolicy,
} from "@/lib/marketing/autonomy";
import { hasSegmentBeenSent, recordSegmentSend, upsertAutonomySettings } from "@/lib/marketing/autonomyStore";
import { runMarketingAgentTurn } from "@/lib/marketing/agent/loop";
import type { MarketingAgentEvent } from "@/lib/marketing/agent/events";
import { buildMarketingSystemPrompt } from "@/lib/marketing/agent/prompt";
import { answeredMessage, resumeAgentAfterAnswer } from "@/lib/marketing/agent/resume";
import { loadAction } from "@/lib/marketing/gate";
import { answerQuestion, listPendingQuestions, type MarketingQuestionRow } from "@/lib/marketing/questions";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { createMockEmailProvider, fixedClock } from "@/lib/marketing/services/mock";
import {
  acceptMarketingAction,
  ALL_MARKETING_TOOLS,
  approveMarketingAction,
  executeMarketingTool,
  rejectMarketingAction,
} from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { loadCampaign, loadLandingPage } from "@/lib/marketing/persistence";

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

const NOW_MS = Date.parse("2026-06-18T00:00:00.000Z"); // fixedClock's default instant (00:00 UTC)

function facts(overrides: Partial<AutonomyFacts> = {}): AutonomyFacts {
  return {
    toolName: "send_broadcast",
    audienceCount: 10,
    budgetCents: null,
    segmentKey: "status:all",
    segmentSeenBefore: true,
    nowMs: NOW_MS,
    recipientIsOwner: false,
    ...overrides,
  };
}

function permissive(overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return {
    autoApproveTools: ["send_broadcast"],
    maxRecipients: 100,
    maxBudgetCents: 100_000,
    allowedHours: { startHour: 0, endHour: 24, timezone: null },
    firstSendToNewSegmentManual: true,
    ...overrides,
  };
}

function failedNames(policy: AutonomyPolicy, f: AutonomyFacts, mode: AutonomyMode = "auto"): string[] {
  return evaluateAutonomy(mode, policy, f)
    .guardrails.filter((g) => g.status === "fail")
    .map((g) => g.name);
}

/* ═══════════════════════════ PART A — pure checks ═══════════════════════ */

function pureChecks() {
  console.log("# drift guard — engine tool sets match the registry");
  const registryIrreversible = new Set(
    ALL_MARKETING_TOOLS.filter((t) => t.reversibility === "irreversible").map((t) => t.name)
  );
  check(
    "KNOWN_IRREVERSIBLE_TOOLS === the registry's irreversible set",
    registryIrreversible.size === KNOWN_IRREVERSIBLE_TOOLS.size &&
      [...registryIrreversible].every((t) => KNOWN_IRREVERSIBLE_TOOLS.has(t)),
    `registry: ${[...registryIrreversible].join(",")}`
  );
  check("every hard-denied tool is a known irreversible tool", [...HARD_DENY_TOOLS].every((t) => KNOWN_IRREVERSIBLE_TOOLS.has(t)));
  check(
    "AUTO_APPROVABLE = KNOWN minus HARD_DENY",
    AUTO_APPROVABLE_TOOLS.size === KNOWN_IRREVERSIBLE_TOOLS.size - HARD_DENY_TOOLS.size &&
      [...AUTO_APPROVABLE_TOOLS].every((t) => KNOWN_IRREVERSIBLE_TOOLS.has(t) && !HARD_DENY_TOOLS.has(t))
  );

  console.log("\n# parsePolicy — a corrupt policy can only reduce autonomy");
  check("garbage → EMPTY policy", JSON.stringify(parsePolicy("not an object")) === JSON.stringify(EMPTY_POLICY));
  check("array → EMPTY policy", JSON.stringify(parsePolicy([1, 2])) === JSON.stringify(EMPTY_POLICY));
  const partial = parsePolicy({ maxRecipients: 50 });
  check("partial policy fills fail-closed defaults", partial.maxRecipients === 50 && partial.autoApproveTools.length === 0 && partial.allowedHours === null && partial.firstSendToNewSegmentManual === true);
  const corruptField = parsePolicy({ autoApproveTools: "everything", maxRecipients: 10 });
  check("a corrupt FIELD degrades to its empty default, keeps the rest", corruptField.autoApproveTools.length === 0 && corruptField.maxRecipients === 10);

  console.log("\n# hourInTimeZone — deterministic");
  check("00:00Z → hour 0 UTC", hourInTimeZone(NOW_MS, null) === 0, String(hourInTimeZone(NOW_MS, null)));
  check("00:00Z → 20:00 in New York (EDT)", hourInTimeZone(NOW_MS, "America/New_York") === 20, String(hourInTimeZone(NOW_MS, "America/New_York")));
  check("unknown timezone falls back to UTC (guardrail still applies)", hourInTimeZone(NOW_MS, "Not/AZone") === 0);

  console.log("\n# invariant 1 — unknown tool is never auto-approvable (pure)");
  const fake = evaluateAutonomy("auto", permissive({ autoApproveTools: ["totally_fake_tool"] }), facts({ toolName: "totally_fake_tool" }));
  check("policy allow-listing an unknown name never yields auto_execute", fake.route === "pending_approval");
  check("…and the failure is the allowlist guardrail", fake.guardrails.some((g) => g.name === "tool_allowlist" && g.status === "fail"));

  console.log("\n# invariant 2 — hard-deny sweep: 3 tools × 3 modes × permissive policy");
  for (const tool of HARD_DENY_TOOLS) {
    for (const mode of ["manual", "assisted", "auto"] as const) {
      const d = evaluateAutonomy(mode, permissive({ autoApproveTools: [...KNOWN_IRREVERSIBLE_TOOLS], firstSendToNewSegmentManual: false, maxRecipients: 1_000_000 }), facts({ toolName: tool }));
      check(`${tool} under ${mode} → pending_approval (hard_deny first)`, d.route === "pending_approval" && d.guardrails[0]?.name === "hard_deny" && d.guardrails[0]?.status === "fail");
    }
  }

  console.log("\n# owner test-email rule");
  check("assisted + owner-addressed test → auto_log", evaluateAutonomy("assisted", EMPTY_POLICY, facts({ toolName: "send_test_email", recipientIsOwner: true, segmentKey: null, segmentSeenBefore: null })).route === "auto_log");
  check("auto + owner-addressed test → auto_log", evaluateAutonomy("auto", EMPTY_POLICY, facts({ toolName: "send_test_email", recipientIsOwner: true, segmentKey: null, segmentSeenBefore: null })).route === "auto_log");
  check("manual + owner-addressed test → pending (no exceptions in manual)", evaluateAutonomy("manual", EMPTY_POLICY, facts({ toolName: "send_test_email", recipientIsOwner: true, segmentKey: null, segmentSeenBefore: null })).route === "pending_approval");
  check("assisted + FOREIGN-addressed test → pending (fail closed)", evaluateAutonomy("assisted", EMPTY_POLICY, facts({ toolName: "send_test_email", recipientIsOwner: false, segmentKey: null, segmentSeenBefore: null })).route === "pending_approval");

  console.log("\n# invariant 4 — any single guardrail failing routes to a card");
  check("all guardrails pass → auto_execute", evaluateAutonomy("auto", permissive(), facts()).route === "auto_execute");
  check("manual mode never auto-executes even with a permissive policy", evaluateAutonomy("manual", permissive(), facts()).route === "pending_approval");
  check("assisted mode never auto-executes even with a permissive policy", evaluateAutonomy("assisted", permissive(), facts()).route === "pending_approval");
  check("recipient cap breach ALONE → pending", failedNames(permissive({ maxRecipients: 5 }), facts({ audienceCount: 10 })).join(",") === "recipient_cap");
  check("NULL recipient cap with audience>0 fails closed", failedNames(permissive({ maxRecipients: null }), facts()).join(",") === "recipient_cap");
  check("budget with NULL budget cap fails closed", failedNames(permissive({ maxBudgetCents: null }), facts({ budgetCents: 500 })).join(",") === "budget_cap");
  check("budget over cap fails", failedNames(permissive({ maxBudgetCents: 100 }), facts({ budgetCents: 500 })).join(",") === "budget_cap");
  check("outside allowed hours ALONE → pending", failedNames(permissive({ allowedHours: { startHour: 9, endHour: 17, timezone: null } }), facts()).join(",") === "allowed_hours");
  check("NULL allowed hours fails closed for every candidate", failedNames(permissive({ allowedHours: null }), facts()).join(",") === "allowed_hours");
  check("overnight window (22–6) admits 00:00", evaluateAutonomy("auto", permissive({ allowedHours: { startHour: 22, endHour: 6, timezone: null } }), facts()).route === "auto_execute");
  check("first send to an UNSEEN segment ALONE → pending", failedNames(permissive(), facts({ segmentSeenBefore: false })).join(",") === "new_segment");
  check("UNKNOWN segment history fails closed", failedNames(permissive(), facts({ segmentSeenBefore: null })).join(",") === "new_segment");
  check("first-send guardrail can be explicitly disabled", evaluateAutonomy("auto", permissive({ firstSendToNewSegmentManual: false }), facts({ segmentSeenBefore: false })).route === "auto_execute");
  check("EMPTY policy is inert (not allow-listed + null caps)", (() => {
    const names = failedNames(EMPTY_POLICY, facts());
    return names.includes("tool_allowlist") && names.includes("recipient_cap") && names.includes("allowed_hours");
  })());
  check("two failures never cancel out (cap breach + outside hours → still pending)", evaluateAutonomy("auto", permissive({ maxRecipients: 5, allowedHours: { startHour: 9, endHour: 17, timezone: null } }), facts()).route === "pending_approval");
  check("every decision records ALL evaluated guardrails (audit)", evaluateAutonomy("auto", permissive(), facts()).guardrails.length >= 5);

  console.log("\n# invariant 6 — governance language intact");
  const system = buildMarketingSystemPrompt();
  check("system prompt still declares IRREVERSIBLE + explicit approval", system.includes("IRREVERSIBLE") && system.includes("REQUIRES the creator's explicit approval"));
  check("system prompt still says the model cannot bypass the gate", system.includes("You cannot bypass this"));
  check("system prompt teaches ask_creator for blocked targeting", system.includes("ask_creator"));
  check(
    "system prompt demands the end-of-run wrap-up (what happened + delivery timing)",
    system.includes("END OF RUN") && system.includes("Enqueued is NOT sent")
  );

  console.log("\n# resume messages");
  const gateQ = {
    id: "q1", courseId: "c", campaignId: null, conversationId: "conv", source: "gate", toolName: "send_broadcast",
    toolCallId: "call1", toolParams: { args: { status: null }, paramKey: "status" }, question: "Which segment?",
    options: [], status: "pending", answer: null, requestedBy: "agent", resolvedAt: null, createdAt: "",
  } as MarketingQuestionRow;
  const gateMsg = answeredMessage(gateQ, { value: "engaged", label: "Engaged (12)" });
  check("gate-raised answer message says to retry the tool with the resolved param", gateMsg.includes("Retry send_broadcast") && gateMsg.includes("status") && gateMsg.includes('"engaged"'));
  const modelMsg = answeredMessage({ ...gateQ, source: "model", toolName: null }, { value: "list-a", label: "Spring list" });
  check("model-raised answer message hands the answer back and continues", modelMsg.includes("Spring list") && modelMsg.includes("Continue"));
}

/* ═══════════════════════════ PART B — live checks ═══════════════════════ */

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

async function liveChecks() {
  const { url, anon } = loadEnv();
  const email = `mkt-au-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
    title: "Watercolor Basics",
    description: "Paint your first wash.",
    plan: { outcomes: ["Mix pigment", "Layer washes"], prerequisites: [], teachingStyle: "warm" } as never,
  });
  await supabase.from("marketing_campaign").insert({ id: campaignId, course_id: courseId, name: "Launch" });
  // MIXED audience (2 leads + 1 engaged) so null-segment targeting is ambiguous.
  await supabase.from("subscriber").insert([
    { campaign_id: campaignId, course_id: courseId, email: `l1-${crypto.randomUUID().slice(0, 6)}@example.com`, status: "lead" },
    { campaign_id: campaignId, course_id: courseId, email: `l2-${crypto.randomUUID().slice(0, 6)}@example.com`, status: "lead" },
    { campaign_id: campaignId, course_id: courseId, email: `e1-${crypto.randomUUID().slice(0, 6)}@example.com`, status: "engaged" },
  ]);
  console.log("# seeded course + campaign + mixed audience (2 lead, 1 engaged)");

  const provider = createMockEmailProvider();
  const clock = fixedClock();
  const services = createMarketingServices({ email: provider, clock });
  const ctx: MarketingToolContext = { supabase, courseId, campaignId, ownerId: userId, ownerEmail: email, services, requestedBy: "user" };
  const briefArgs = (note: string) => ({ campaignId, audienceNotes: note, proofPoints: null, offerDetails: null, thingsToAvoid: null, freeform: null, language: null, offerDeadlineIso: null });
  const actionCount = async () => (await supabase.from("marketing_action").select("id", { count: "exact", head: true }).eq("course_id", courseId)).count ?? 0;

  /* invariant 5 — reversible never pends, in ANY mode */
  console.log("\n# invariant 5 — reversible executes + logs under every mode");
  const stagedIds: string[] = [];
  for (const mode of ["manual", "assisted", "auto"] as const) {
    await upsertAutonomySettings(supabase, courseId, { mode });
    const out = await executeMarketingTool("update_campaign_brief", briefArgs(`note under ${mode}`), ctx);
    check(`reversible is 'staged' under ${mode} (never pending_approval)`, out.status === "staged", out.status);
    stagedIds.push(out.actionId!);
  }
  await upsertAutonomySettings(supabase, courseId, { mode: "assisted" });

  const stagedRow = (await loadAction(supabase, stagedIds[2]))!;
  const expectedExpiry = new Date(clock.epochMs() + 24 * 3_600_000).getTime();
  check(
    "revert_expires_at ≈ created + 24h (default window)",
    Math.abs(new Date(stagedRow.revertExpiresAt!).getTime() - expectedExpiry) < 5 * 60_000,
    String(stagedRow.revertExpiresAt)
  );

  await rejectMarketingAction(supabase, stagedIds[2], { nowIso: clock.now() });
  check("within-window revert works (status 'reverted')", (await loadAction(supabase, stagedIds[2]))?.status === "reverted");
  check("revert restored the previous brief", ((await loadCampaign(supabase, campaignId))?.config.brief?.audienceNotes ?? null) === "note under assisted");

  await supabase.from("marketing_action").update({ revert_expires_at: new Date(clock.epochMs() - 1000).toISOString() }).eq("id", stagedIds[1]);
  let expiredThrew = false;
  try {
    await rejectMarketingAction(supabase, stagedIds[1], { nowIso: clock.now() });
  } catch (e) {
    expiredThrew = e instanceof Error && e.message.includes("Revert window expired");
  }
  check("revert REFUSED past the window (fail closed)", expiredThrew);
  check("the expired row is untouched (still auto_approved)", (await loadAction(supabase, stagedIds[1]))?.status === "auto_approved");
  await acceptMarketingAction(supabase, stagedIds[1]);
  check("dismiss resolves the log entry to 'executed'", (await loadAction(supabase, stagedIds[1]))?.status === "executed");

  /* invariant 1 — unknown tool live */
  console.log("\n# invariant 1 — unknown tool fails closed (live)");
  const before1 = await actionCount();
  let unknownThrew = false;
  try {
    await executeMarketingTool("not_a_real_tool", {}, ctx);
  } catch (e) {
    unknownThrew = e instanceof Error && e.message.includes("Unknown marketing tool");
  }
  check("unknown tool throws (nothing executed)", unknownThrew);
  check("…and nothing was recorded on the ledger", (await actionCount()) === before1);

  /* owner test-email auto-log (assisted default) */
  console.log("\n# assisted — owner-addressed test email auto-logs");
  const sendsBefore = provider.getSends().length;
  const ownTest = await executeMarketingTool(
    "send_test_email",
    { to: email, subject: "Test my email", body: { blocks: [{ kind: "paragraph", text: "Hello me." }] } },
    ctx
  );
  check("owner-addressed test send is 'executed' (no card)", ownTest.status === "executed", ownTest.status);
  check("the test email actually went out", provider.getSends().length === sendsBefore + 1);
  const ownRow = await loadAction(supabase, ownTest.actionId!);
  check("audit route is 'auto_log'", (ownRow?.autonomyDecision as { route?: string } | null)?.route === "auto_log");
  check("auto-logged row is resolved (executed)", ownRow?.status === "executed" && ownRow.resolvedAt !== null);

  const foreignTest = await executeMarketingTool(
    "send_test_email",
    { to: "someone-else@example.com", subject: "Test", body: { blocks: [{ kind: "paragraph", text: "Hi." }] } },
    ctx
  );
  check("FOREIGN-addressed test send stays pending (fail closed)", foreignTest.status === "pending_approval", foreignTest.status);
  const sendsAfterForeign = provider.getSends().length;
  await rejectMarketingAction(supabase, foreignTest.actionId!);
  check("denied test send never reached the provider (invariant 3)", provider.getSends().length === sendsAfterForeign && sendsAfterForeign === sendsBefore + 1);
  check("denied row is 'rejected'", (await loadAction(supabase, foreignTest.actionId!))?.status === "rejected");

  /* invariant 3 — deny a publish; the effect never runs */
  console.log("\n# invariant 3 — deny guarantees no execution");
  const gen = await executeMarketingTool("generate_landing_page", { title: null, ctaLabel: null }, ctx);
  const pageId = (gen.data as { pageId: string }).pageId;
  await acceptMarketingAction(supabase, gen.actionId!);
  const pub1 = await executeMarketingTool("publish_landing_page", { pageId }, ctx);
  check("publish pends under assisted", pub1.status === "pending_approval");
  await rejectMarketingAction(supabase, pub1.actionId!);
  check("denied publish leaves the page draft", (await loadLandingPage(supabase, pageId))?.status === "draft");
  check("denied publish row is 'rejected'", (await loadAction(supabase, pub1.actionId!))?.status === "rejected");

  /* approve race — one click wins, the double-click sees "already resolved" */
  console.log("\n# approve double-click race");
  const pub2 = await executeMarketingTool("publish_landing_page", { pageId }, ctx);
  await approveMarketingAction(pub2.actionId!, { supabase, ownerId: userId, services });
  check("first approve executes (page published)", (await loadLandingPage(supabase, pageId))?.status === "published");
  let secondThrew = false;
  try {
    await approveMarketingAction(pub2.actionId!, { supabase, ownerId: userId, services });
  } catch (e) {
    secondThrew = e instanceof Error && e.message.includes("not pending");
  }
  check("second approve throws 'not pending' — never a duplicate effect", secondThrew);

  /* gate-raised clarifying question */
  console.log("\n# gate question — ambiguous broadcast targeting");
  const beforeQ = await actionCount();
  const ambiguous = await executeMarketingTool(
    "send_broadcast",
    { subject: "News", body: { blocks: [{ kind: "paragraph", text: "Update." }] }, status: null },
    ctx
  );
  check("null-segment broadcast over a MIXED audience → needs_clarification", ambiguous.status === "needs_clarification", ambiguous.status);
  check("no pending action row was created (nothing half-requested)", (await actionCount()) === beforeQ);
  check("the question offers Everyone + per-status options", (ambiguous.question?.options.length ?? 0) >= 3 && ambiguous.question!.options.some((o) => o.value === "all"));
  const qRows = await listPendingQuestions(supabase, courseId);
  const gateQ = qRows.find((q) => q.id === ambiguous.questionId)!;
  check("question row links the paused tool (name + args + paramKey)", gateQ?.source === "gate" && gateQ.toolName === "send_broadcast" && (gateQ.toolParams as { paramKey?: string })?.paramKey === "status");
  check("answerQuestion resolves it (first answer wins)", await answerQuestion(supabase, gateQ.id, { value: "engaged", label: "Engaged" }));
  check("answerQuestion is idempotent (second answer no-ops)", !(await answerQuestion(supabase, gateQ.id, { value: "all", label: "Everyone" })));

  /* one pause shape through the loop + resume-after-answer */
  console.log("\n# loop pause parity + resume after answer");
  const ev: MarketingAgentEvent[] = [];
  const model1 = createMockModelClient(
    [{ text: "Sending an update.", toolCalls: [{ name: "send_broadcast", arguments: { subject: "Hello", body: { blocks: [{ kind: "paragraph", text: "Hi all." }] }, status: null } }] }],
    { finalText: "(unreachable — pauses)" }
  );
  const r1 = await runMarketingAgentTurn({
    supabase, model: model1, courseId, campaignId, ownerId: userId, ownerEmail: email,
    userMessage: "Send everyone an update", services, emit: (e) => ev.push(e),
  });
  const blocked = ev.find((e) => e.type === "agent_blocked");
  check("agent run blocks with kind='question' (same pause shape as approvals)", r1.paused === true && !!blocked && blocked.type === "agent_blocked" && blocked.kind === "question");
  const loopQ = (await listPendingQuestions(supabase, courseId)).find((q) => q.requestedBy === "agent")!;
  check("loop-raised question stores the conversation for resume", !!loopQ && loopQ.conversationId === r1.conversationId);
  await answerQuestion(supabase, loopQ.id, { value: "all", label: "Everyone (3)" });
  const model2 = createMockModelClient([], { finalText: "Got it — retrying with everyone." });
  const resumed = await resumeAgentAfterAnswer({
    supabase, model: model2, services, ownerId: userId, question: loopQ, answer: { value: "all", label: "Everyone (3)" },
  });
  check("resume lands in the SAME conversation, exactly one turn", resumed?.conversationId === r1.conversationId && model2.getCalls().length === 1);
  check("the resumed turn carries the retry instruction", JSON.stringify(model2.getCalls()[0]?.input ?? []).includes("Retry send_broadcast"));

  /* invariant 4 live — the auto-mode guardrail ladder */
  console.log("\n# auto mode — the guardrail ladder (each failure alone blocks)");
  const bc = { subject: "Weekly tips", body: { blocks: [{ kind: "paragraph", text: "This week…" }] }, status: "all" as const };
  const route = async () => {
    const out = await executeMarketingTool("send_broadcast", bc, ctx);
    const row = await loadAction(supabase, out.actionId!);
    const decision = row?.autonomyDecision as { route?: string; guardrails?: { name: string; status: string }[] } | null;
    if (out.status === "pending_approval") await rejectMarketingAction(supabase, out.actionId!); // keep the inbox clean between steps
    return { status: out.status, decision };
  };

  await upsertAutonomySettings(supabase, courseId, { mode: "auto", policy: { ...EMPTY_POLICY, autoApproveTools: ["send_broadcast"] } });
  const s1 = await route();
  check("allow-listed but NULL caps → pending (empty fields fail closed)", s1.status === "pending_approval" && (s1.decision?.guardrails ?? []).some((g) => g.name === "recipient_cap" && g.status === "fail"));

  // first-send review is disabled for these two steps so allowed_hours is the
  // ONLY failing guardrail (the segment is genuinely unseen until step 5).
  await upsertAutonomySettings(supabase, courseId, { policy: permissive({ allowedHours: null, firstSendToNewSegmentManual: false }) });
  const s2 = await route();
  check("null allowed-hours ALONE → pending", s2.status === "pending_approval" && (s2.decision?.guardrails ?? []).filter((g) => g.status === "fail").every((g) => g.name === "allowed_hours"));

  await upsertAutonomySettings(supabase, courseId, { policy: permissive({ allowedHours: { startHour: 9, endHour: 17, timezone: null }, firstSendToNewSegmentManual: false }) });
  const s3 = await route();
  check("outside allowed hours ALONE → pending (clock is 00:00 UTC)", s3.status === "pending_approval" && (s3.decision?.guardrails ?? []).filter((g) => g.status === "fail").every((g) => g.name === "allowed_hours"));

  await upsertAutonomySettings(supabase, courseId, { policy: permissive() });
  const s4 = await route();
  check("first send to an unseen segment ALONE → pending", s4.status === "pending_approval" && (s4.decision?.guardrails ?? []).filter((g) => g.status === "fail").every((g) => g.name === "new_segment"));

  await recordSegmentSend(supabase, { courseId, campaignId, segmentKey: "status:all", nowIso: clock.now() });
  const sendsBeforeAuto = provider.getSends().length;
  const clean = await executeMarketingTool("send_broadcast", bc, ctx);
  check("clean policy match AUTO-EXECUTES (row 'executed', route 'auto_execute')", clean.status === "executed" && ((await loadAction(supabase, clean.actionId!))?.autonomyDecision as { route?: string })?.route === "auto_execute");
  check("the broadcast actually sent to the audience", provider.getSends().length === sendsBeforeAuto + 3, String(provider.getSends().length - sendsBeforeAuto));
  const { data: segRow } = await supabase.from("marketing_segment_send").select("send_count").eq("course_id", courseId).eq("segment_key", "status:all").single();
  check("segment history bumped on auto-execute", segRow?.send_count === 2, String(segRow?.send_count));

  /* invariant 2 live — hard-denied under the MOST permissive auto policy */
  console.log("\n# invariant 2 (live) — hard-denied tools under a fully permissive auto policy");
  await upsertAutonomySettings(supabase, courseId, {
    mode: "auto",
    policy: permissive({ autoApproveTools: [...KNOWN_IRREVERSIBLE_TOOLS], maxRecipients: 1_000_000, firstSendToNewSegmentManual: false }),
  });
  const launch = await executeMarketingTool("launch_campaign", { campaignId }, ctx);
  check("launch_campaign stays pending even when allow-listed", launch.status === "pending_approval", launch.status);
  check("audit shows the hard_deny guardrail", ((await loadAction(supabase, launch.actionId!))?.autonomyDecision as { guardrails?: { name: string; status: string }[] })?.guardrails?.[0]?.name === "hard_deny");
  await rejectMarketingAction(supabase, launch.actionId!);
  const cancel = await executeMarketingTool("cancel_campaign", { campaignId }, ctx);
  check("cancel_campaign stays pending even when allow-listed", cancel.status === "pending_approval", cancel.status);
  await rejectMarketingAction(supabase, cancel.actionId!);

  /* human-approved segment sends also teach the guardrail */
  console.log("\n# manual approval teaches the segment history too");
  await upsertAutonomySettings(supabase, courseId, { mode: "assisted" });
  check("segment 'status:engaged' unseen before", !(await hasSegmentBeenSent(supabase, courseId, "status:engaged")));
  const engagedBc = await executeMarketingTool("send_broadcast", { ...bc, status: "engaged" }, ctx);
  check("assisted broadcast pends", engagedBc.status === "pending_approval");
  await approveMarketingAction(engagedBc.actionId!, { supabase, ownerId: userId, services });
  check("human-approved send recorded segment history", await hasSegmentBeenSent(supabase, courseId, "status:engaged"));

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
