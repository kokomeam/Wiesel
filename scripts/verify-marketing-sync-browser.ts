/**
 * Marketing hub BROWSER test — drives the REAL redesigned /marketing hub
 * through Playwright chromium against the dev server (localhost:3000) + live
 * Supabase. Run: `npm run verify:marketing:sync:browser` (dev server must be
 * running).
 *
 * What it proves end-to-end (no mocks in the browser):
 *   1. The redesigned hub anatomy renders: ask-bar, ONE "Needs your attention"
 *      zone with the pending approval card, the campaign card, the landing
 *      pages card, the compact Explore nav, and the two collapsibles.
 *   2. Disclosure persists: toggling "Agent autonomy" open survives a reload
 *      (hubUiStore, zustand persist + skipHydration).
 *   3. CROSS-TAB approval sync: the same approval card open in TWO tabs;
 *      approving in tab 1 collapses tab 2's card to the quiet resolved line
 *      WITHOUT any reload (approvalSync store + BroadcastChannel).
 *   4. The approval really executed: the landing page is published after.
 */

import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { acceptMarketingAction, executeMarketingTool } from "@/lib/marketing/tools";
import type { MarketingToolContext } from "@/lib/marketing/tools/types";

const BASE = process.env.MARKETING_BROWSER_BASE ?? "http://localhost:3000";

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
  if (!url || !anon) throw new Error("Missing Supabase env");
  const ping = await fetch(BASE).catch(() => null);
  if (!ping || !ping.ok) throw new Error(`No dev server at ${BASE} — run npm run dev first`);

  /* ── provision a fresh creator + fixture (course → campaign → page → pending publish) ── */
  const email = `mkt-sync-btest-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const supabase = createClient<Database>(url, anon);
  const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
  if (authErr || !auth.user) throw new Error(`signin failed: ${authErr?.message}`);
  const userId = auth.user.id;
  console.log(`# provisioned ${email}`);

  const courseId = crypto.randomUUID();
  const { error: courseErr } = await supabase.from("courses").insert({
    id: courseId,
    author_id: userId,
    title: "Sync Browser Fixture Course",
    description: "Fixture for the hub sync browser test.",
    audience: "beginners",
    level: "beginner",
    price_cents: 1900,
    plan: { outcomes: ["one outcome"], prerequisites: [] } as never,
  });
  if (courseErr) throw new Error(`course insert: ${courseErr.message}`);

  const ctx = (campaignId: string | null): MarketingToolContext => ({
    supabase,
    courseId,
    campaignId,
    ownerId: userId,
    services: createMarketingServices(),
    requestedBy: "user",
  });

  const created = await executeMarketingTool("create_campaign", { name: "Sync fixture campaign", goal: null }, ctx(null));
  if (created.actionId) await acceptMarketingAction(supabase, created.actionId);
  const campaignId = (created.data as { campaignId: string }).campaignId;

  // Staged (left un-dismissed → a REVERTABLE "Recent changes" entry).
  const gen = await executeMarketingTool("generate_landing_page", { title: null, ctaLabel: null }, ctx(campaignId));
  const pageId = ((gen.data as { pageId?: string })?.pageId ?? (gen.target?.id as string))!;

  // The pending approval (assisted default mode → publish always cards).
  const pub = await executeMarketingTool("publish_landing_page", { pageId }, ctx(campaignId));
  if (pub.status !== "pending_approval") throw new Error(`expected pending publish, got ${pub.status}`);
  console.log(`# fixture ready — pending action ${pub.actionId}`);

  /* ─────────────────────────── the browser run ─────────────────────────── */
  const browser = await chromium.launch();
  const bctx = await browser.newContext();
  try {
    const page = await bctx.newPage();
    await page.goto(`${BASE}/login?redirectTo=${encodeURIComponent(`/marketing?course=${courseId}`)}`);
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/marketing**", { timeout: 30000 });
    await page.waitForSelector('[data-testid="approval-card"]', { timeout: 30000 });

    console.log("\n# 1 · redesigned hub anatomy");
    check("ask-bar renders", (await page.locator('input[aria-label="Ask the marketing agent"]').count()) === 1);
    check("ONE attention zone with the pending approval", (await page.locator('[data-testid="attention-zone"]').count()) === 1);
    check("the approval card is in it", (await page.locator('[data-testid="attention-zone"] [data-testid="approval-card"]').count()) === 1);
    check("campaign card shows the campaign", await page.getByText("Sync fixture campaign").first().isVisible());
    check(
      "Explore nav lists the six destinations compactly",
      (await page.locator("nav >> text=Email campaigns").count()) >= 1 &&
        (await page.locator("nav >> text=Sequences").count()) >= 1 &&
        (await page.locator("nav >> text=Analytics").count()) >= 1
    );
    check("landing pages card shows the draft page", (await page.locator("text=/p/").count()) >= 1);
    const autonomyToggle = page.locator('button[aria-expanded]', { hasText: "Agent autonomy" });
    check("Agent autonomy is a collapsible, CLOSED by default", (await autonomyToggle.getAttribute("aria-expanded")) === "false");
    const activityToggle = page.locator('button[aria-expanded]', { hasText: "Recent changes" });
    check(
      "Recent changes is OPEN by default while something is revertable",
      (await activityToggle.getAttribute("aria-expanded")) === "true"
    );
    check("…and badges the revertable count", await page.getByText("1 revertable").isVisible());

    console.log("\n# 2 · disclosure persists across reload (hubUiStore)");
    await autonomyToggle.click();
    check("toggling opens the autonomy panel", (await autonomyToggle.getAttribute("aria-expanded")) === "true");
    check("…revealing the mode picker", await page.getByText("Manual", { exact: true }).isVisible());
    await page.reload();
    await page.waitForSelector('[data-testid="approval-card"]', { timeout: 30000 });
    const autonomyToggle2 = page.locator('button[aria-expanded]', { hasText: "Agent autonomy" });
    check("autonomy stays OPEN after reload (persisted)", (await autonomyToggle2.getAttribute("aria-expanded")) === "true");

    console.log("\n# 3 · CROSS-TAB approval sync (approvalSync + BroadcastChannel)");
    const page2 = await bctx.newPage();
    await page2.goto(`${BASE}/marketing?course=${courseId}`);
    await page2.waitForSelector('[data-testid="approval-card"]', { timeout: 30000 });
    check("tab 2 renders the SAME pending approval", (await page2.locator('[data-testid="approval-card"]').count()) === 1);

    await page.getByRole("button", { name: /Approve &/ }).first().click();
    // Tab 1 collapses via its own resolution; tab 2 must collapse via the
    // broadcast — with NO reload/navigation on tab 2.
    await page2.waitForSelector('[data-testid="approval-card"]', { state: "detached", timeout: 15000 });
    check("tab 2's card collapsed WITHOUT a reload", (await page2.locator('[data-testid="approval-card"]').count()) === 0);
    check("tab 2 shows the quiet resolved line", await page2.getByText(/Approved —/).first().isVisible());
    check("tab 1 collapsed too", (await page.locator('[data-testid="approval-card"]').count()) === 0);

    console.log("\n# 4 · the approval really executed");
    const { data: pageRow } = await supabase.from("landing_page").select("status").eq("id", pageId).single();
    check("landing page is PUBLISHED in the DB", pageRow?.status === "published");
    await page.reload();
    await page.waitForSelector("text=published", { timeout: 30000 });
    check("hub shows the published badge after refresh", await page.getByText("published", { exact: true }).first().isVisible());
    check("attention zone is gone (nothing pending)", (await page.locator('[data-testid="attention-zone"]').count()) === 0);
  } finally {
    await browser.close();
    await supabase.from("courses").delete().eq("id", courseId);
    console.log("\n# cleaned up course");
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
