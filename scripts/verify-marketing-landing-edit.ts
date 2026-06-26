/**
 * Slice 3 test against LIVE Supabase: conversational landing-page editing —
 * typed design layer + the content/design tools through the gate, plus the agent
 * path via the mock model client (no OpenAI key).
 * Run: `npx tsx scripts/verify-marketing-landing-edit.ts`
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { fixedClock } from "@/lib/marketing/services/mock";
import {
  acceptMarketingAction,
  executeMarketingTool,
  rejectMarketingAction,
} from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";
import { loadLandingPage } from "@/lib/marketing/persistence";
import { runMarketingAgentTurn } from "@/lib/marketing/agent/loop";
import type { MarketingAgentEvent } from "@/lib/marketing/agent/events";

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
  const email = `mkt-edit-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
  await supabase.from("courses").insert({ id: courseId, author_id: userId, title: "Calligraphy 101", description: "Beautiful letters by hand.", plan: { outcomes: ["Hold the pen", "Draw strokes"], prerequisites: [], teachingStyle: "patient" } as never });
  await supabase.from("marketing_campaign").insert({ id: campaignId, course_id: courseId, name: "Launch" });
  const services = createMarketingServices({ clock: fixedClock() });
  const ctx: MarketingToolContext = { supabase, courseId, campaignId, ownerId: userId, services, requestedBy: "user" };

  const gen = await executeMarketingTool("generate_landing_page", { title: null, ctaLabel: null }, ctx);
  const pageId = (gen.data as { pageId: string }).pageId;
  await acceptMarketingAction(supabase, gen.actionId!);
  const page0 = await loadLandingPage(supabase, pageId);
  console.log("# generated a landing page");

  // ── design tokens (set_page_design) ───────────────────────────────────
  console.log("\n# set_page_design — typed tokens, staged + reject restores");
  const themeBefore = JSON.stringify(page0?.theme ?? {});
  const d = await executeMarketingTool(
    "set_page_design",
    { pageId, colorTheme: "cool", typePairing: "modern", density: "airy", buttonStyle: "square" },
    ctx
  );
  check("set_page_design is staged", d.status === "staged");
  const afterDesign = await loadLandingPage(supabase, pageId);
  check("design tokens applied to the draft", afterDesign?.theme.colorTheme === "cool" && afterDesign?.theme.density === "airy");
  await rejectMarketingAction(supabase, d.actionId!);
  check("reject restores the theme byte-for-byte", JSON.stringify((await loadLandingPage(supabase, pageId))?.theme ?? {}) === themeBefore);

  // ── section variant (set_section_variant) ─────────────────────────────
  console.log("\n# set_section_variant — per-section layout");
  const hero = page0!.sections.find((s) => s.kind === "hero")!;
  const v = await executeMarketingTool("set_section_variant", { pageId, sectionId: hero.id, variant: "split" }, ctx);
  check("set_section_variant is staged", v.status === "staged");
  const afterVar = await loadLandingPage(supabase, pageId);
  check("hero variant set to split", (afterVar?.sections.find((s) => s.id === hero.id) as { variant?: string } | undefined)?.variant === "split");
  await acceptMarketingAction(supabase, v.actionId!);

  let rejectedBad = false;
  try {
    await executeMarketingTool("set_section_variant", { pageId, sectionId: hero.id, variant: "spinny" }, ctx);
  } catch {
    rejectedBad = true;
  }
  check("an invalid variant is rejected (typed enum guard)", rejectedBad);

  // ── content edit (update_landing_section) ─────────────────────────────
  console.log("\n# update_landing_section — content edit, reject restores");
  const heroNow = (await loadLandingPage(supabase, pageId))!.sections.find((s) => s.id === hero.id)!;
  const heroJson = JSON.stringify(heroNow);
  const edited = { ...heroNow, headline: "Write like an artist" } as typeof heroNow;
  const c = await executeMarketingTool("update_landing_section", { pageId, section: edited }, ctx);
  check("content edit is staged", c.status === "staged");
  await rejectMarketingAction(supabase, c.actionId!);
  check("reject restores the section byte-for-byte", JSON.stringify((await loadLandingPage(supabase, pageId))?.sections.find((s) => s.id === hero.id)) === heroJson);

  // ── agent path (mock model) drives a design edit ──────────────────────
  console.log("\n# agent edits the page via chat (mock model)");
  const ev: MarketingAgentEvent[] = [];
  const model = createMockModelClient(
    [{ text: "Switching to a cooler palette.", toolCalls: [{ name: "set_page_design", arguments: { pageId, colorTheme: "cool", typePairing: null, density: null, buttonStyle: null } }] }],
    { finalText: "Done — staged a cool palette for your review." }
  );
  await runMarketingAgentTurn({
    supabase, model, courseId, campaignId, ownerId: userId, userMessage: "make it cooler", services, emit: (e) => ev.push(e), pageId,
  });
  check("agent edit stages a reversible change", ev.some((e) => e.type === "tool_result" && e.status === "staged"));
  check("agent edit applied to the draft", (await loadLandingPage(supabase, pageId))?.theme.colorTheme === "cool");
  check("agent observation was page-scoped", (model.getCalls()[0]?.input?.[0] as { content?: string } | undefined)?.content?.includes("EDITING THIS PAGE") === true);

  await supabase.from("courses").delete().eq("id", courseId);
  console.log("\n# cleaned up");
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
