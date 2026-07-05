/**
 * Phase 0 integration test of the Marketing spine against LIVE Supabase, with
 * the deterministic mock services (no OpenAI / Resend key needed).
 * Run: `npx tsx scripts/verify-marketing.ts`
 *
 * Proves the GOVERNANCE GATE end-to-end + the RLS guarantees:
 *   - read tools execute, never recorded;
 *   - reversible create stages (auto_approved) + Reject deletes it;
 *   - reversible update stages with a before-snapshot + Reject restores it
 *     BYTE-FOR-BYTE;
 *   - Accept resolves a staged change (keeps it);
 *   - irreversible publish does NOT execute — it pends; Approve runs it; Deny
 *     leaves the page untouched;
 *   - published landing pages are PUBLIC-READ; drafts are not;
 *   - a different author cannot read the campaign (author-scope RLS).
 *
 * Throwaway *@example.com users can't be deleted with the anon key — clean them
 * in Supabase → Auth. The course is deleted at the end (cascades all of it).
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  acceptMarketingAction,
  approveMarketingAction,
  executeMarketingTool,
  getMarketingToolDefinitions,
  rejectMarketingAction,
} from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { createMockEmailProvider, fixedClock } from "@/lib/marketing/services/mock";
import { loadLandingPage } from "@/lib/marketing/persistence";
import { listPendingApprovals, listStagedActions, loadAction } from "@/lib/marketing/gate";

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

function loadEnv(): { url: string; anon: string } {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

async function provision(url: string, anon: string) {
  const email = `mkt-itest-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const supabase = createClient<Database>(url, anon);
  const { data: signin, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !signin.user) throw new Error(`signin failed: ${error?.message}`);
  return { supabase, userId: signin.user.id, email, password };
}

async function main() {
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");

  const { supabase, userId } = await provision(url, anon);
  console.log(`# provisioned author`);

  // seed a course + module + lessons + plan
  const courseId = crypto.randomUUID();
  const moduleId = crypto.randomUUID();
  {
    const { error } = await supabase.from("courses").insert({
      id: courseId,
      author_id: userId,
      title: "Intro to Options Trading",
      description: "A beginner-friendly path from “what's a call?” to your first spread.",
      audience: "beginners",
      level: "beginner",
      price_cents: 2900,
      plan: {
        outcomes: [
          "Read an options chain without freezing up",
          "Place your first call and put with a clear plan",
          "Draw payoff diagrams for any single-leg trade",
        ],
        prerequisites: ["basic arithmetic"],
        teachingStyle: "friendly",
      } as never,
    });
    if (error) throw new Error(`course insert: ${error.message}`);
    await supabase.from("modules").insert({ id: moduleId, course_id: courseId, title: "Foundations", order: 0 });
    await supabase.from("lessons").insert([
      { id: crypto.randomUUID(), module_id: moduleId, course_id: courseId, title: "What is an option?", order: 0 },
      { id: crypto.randomUUID(), module_id: moduleId, course_id: courseId, title: "Calls & puts", order: 1 },
    ]);
  }
  console.log("# seeded course/module/lessons");

  const services = createMarketingServices({ email: createMockEmailProvider(), clock: fixedClock() });
  const baseCtx: MarketingToolContext = {
    supabase,
    courseId,
    campaignId: null,
    ownerId: userId,
    services,
    requestedBy: "user",
  };

  // ── tool definitions are strict JSON schema ───────────────────────────
  console.log("\n# tool definitions");
  const defs = getMarketingToolDefinitions();
  check("tool defs exist for every tool", defs.length >= 9, `got ${defs.length}`);
  const publishDef = defs.find((d) => d.name === "publish_landing_page");
  check("a tool def carries strict params (additionalProperties:false)", !!publishDef && (publishDef.parameters as { additionalProperties?: boolean }).additionalProperties === false);

  // ── read: no ledger row ───────────────────────────────────────────────
  console.log("\n# read tool — no gate row");
  const ctxRead = await executeMarketingTool("get_campaign_context", {}, baseCtx);
  check("read tool returns status 'read'", ctxRead.status === "read", ctxRead.status);
  check("read tool records no action", ctxRead.actionId === null);

  // ── reversible create: create_campaign stages ─────────────────────────
  console.log("\n# reversible create — create_campaign");
  const created = await executeMarketingTool(
    "create_campaign",
    { name: "Options Launch", goal: "Sell the beta cohort" },
    baseCtx
  );
  check("create_campaign is staged", created.status === "staged", created.status);
  check("create_campaign returns a target", created.target?.entity === "campaign");
  const campaignId = (created.data as { campaignId: string }).campaignId;
  const ctx: MarketingToolContext = { ...baseCtx, campaignId };
  const createAction = await loadAction(supabase, created.actionId!);
  check("create action recorded auto_approved (staged)", createAction?.status === "auto_approved", createAction?.status);
  check("create action before_snapshot is null (a create)", createAction?.beforeSnapshot === null);
  const { data: campRow } = await supabase.from("marketing_campaign").select("id,name").eq("id", campaignId).maybeSingle();
  check("campaign row persisted", campRow?.name === "Options Launch");

  // accept the campaign (keep it)
  await acceptMarketingAction(supabase, created.actionId!);
  check("accept resolves the staged action to executed", (await loadAction(supabase, created.actionId!))?.status === "executed");

  // ── get_course_plan grounds generation ────────────────────────────────
  const plan = await executeMarketingTool("get_course_plan", {}, ctx);
  check("get_course_plan returns outcomes", Array.isArray((plan.data as { outcomes: string[] }).outcomes) && (plan.data as { outcomes: string[] }).outcomes.length === 3);

  // ── reversible create: generate a KEEPER landing page ─────────────────
  console.log("\n# reversible create — generate_landing_page (keeper)");
  const gen = await executeMarketingTool("generate_landing_page", { title: null, ctaLabel: null }, ctx);
  check("generate_landing_page is staged", gen.status === "staged");
  const pageId = (gen.data as { pageId: string }).pageId;
  const page = await loadLandingPage(supabase, pageId);
  check("page persisted as draft", page?.status === "draft");
  check("page has grounded sections (hero+outcomes+curriculum+…)", (page?.sections.length ?? 0) >= 5, `got ${page?.sections.length}`);
  check("page slug derived from title", !!page && page.slug.startsWith("intro-to-options-trading"));
  const heroBefore = JSON.stringify(page?.sections.find((s) => s.kind === "hero"));
  await acceptMarketingAction(supabase, gen.actionId!); // keep it

  // ── reversible create + REJECT deletes it ─────────────────────────────
  console.log("\n# reversible create + reject — throwaway page is deleted");
  const gen2 = await executeMarketingTool("generate_landing_page", { title: "Throwaway", ctaLabel: null }, ctx);
  const page2Id = (gen2.data as { pageId: string }).pageId;
  check("throwaway page exists before reject", !!(await loadLandingPage(supabase, page2Id)));
  await rejectMarketingAction(supabase, gen2.actionId!, { nowIso: services.clock.now() });
  check("reject of a create DELETES the page", (await loadLandingPage(supabase, page2Id)) === null);
  check("rejected create action is 'reverted'", (await loadAction(supabase, gen2.actionId!))?.status === "reverted");

  // ── reversible update + REJECT restores byte-for-byte ─────────────────
  console.log("\n# reversible update + reject — section restored byte-for-byte");
  const hero = page!.sections.find((s) => s.kind === "hero")!;
  const editedHero = { ...hero, headline: "TOTALLY DIFFERENT HEADLINE" };
  const upd = await executeMarketingTool("update_landing_section", { pageId, section: editedHero }, ctx);
  check("update_landing_section is staged", upd.status === "staged");
  const afterEdit = await loadLandingPage(supabase, pageId);
  check("section changed after update", JSON.stringify(afterEdit?.sections.find((s) => s.kind === "hero")) !== heroBefore);
  const updAction = await loadAction(supabase, upd.actionId!);
  check("update action captured a before_snapshot", !!updAction?.beforeSnapshot);
  await rejectMarketingAction(supabase, upd.actionId!, { nowIso: services.clock.now() });
  const afterReject = await loadLandingPage(supabase, pageId);
  check("reject restores the section BYTE-FOR-BYTE", JSON.stringify(afterReject?.sections.find((s) => s.kind === "hero")) === heroBefore, "section differs after restore");

  // ── irreversible publish: pends, then approve ─────────────────────────
  console.log("\n# irreversible publish — pends, no write, then approve");
  const pub = await executeMarketingTool("publish_landing_page", { pageId }, ctx);
  check("publish returns pending_approval", pub.status === "pending_approval", pub.status);
  check("publish surfaces an approval preview (slug/url)", !!(pub.approvalPreview as { slug?: string })?.slug);
  check("page is STILL draft while pending (no write)", (await loadLandingPage(supabase, pageId))?.status === "draft");
  check("pending action listed in the approval inbox", (await listPendingApprovals(supabase, courseId)).some((a) => a.id === pub.actionId));

  await approveMarketingAction(pub.actionId!, { supabase, ownerId: userId, services });
  const published = await loadLandingPage(supabase, pageId);
  check("approve publishes the page", published?.status === "published");
  check("approve sets published_at", !!published?.publishedAt);
  check("approved action is 'executed'", (await loadAction(supabase, pub.actionId!))?.status === "executed");

  // ── irreversible + DENY leaves the page untouched ─────────────────────
  console.log("\n# irreversible publish + deny — page untouched");
  const gen3 = await executeMarketingTool("generate_landing_page", { title: "Second page", ctaLabel: null }, ctx);
  const page3Id = (gen3.data as { pageId: string }).pageId;
  await acceptMarketingAction(supabase, gen3.actionId!);
  const pub3 = await executeMarketingTool("publish_landing_page", { pageId: page3Id }, ctx);
  await rejectMarketingAction(supabase, pub3.actionId!); // deny
  check("denied publish leaves page draft", (await loadLandingPage(supabase, page3Id))?.status === "draft");
  check("denied action is 'rejected'", (await loadAction(supabase, pub3.actionId!))?.status === "rejected");

  // ── staged list sanity ────────────────────────────────────────────────
  check("no staged actions linger (all accepted/reverted)", (await listStagedActions(supabase, courseId)).length === 0, `staged remain`);

  // ── RLS: published page is PUBLIC-READ; draft is not ──────────────────
  console.log("\n# RLS — public read of published, not draft");
  const anonClient = createClient<Database>(url, anon); // no session = anon role
  const { data: anonPub } = await anonClient.from("landing_page").select("id,status").eq("id", pageId).maybeSingle();
  check("anon CAN read a published landing page", anonPub?.status === "published", JSON.stringify(anonPub));
  const { data: anonDraft } = await anonClient.from("landing_page").select("id").eq("id", page3Id).maybeSingle();
  check("anon CANNOT read a draft landing page", anonDraft === null);
  const { data: anonCamp } = await anonClient.from("marketing_campaign").select("id").eq("id", campaignId).maybeSingle();
  check("anon CANNOT read the campaign", anonCamp === null);

  // ── RLS: a DIFFERENT author cannot read this campaign ─────────────────
  console.log("\n# RLS — author scoping");
  const other = await provision(url, anon);
  const { data: otherCamp } = await other.supabase.from("marketing_campaign").select("id").eq("id", campaignId).maybeSingle();
  check("a different author CANNOT read the campaign", otherCamp === null);
  const { data: otherActions } = await other.supabase.from("marketing_action").select("id").eq("course_id", courseId);
  check("a different author CANNOT read the gate ledger", (otherActions ?? []).length === 0);

  // cleanup
  await supabase.from("courses").delete().eq("id", courseId);
  console.log("\n# cleaned up course");

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
