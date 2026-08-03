/** M-D queue-state screenshots (seeded via the repository single-write
 *  paths; labels in the report): held / failed+retry / platform_failed /
 *  voided / posted_api + history drawer / unhealthy-account scheduler /
 *  (dev banner captured separately with Inngest down). */
import { readFileSync, mkdirSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { encryptSecret } from "@/lib/marketing/accounts/crypto";
import { contentHashForPost } from "@/lib/marketing/publish/contentHash";
import { createApprovalRequest } from "@/lib/marketing/publish/approvalRepository";
import {
  createPublishManifest,
  transitionPublishManifest,
} from "@/lib/marketing/publish/manifestRepository";
import { updatePostStatus } from "@/lib/marketing/social/repository";

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

async function main() {
  const { url, anon } = loadEnv();
  const email = `md-shot-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
    .insert({ creator_id: uid, provider: "upload_post", profile_ref_enc: encryptSecret("ws_md") })
    .throwOnError();
  const { data: acct } = await supabase
    .from("social_account")
    .insert({ creator_id: uid, provider: "upload_post", platform: "linkedin", status: "expired", display_name: "Maya Chen", handle: "@maya-teaches", last_synced_at: new Date().toISOString() })
    .select("id")
    .single()
    .throwOnError();
  const { data: course } = await supabase.from("courses").insert({ author_id: uid, title: "MD course" }).select("id").single().throwOnError();
  const mkPost = async (body: string) =>
    (
      await supabase
        .from("social_post")
        .insert({
          creator_id: uid, course_id: course!.id, body, platform: "linkedin", post_type: "text",
          funnel_stage: "tofu", goal: "value", tone: "friendly", source_type: "manual",
          status: "ready", hashtags: ["wisesel"],
        })
        .select("*")
        .single()
        .throwOnError()
    ).data!;

  const seed = async (
    body: string,
    drive: (m: Awaited<ReturnType<typeof createPublishManifest>>) => Promise<void>
  ) => {
    const post = await mkPost(body);
    const approval = await createApprovalRequest(supabase, {
      creatorId: uid,
      socialPostId: post.id,
      socialAccountId: acct!.id,
      platform: "linkedin",
      contentHash: contentHashForPost(post),
      kind: "retry",
      consumedAt: new Date().toISOString(),
    });
    const m = await createPublishManifest(supabase, {
      creatorId: uid,
      socialPostId: post.id,
      socialAccountId: acct!.id,
      platform: "linkedin",
      approvalId: approval.id,
      contentHash: contentHashForPost(post),
    });
    await drive(m);
    return post;
  };

  await seed("Held example: the source lesson was re-recorded after this clip rendered.", async (m) => {
    await transitionPublishManifest(supabase, m, "queued", "held", { holdReason: "source_superseded" });
  });
  await seed("Failed example: the network dropped mid-call — retry needs no new card.", async (m) => {
    const s = await transitionPublishManifest(supabase, m, "queued", "submitting", {});
    await transitionPublishManifest(supabase, s, "submitting", "failed", {
      lastError: { message: "ambiguous submit: the publish call's outcome could not be confirmed" },
      bumpAttempt: true,
    });
  });
  await seed("Platform-rejected example: LinkedIn refused the duplicate.", async (m) => {
    const s = await transitionPublishManifest(supabase, m, "queued", "submitting", {});
    await transitionPublishManifest(supabase, s, "submitting", "platform_failed", {
      lastError: { message: "Duplicate post detected" },
    });
  });
  await seed("Voided example: edited after approval — needs a fresh review.", async (m) => {
    await transitionPublishManifest(supabase, m, "queued", "voided", {
      lastError: { message: "approval voided (post_edited)" },
    });
  });
  const livePost = await seed("Live example: open its publish history for the retry lineage.", async (m) => {
    const s = await transitionPublishManifest(supabase, m, "queued", "submitting", {});
    const s2 = await transitionPublishManifest(supabase, s, "submitting", "submitted", {
      providerRequestId: "shot-req",
      platformPostId: "urn:li:share:md-demo",
      postUrl: "https://www.linkedin.com/feed/update/urn:li:share:md-demo",
    });
    await transitionPublishManifest(supabase, s2, "submitted", "live", {});
  });
  await updatePostStatus(supabase, livePost.id, "posted_api", new Date().toISOString());

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1400 } })).newPage();
  await page.goto(`${BASE}/login`, { timeout: 60000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|studio|marketing/, { timeout: 30000 }).catch(() => {});
  mkdirSync(OUT, { recursive: true });

  await page.goto(`${BASE}/marketing/social`, { timeout: 150000, waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Held — the source lesson was re-recorded", { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/md-queue-states.png`, fullPage: true });
  console.log("saved md-queue-states.png");

  await page.getByRole("button", { name: "History" }).first().click();
  await page.waitForSelector("text=Publish history", { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/md-history-drawer.png`, fullPage: false });
  console.log("saved md-history-drawer.png");
  await page.getByRole("button", { name: "Close" }).click();

  // Unhealthy account: the editor's scheduler shows the re-link prompt.
  await page.getByText("Failed example", { exact: false }).first().click();
  await page.waitForSelector("text=needs re-linking first", { timeout: 20000 });
  await page
    .locator("div", { hasText: "Publish through a connected account" })
    .last()
    .screenshot({ path: `${OUT}/md-unhealthy-account.png` });
  console.log("saved md-unhealthy-account.png");

  await browser.close();
  await supabase.from("social_account").delete().eq("creator_id", uid);
  await supabase.from("social_provider_profile").delete().eq("creator_id", uid);
  console.log("done —", email);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
