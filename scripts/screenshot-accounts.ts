/**
 * screenshot-accounts — checkpoint evidence for M-A: /marketing/accounts in
 * every account health state (linked · expired/re-link · revoked ·
 * not-connected-with-prereq · usage warning). Seeds a THROWAWAY creator with
 * rows in each state (direct inserts are fine here — the repository
 * write-confinement grep covers lib/app/components, and this seed is test
 * scaffolding, not product code), signs in through the real /login, and
 * captures the page.
 *
 * Prereqs: dev server on :3000, migration 20260723120000 applied, and a
 * TEMPORARY playwright install (repo convention):
 *   npm i -D playwright && npx tsx scripts/screenshot-accounts.ts && npm uninstall playwright
 * NOTE: this page never calls the provider without ?linked=1 — the capture
 * stays offline (no Upload-Post traffic, no profile created).
 */

import { readFileSync, mkdirSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

dns.setDefaultResultOrder("ipv4first");

const BASE = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = new URL("../artifacts", import.meta.url).pathname;

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
  const email = `accounts-shot-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "test-password-1234";

  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup: ${await signup.text()}`);
  const supabase = createClient<Database>(url!, anon!);
  const { data: auth, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !auth.user) throw new Error(`signin: ${error?.message}`);
  const uid = auth.user.id;

  // One row per health state + not-connected facebook (prereq note) stays absent.
  const mk = (platform: string, status: string, extra: Record<string, unknown> = {}) => ({
    creator_id: uid,
    provider: "upload_post",
    platform,
    status,
    display_name: `Demo ${platform}`,
    handle: `@demo_${platform}`,
    last_synced_at: new Date().toISOString(),
    ...extra,
  });
  const { data: rows, error: insErr } = await supabase
    .from("social_account")
    .insert([mk("linkedin", "linked"), mk("youtube", "expired"), mk("tiktok", "revoked"), mk("instagram", "linked")])
    .select("id,platform");
  if (insErr || !rows) throw new Error(`seed accounts: ${insErr?.message}`);

  // Warning state: 8 of 10 uploads on the instagram account this month.
  const ig = rows.find((r) => r.platform === "instagram")!;
  const ledger = Array.from({ length: 8 }, (_, i) => ({
    creator_id: uid,
    social_account_id: ig.id,
    platform: "instagram",
    client_ref: `shot-${i}`,
  }));
  const { error: ledErr } = await supabase.from("social_publish_ledger").insert(ledger);
  if (ledErr) throw new Error(`seed ledger: ${ledErr.message}`);

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|studio|marketing/, { timeout: 20000 }).catch(() => {});

  await page.goto(`${BASE}/marketing/accounts`);
  await page.waitForSelector("text=Connected accounts", { timeout: 20000 });
  await page.waitForTimeout(600);
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: `${OUT_DIR}/accounts-health-states.png`, fullPage: true });
  console.log(`saved ${OUT_DIR}/accounts-health-states.png`);
  await browser.close();

  // tidy the throwaway rows (ledger has no delete policy — rows are inert
  // under a throwaway creator; accounts/profile clean up fine)
  await supabase.from("social_account").delete().eq("creator_id", uid);
  console.log("done — throwaway creator:", email);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
