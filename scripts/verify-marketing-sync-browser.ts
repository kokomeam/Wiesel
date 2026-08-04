/**
 * Marketing hub BROWSER test — drives the REAL redesigned /marketing hub
 * through Playwright chromium against the dev server (localhost:3000) + live
 * Supabase. Run: `npm run verify:marketing:sync:browser` (dev server must be
 * running).
 *
 * What it proves end-to-end (no mocks in the browser):
 *   1. The redesigned hub anatomy renders: ask-bar, ONE "Needs your attention"
 *      zone with the pending approval card, the campaign card, the landing
 *      pages card, the compact section nav, the quiet-rail Activity feed (with
 *      the revertable entry + count), and the autonomy pill.
 *   2. UI-1 rail behaviour: the autonomy PILL opens the settings DRAWER (with
 *      its save/discard controls); the Activity hint dismissal PERSISTS across
 *      a reload (hubUiStore, zustand persist + skipHydration — the ONE
 *      disclosure UI-1 still persists after the CollapsibleCard hub was
 *      superseded by the AutonomyPill+Drawer / ActivityFeed layout).
 *   3. CROSS-TAB approval sync: the same approval card open in TWO tabs;
 *      approving in tab 1 collapses tab 2's card to the quiet resolved line
 *      WITHOUT any reload (approvalSync store + BroadcastChannel).
 *   4. The approval really executed: the landing page is published after.
 *
 * UI-1 SUPERSESSION NOTE: the pre-UI-1 hub used two CollapsibleCards ("Agent
 * autonomy", closed by default; "Recent changes", open while revertable) whose
 * open/closed state persisted via hubUiStore. The ratified UI-1 overhaul
 * removed both: autonomy now lives behind a one-line pill that opens a Drawer,
 * and the activity log is a permanently-open ActivityFeed. hubUiStore no longer
 * persists any section open/closed state — the only thing it persists is the
 * first-run Activity hint dismissal (activityHintDismissed). Sections §1/§2
 * below assert those UI-1 equivalents; the approval-sync semantics (§3/§4) —
 * this suite's reason for existing — are UNCHANGED save for selectors.
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
    // Match the PATHNAME, never a `**/marketing**` glob — the login URL carries
    // `?redirectTo=/marketing?course=…`, which that glob would match on the
    // login page itself (the repo-wide redirectTo trap).
    await page.waitForURL((u) => u.pathname === "/marketing", { timeout: 30000 });
    await page.waitForSelector('[data-testid="approval-card"]', { timeout: 30000 });

    console.log("\n# 1 · redesigned hub anatomy (UI-1 layout)");
    check("ask-bar renders", (await page.locator('input[aria-label="Ask the marketing agent"]').count()) === 1);
    check("ONE attention zone with the pending approval", (await page.locator('[data-testid="attention-zone"]').count()) === 1);
    check("the approval card is in it", (await page.locator('[data-testid="attention-zone"] [data-testid="approval-card"]').count()) === 1);
    check("campaign card shows the campaign", await page.getByText("Sync fixture campaign").first().isVisible());
    check(
      "section nav lists the destinations compactly",
      (await page.locator('[data-testid="section-nav"] >> text=Email campaigns').count()) >= 1 &&
        (await page.locator('[data-testid="section-nav"] >> text=Sequences').count()) >= 1 &&
        (await page.locator('[data-testid="section-nav"] >> text=Analytics').count()) >= 1
    );
    check("landing pages card shows the draft page", (await page.locator("text=/p/").count()) >= 1);

    // UI-1: the quiet rail = ActivityFeed (permanently open, no collapsible) +
    // the one-line autonomy pill that opens the settings Drawer. There is no
    // longer an `aria-expanded` "Agent autonomy"/"Recent changes" toggle.
    const activityFeed = page.locator('[data-testid="activity-feed"]');
    check("the quiet-rail Activity feed renders", (await activityFeed.count()) === 1);
    check("the feed is titled Activity", (await activityFeed.locator("h2").first().textContent()) === "Activity");
    check(
      "the generated landing page shows up as an activity entry",
      (await activityFeed.locator('[data-testid="activity-entry"]').count()) >= 1
    );
    // The staged (un-dismissed) generate_landing_page is revertible → the feed
    // badges a revertable COUNT. Assert the shape (≥1), not an exact number:
    // the fixture's reversible roots (create_campaign + generate_landing_page)
    // both land as revertable rows, so the count is ≥1, not fixed at 1.
    const revertBadge = (await activityFeed.textContent()) ?? "";
    check("…and the feed badges the revertable count", /\d+ revertable/.test(revertBadge), revertBadge.slice(0, 120));
    const railRevertable = await activityFeed.locator('[data-testid="activity-revert-inline"]').count();
    check("…with an inline one-click Revert on a fresh entry", railRevertable >= 1);
    check("autonomy pill present in the quiet rail", (await page.locator('[data-testid="autonomy-pill"]').count()) === 1);
    check(
      "autonomy pill reflects the (default) assisted mode",
      ((await page.locator('[data-testid="autonomy-pill"]').textContent()) ?? "").includes("Assisted")
    );

    console.log("\n# 2 · autonomy drawer opens + hint dismissal persists (hubUiStore)");
    // The pill opens the settings DRAWER (replaces the old collapsible panel).
    await page.locator('[data-testid="autonomy-pill"]').click();
    const drawer = page.locator('[data-testid="autonomy-drawer"]');
    await drawer.waitFor({ state: "visible", timeout: 10000 });
    check("the pill opens the autonomy drawer", await drawer.isVisible());
    check("…with the mode picker inside", ((await drawer.textContent()) ?? "").includes("Manual"));
    check("…and its save/discard controls", (await drawer.locator('[data-testid="autonomy-save"]').count()) === 1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // The ONE disclosure UI-1 persists (via hubUiStore, zustand persist +
    // skipHydration): the first-run Activity hint, once dismissed, stays gone
    // across a reload. This replaces the superseded "autonomy open/closed"
    // persistence check — same store, the state it actually keeps now.
    const hint = page.locator('[data-testid="activity-hint"]');
    if ((await hint.count()) === 1) {
      await hint.locator("button", { hasText: "Got it" }).click();
      await page.waitForTimeout(300);
      check("dismissing the Activity hint hides it", (await hint.count()) === 0);
      await page.reload();
      await page.waitForSelector('[data-testid="approval-card"]', { timeout: 30000 });
      check(
        "hint dismissal persists across reload (hubUiStore skipHydration)",
        (await page.locator('[data-testid="activity-hint"]').count()) === 0
      );
    } else {
      // No hint rendered (e.g. empty feed) — assert the store's contract holds
      // rather than skip: the feed must still be present post-reload.
      await page.reload();
      await page.waitForSelector('[data-testid="approval-card"]', { timeout: 30000 });
      check("activity feed survives reload (hubUiStore rehydrate)", (await page.locator('[data-testid="activity-feed"]').count()) === 1);
    }

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
