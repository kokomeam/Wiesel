/**
 * Browser verification of the Creator Studio course gallery (server on :3100).
 * Requires: `npm i -D playwright`. Run: `npx tsx scripts/verify-gallery-browser.ts`
 *
 * Asserts: with courses, /studio shows a card per course + a "New course" card,
 * and clicking a card opens that course's editor (?course=, agent panel docked);
 * with zero courses, /studio still shows the gallery with a single "Create your
 * first course" card. Screenshots → /tmp.
 */

import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createBlock, createLesson, createModule } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import type { CourseDocument } from "@/lib/course/types";

const BASE = "http://localhost:3100";
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${d}`); }
};

function env() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const e: Record<string, string> = {};
  for (const l of raw.split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: e.NEXT_PUBLIC_SUPABASE_URL, anon: e.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

async function makeUser(url: string, anon: string) {
  const email = `gallery-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const r = await fetch(`${url}/auth/v1/signup`, {
    method: "POST", headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`signup: ${await r.text()}`);
  const supabase = createClient<Database>(url, anon);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin: ${error?.message}`);
  return { email, password, userId: data.user.id, supabase };
}

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
}

async function main() {
  const { url, anon } = env();
  const browser = await chromium.launch();
  try {
    // ── User A: two courses (one WITH content) → gallery with cards ──
    const a = await makeUser(url, anon);
    const now = "2026-06-15T00:00:00.000Z";
    // Course 0 has a lesson + block so it opens straight into the editor.
    const lesson = createLesson("Calls & puts", 0);
    lesson.blocks = [createBlock("lecture_text")];
    const mod = createModule("Foundations", 0);
    mod.lessons = [lesson];
    const withContent: CourseDocument = {
      id: crypto.randomUUID(), title: "Intro to Options Trading", description: "A short options course.",
      level: "beginner", plan: { outcomes: [], prerequisites: [] }, modules: [mod],
      theme: defaultCourseTheme(), metadata: { createdAt: now, updatedAt: now, ownerId: a.userId, aiReadableVersion: "1.0" },
    };
    const rows = courseDocToRows(withContent, a.userId);
    await a.supabase.from("courses").insert(rows.course);
    await a.supabase.from("modules").insert(rows.modules);
    await a.supabase.from("lessons").insert(rows.lessons);
    await a.supabase.from("blocks").insert(rows.blocks);

    const emptyId = crypto.randomUUID();
    await a.supabase.from("courses").insert({
      id: emptyId, author_id: a.userId, title: "Two Pointers 101", description: "Array patterns.", level: "beginner",
      plan: { outcomes: [], prerequisites: [] } as never, theme: defaultCourseTheme() as never,
    });
    const ids = [withContent.id, emptyId];

    const pageA = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await login(pageA, a.email, a.password);
    await pageA.goto(`${BASE}/studio`, { waitUntil: "networkidle" });

    console.log("# gallery with courses");
    check("both course titles render as cards",
      (await pageA.getByText("Intro to Options Trading").count()) > 0 &&
      (await pageA.getByText("Two Pointers 101").count()) > 0);
    check("a 'New course' creation card is present", (await pageA.getByText("New course").count()) > 0);
    check("editor is NOT auto-opened (no agent panel on the gallery)",
      (await pageA.locator('[aria-label="AI Content Agent"]').count()) === 0);
    await pageA.screenshot({ path: "/tmp/gallery_courses.png" });

    // click the content course's card → opens its editor (agent panel docked)
    await pageA.getByText("Intro to Options Trading").first().click();
    await pageA.waitForURL((u) => u.searchParams.get("course") === ids[0], { timeout: 15000 });
    await pageA.locator('[aria-label="AI Content Agent"]').waitFor({ state: "visible", timeout: 15000 });
    check("clicking a card opens that course in the editor", pageA.url().includes(`course=${ids[0]}`));
    check("editor (agent panel) loads for the opened course",
      await pageA.locator('[aria-label="AI Content Agent"]').isVisible());

    // ── User B: zero courses → gallery with the first-course card ──
    const b = await makeUser(url, anon);
    const pageB = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await login(pageB, b.email, b.password);
    await pageB.goto(`${BASE}/studio`, { waitUntil: "networkidle" });

    console.log("# gallery with zero courses");
    check("still lands on the gallery (Creator Studio header)", (await pageB.getByText("Creator Studio").count()) > 0);
    check("shows the 'Create your first course' card", (await pageB.getByText("Create your first course").count()) > 0);
    check("no editor auto-opened for a brand-new user",
      (await pageB.locator('[aria-label="AI Content Agent"]').count()) === 0);
    await pageB.screenshot({ path: "/tmp/gallery_empty.png" });

    // cleanup user A's courses
    for (const id of ids) await a.supabase.from("courses").delete().eq("id", id);
  } finally {
    await browser.close();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
