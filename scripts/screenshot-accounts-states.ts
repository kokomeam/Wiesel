/**
 * screenshot-accounts-states — M-A checkpoint evidence, one labeled PNG per
 * required state, saved to screenshots/:
 *   01-empty-unconnected.png    fresh creator, zero rows (all five cards "Not connected")
 *   02-health-linked.png        seeded social_account status=linked
 *   03-health-expired.png       seeded status=expired ("Needs re-link" + Re-link CTA)
 *   04-health-revoked.png       seeded status=revoked ("Disconnected" + Connect again)
 *   05-usage-warning.png        seeded 8/10 ledger rows on a linked account (amber meter)
 *   06-multi-import-dialog.png  REAL MultiImportDialog via the temp /zz-accounts-preview
 *                               route (newlyLinked prop seeded — the server reconcile that
 *                               produces it needs live vendor traffic; that path is
 *                               int-tested in linking.spec instead)
 *   07-all-states-overview.png  full page, the seeded states creator
 *
 * All states are SEEDED via direct row inserts under a throwaway creator
 * (test scaffolding — the repository write-confinement grep covers
 * lib/app/components, not scripts). No Upload-Post traffic occurs: the page
 * only calls the provider under ?linked=1, which is never visited here.
 *
 * Prereqs: dev server on :3000, migration 20260723120000 applied, temp
 * playwright install, and the temp app/zz-accounts-preview/page.tsx present.
 */

import { readFileSync, mkdirSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

dns.setDefaultResultOrder("ipv4first");

const BASE = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = new URL("../screenshots", import.meta.url).pathname;

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

async function provisionCreator(url: string, anon: string, tag: string) {
  const email = `accounts-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "test-password-1234";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup ${tag}: ${await signup.text()}`);
  const supabase = createClient<Database>(url, anon);
  const { data: auth, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !auth.user) throw new Error(`signin ${tag}: ${error?.message}`);
  return { email, password, uid: auth.user.id, supabase };
}

async function main() {
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("missing supabase env");
  mkdirSync(OUT_DIR, { recursive: true });

  // ── Creator 1: EMPTY state (no rows at all) ──────────────────────────────
  const empty = await provisionCreator(url, anon, "empty");
  // ── Creator 2: one row per health state + the usage-warning ledger ──────
  const seeded = await provisionCreator(url, anon, "states");
  const mk = (platform: string, status: string) => ({
    creator_id: seeded.uid,
    provider: "upload_post",
    platform,
    status,
    display_name: `Demo ${platform}`,
    handle: `@demo_${platform}`,
    last_synced_at: new Date().toISOString(),
  });
  const { data: rows, error: insErr } = await seeded.supabase
    .from("social_account")
    .insert([
      mk("linkedin", "linked"),
      mk("youtube", "expired"),
      mk("tiktok", "revoked"),
      mk("instagram", "linked"),
    ])
    .select("id,platform");
  if (insErr || !rows) throw new Error(`seed accounts: ${insErr?.message}`);
  const ig = rows.find((r) => r.platform === "instagram")!;
  const { error: ledErr } = await seeded.supabase.from("social_publish_ledger").insert(
    Array.from({ length: 8 }, (_, i) => ({
      creator_id: seeded.uid,
      social_account_id: ig.id,
      platform: "instagram",
      client_ref: `shot-${i}`,
    }))
  );
  if (ledErr) throw new Error(`seed ledger: ${ledErr.message}`);

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();

  async function signInPage(creds: { email: string; password: string }) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { timeout: 60000 });
    await page.fill('input[type="email"]', creds.email);
    await page.fill('input[type="password"]', creds.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard|studio|marketing/, { timeout: 30000 }).catch(() => {});
    return { ctx, page };
  }

  // 01 — empty / unconnected (fresh creator, zero rows)
  {
    const { ctx, page } = await signInPage(empty);
    await page.goto(`${BASE}/marketing/accounts`, { timeout: 60000 });
    await page.waitForSelector("text=Connected accounts", { timeout: 30000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT_DIR}/01-empty-unconnected.png`, fullPage: true });
    console.log("saved 01-empty-unconnected.png");
    await ctx.close();
  }

  // 02–05 + 07 — the seeded states creator
  {
    const { ctx, page } = await signInPage(seeded);
    await page.goto(`${BASE}/marketing/accounts`, { timeout: 60000 });
    await page.waitForSelector("text=Connected accounts", { timeout: 30000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT_DIR}/07-all-states-overview.png`, fullPage: true });
    console.log("saved 07-all-states-overview.png");

    // Cards render in PUBLISH_PLATFORMS order: linkedin, youtube, tiktok, instagram, facebook
    const cards = page.locator("div.grid > div");
    const shots: Array<[number, string]> = [
      [0, "02-health-linked.png"], // linkedin: linked
      [1, "03-health-expired.png"], // youtube: expired → Re-link
      [2, "04-health-revoked.png"], // tiktok: revoked → Connect again
      [3, "05-usage-warning.png"], // instagram: linked + 8/10 amber meter
    ];
    for (const [i, name] of shots) {
      await cards.nth(i).screenshot({ path: `${OUT_DIR}/${name}` });
      console.log(`saved ${name}`);
    }

    // 06 — multi-account import dialog (temp preview route, seeded prop)
    await page.goto(`${BASE}/zz-accounts-preview`, { timeout: 60000 });
    await page.waitForSelector("text=came back from the linking page", { timeout: 30000 });
    await page.waitForTimeout(400);
    await page
      .locator("div.border-brand-200")
      .first()
      .screenshot({ path: `${OUT_DIR}/06-multi-import-dialog.png` });
    console.log("saved 06-multi-import-dialog.png");
    await ctx.close();
  }

  await browser.close();

  // tidy throwaway account rows (the ledger has no delete policy by design —
  // its rows are inert under throwaway creators)
  await seeded.supabase.from("social_account").delete().eq("creator_id", seeded.uid);
  console.log("done — throwaway creators:", empty.email, seeded.email);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
