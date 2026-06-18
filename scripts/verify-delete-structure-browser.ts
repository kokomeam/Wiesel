/**
 * Browser check of the MANUAL module/lesson delete flow in the studio: each
 * delete pops a confirmation dialog, Cancel is a no-op, Confirm removes the
 * item, and the removal persists across a reload.
 * Requires: `npm i -D playwright`. Run with the dev server up (BASE_URL).
 */

import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createBlock, createLesson, createModule } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import type { CourseDocument } from "@/lib/course/types";

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
  const email = `del-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
  const a = await makeUser(url, anon);

  // Seed: 2 modules; module A has a lesson (with a block) we'll delete, then we
  // delete module A itself; module B remains.
  const now = "2026-06-16T00:00:00.000Z";
  const lessonA = createLesson("Pointers intro", 0);
  lessonA.blocks = [createBlock("lecture_text")];
  const modA = createModule("Foundations", 0);
  modA.lessons = [lessonA];
  const lessonB = createLesson("Sliding window", 0);
  lessonB.blocks = [createBlock("lecture_text")]; // keep the course non-empty so
  const modB = createModule("Advanced", 1); // the studio stays on the Create step
  modB.lessons = [lessonB];
  const courseId = crypto.randomUUID();
  const doc: CourseDocument = {
    id: courseId, title: "DelTest", description: "", level: "beginner",
    plan: { outcomes: [], prerequisites: [] }, modules: [modA, modB],
    theme: defaultCourseTheme(),
    metadata: { createdAt: now, updatedAt: now, ownerId: a.userId, aiReadableVersion: "1.0" },
  };
  const rows = courseDocToRows(doc, a.userId);
  await a.supabase.from("courses").insert(rows.course);
  await a.supabase.from("modules").insert(rows.modules);
  await a.supabase.from("lessons").insert(rows.lessons);
  await a.supabase.from("blocks").insert(rows.blocks);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
    await login(page, a.email, a.password);
    await page.goto(`${BASE}/studio`, { waitUntil: "networkidle" });
    await page.getByText("DelTest").first().click();
    await page.waitForURL((u) => u.searchParams.get("course") === courseId, { timeout: 15000 });
    await page.locator('[aria-label="AI Content Agent"]').waitFor({ state: "visible", timeout: 15000 });

    // Open Module A from the sidebar to reach its module page.
    await page.locator("aside").getByText("Module 1: Foundations").first().click();
    await page.getByText("Pointers intro").first().waitFor({ state: "visible", timeout: 8000 });

    // ── Lesson delete: Cancel is a no-op ── (row delete button = "Delete <title>")
    console.log("# delete lesson — cancel keeps it");
    const lessonDeleteBtn = page.getByRole("button", { name: "Delete Pointers intro", exact: true });
    await lessonDeleteBtn.first().click();
    await page.getByRole("alertdialog").waitFor({ state: "visible", timeout: 5000 });
    check("a confirmation dialog appears", (await page.getByText("Delete this lesson?").count()) > 0);
    await page.screenshot({ path: "/tmp/delete_confirm_dialog.png" });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForTimeout(300);
    check("lesson kept after Cancel", (await page.getByText("Pointers intro").count()) > 0);

    // ── Lesson delete: Confirm removes it ──
    console.log("# delete lesson — confirm removes it");
    await lessonDeleteBtn.first().click();
    await page.getByRole("alertdialog").waitFor({ state: "visible", timeout: 5000 });
    await page.getByRole("button", { name: "Delete lesson", exact: true }).click();
    await page.waitForTimeout(600);
    check("lesson removed from the module page", (await page.getByText("Pointers intro").count()) === 0);
    check("module page now shows the empty state", (await page.getByText("No lessons yet").count()) > 0);

    // ── Module delete via the header: Confirm removes it, returns to course ──
    console.log("# delete module — confirm removes it");
    await page.getByRole("button", { name: "Delete", exact: true }).click(); // header "Delete"
    await page.getByRole("alertdialog").waitFor({ state: "visible", timeout: 5000 });
    check("module confirm dialog appears", (await page.getByText("Delete this module?").count()) > 0);
    await page.getByRole("button", { name: "Delete module", exact: true }).click(); // dialog confirm
    await page.waitForTimeout(700);
    check("returns to the course overview", (await page.getByText("Course overview").count()) > 0);
    check("Foundations module is gone, Advanced remains",
      (await page.getByText("Foundations").count()) === 0 &&
      (await page.getByText("Advanced").count()) > 0);

    // ── Persistence: poll the DB until the debounced autosave lands ──
    console.log("# deletes persist (autosave → DB)");
    let titles: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(200);
      const r = await a.supabase.from("modules").select("title").eq("course_id", courseId);
      titles = (r.data ?? []).map((m) => m.title);
      if (titles.length === 1 && titles[0] === "Advanced") break;
    }
    check("DB has exactly one module after autosave (Advanced)", titles.length === 1 && titles[0] === "Advanced", titles.join(","));
    const lessonsLeft = await a.supabase.from("lessons").select("title").eq("course_id", courseId);
    check("the deleted lesson is gone from the DB",
      !(lessonsLeft.data ?? []).some((l) => l.title === "Pointers intro"),
      (lessonsLeft.data ?? []).map((l) => l.title).join(","));

    // Reload and confirm the editor reflects the persisted state.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    check("after reload only Advanced remains in the outline",
      (await page.locator("aside").getByText("Advanced").count()) > 0 &&
      (await page.locator("aside").getByText("Foundations").count()) === 0);

    await page.screenshot({ path: "/tmp/delete_structure.png" });
    await a.supabase.from("courses").delete().eq("id", courseId);
  } finally {
    await browser.close();
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
