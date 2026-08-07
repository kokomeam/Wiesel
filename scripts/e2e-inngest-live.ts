/**
 * AC-MD.8 — the FIRST REAL DELIVERY PROOF: Inngest dev server + the local
 * Upload-Post stub (zero vendor traffic), driven through the real UI.
 *   1. seed creator + linked account + ready post
 *   2. queue → editor → connected scheduler → card modal → approve ~2 min out
 *   3. sleepUntil fires → manifest live → queue shows posted_api + link-out
 *   4. cancel-by-event: schedule a second post, cancel from the queue, wait
 *      past its fire time — the released run is a no-op (stub publish count
 *      unchanged, manifest stays cancelled)
 * Prereqs: stub on :4949, `npx inngest-cli dev`, `npm run dev` with
 * UPLOAD_POST_API_BASE=http://127.0.0.1:4949/api. Screenshots → screenshots/.
 */

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
  const email = `e2e-fire-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
    .insert({ creator_id: uid, provider: "upload_post", profile_ref_enc: encryptSecret("ws_e2e") })
    .throwOnError();
  await supabase
    .from("social_account")
    .insert({ creator_id: uid, provider: "upload_post", platform: "linkedin", status: "linked", display_name: "E2E Creator", handle: "@e2e", last_synced_at: new Date().toISOString() })
    .select("id")
    .single()
    .throwOnError();
  const { data: course } = await supabase
    .from("courses")
    .insert({ author_id: uid, title: "E2E course" })
    .select("id")
    .single()
    .throwOnError();
  const mkPost = async (body: string) =>
    (
      await supabase
        .from("social_post")
        .insert({
          creator_id: uid, course_id: course!.id, body, platform: "linkedin", post_type: "text",
          funnel_stage: "tofu", goal: "value", tone: "friendly", source_type: "manual",
          status: "ready", hashtags: ["e2e"],
        })
        .select("*")
        .single()
        .throwOnError()
    ).data!;
  const p1 = await mkPost("E2E delivery proof: this fires through Inngest sleepUntil.");
  const p2 = await mkPost("E2E cancel proof: this one gets cancelled from the queue.");

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
  await page.waitForSelector("text=E2E delivery proof", { timeout: 30000 });

  // Open the editor → connected scheduler → schedule ~2 min out.
  await page.getByText("E2E delivery proof", { exact: false }).first().click();
  await page.waitForSelector("text=Publish through a connected account", { timeout: 20000 });
  const fireAt = new Date(Date.now() + 2 * 60_000);
  const local = new Date(fireAt.getTime() - fireAt.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  const sched1 = page.locator("div", { hasText: "Publish through a connected account" }).last();
  await sched1.locator('input[type="datetime-local"]').fill(local);
  await sched1.getByRole("button", { name: "Schedule…" }).click();
  await page.waitForSelector("text=Exactly what ships", { timeout: 20000 });
  await page.screenshot({ path: `${OUT}/md-e2e-card-modal.png`, fullPage: false });
  const approvedAt = new Date();
  await page.getByRole("button", { name: "Approve & schedule" }).click();
  await page.waitForSelector("text=Approved — scheduled", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await page.reload();
  await page.waitForSelector("text=Scheduled ·", { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/md-e2e-scheduled-countdown.png`, fullPage: true });
  console.log(JSON.stringify({ moment: "approved+scheduled", approvedAt, scheduledFor: fireAt.toISOString() }));

  // Wait for sleepUntil delivery (fire + advance + verify edges).
  const deadline = Date.now() + 5 * 60_000;
  let live: { status: string; updated_at: string; post_url: string | null } | null = null;
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from("social_publish_manifest")
      .select("status,updated_at,post_url")
      .eq("social_post_id", p1.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data?.[0]?.status === "live") {
      live = data[0];
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!live) throw new Error("manifest never went live — check inngest dev server");
  const fireDelayMs = new Date(live.updated_at).getTime() - fireAt.getTime();
  console.log(
    JSON.stringify({
      moment: "LIVE",
      scheduledFor: fireAt.toISOString(),
      liveAt: live.updated_at,
      fireDelaySeconds: Math.round(fireDelayMs / 1000),
      postUrl: live.post_url,
      stubPublishCalls: await stubCalls(),
    })
  );
  await page.reload();
  await page.waitForSelector("text=Live via connected account", { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/md-e2e-live-linkout.png`, fullPage: true });

  // ── cancel-by-event proof ──
  await page.getByText("E2E cancel proof", { exact: false }).first().click();
  await page.waitForSelector("text=Publish through a connected account", { timeout: 20000 });
  const fire2 = new Date(Date.now() + 90_000);
  const local2 = new Date(fire2.getTime() - fire2.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const sched2 = page.locator("div", { hasText: "Publish through a connected account" }).last();
  await sched2.locator('input[type="datetime-local"]').fill(local2);
  await sched2.getByRole("button", { name: "Schedule…" }).click();
  await page.waitForSelector("text=Exactly what ships", { timeout: 20000 });
  await page.getByRole("button", { name: "Approve & schedule" }).click();
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await page.reload();
  await page.waitForSelector("text=Scheduled ·", { timeout: 30000 });
  const callsBeforeCancel = await stubCalls();
  await page.getByRole("button", { name: "Cancel" }).first().click();
  await page.waitForSelector("text=Schedule cancelled", { timeout: 20000 });
  console.log(JSON.stringify({ moment: "cancelled-from-queue", scheduledFor: fire2.toISOString() }));

  // Wait past the would-be fire time + margin: the released run must no-op.
  await new Promise((r) => setTimeout(r, fire2.getTime() - Date.now() + 45_000));
  const { data: m2 } = await supabase
    .from("social_publish_manifest")
    .select("status")
    .eq("social_post_id", p2.id)
    .order("created_at", { ascending: false })
    .limit(1);
  const callsAfter = await stubCalls();
  console.log(
    JSON.stringify({
      moment: "cancel-proof",
      manifestStatus: m2?.[0]?.status,
      stubCallsBeforeCancel: callsBeforeCancel,
      stubCallsAfterFireTime: callsAfter,
      releasedRunNoOp: m2?.[0]?.status === "cancelled" && callsAfter === callsBeforeCancel,
    })
  );
  await page.reload();
  await page.waitForSelector("text=Schedule cancelled", { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/md-e2e-cancelled.png`, fullPage: true });

  await browser.close();
  await supabase.from("social_account").delete().eq("creator_id", uid);
  await supabase.from("social_provider_profile").delete().eq("creator_id", uid);
  console.log("done — throwaway creator:", email);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
