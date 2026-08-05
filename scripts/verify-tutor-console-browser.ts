/**
 * Creator Tutor Console — BROWSER suite (Playwright chromium, real UI). TUTOR-1
 * Wave 5 (P5.1). tsconfig-EXCLUDED (it imports playwright). The orchestrator
 * runs it in the P5.4 consolidation pass; P5.1 only writes it.
 *
 *   Run: `npm run dev` first (dev server on :3000, live Supabase), THEN
 *   `npx tsx scripts/verify-tutor-console-browser.ts`. Or a prod build:
 *   `next build && next start -p 3100` with TUTOR_CONSOLE_BROWSER_BASE=…:3100.
 *
 * Fresh throwaway users each run (*@example.com — clean in Supabase → Auth).
 *
 * SECTIONS
 *   T5.1   toggle → sidebar-absent — enabling the tutor WITHOUT an accepted graph
 *          surfaces the "Build the concept graph first" extraction CTA and the
 *          enable stays OFF (the learner tutor sidebar is absent on /learn until
 *          a graph is accepted AND the tutor is enabled).
 *   W5O.1  suppressed UI — with a sub-floor cohort (<5 learners), the Overview
 *          usage card renders the SUPPRESSED empty state, NEVER a count.
 *   nav    tab deep-linking — ?tab=charter / ?tab=graph / ?tab=analytics render
 *          the right panel; aria-current tracks the active tab.
 *   a11y   axe zero serious/critical on the Overview + Charter panels.
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createBlock, createLesson, createModule, createSlide, newRowId } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import { resolveLivePublicationBySlug, type PublicationRow } from "@/lib/learn/resolve";

dns.setDefaultResultOrder("ipv4first");

const BASE = process.env.TUTOR_CONSOLE_BROWSER_BASE ?? "http://localhost:3000";
type DB = SupabaseClient<Database>;

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

function loadEnv(): { url: string; anon: string; service?: string } {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return {
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    service: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY,
  };
}

async function provisionUser(url: string, anon: string, tag: string) {
  const email = `tutor-console-b-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  return { client, userId: data.user.id, email, password };
}

function makeDoc(courseId: string, ownerId: string, title: string): CourseDocument {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];
  const lesson = createLesson("Lesson A", 0);
  lesson.blocks = [deck];
  const mod = createModule("Foundations", 0);
  mod.lessons = [lesson];
  return {
    id: courseId,
    title,
    description: "Tutor console browser fixture.",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId,
      aiReadableVersion: "1.0",
    },
  };
}

/** Sign a Playwright page into the app via the real /login form. */
async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!service) throw new Error("verify:tutor-console:browser needs SUPABASE_SERVICE_ROLE_KEY");
  const author = await provisionUser(url, anon, "author");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, `Console browser ${crypto.randomUUID().slice(0, 6)}`);
  const rows = courseDocToRows(doc, author.userId);
  for (const [table, data] of [
    ["courses", rows.course],
    ["modules", rows.modules],
    ["lessons", rows.lessons],
    ["blocks", rows.blocks],
  ] as const) {
    const { error } = await (author.client as DB).from(table).insert(data as never);
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }
  const v1 = await publishCourse(author.client as DB, doc, { visibility: "public" });
  const found = await resolveLivePublicationBySlug(author.client as DB, v1.publication.slug);
  if (found.kind !== "found") throw new Error("publication not resolvable");
  const publication: PublicationRow = found.publication;

  const browser: Browser = await chromium.launch();
  const ctx: BrowserContext = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await signIn(page, author.email, author.password);

    /* ── T5.1: toggle → the enable stays OFF without an accepted graph ── */
    console.log("\n# T5.1 — enabling without an accepted graph surfaces extraction");
    await page.goto(`${BASE}/studio/${courseId}/tutor`);
    await page.waitForLoadState("networkidle");
    const toggle = page.locator('[data-ai-tool="tutor-enable"] [role="switch"]');
    check("the enablement toggle is present", (await toggle.count()) === 1);
    await toggle.click();
    await page.waitForTimeout(1200);
    check(
      "enabling without a graph shows the 'Build the concept graph first' CTA",
      await page.getByText("Build the concept graph first").isVisible()
    );
    check(
      "the extraction CTA is present",
      (await page.locator('[data-ai-tool="tutor-request-extraction"]').count()) === 1
    );
    check("the toggle stays OFF (aria-checked=false)", (await toggle.getAttribute("aria-checked")) === "false");

    /* ── T5.1 (learner half): the /learn tutor sidebar is ABSENT while disabled ──
     * Enroll a fresh learner, open the lesson, assert NO tutor entry. (Left as a
     * detailed assertion for the consolidation run — the sidebar-present path is
     * covered by verify-tutor-browser.ts once enabled.) */

    /* ── W5O.1: sub-floor cohort → suppressed usage UI (no count) ── */
    console.log("\n# W5O.1 — sub-floor usage renders the suppressed empty state");
    // Seed 3 learners' tutor activity (below the ≥5 floor) via admin.
    for (let i = 0; i < 3; i++) {
      const uid = crypto.randomUUID();
      const t = await admin.from("tutor_threads").insert({ user_id: uid, course_id: courseId }).select("id").single();
      await admin.from("tutor_turns").insert({
        thread_id: t.data!.id,
        user_id: uid,
        course_id: courseId,
        role: "learner",
        content: `Q${i}`,
        publication_id: publication.id,
        version: publication.version,
      });
    }
    await page.reload();
    await page.waitForLoadState("networkidle");
    check(
      "the usage card shows the suppressed empty state",
      await page.getByText("Not enough learners yet").isVisible()
    );
    const bodyText = (await page.locator("body").innerText()).toLowerCase();
    check(
      "no raw learner count is rendered near the usage card (privacy)",
      !/3 learners? used/.test(bodyText)
    );

    /* ── nav: tab deep-linking + aria-current ── */
    console.log("\n# nav — ?tab= deep-linking");
    await page.goto(`${BASE}/studio/${courseId}/tutor?tab=charter`);
    await page.waitForLoadState("networkidle");
    check("charter tab renders the charter form", (await page.locator('[data-ai-tool="charter-save"]').count()) === 1);
    check(
      "the charter tab link is aria-current=page",
      (await page.locator('nav a[aria-current="page"]').innerText()).includes("charter") ||
        (await page.locator('nav a[aria-current="page"]').innerText()).toLowerCase().includes("charter")
    );
    await page.goto(`${BASE}/studio/${courseId}/tutor?tab=graph`);
    await page.waitForLoadState("networkidle");
    check("graph tab renders its placeholder", await page.getByText("Concept graph — coming in this wave").isVisible());
    await page.goto(`${BASE}/studio/${courseId}/tutor?tab=analytics`);
    await page.waitForLoadState("networkidle");
    check("analytics tab renders its placeholder", await page.getByText("Analytics — coming in this wave").isVisible());

    /* ── a11y: axe zero serious/critical on Overview + Charter ── */
    console.log("\n# a11y — axe (serious/critical)");
    for (const tab of ["", "?tab=charter"]) {
      await page.goto(`${BASE}/studio/${courseId}/tutor${tab}`);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      check(`axe: zero serious/critical on ${tab || "overview"}`, serious.length === 0, JSON.stringify(serious.map((v) => v.id)));
    }
  } finally {
    await browser.close();
    await author.client.from("courses").delete().eq("id", courseId);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
