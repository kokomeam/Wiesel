/** AC-MD.8 second half — cancel-by-event: schedule ~90s out via the queue,
 *  cancel from the queue, wait past fire time, assert the released run is a
 *  no-op (stub count unchanged, manifest stays cancelled). */
import { readFileSync, mkdirSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { encryptSecret } from "@/lib/marketing/accounts/crypto";

dns.setDefaultResultOrder("ipv4first");
const BASE = "http://localhost:3000";
const OUT = new URL("../screenshots", import.meta.url).pathname;

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! };
}
const stubCalls = async () =>
  (await (await fetch("http://127.0.0.1:4949/__calls")).json()).publishCalls as number;

async function main() {
  const { url, anon } = loadEnv();
  const email = `e2e-cancel-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "test-password-1234";
  await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const supabase = createClient<Database>(url, anon);
  const { data: auth } = await supabase.auth.signInWithPassword({ email, password });
  const uid = auth!.user!.id;
  await supabase
    .from("social_provider_profile")
    .insert({ creator_id: uid, provider: "upload_post", profile_ref_enc: encryptSecret("ws_e2e_c") })
    .throwOnError();
  await supabase
    .from("social_account")
    .insert({ creator_id: uid, provider: "upload_post", platform: "linkedin", status: "linked", display_name: "E2E Cancel", handle: "@e2ec", last_synced_at: new Date().toISOString() })
    .throwOnError();
  const { data: course } = await supabase.from("courses").insert({ author_id: uid, title: "E2E cancel course" }).select("id").single().throwOnError();
  const { data: post } = await supabase
    .from("social_post")
    .insert({
      creator_id: uid, course_id: course!.id, body: "E2E cancel proof: cancelled from the queue before firing.",
      platform: "linkedin", post_type: "text", funnel_stage: "tofu", goal: "value", tone: "friendly",
      source_type: "manual", status: "ready", hashtags: ["e2e"],
    })
    .select("*")
    .single()
    .throwOnError();

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  await page.goto(`${BASE}/login`, { timeout: 60000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|studio|marketing/, { timeout: 30000 }).catch(() => {});
  mkdirSync(OUT, { recursive: true });

  await page.goto(`${BASE}/marketing/social`, { timeout: 90000 });
  await page.waitForSelector("text=E2E cancel proof", { timeout: 30000 });
  await page.getByText("E2E cancel proof", { exact: false }).first().click();
  await page.waitForSelector("text=Publish through a connected account", { timeout: 20000 });
  const fireAt = new Date(Date.now() + 90_000);
  const local = new Date(fireAt.getTime() - fireAt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const sched = page.locator("div", { hasText: "Publish through a connected account" }).last();
  await sched.locator('input[type="datetime-local"]').fill(local);
  await sched.getByRole("button", { name: "Schedule…" }).click();
  await page.waitForSelector("text=Exactly what ships", { timeout: 20000 });
  await page.getByRole("button", { name: "Approve & schedule" }).click();
  await page.waitForTimeout(2000);
  await page.reload();
  await page.waitForSelector("text=Scheduled ·", { timeout: 30000 });
  const before = await stubCalls();
  console.log(JSON.stringify({ moment: "scheduled", scheduledFor: fireAt.toISOString(), stubCallsBefore: before }));
  await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await page.waitForSelector("text=Schedule cancelled", { timeout: 20000 });
  await page.screenshot({ path: `${OUT}/md-e2e-cancelled.png`, fullPage: true });
  console.log(JSON.stringify({ moment: "cancelled-from-queue", cancelledAt: new Date().toISOString() }));

  await new Promise((r) => setTimeout(r, fireAt.getTime() - Date.now() + 45_000));
  const { data: m } = await supabase
    .from("social_publish_manifest")
    .select("status")
    .eq("social_post_id", post!.id)
    .order("created_at", { ascending: false })
    .limit(1);
  const after = await stubCalls();
  console.log(
    JSON.stringify({
      moment: "cancel-proof",
      manifestStatus: m?.[0]?.status,
      stubCallsBefore: before,
      stubCallsAfterFireTime: after,
      releasedRunNoOp: m?.[0]?.status === "cancelled" && after === before,
    })
  );
  await browser.close();
  await supabase.from("social_account").delete().eq("creator_id", uid);
  await supabase.from("social_provider_profile").delete().eq("creator_id", uid);
  console.log("done —", email);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
