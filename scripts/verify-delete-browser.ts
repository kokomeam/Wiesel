/**
 * Browser check of the gallery delete flow (server on :3100).
 * Requires: `npm i -D playwright`. Run: `npx tsx scripts/verify-delete-browser.ts`
 */

import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { defaultCourseTheme } from "@/lib/course/persistence";

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
  const email = `del-ui-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  await fetch(`${url}/auth/v1/signup`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const supabase = createClient<Database>(url, anon);
  const { data: si } = await supabase.auth.signInWithPassword({ email, password });
  const userId = si!.user!.id;
  for (const title of ["Keep Me", "Delete Me"]) {
    await supabase.from("courses").insert({ id: crypto.randomUUID(), author_id: userId, title, description: `${title}.`, level: "beginner", plan: { outcomes: [], prerequisites: [] } as never, theme: defaultCourseTheme() as never });
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
    await page.goto(`${BASE}/studio`, { waitUntil: "networkidle" });

    check("both courses shown", (await page.getByText("Keep Me").count()) > 0 && (await page.getByText("Delete Me").count()) > 0);

    // Open the delete confirmation for "Delete Me"
    await page.click('[aria-label="Delete Delete Me"]');
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 5000 });
    check("confirmation modal appears", await dialog.isVisible());
    check("modal warns it's permanent / can't be undone", /can.t be undone/i.test(await dialog.innerText()));
    await page.screenshot({ path: "/tmp/delete_modal.png" });

    // Cancel keeps it
    await page.getByRole("button", { name: "Cancel" }).click();
    check("cancel keeps the course", (await page.getByText("Delete Me").count()) > 0 && (await page.getByRole("dialog").count()) === 0);

    // Delete for real
    await page.click('[aria-label="Delete Delete Me"]');
    await page.getByRole("button", { name: /Delete course/ }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("Delete Me"), { timeout: 15000 });
    check("course card removed after confirm", (await page.getByText("Delete Me").count()) === 0);
    check("other course remains", (await page.getByText("Keep Me").count()) > 0);

    // Gone from the DB too
    const { count } = await supabase.from("courses").select("id", { count: "exact", head: true }).eq("author_id", userId).eq("title", "Delete Me");
    check("deleted from the database", (count ?? 0) === 0);
  } finally {
    await browser.close();
    await supabase.from("courses").delete().eq("author_id", userId);
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
