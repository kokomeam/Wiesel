/**
 * verify-ui-browser — UI-1 Waves 1–4 browser suite (Playwright vs a running
 * prod server; temp `playwright` install, like the other *-browser suites).
 *
 * Self-provisions a throwaway creator + seeds a defect-reproducing state,
 * then asserts (sections named for the AC ledger):
 *   layout.test      [AC-W2.1] no horizontal overflow at 1440/1024/768/390;
 *                    responsive shell (icon rail <xl, hamburger <md)
 *   nav.test         [AC-W2.2] grouped strip ≤88px, every destination 1 click
 *   overview.test    [AC-W2.3] stat tiles from loaded data
 *   rail.test        [AC-W2.4] rail = Activity + autonomy pill
 *   fab.test         [AC-W2.5] zero FAB/click-target intersection; FAB
 *                    vacates while a drawer is open
 *   activity.test    [AC-W3.1/2/4/5/6/7/8] anatomy, hint, popover, day
 *                    groups, show-all, revert states, fallback + D-16,
 *                    render-time translation, origin-resolved links
 *   drawer.test      [AC-W4.1..W4.6] segmented modes, compare popover,
 *                    grouped toggles, locked group, guardrail fields +
 *                    validation, dirty→save→pill, discard guard, conflict
 *   humanize.test    [AC-W1.4/D-6] no raw tool identifiers anywhere
 *
 * Prereq: prod server on SCREENSHOT_BASE_URL (default :3100).
 * Run: npm run verify:ui:browser
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright";
import { MUTATING_TOOL_NAMES } from "../lib/marketing/humanize";

dns.setDefaultResultOrder("ipv4first");

const ROOT = new URL("..", import.meta.url).pathname;
const BASE = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3100";
const OUT = `${ROOT}screenshots/ui1/after-w4`;

/** DEV-4 (approved): the marketing-route JS budget the checkpoint tracks —
 *  decoded bytes on an authenticated cold load, prefetch noise included
 *  (~±10%); headroom over the W4 worst observation (542 KB). Raise it only
 *  with a checkpoint note. */
const MARKETING_JS_BUDGET_KB = 620;

const AXE_SOURCE = readFileSync(`${ROOT}node_modules/axe-core/axe.min.js`, "utf8");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function loadEnv() {
  const raw = readFileSync(`${ROOT}.env.local`, "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

type Box = { x: number; y: number; width: number; height: number };
const intersect = (a: Box | null, b: Box | null) => {
  if (!a || !b) return 0;
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? Math.round(w * h) : 0;
};

/** [AC-W5.2] axe-core scan — zero serious/critical violations. */
async function axeScan(page: Page, label: string) {
  // Let entrance animations settle: axe reads COMPOSITED colors, and a
  // mid-fade drawer fails contrast on everything behind it.
  await page.waitForTimeout(500);
  await page.addScriptTag({ content: AXE_SOURCE });
  const res = (await page.evaluate(
    // @ts-expect-error axe is injected above
    async () => await window.axe.run(document, { resultTypes: ["violations"] })
  )) as { violations: { id: string; impact: string | null; nodes: unknown[] }[] };
  const serious = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  check(
    `axe ${label}: zero serious/critical violations`,
    serious.length === 0,
    serious.map((v) => `${v.id}(${v.nodes.length})`).join(", ")
  );
}

/** [AC-W5.4] no interactive element extends past the viewport (the sub-lg
 *  nav strip scrolls by design; the closed agent dock rides off-canvas
 *  inert). */
async function clippedInteractive(page: Page, navScrolls: boolean): Promise<string[]> {
  return page.evaluate((allowNavScroll: boolean) => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("a, button, input, select, textarea"));
    return els
      .filter((el) => {
        if (el.offsetParent === null) return false;
        if (el.closest("[inert]")) return false;
        if (allowNavScroll && el.closest('[data-testid="section-nav"]')) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return r.right > window.innerWidth + 1 || r.left < -1;
      })
      .map((el) => (el.textContent ?? el.getAttribute("aria-label") ?? "?").trim().slice(0, 40));
  }, navScrolls);
}

async function overflow(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const doc = document.scrollingElement!;
    return {
      mainScrollW: main?.scrollWidth ?? 0,
      mainClientW: main?.clientWidth ?? 0,
      docScrollW: doc.scrollWidth,
      winW: window.innerWidth,
    };
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("missing supabase env");

  // ── throwaway creator + seeded state ────────────────────────────────────
  const email = `ui1-w4-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "test-password-1234";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup: ${await signup.text()}`);
  const supabase = createClient(url, anon);
  const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
  if (authErr || !auth.user) throw new Error(`signin: ${authErr?.message}`);
  const uid = auth.user.id;

  const courseId = crypto.randomUUID();
  const campaignId = crypto.randomUUID();
  const sfx = crypto.randomUUID().slice(0, 6);
  {
    const { error } = await supabase.from("courses").insert({
      id: courseId,
      author_id: uid,
      title: "Data Structures Interview Prep",
      description: "From Big-O intuition to whiteboard-ready implementations.",
      audience: "cs students",
      level: "intermediate",
      price_cents: 4900,
      plan: { outcomes: ["Reason about complexity"], prerequisites: [], teachingStyle: "friendly" } as never,
    });
    if (error) throw new Error(`course: ${error.message}`);
  }
  {
    const { error } = await supabase.from("marketing_campaign").insert({
      id: campaignId,
      course_id: courseId,
      name: "Launch: Data Structures Interview Prep",
      goal: "launch_course",
      status: "active",
      config: { blueprintKey: "launch_course" } as never,
    });
    if (error) throw new Error(`campaign: ${error.message}`);
  }
  {
    const { error } = await supabase.from("landing_page").insert([
      {
        campaign_id: campaignId,
        course_id: courseId,
        slug: `dsip-${sfx}`,
        title: "Data Structures Interview Prep",
        status: "published",
        sections: [{ t: "hero" }, { t: "pricing" }] as never,
        theme: {} as never,
        published_at: new Date().toISOString(),
      },
      {
        campaign_id: campaignId,
        course_id: courseId,
        slug: `big-o-${sfx}`,
        title: "Big-O Crash Course (free preview)",
        status: "draft",
        sections: [{ t: "hero" }] as never,
        theme: {} as never,
        published_at: null,
      },
    ]);
    if (error) throw new Error(`pages: ${error.message}`);
  }
  // Assisted + 4 remembered opt-ins: the W4 flow switches to Auto and saves.
  {
    const { error } = await supabase.from("marketing_autonomy_settings").insert({
      course_id: courseId,
      mode: "assisted",
      policy: {
        autoApproveTools: ["publish_landing_page", "send_test_email", "retry_publish", "cancel_scheduled_publish"],
        maxRecipients: 25,
        maxBudgetCents: null,
        allowedHours: { startHour: 9, endHour: 17, timezone: "America/Los_Angeles" },
        firstSendToNewSegmentManual: true,
      } as never,
      revert_window_hours: 24,
    });
    if (error) throw new Error(`autonomy: ${error.message}`);
  }

  const now = Date.now();
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const plusH = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3_600_000).toISOString();
  const base = {
    course_id: courseId,
    campaign_id: null as string | null,
    before_snapshot: null,
    target_ref: null,
    resolved_at: null,
    conversation_id: null,
    autonomy_decision: null as unknown,
    summary_fields: null as unknown,
    params: {} as unknown,
  };
  const rows = [
    {
      ...base,
      created_at: at(5),
      tool_name: "select_clip_moments",
      action_kind: "select_clip_moments",
      reversibility: "reversible",
      status: "auto_approved",
      requested_by: "agent",
      revert_expires_at: plusH(at(5), 24),
      summary_fields: { v: 1, count: 3, dropped: 1, entity: "Big O only gives an upper limit", outcome: "done" },
      summary: `Found 3 moment(s) worth clipping in this lesson (transcript: platform). 1 candidate(s) were dropped by validation (hook references a slide outside the clip window).`,
    },
    {
      ...base,
      created_at: at(10),
      tool_name: "generate_lesson_clips",
      action_kind: "generate_lesson_clips",
      reversibility: "reversible",
      status: "auto_approved",
      requested_by: "agent",
      revert_expires_at: plusH(at(10), 24),
      summary_fields: {
        v: 1,
        entity: "Big O only gives an upper limit — that's not what your interviewer means",
        layout: "Face track",
        preset: "tofu_hook",
        outcome: "queued",
        note: "It renders in the background over the next few minutes.",
      },
      summary: `Render queued for "Big O only gives an upper limit" — Face track, preset tofu_hook.`,
    },
    {
      ...base,
      created_at: at(15),
      tool_name: "generate_posting_kit",
      action_kind: "generate_posting_kit",
      reversibility: "reversible",
      status: "auto_approved",
      requested_by: "agent",
      revert_expires_at: plusH(at(15), 24),
      summary_fields: { v: 1, platform: "instagram", keyword: "THETA", shortCode: "theta", outcome: "ready" },
      summary: `Posting kit ready (Instagram Reels): comment keyword "THETA", short link /l/theta.`,
    },
    {
      // LEGACY prose-only row (pre-summary_fields history): generic template
      // collapsed; the stored prose (with its baked localhost link) appears
      // ONLY in the expanded detail.
      ...base,
      created_at: at(45),
      tool_name: "generate_posting_kit",
      action_kind: "generate_posting_kit",
      reversibility: "reversible",
      status: "auto_approved",
      requested_by: "agent",
      revert_expires_at: plusH(at(45), 24),
      summary: `Posting kit ready (Instagram Reels): comment keyword "THETA", short link /l/theta. Copy the full text below and post it MANUALLY.\n\nhttp://localhost:3000/l/theta`,
    },
    {
      // D-14 + D-16: card-routed (guardrails failed), later human-approved.
      ...base,
      created_at: at(120),
      tool_name: "send_broadcast",
      action_kind: "send_broadcast",
      reversibility: "irreversible",
      status: "executed",
      requested_by: "agent",
      revert_expires_at: null,
      summary_fields: { v: 1, entity: "One week left", count: 4 },
      autonomy_decision: {
        route: "pending_approval",
        mode: "auto",
        guardrails: [
          { name: "tool_allowlist", status: "fail", detail: "send_broadcast is not opted into auto-approval" },
          { name: "recipient_cap", status: "fail", detail: "no recipient cap configured (audience 4)" },
        ],
        reason: "Auto mode fell back to approval: send_broadcast is not opted into auto-approval; no recipient cap configured (audience 4).",
      },
      summary: `Broadcast "One week left" sent to 4 subscriber(s).`,
    },
    {
      // True policy execution (owner test email).
      ...base,
      created_at: at(180),
      tool_name: "send_test_email",
      action_kind: "send_test_email",
      reversibility: "irreversible",
      status: "executed",
      requested_by: "agent",
      revert_expires_at: null,
      summary_fields: { v: 1, outcome: "sent" },
      autonomy_decision: {
        route: "auto_execute",
        mode: "auto",
        guardrails: [],
        reason: "Test email to your own address — sent and logged, no approval needed.",
      },
      summary: `Test email for step 1 sent to your own address.`,
    },
    {
      // Near-expiry revert window (~30m left) — created 25h ago so its day
      // label is ALWAYS "Yesterday" regardless of wall-clock time.
      ...base,
      created_at: at(25 * 60),
      tool_name: "build_audience_list",
      action_kind: "build_audience_list",
      reversibility: "reversible",
      status: "auto_approved",
      requested_by: "user",
      revert_expires_at: plusH(at(25 * 60), 25.5),
      summary_fields: { v: 1, entity: "Confirmed subscribers", count: 4, outcome: "done" },
      summary: `Created list "Confirmed subscribers" with 4 contact(s).`,
    },
    {
      // Expired window — no revert control at all (never a disabled one).
      ...base,
      created_at: at(26 * 60),
      tool_name: "import_leads",
      action_kind: "import_leads",
      reversibility: "reversible",
      status: "auto_approved",
      requested_by: "user",
      revert_expires_at: plusH(at(26 * 60), 24),
      summary_fields: { v: 1, count: 4, outcome: "done" },
      summary: `Imported 4 contact(s).`,
    },
    // Bulk history for the load test (W3.6): ~95 more rows, 2–5 days old.
    ...Array.from({ length: 95 }, (_, i) => ({
      ...base,
      created_at: at(2 * 24 * 60 + i * 37),
      tool_name: "build_audience_list",
      action_kind: "build_audience_list",
      reversibility: "reversible",
      status: "auto_approved",
      requested_by: "agent" as const,
      revert_expires_at: plusH(at(2 * 24 * 60 + i * 37), 24),
      summary_fields: { v: 1, entity: `Cohort ${i + 1}`, count: i + 1, outcome: "done" },
      summary: `Created list "Cohort ${i + 1}".`,
    })),
  ];
  {
    const { error } = await supabase.from("marketing_action").insert(rows as never);
    if (error) throw new Error(`actions: ${error.message}`);
  }

  // ── browser ─────────────────────────────────────────────────────────────
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });

  await page.goto(`${BASE}/login`, { timeout: 60000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|studio|marketing/, { timeout: 30000 }).catch(() => {});

  const gotoHub = async () => {
    await page.goto(`${BASE}/marketing`, { timeout: 60000 });
    await page.waitForSelector("text=Marketing Assistant", { timeout: 30000 });
    await page.waitForTimeout(500);
  };
  await gotoHub();

  console.log("\n## nav.test [AC-W2.2]");
  const nav = page.locator('[data-testid="section-nav"]');
  check("section nav renders", (await nav.count()) === 1);
  const navBox = await nav.boundingBox();
  check(`nav height ≤ 88px at 1440 (got ${navBox?.height})`, (navBox?.height ?? 999) <= 88);
  const DESTS = [
    "/marketing/leads",
    "/marketing/audience",
    "/marketing/email",
    "/marketing/sequences",
    "/marketing/social",
    "/marketing/clips",
    "/marketing/accounts",
    "/marketing/publish",
    "/marketing/analytics",
  ];
  for (const d of DESTS) {
    const link = page.locator(`[data-testid="section-nav"] a[href="${d}?course=${courseId}"]`);
    check(`destination 1 click from hub: ${d}`, (await link.count()) === 1);
  }
  check("Explore rail card is gone", (await page.getByText("Explore", { exact: true }).count()) === 0);

  console.log("\n## overview.test [AC-W2.3]");
  check("stat strip renders", (await page.locator('[data-testid="hub-stats"]').count()) === 1);
  for (const t of ["stat-campaign", "stat-review", "stat-revertable", "stat-pages"]) {
    check(`tile ${t}`, (await page.locator(`[data-testid="${t}"]`).count()) === 1);
  }
  check("pages tile shows 1/2", (await page.locator('[data-testid="stat-pages"]').textContent())?.includes("1/2") === true);

  console.log("\n## rail.test [AC-W2.4]");
  check("Activity feed is the rail's first resident", (await page.locator('[data-testid="activity-feed"]').count()) === 1);
  check("feed is titled Activity", (await page.locator('[data-testid="activity-feed"] h2').first().textContent()) === "Activity");
  check("autonomy pill present", (await page.locator('[data-testid="autonomy-pill"]').count()) === 1);
  check(
    "pill reflects assisted mode",
    (await page.locator('[data-testid="autonomy-pill"]').textContent())?.includes("Assisted — asks before anything outward") === true
  );

  console.log("\n## activity.test [AC-W3.1] — hint + popover, no standing copy");
  const feed = page.locator('[data-testid="activity-feed"]');
  check("first-run hint renders", (await page.locator('[data-testid="activity-hint"]').count()) === 1);
  await page.locator('[data-testid="activity-hint"] button', { hasText: "Got it" }).click();
  await page.waitForTimeout(300);
  check("hint dismisses", (await page.locator('[data-testid="activity-hint"]').count()) === 0);
  await page.reload();
  await page.waitForSelector('[data-testid="activity-feed"]', { timeout: 30000 });
  check("hint dismissal persists across reload", (await page.locator('[data-testid="activity-hint"]').count()) === 0);
  const feedText = (await feed.textContent()) ?? "";
  check("card body has zero standing explainer copy", !feedText.includes("apply automatically"));
  await feed.locator('button[aria-label="About this section"]').click();
  const note = feed.locator('[role="note"]');
  check("info popover explains the revert window", ((await note.textContent()) ?? "").includes("revert"));
  await page.keyboard.press("Escape");

  console.log("\n## activity.test [AC-W3.2/W3.3] — anatomy + deterministic lines");
  const lines = page.locator('[data-testid="activity-line"]');
  check("collapsed entries render", (await lines.count()) >= 7);
  const firstLine = (await lines.first().textContent()) ?? "";
  check(
    'template line: "Found 3 clip moments · 1 dropped"',
    firstLine === "Found 3 clip moments · 1 dropped",
    firstLine
  );
  const kitLine = (await lines.nth(2).textContent()) ?? "";
  check('template line: kit ready with keyword', kitLine === "Posting kit ready — Instagram Reels · keyword “THETA”", kitLine);
  const lineH = await lines.first().evaluate((el) => el.getBoundingClientRect().height);
  check(`collapsed line is single-line at rail width (h=${Math.round(lineH)})`, lineH <= 24);
  const collapsedFeed = (await feed.textContent()) ?? "";
  check("no internal codes collapsed (tofu/transcript/localhost)", !/tofu|mofu|bofu|transcript:|localhost:3000/.test(collapsedFeed), collapsedFeed.slice(0, 200));
  check("day dividers: Today", collapsedFeed.includes("Today"));
  check("day dividers: Yesterday", collapsedFeed.includes("Yesterday"));

  console.log("\n## activity.test [AC-W3.4] — detail translation + origin links");
  await lines.nth(1).click(); // clip render row
  const detail1 = page.locator('[data-testid="activity-detail"]');
  await detail1.waitFor({ state: "visible", timeout: 5000 });
  const d1 = (await detail1.textContent()) ?? "";
  check("detail shows translated preset (Style Hook, never tofu_hook)", d1.includes("Hook") && !d1.includes("tofu"), d1.slice(0, 150));
  await lines.nth(1).click();
  await lines.nth(2).click(); // kit row (fields)
  const d2 = (await page.locator('[data-testid="activity-detail"]').textContent()) ?? "";
  check("short link resolves against the CURRENT origin, not the baked URL", d2.includes("localhost:3100/l/theta") && !d2.includes("localhost:3000"), d2.slice(0, 200));
  await lines.nth(2).click();
  await lines.nth(3).click(); // legacy prose row
  const d3 = (await page.locator('[data-testid="activity-detail"]').textContent()) ?? "";
  check("legacy row keeps its stored prose in DETAIL only (historical)", d3.includes("localhost:3000/l/theta"));
  await lines.nth(3).click();

  console.log("\n## activity.test [AC-W3.7 + D-16] — humanized policy routing");
  const broadcastRow = page.locator('[data-testid="activity-entry"]', { hasText: "Broadcast to 4 subscribers" });
  check("approved-by-you chip (never auto · policy)", ((await broadcastRow.textContent()) ?? "").includes("Approved by you"));
  check("no 'auto · policy' badge anywhere", !((await feed.textContent()) ?? "").includes("auto · policy"));
  await broadcastRow.locator('[data-testid="activity-line"]').click();
  const bd = (await broadcastRow.locator('[data-testid="activity-detail"]').textContent()) ?? "";
  check("guardrails in creator language", bd.includes("You haven't opted this action into auto-approval."), bd.slice(0, 200));
  check("debug detail string gone", !bd.includes("(audience 4)"));
  check("states the creator approved it", bd.includes("You approved it."));
  await broadcastRow.getByText("Change autonomy settings").click();
  const drawer = page.locator('[data-testid="autonomy-drawer"]');
  await drawer.waitFor({ state: "visible", timeout: 5000 });
  check("feed link opens the autonomy drawer [W3.7]", await drawer.isVisible());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const testEmailRow = page.locator('[data-testid="activity-entry"]', { hasText: "Test email to your own address" });
  await testEmailRow.locator('[data-testid="activity-line"]').click();
  const td = (await testEmailRow.locator('[data-testid="activity-detail"]').textContent()) ?? "";
  check("true policy execution says so", td.includes("Ran on its own under your auto policy"));
  await testEmailRow.locator('[data-testid="activity-line"]').click();

  console.log("\n## activity.test [AC-W3.5] — revert states");
  const fresh = page.locator('[data-testid="activity-entry"]', { hasText: "Found 3 clip moments" });
  const freshRevert = fresh.locator('[data-testid="activity-revert-inline"]');
  check("fresh row: inline one-click revert with window", (await freshRevert.getAttribute("aria-label"))?.match(/Revert · \d+h left/) != null);
  const nearRow = page.locator('[data-testid="activity-entry"]', { hasText: "List “Confirmed subscribers”" }).first();
  const nearLabel = await nearRow.locator('[data-testid="activity-revert-inline"]').getAttribute("aria-label");
  check(`near-expiry row shows minutes (${nearLabel})`, /Revert · \d+m left/.test(nearLabel ?? ""));
  console.log("\n## activity.test [AC-W3.6] — default N + show-all under load");
  check("default shows 7 entries", (await page.locator('[data-testid="activity-entry"]').count()) === 7);
  check(
    "the 8th (expired) row is beyond the default window",
    (await page.locator('[data-testid="activity-entry"]', { hasText: "Imported 4 contacts" }).count()) === 0
  );
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) {
    const btn = page.locator('[data-testid="activity-show-all"]');
    if ((await btn.count()) === 0) break;
    await btn.click();
    await page.waitForTimeout(100);
  }
  const shownAll = await page.locator('[data-testid="activity-entry"]').count();
  const loadMs = Date.now() - t0;
  check(`show-all renders the full 100+ history (${shownAll} entries in ${loadMs}ms)`, shownAll >= 100 && loadMs < 8000);
  const oAll = await overflow(page);
  check("full feed: no horizontal overflow", oAll.mainScrollW <= oAll.mainClientW + 1);

  // [AC-W3.5] expired state — the row exists once expanded into history.
  const expiredRow = page.locator('[data-testid="activity-entry"]', { hasText: "Imported 4 contacts" });
  check("expired row visible after show-all", (await expiredRow.count()) === 1);
  check("expired row: NO revert control at all", (await expiredRow.locator('[data-testid="activity-revert-inline"]').count()) === 0);
  await expiredRow.locator('[data-testid="activity-line"]').click();
  const ed = (await expiredRow.locator('[data-testid="activity-detail"]').textContent()) ?? "";
  check("expired detail: Dismiss only, no disabled Revert", ed.includes("Dismiss") && !ed.includes("Revert"));
  await expiredRow.locator('[data-testid="activity-line"]').click();
  await page.screenshot({ path: `${OUT}/w4-02-activity-full-1440.png`, fullPage: false });
  await gotoHub();

  console.log("\n## drawer.test [AC-W4.1/W4.2] — container + modes");
  await page.locator('[data-testid="autonomy-pill"]').click();
  await drawer.waitFor({ state: "visible", timeout: 5000 });
  check("drawer is a dialog", (await drawer.getAttribute("role")) === "dialog");
  check("FAB vacates while drawer open [AC-W2.5]", (await page.locator('[data-testid="agent-dock-fab"]').count()) === 0);
  await axeScan(page, "autonomy drawer open");
  const radios = drawer.locator('[role="radio"]');
  check("mode segmented control: 3 radios", (await radios.count()) === 3);
  check("assisted selected with whole Recommended chip", ((await radios.nth(1).textContent()) ?? "").includes("Recommended"));
  check("one description line for the selected mode", ((await drawer.locator('[data-testid="mode-description"]').textContent()) ?? "").includes("Approval cards for everything outward"));
  check("no consequence line while mode unchanged", (await drawer.locator('[data-testid="mode-consequence"]').count()) === 0);
  await drawer.locator('[data-testid="compare-modes"]').click();
  const cmp = (await drawer.locator('[role="note"]').textContent()) ?? "";
  check("compare popover: 3 columns, one line per row", cmp.includes("Manual") && cmp.includes("Assisted") && cmp.includes("Auto") && cmp.includes("Outward actions"));
  await drawer.locator('[data-testid="compare-modes"]').click();
  check("opt-in hint outside auto mode", (await drawer.locator('[data-testid="optin-hint"]').count()) === 1);

  console.log("\n## humanize.test [AC-W1.4/D-6] + [AC-W4.3] locked group");
  const drawerText0 = (await drawer.textContent()) ?? "";
  const rawIdsShown = MUTATING_TOOL_NAMES.filter((n) => drawerText0.includes(n));
  check("no raw tool identifiers in the autonomy surface", rawIdsShown.length === 0, rawIdsShown.join(", "));
  check("locked group: 6 rows, consistent annotation", ((await drawer.locator('[data-testid="hard-locked-list"]').textContent()) ?? "").split("Always requires your approval").length === 7);
  for (const label of ["Take down a social post", "Bulk consent confirmations", "Launch a campaign"]) {
    check(`hard-locked label: ${label}`, drawerText0.includes(label));
  }
  check("no dashes-in-prose annotation", !drawerText0.includes("— always needs you"));

  console.log("\n## drawer.test [AC-W4.6] — consequence + toggles");
  await radios.nth(2).click(); // Auto
  await page.waitForTimeout(200);
  const consequence = (await drawer.locator('[data-testid="mode-consequence"]').textContent()) ?? "";
  check("consequence computed from actual settings (4 opted-in)", consequence.includes("4 opted-in actions") && consequence.includes("Social publishing always asks."), consequence);
  check("grouped toggle rows appear in auto", (await drawer.locator('[data-testid="toggle-publish_landing_page"]').count()) === 1);
  check("toggles reflect saved policy", (await drawer.locator('[data-testid="toggle-retry_publish"]').getAttribute("aria-checked")) === "true");
  await drawer.locator('[data-testid="toggle-send_broadcast"]').click();
  check("dirty state enables save", (await drawer.locator('[data-testid="autonomy-save"]').isEnabled()) === true);
  check("save bar notes unsaved changes", ((await drawer.locator('[data-testid="autonomy-save-bar"]').textContent()) ?? "").includes("You have unsaved changes"));

  console.log("\n## drawer.test [AC-W4.4] — guardrail fields + validation");
  check("timezone select constrained to drawer", ((await drawer.locator('[data-testid="timezone-select"]').boundingBox())?.width ?? 9999) <= 460);
  const revertInput = drawer.locator("#autonomy-revert-window");
  await revertInput.fill("0");
  await page.waitForTimeout(200);
  check("revert-window validation shows", ((await drawer.textContent()) ?? "").includes("Between 1 and 720 hours."));
  check("invalid form disables save", (await drawer.locator('[data-testid="autonomy-save"]').isEnabled()) === false);
  await revertInput.fill("24");
  await page.waitForTimeout(200);

  console.log("\n## drawer.test [AC-W4.5] — save → toast → pill");
  await drawer.locator('[data-testid="autonomy-save"]').click();
  await page.waitForSelector("text=Autonomy settings saved", { timeout: 15000 });
  check("success toast: Autonomy settings saved", true);
  // router.refresh() re-runs the whole hub loader — poll for the refreshed
  // pill instead of guessing a delay (the drawer stays open via its store).
  const pillUpdated = await page
    .waitForFunction(
      () =>
        document
          .querySelector('[data-testid="autonomy-pill"]')
          ?.textContent?.includes("Auto — 5 actions opted in") ?? false,
      undefined,
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);
  check(
    "pill updates after save (Auto — 5 actions opted in)",
    pillUpdated,
    (await page.locator('[data-testid="autonomy-pill"]').textContent()) ?? ""
  );
  check("save bar settles", ((await drawer.locator('[data-testid="autonomy-save-bar"]').textContent()) ?? "").includes("Everything saved"));

  console.log("\n## drawer.test [AC-W4.5] — conflict path (guarded save)");
  await drawer.locator('[data-testid="toggle-unpublish_landing_page"]').waitFor({ state: "visible", timeout: 10000 });
  await drawer.locator('[data-testid="toggle-unpublish_landing_page"]').click(); // dirty
  // A concurrent writer bumps the row (trigger updates updated_at).
  {
    const { error } = await supabase
      .from("marketing_autonomy_settings")
      .update({ revert_window_hours: 48 })
      .eq("course_id", courseId);
    if (error) throw new Error(`concurrent bump: ${error.message}`);
  }
  await drawer.locator('[data-testid="autonomy-save"]').click();
  await page.waitForSelector("text=your view was refreshed", { timeout: 15000 });
  check("conflict → re-read, re-apply once, inform (view refreshed)", true);
  // Let the post-save refresh land (remount would reset a mid-flight toggle).
  await page
    .waitForFunction(
      () =>
        document
          .querySelector('[data-testid="autonomy-pill"]')
          ?.textContent?.includes("Auto — 6 actions opted in") ?? false,
      undefined,
      { timeout: 20000 }
    )
    .catch(() => {});

  console.log("\n## drawer.test [AC-W4.5] — discard guard");
  await drawer.locator('[data-testid="toggle-send_consent_confirmation"]').click(); // dirty again
  await page.keyboard.press("Escape");
  const discardDialog = page.locator('[role="alertdialog"]');
  await discardDialog.waitFor({ state: "visible", timeout: 5000 });
  check("close-with-dirty asks to discard", ((await discardDialog.textContent()) ?? "").includes("Discard unsaved changes?"));
  await discardDialog.getByText("Keep editing").click();
  await page.waitForTimeout(300);
  check("keep editing stays open", await drawer.isVisible());
  await page.keyboard.press("Escape");
  await discardDialog.waitFor({ state: "visible", timeout: 5000 });
  await discardDialog.getByText("Discard", { exact: true }).click();
  await page.waitForTimeout(500);
  check("discard closes the drawer", !(await drawer.isVisible().catch(() => false)));
  await page.screenshot({ path: `${OUT}/w4-01-hub-after-flows-1440.png`, fullPage: true });

  console.log("\n## fab.test [AC-W2.5]");
  await page.evaluate(() => {
    const m = document.querySelector("main");
    if (m) m.scrollTop = m.scrollHeight;
  });
  await page.waitForTimeout(400);
  const fabBox = await page.locator('[data-testid="agent-dock-fab"]').boundingBox();
  check("FAB is back after drawer close", fabBox !== null);
  const boxes = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>("main a, main button, main input, main select, main textarea")
    );
    return els
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, label: (el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 40) };
      })
      .filter((b) => b.width > 0 && b.height > 0);
  });
  const overlaps = boxes.filter((b) => intersect(fabBox, b) > 0);
  check(
    `zero FAB/interactive intersections at bottom scroll (checked ${boxes.length} targets)`,
    overlaps.length === 0,
    overlaps.map((o) => `${o.label} (${intersect(fabBox, o)}px²)`).join(", ")
  );

  console.log("\n## layout.test [AC-W2.1]");
  await page.evaluate(() => {
    const m = document.querySelector("main");
    if (m) m.scrollTop = 0;
  });
  const o1440 = await overflow(page);
  check(`1440: no doc overflow (${o1440.docScrollW}/${o1440.winW})`, o1440.docScrollW <= o1440.winW);
  check(`1440: no main overflow (${o1440.mainScrollW}/${o1440.mainClientW})`, o1440.mainScrollW <= o1440.mainClientW + 1);
  const clipped1440 = await clippedInteractive(page, false);
  check("1440: no clipped interactive elements [AC-W5.4]", clipped1440.length === 0, clipped1440.join(", "));
  await axeScan(page, "hub @1440");
  await page.screenshot({ path: `${OUT}/w4-03-hub-1440.png`, fullPage: true });

  console.log("\n## keyboard.test [AC-W5.2] — keyboard-only walkthrough");
  {
    // Focus rings come from the token layer (focus-visible utilities).
    const chip = page.locator('[data-testid="section-nav"] a').first();
    await chip.focus();
    const ring = await chip.evaluate((el) => getComputedStyle(el).boxShadow);
    check("visible focus state on nav chips", ring !== "none", ring);

    // Open the drawer with the keyboard, drive the segmented control with
    // arrows, flip a Toggle with Space, close with Escape.
    await page.locator('[data-testid="autonomy-pill"]').focus();
    await page.keyboard.press("Enter");
    await drawer.waitFor({ state: "visible", timeout: 5000 });
    let radioFocused = false;
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      radioFocused = await page.evaluate(() => document.activeElement?.getAttribute("role") === "radio");
      if (radioFocused) break;
    }
    check("tab reaches the mode radiogroup", radioFocused);
    const before = await page.evaluate(() => document.activeElement?.textContent ?? "");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(250); // selection is state — let React re-render before reading aria
    const after = await page.evaluate(() => ({
      label: document.activeElement?.textContent ?? "",
      checked: document.activeElement?.getAttribute("aria-checked"),
    }));
    check("arrow keys move + select the mode (announced via aria-checked)", after.label !== before && after.checked === "true");
    await page.keyboard.press("ArrowRight"); // back to the saved mode — not dirty
    await page.waitForTimeout(250);
    let toggleFocused = false;
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      toggleFocused = await page.evaluate(() => document.activeElement?.getAttribute("role") === "switch");
      if (toggleFocused) break;
    }
    check("tab reaches a permission Toggle", toggleFocused);
    if (toggleFocused) {
      const was = await page.evaluate(() => document.activeElement?.getAttribute("aria-checked"));
      await page.keyboard.press("Space");
      await page.waitForTimeout(250);
      const flipped = await page.evaluate(() => document.activeElement?.getAttribute("aria-checked"));
      check("Space flips the Toggle (aria-checked announced)", flipped !== was);
      await page.keyboard.press("Space"); // back — not dirty
      await page.waitForTimeout(250);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    // If anything above left the form dirty, the discard guard is the correct
    // behavior — resolve it so the walkthrough still proves Escape + restore.
    const guard = page.locator('[role="alertdialog"]');
    if (await guard.isVisible().catch(() => false)) {
      await guard.getByText("Discard", { exact: true }).click();
      await page.waitForTimeout(400);
    }
    check("Escape closes; focus returns to the pill", await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "autonomy-pill"));
  }

  for (const [w, h, name] of [
    [1024, 768, "w4-04-hub-1024"],
    [768, 1024, "w4-05-hub-768"],
    [390, 844, "w4-06-hub-390"],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await gotoHub();
    const o = await overflow(page);
    check(`${w}: no doc overflow (${o.docScrollW}/${o.winW})`, o.docScrollW <= o.winW);
    check(`${w}: no main overflow (${o.mainScrollW}/${o.mainClientW})`, o.mainScrollW <= o.mainClientW + 1);
    if (w >= 768) {
      const aside = await page.locator("aside").boundingBox();
      check(`${w}: sidebar is the icon rail (width ${aside?.width})`, (aside?.width ?? 999) <= 65);
      const nb = await page.locator('[data-testid="section-nav"]').boundingBox();
      check(`${w}: nav height ≤ 88px (got ${nb?.height})`, (nb?.height ?? 999) <= 88);
    }
    const clipped = await clippedInteractive(page, w < 1024);
    check(`${w}: no clipped interactive elements [AC-W5.4]`, clipped.length === 0, clipped.join(", "));
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  }
  await axeScan(page, "hub @390");

  console.log("\n## layout.test — mobile shell + drawer sheet (390)");
  check("390: desktop sidebar hidden", (await page.locator("aside").isVisible().catch(() => false)) === false);
  const burger = page.locator('button[aria-label="Open navigation"]');
  check("390: hamburger visible", await burger.isVisible());
  await burger.click();
  const mobileDrawer = page.locator('[data-testid="mobile-nav-drawer"]');
  await mobileDrawer.waitFor({ state: "visible", timeout: 5000 });
  check("390: mobile nav opens with app links", ((await mobileDrawer.textContent()) ?? "").includes("Marketing"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const pill390 = page.locator('[data-testid="autonomy-pill"]');
  await pill390.scrollIntoViewIfNeeded();
  await pill390.click();
  await drawer.waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/w4-07-autonomy-sheet-390.png` });
  const o390d = await overflow(page);
  check("390: drawer sheet no doc overflow", o390d.docScrollW <= o390d.winW);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  check("zero console errors across the run", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  console.log("\n## empty-states.test [AC-W5.3] — fresh creator");
  {
    const email2 = `ui1-empty-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const s2 = await fetch(`${url}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email2, password }),
    });
    if (!s2.ok) throw new Error(`signup2: ${await s2.text()}`);
    const supabase2 = createClient(url, anon);
    const { data: auth2 } = await supabase2.auth.signInWithPassword({ email: email2, password });
    await supabase2.from("courses").insert({
      id: crypto.randomUUID(),
      author_id: auth2!.user!.id,
      title: "Untitled course",
      description: "",
      audience: "",
      level: "beginner",
      price_cents: 0,
      plan: {} as never,
    });
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await ctx2.newPage();
    await p2.goto(`${BASE}/login`, { timeout: 60000 });
    await p2.fill('input[type="email"]', email2);
    await p2.fill('input[type="password"]', password);
    await p2.click('button[type="submit"]');
    await p2.waitForURL(/dashboard|studio|marketing/, { timeout: 30000 }).catch(() => {});
    await p2.goto(`${BASE}/marketing`, { timeout: 60000 });
    await p2.waitForSelector("text=Marketing Assistant", { timeout: 30000 });
    await p2.waitForTimeout(500);
    check("empty: activity empty state renders", (await p2.locator('[data-testid="activity-empty"]').count()) === 1);
    check(
      "empty: invites action, no dead card",
      ((await p2.locator('[data-testid="activity-empty"]').textContent()) ?? "").includes("No activity yet")
    );
    check("empty: campaign tile honest", ((await p2.locator('[data-testid="stat-campaign"]').textContent()) ?? "").includes("None yet"));
    check("empty: landing empty state invites", ((await p2.textContent("body")) ?? "").includes("No landing page yet"));
    const oEmpty = await overflow(p2);
    check("empty: no overflow", oEmpty.docScrollW <= oEmpty.winW && oEmpty.mainScrollW <= oEmpty.mainClientW + 1);
    await axeScan(p2, "empty hub @1440");
    await p2.screenshot({ path: `${OUT}/w5-01-empty-hub-1440.png`, fullPage: true });
    await ctx2.close();
  }

  // ── per-route JS metrics (checkpoint bundle table) ──────────────────────
  await page.setViewportSize({ width: 1440, height: 900 });
  await ctx.storageState({ path: "/tmp/ui1-w4-state.json" });
  const routes = ["/marketing", "/marketing/social", "/marketing/publish", "/marketing/accounts"];
  const metrics: Record<string, { jsKB: number; htmlKB: number }> = {};
  for (const r of routes) {
    const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: "/tmp/ui1-w4-state.json" });
    const p2 = await c2.newPage();
    let js = 0,
      htmlB = 0;
    p2.on("response", async (res) => {
      try {
        const u = new URL(res.url());
        if (u.origin !== BASE) return;
        if (u.pathname.endsWith(".js")) js += (await res.body()).length;
        if (res.request().resourceType() === "document") htmlB += (await res.body()).length;
      } catch {
        /* ignored */
      }
    });
    await p2.goto(`${BASE}${r}`, { timeout: 60000, waitUntil: "networkidle" }).catch(() => {});
    metrics[r] = { jsKB: Math.round(js / 1024), htmlKB: Math.round(htmlB / 1024) };
    await c2.close();
  }
  writeFileSync("/tmp/ui1-w4-metrics.json", JSON.stringify({ creator: email, metrics }, null, 2));
  console.log("\nroute metrics (networkidle, incl. prefetch):", JSON.stringify(metrics));

  // The BUDGET measures the page's own load (waitUntil "load" + settle) —
  // networkidle also counts Link prefetches of sibling routes, which is
  // noise the page didn't spend.
  {
    const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: "/tmp/ui1-w4-state.json" });
    const p3 = await c3.newPage();
    let jsLoad = 0;
    p3.on("response", async (res) => {
      try {
        const u = new URL(res.url());
        if (u.origin === BASE && u.pathname.endsWith(".js")) jsLoad += (await res.body()).length;
      } catch {
        /* ignored */
      }
    });
    await p3.goto(`${BASE}/marketing`, { timeout: 60000, waitUntil: "load" });
    await p3.waitForTimeout(800);
    const loadKB = Math.round(jsLoad / 1024);
    check(`budget.test [AC-W5.5/DEV-4]: /marketing load JS ${loadKB}KB ≤ ${MARKETING_JS_BUDGET_KB}KB`, loadKB <= MARKETING_JS_BUDGET_KB);
    await c3.close();
  }

  await browser.close();
  console.log(`\n=== verify-ui-browser: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
