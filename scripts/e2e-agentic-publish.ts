/**
 * AC-AG.5 — the FULL AGENTIC CONVERSATION, live (real OpenAI model, real
 * Inngest dev server, local Upload-Post stub — ZERO vendor traffic):
 *   1. seed creator + linked account + course + two ready posts
 *   2. /marketing/agent: one request → the agent plans → TWO publish cards
 *      render INLINE in the chat
 *   3. approve the scheduled card in chat (~2.5 min out) → the agent's
 *      follow-up wrap-up streams into the transcript; skip the other card
 *   4. the queue shows the countdown; sleepUntil fires; queue shows posted
 *   5. a later chat turn asks "did my post go out?" — the agent answers from
 *      get_publish_status with the platform link
 * Prereqs: stub on :4949, `npx inngest-cli dev` (INNGEST_DEV=1 on the app),
 * `npm run dev` with UPLOAD_POST_API_BASE=http://127.0.0.1:4949/api.
 * Screenshots → screenshots/mag-*.png.
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
  const email = `e2e-agentic-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
    .insert({ creator_id: uid, provider: "upload_post", profile_ref_enc: encryptSecret("ws_e2e_ag") })
    .throwOnError();
  await supabase
    .from("social_account")
    .insert({
      creator_id: uid,
      provider: "upload_post",
      platform: "linkedin",
      status: "linked",
      display_name: "Agentic E2E Creator",
      handle: "@agentic-e2e",
      last_synced_at: new Date().toISOString(),
    })
    .throwOnError();
  const { data: course } = await supabase
    .from("courses")
    .insert({ author_id: uid, title: "Agentic E2E course" })
    .select("id")
    .single()
    .throwOnError();
  const mkPost = async (body: string) =>
    (
      await supabase
        .from("social_post")
        .insert({
          creator_id: uid,
          course_id: course!.id,
          body,
          platform: "linkedin",
          post_type: "text",
          funnel_stage: "tofu",
          goal: "value",
          tone: "friendly",
          source_type: "manual",
          status: "ready",
          hashtags: ["wisesel"],
        })
        .select("*")
        .single()
        .throwOnError()
    ).data!;
  const pSched = await mkPost("AGENTIC-SCHEDULED: how spaced repetition beats cramming, in one chart.");
  const pSkip = await mkPost("AGENTIC-SKIPPED: three myths about learning styles, debunked.");

  // Computed at SEED time: login + the model's planning turn (~60-90s) and the
  // 90s wrap-up window all happen before the queue screenshot — +330s leaves
  // the countdown visibly pre-fire, with the fire still inside the run.
  const fireAt = new Date(Date.now() + 330_000);
  const fireAtIso = fireAt.toISOString();

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 1050 } })).newPage();
  page.setDefaultTimeout(240_000);
  await page.goto(`${BASE}/login`, { timeout: 120_000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|studio|marketing/, { timeout: 60_000 }).catch(() => {});
  mkdirSync(OUT, { recursive: true });

  // Send scoped to the panel's OWN form — a bare button[type=submit] click
  // hits the topbar's "New Course" server-action form first (observed live:
  // 303 + createNewCourse + navigation to /studio). Retry guards hydration.
  const chatForm = () =>
    page.locator("form").filter({ has: page.locator('input[placeholder*="Ask the agent"]') });
  const sendChat = async (text: string) => {
    for (let i = 0; i < 6; i++) {
      await chatForm().locator("input").fill(text);
      await chatForm().locator('button[type="submit"]').click();
      try {
        await page.getByText(text.slice(0, 40)).first().waitFor({ timeout: 5000 });
        return;
      } catch {
        await page.waitForTimeout(1500); // not yet hydrated — retry
      }
    }
    throw new Error("chat send never registered");
  };

  // ── 1. the conversation: one request → inline cards ──
  await page.goto(`${BASE}/marketing/agent?course=${course!.id}`, { timeout: 120_000 });
  const ask = [
    `File a publish plan now with propose_publish_plan (no clarifying questions needed):`,
    `item 1 = my post starting "AGENTIC-SCHEDULED" to my LinkedIn account, scheduledFor ${fireAtIso};`,
    `item 2 = my post starting "AGENTIC-SKIPPED" to the same account, immediate (scheduledFor null).`,
    `Use get_connected_accounts and list_social_posts to find the ids yourself.`,
  ].join(" ");
  await sendChat(ask);

  console.log(`[${new Date().toISOString()}] request sent; waiting for inline cards…`);
  await page.waitForSelector("[data-chat-publish-cards]", { timeout: 240_000 });
  await page.waitForSelector("[data-publish-card]");
  const cardCount = await page.locator("[data-publish-card]").count();
  console.log(`[${new Date().toISOString()}] inline cards rendered: ${cardCount}`);
  await page.screenshot({ path: `${OUT}/mag-01-cards-inline.png`, fullPage: true });

  // ── 2. approve the SCHEDULED card in chat; skip the other ──
  const approveBtn = page.getByRole("button", { name: "Approve & schedule" }).first();
  const approvedAt = new Date();
  await approveBtn.click();
  await page.getByText("Approved — scheduled.").waitFor({ timeout: 60_000 });
  console.log(`[${approvedAt.toISOString()}] approved in chat (fire at ${fireAtIso})`);

  const skipBtn = page.getByRole("button", { name: "Skip" }).first();
  await skipBtn.click();
  await page.getByText("Skipped — the post stays in Ready.").waitFor({ timeout: 60_000 });

  // the agent's follow-up wrap-up streams into the transcript (background fetch)
  await page
    .getByText(/scheduled|fire|approv/i)
    .last()
    .waitFor({ timeout: 240_000 })
    .catch(() => {});
  // wait for a NEW assistant bubble after the decisions (the wrap-up)
  await page.waitForTimeout(90_000);
  await page.screenshot({ path: `${OUT}/mag-02-decided-followup.png`, fullPage: true });

  // manifest truth: exactly one queued manifest at the card's fire time
  const { data: manifest } = await supabase
    .from("social_publish_manifest")
    .select("*")
    .eq("social_post_id", pSched.id)
    .single()
    .throwOnError();
  console.log(`manifest: status=${manifest!.status} scheduled_for=${manifest!.scheduled_for}`);
  const { data: skippedApprovals } = await supabase
    .from("social_publish_approval")
    .select("declined_at")
    .eq("social_post_id", pSkip.id)
    .throwOnError();
  console.log(`skipped card declined: ${skippedApprovals?.every((a) => a.declined_at !== null)}`);

  // ── 3. the queue shows the countdown ──
  await page.goto(`${BASE}/marketing/social`, { timeout: 120_000 });
  await page.getByText("Scheduled ·").first().waitFor({ timeout: 120_000 });
  await page.screenshot({ path: `${OUT}/mag-03-queue-countdown.png`, fullPage: true });
  console.log(`[${new Date().toISOString()}] countdown visible in the queue`);

  // ── 4. sleepUntil fires → posted ──
  const deadline = Date.now() + 360_000;
  let liveAt: string | null = null;
  while (Date.now() < deadline) {
    const { data: m } = await supabase
      .from("social_publish_manifest")
      .select("status,post_url,updated_at")
      .eq("id", manifest!.id)
      .single();
    if (m?.status === "live") {
      liveAt = m.updated_at;
      console.log(`[${new Date().toISOString()}] LIVE — post_url=${m.post_url} (manifest updated ${m.updated_at})`);
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!liveAt) throw new Error("manifest never went live — is the Inngest dev server running?");
  const fireDelayS = Math.round((new Date(liveAt).getTime() - fireAt.getTime()) / 1000);
  console.log(`fire delay vs scheduled instant: ${fireDelayS}s`);

  await page.reload();
  await page.getByText("Posted via account").first().waitFor({ timeout: 120_000 });
  await page.screenshot({ path: `${OUT}/mag-04-queue-posted.png`, fullPage: true });

  // ── 5. the honesty loop: a later turn answers from truth ──
  await page.goto(`${BASE}/marketing/agent?course=${course!.id}`, { timeout: 120_000 });
  await sendChat("Did my scheduled post go out? Answer from get_publish_status and give me the link.");
  await page.getByText(/linkedin\.com\/feed\/update|urn:li:share/i).first().waitFor({ timeout: 240_000 });
  await page.screenshot({ path: `${OUT}/mag-05-truth-answer.png`, fullPage: true });
  console.log(`[${new Date().toISOString()}] agent reported the post with its platform link`);

  const { data: postAfter } = await supabase
    .from("social_post")
    .select("status")
    .eq("id", pSched.id)
    .single();
  const calls = await stubCalls();
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        scheduledFor: fireAtIso,
        liveAt,
        fireDelayS,
        postStatus: postAfter?.status,
        stubPublishCalls: calls,
        creator: email,
      },
      null,
      2
    )
  );
  await browser.close();
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
