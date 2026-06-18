/**
 * Browser verification of the docked agent UI against a running app.
 * Requires: `npm i -D playwright` and a server on :3100 (`PORT=3100 npm start`).
 * Run: `npx tsx scripts/verify-agent-browser.ts`  (uninstall playwright after.)
 *
 * Seeds a throwaway user + a course with one lesson/block, signs in through the
 * real /login UI, opens the studio, and asserts the agent panel docks + the
 * composer works + the no-key path surfaces gracefully (the real model leg
 * needs OPENAI_API_KEY). Screenshots land in /tmp.
 */

import { readFileSync } from "node:fs";
import { chromium } from "playwright";
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

async function main() {
  const { url, anon } = env();
  const email = `agent-ui-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup: ${await signup.text()}`);

  const supabase = createClient<Database>(url, anon);
  const { data: si, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !si.user) throw new Error(`signin: ${error?.message}`);
  const userId = si.user.id;

  // Seed a course with a lesson + one block (so the studio opens in the editor).
  const block = createBlock("lecture_text");
  block.title = "Intro notes";
  const lesson = createLesson("What is two pointers?", 0);
  lesson.blocks = [block];
  const mod = createModule("Foundations", 0);
  mod.lessons = [lesson];
  const now = "2026-06-15T00:00:00.000Z";
  const doc: CourseDocument = {
    id: crypto.randomUUID(),
    title: "Two Pointers 101",
    description: "Core array patterns.",
    audience: "beginner CP",
    level: "beginner",
    plan: { outcomes: ["Apply two pointers"], prerequisites: [], teachingStyle: "friendly" },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: { createdAt: now, updatedAt: now, ownerId: userId, aiReadableVersion: "1.0" },
  };
  const rows = courseDocToRows(doc, userId);
  if ((await supabase.from("courses").insert(rows.course)).error) throw new Error("course insert");
  await supabase.from("modules").insert(rows.modules);
  await supabase.from("lessons").insert(rows.lessons);
  await supabase.from("blocks").insert(rows.blocks);
  console.log(`# seeded course for ${email}`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    // Sign in through the real UI.
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });

    // Open the studio.
    await page.goto(`${BASE}/studio?course=${doc.id}`, { waitUntil: "networkidle" });
    const panel = page.locator('[aria-label="AI Content Agent"]');
    await panel.waitFor({ state: "visible", timeout: 15000 });
    check("agent panel docked", await panel.isVisible());
    check("composer present", await page.locator('[data-ai-tool="agent-input"]').count() > 0);
    check("lecture block rendered", (await page.locator('[data-ai-component="lesson-block"]').count()) > 0);
    await page.screenshot({ path: "/tmp/agent_studio.png", fullPage: false });

    // Send a message — with no key, the route streams a graceful error.
    await page.fill('[data-ai-tool="agent-input"]', "Write a 3-slide intro deck for this lesson.");
    await page.click('[data-ai-tool="agent-send"]');
    const errBubble = page.getByText(/isn’t configured|isn't configured|not configured/i);
    await errBubble.waitFor({ state: "visible", timeout: 15000 });
    check("no-key path surfaces a clear message", await errBubble.isVisible());
    check("user message echoed in transcript", (await page.getByText("Write a 3-slide intro deck for this lesson.").count()) > 0);
    await page.screenshot({ path: "/tmp/agent_nokey.png", fullPage: false });
  } finally {
    await browser.close();
    await supabase.from("courses").delete().eq("id", doc.id);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
