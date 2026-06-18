/**
 * Browser verification of the COURSE-ROOT page (the new "course home" — the
 * clear way to add the first module, mirroring the lesson UX one level up).
 * Requires: `npm i -D playwright`. Run: `npx tsx scripts/verify-coursepage-browser.ts`
 * (dev server on :3100).
 *
 * Drives the exact gap the user hit: open an EMPTY course (no modules), go to
 * Create, and confirm there's a prominent "No modules yet → Add module" empty
 * state. Then add a module (lands in it), navigate back to the course root, and
 * confirm the module renders as a preview card with the light-blue identity.
 * Screenshots → /tmp.
 */

import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { defaultCourseTheme } from "@/lib/course/persistence";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
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
  const email = `coursepage-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
    const a = await makeUser(url, anon);
    const courseId = crypto.randomUUID();
    await a.supabase.from("courses").insert({
      id: courseId, author_id: a.userId, title: "cs61b", description: "", level: "intermediate",
      plan: { outcomes: [], prerequisites: [] } as never, theme: defaultCourseTheme() as never,
    });

    const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
    await login(page, a.email, a.password);
    await page.goto(`${BASE}/studio`, { waitUntil: "networkidle" });

    // Open the empty course from the gallery → editor.
    await page.getByText("cs61b").first().click();
    await page.waitForURL((u) => u.searchParams.get("course") === courseId, { timeout: 15000 });

    // An empty course defaults to the Plan step (no agent panel there). Switch
    // to Create, then wait for the three-column editor (agent panel docked).
    await page.getByText("Create content").first().waitFor({ state: "visible", timeout: 15000 });
    await page.getByText("Create content").first().click();
    await page.locator('[aria-label="AI Content Agent"]').waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(400);

    console.log("# empty course → course-root page");
    check("shows the 'No modules yet' empty state", (await page.getByText("No modules yet").count()) > 0);
    // The CoursePage's PRIMARY add-module button (sky CTA), not the sidebar one.
    const primaryAdd = page.locator("button.bg-sky-600");
    check("a prominent (sky) 'Add module' button is present",
      (await primaryAdd.count()) > 0 && (await primaryAdd.first().innerText()).includes("Add module"));
    check("no confusing 'No lesson selected' on a module-less course",
      (await page.getByText("No lesson selected").count()) === 0);
    await page.screenshot({ path: "/tmp/coursepage_empty.png" });

    // Add the first module → should land INSIDE the new module (its page).
    await primaryAdd.first().click();
    await page.waitForTimeout(500);
    console.log("# add module → lands in the new module");
    check("jumps into the new module (its 'No lessons yet' page)",
      (await page.getByText("No lessons yet").count()) > 0);
    await page.screenshot({ path: "/tmp/coursepage_module.png" });

    // Back to the course root via the outline's course row (sidebar header).
    await page.locator("aside").getByText("cs61b", { exact: true }).first().click();
    await page.waitForTimeout(400);
    console.log("# course root now lists the module as a preview card");
    const card = page.locator('[data-ai-component="course-module-row"]').first();
    await card.waitFor({ state: "visible", timeout: 8000 });
    const cardText = (await card.innerText()).replace(/\s+/g, " ").trim();
    console.log(`    card text: "${cardText}"`);
    check("module preview card renders its full title",
      cardText.includes("Module 1:") && cardText.includes("New module"), cardText);
    check("the module count reads '1 module'", (await page.getByText(/^1 module$/i).count()) > 0);
    check("a dashed 'Add module' affordance remains for adding more",
      (await page.getByText("Add module").count()) > 0);
    await page.screenshot({ path: "/tmp/coursepage_with_module.png" });

    await a.supabase.from("courses").delete().eq("id", courseId);
  } finally {
    await browser.close();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
