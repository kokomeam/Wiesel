/**
 * screenshot-publish-cards — M-C checkpoint evidence → screenshots/:
 *   mc-01-text-card.png        text-post card (final text, account, fire time,
 *                              first comment + YouTube-unverified caveat n/a)
 *   mc-02-video-card.png       clip card with the inline player (signed URL)
 *   mc-03-batch-list.png       3 independent cards (j/k list, no approve-all)
 *   mc-04-reject-flow.png      a card after Skip (resolved state + post stays ready)
 *   mc-05-frozen-refusal.png   the source_superseded refusal on the request form
 *   mc-06-unpublish-confirm.png the unpublish valve's honesty confirm
 * All states SEEDED under a throwaway creator (labels in the checkpoint
 * report). No provider traffic (cards never call the vendor).
 * Prereqs: dev server :3000, temp playwright install.
 */

import { readFileSync, mkdirSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { requestPublishCard } from "@/lib/marketing/publish/approvalService";
import { createApprovalRequest } from "@/lib/marketing/publish/approvalRepository";
import {
  createPublishManifest,
  transitionPublishManifest,
} from "@/lib/marketing/publish/manifestRepository";
import { contentHashForPost } from "@/lib/marketing/publish/contentHash";
import { updatePostStatus } from "@/lib/marketing/social/repository";
import { encryptSecret } from "@/lib/marketing/accounts/crypto";

dns.setDefaultResultOrder("ipv4first");
const BASE = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
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
  const email = `mc-shot-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "test-password-1234";
  await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(await r.text());
  });
  const supabase = createClient<Database>(url, anon);
  const { data: auth, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !auth.user) throw new Error(`signin: ${error?.message}`);
  const uid = auth.user.id;

  await supabase
    .from("social_provider_profile")
    .insert({ creator_id: uid, provider: "upload_post", profile_ref_enc: encryptSecret("ws_shot") })
    .throwOnError();
  const { data: accts } = await supabase
    .from("social_account")
    .insert([
      { creator_id: uid, provider: "upload_post", platform: "linkedin", status: "linked", display_name: "Maya Chen", handle: "@maya-teaches", last_synced_at: new Date().toISOString() },
      { creator_id: uid, provider: "upload_post", platform: "youtube", status: "linked", display_name: "Maya Teaches CS", handle: "@mayateachescs", last_synced_at: new Date().toISOString() },
    ])
    .select("id,platform")
    .throwOnError();
  const li = accts!.find((a) => a.platform === "linkedin")!;
  const yt = accts!.find((a) => a.platform === "youtube")!;

  const post = async (over: Partial<Database["public"]["Tables"]["social_post"]["Insert"]>) => {
    const { data } = await supabase
      .from("social_post")
      .insert({
        creator_id: uid,
        body: "Most students think Big-O is about speed. It's about SCALING — here's the 90-second version that finally makes it click.",
        platform: "linkedin",
        post_type: "text",
        funnel_stage: "tofu",
        goal: "value",
        tone: "educational",
        source_type: "manual",
        status: "ready",
        cta: "Full lesson in my course — link in comments.",
        hashtags: ["bigO", "csEducation"],
        first_comment: "Course link: https://wisesel.example/learn/algorithms-101",
        ...over,
      })
      .select("*")
      .single()
      .throwOnError();
    return data!;
  };

  // 01 — text card (scheduled ~2 days out) + 03 batch companions.
  const p1 = await post({});
  const p2 = await post({ body: "Recursion isn't magic — it's a stack of promises your function makes to itself.", first_comment: null });
  const p3 = await post({ body: "The #1 sign you're ready for graphs: trees stopped scaring you.", first_comment: null });
  const twoDaysOut = new Date(Date.now() + 2 * 86400_000).toISOString();
  for (const [p, sched] of [
    [p1, twoDaysOut],
    [p2, null],
    [p3, null],
  ] as const) {
    const r = await requestPublishCard(supabase, uid, {
      socialPostId: p.id,
      socialAccountId: li.id,
      proposedScheduledFor: sched,
    });
    if (!r.ok) throw new Error(`card: ${r.reason}`);
  }

  // 02 — video card: upload a small real mp4 to clip-media for the player.
  const clipBytes = readFileSync(new URL("../artifacts/h-theta-hook-burn-demo.mp4", import.meta.url));
  const clipPath = `${uid}/shots/theta-demo.mp4`;
  // clip-media is admin-written in production (the render pipeline) — the
  // harness mirrors that with the service key.
  const admin = createClient<Database>(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const { error: upErr } = await admin.storage
    .from("clip-media")
    .upload(clipPath, clipBytes, { contentType: "video/mp4", upsert: true });
  if (upErr) throw new Error(`clip upload: ${upErr.message}`);
  const clipPost = await post({
    platform: "youtube_shorts",
    post_type: "clip",
    video_path: clipPath,
    body: "Theta(N) explained with one whiteboard moment.",
    first_comment: "Watch the full lesson — link in the description.",
    hashtags: ["algorithms"],
  });
  const rClip = await requestPublishCard(supabase, uid, {
    socialPostId: clipPost.id,
    socialAccountId: yt.id,
  });
  if (!rClip.ok) throw new Error(`clip card: ${rClip.reason}`);

  // 06 — a posted_api post with a live manifest (manufactured through the
  // repositories — the sole write paths).
  const livePost = await post({ body: "Already live on LinkedIn: the Big-O myth-buster.", first_comment: null });
  const liveApproval = await createApprovalRequest(supabase, {
    creatorId: uid,
    socialPostId: livePost.id,
    socialAccountId: li.id,
    platform: "linkedin",
    contentHash: contentHashForPost(livePost),
    kind: "retry",
    consumedAt: new Date().toISOString(),
  });
  const m0 = await createPublishManifest(supabase, {
    creatorId: uid,
    socialPostId: livePost.id,
    socialAccountId: li.id,
    platform: "linkedin",
    approvalId: liveApproval.id,
    contentHash: contentHashForPost(livePost),
  });
  const m1 = await transitionPublishManifest(supabase, m0, "queued", "submitting", {});
  const m2 = await transitionPublishManifest(supabase, m1, "submitting", "submitted", {
    providerRequestId: "shot-req",
    platformPostId: "urn:li:share:demo",
    postUrl: "https://www.linkedin.com/feed/update/urn:li:share:demo",
  });
  await transitionPublishManifest(supabase, m2, "submitted", "live", {});
  await updatePostStatus(supabase, livePost.id, "posted_api", new Date().toISOString());

  // 05 — frozen-source: full chain, newer take supersedes the job's.
  const { data: course } = await supabase.from("courses").insert({ author_id: uid, title: "Algo course" }).select("id").single().throwOnError();
  const { data: mod } = await supabase.from("modules").insert({ course_id: course!.id, title: "M1" }).select("id").single().throwOnError();
  const { data: lesson } = await supabase.from("lessons").insert({ course_id: course!.id, module_id: mod!.id, title: "Old take lesson" }).select("id").single().throwOnError();
  const mkTake = async (at: string) =>
    (await supabase.from("video_assets").insert({ course_id: course!.id, owner_id: uid, lesson_id: lesson!.id, status: "ready", mux_asset_id: `mux-${crypto.randomUUID().slice(0, 6)}`, created_at: at }).select("id").single().throwOnError()).data!.id;
  const oldTake = await mkTake("2026-07-20T10:00:00.000Z");
  const { data: transcript } = await supabase.from("lesson_transcript").insert({ creator_id: uid, lesson_id: lesson!.id, duration_seconds: 90, recording_format: "camera_only", source: "platform", text: "t", words: [] }).select("id").single().throwOnError();
  const { data: cand } = await supabase.from("clip_moment_candidate").insert({ creator_id: uid, lesson_id: lesson!.id, transcript_id: transcript!.id, request_id: crypto.randomUUID(), start_ms: 0, end_ms: 30000, rank: 1, moment_type: "concrete_win", funnel_stage: "tofu", hook_text: "h", rationale: "r", rubric_scores: {}, prompt_version: "clips-v3" }).select("id").single().throwOnError();
  const { data: job } = await supabase.from("clip_render_job").insert({ creator_id: uid, course_id: course!.id, lesson_id: lesson!.id, candidate_id: cand!.id, layout: "face_track", provider: "wisesel_ffmpeg", status: "completed", source: { videoAssetRowId: oldTake, sourceMuxAssetId: "m", playbackId: null, startMs: 0, endMs: 30000, recordingFormat: "camera_only" } }).select("id").single().throwOnError();
  await mkTake("2026-07-28T10:00:00.000Z"); // the re-record
  const frozenPost = await post({ platform: "youtube_shorts", post_type: "clip", video_path: clipPath, clip_job_id: job!.id, body: "Clip from the OLD take.", first_comment: null, hashtags: [] });

  /* ── drive the UI ── */
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  await page.goto(`${BASE}/login`, { timeout: 60000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|studio|marketing/, { timeout: 30000 }).catch(() => {});
  mkdirSync(OUT, { recursive: true });

  await page.goto(`${BASE}/marketing/publish`, { timeout: 60000 });
  await page.waitForSelector("text=Publish review", { timeout: 30000 });
  await page.waitForTimeout(1200);

  const cards = page.locator("[data-publish-card]");
  await cards.first().screenshot({ path: `${OUT}/mc-01-text-card.png` });
  console.log("saved mc-01-text-card.png");
  // The clip card is the youtube one — find by its body text.
  await page
    .locator("[data-publish-card]", { hasText: "Theta(N) explained" })
    .screenshot({ path: `${OUT}/mc-02-video-card.png` });
  console.log("saved mc-02-video-card.png");
  await page.screenshot({ path: `${OUT}/mc-03-batch-list.png`, fullPage: true });
  console.log("saved mc-03-batch-list.png");

  // 04 — Skip the recursion card and shoot the resolved state.
  const recursion = page.locator("[data-publish-card]", { hasText: "Recursion isn't magic" });
  await recursion.getByRole("button", { name: "Skip" }).click();
  await page.waitForSelector("text=Skipped — the post stays in Ready", { timeout: 15000 });
  await page
    .locator("div", { hasText: "Skipped — the post stays in Ready" })
    .last()
    .screenshot({ path: `${OUT}/mc-04-reject-flow.png` });
  console.log("saved mc-04-reject-flow.png");

  // 05 — frozen refusal via the request form.
  await page.selectOption("select >> nth=0", frozenPost.id);
  await page.selectOption("select >> nth=1", yt.id);
  await page.getByRole("button", { name: "Request card" }).click();
  await page.waitForSelector("text=Refused: source superseded", { timeout: 15000 });
  await page
    .locator("section", { hasText: "New review card" })
    .screenshot({ path: `${OUT}/mc-05-frozen-refusal.png` });
  console.log("saved mc-05-frozen-refusal.png");

  // 06 — unpublish confirm.
  await page.getByRole("button", { name: "Unpublish in WiseSel…" }).click();
  await page.waitForSelector("text=REMAINS LIVE", { timeout: 15000 });
  await page
    .locator("div.rounded-2xl", { hasText: "Already live on LinkedIn" })
    .last()
    .screenshot({ path: `${OUT}/mc-06-unpublish-confirm.png` });
  console.log("saved mc-06-unpublish-confirm.png");

  await browser.close();
  await supabase.from("social_account").delete().eq("creator_id", uid);
  await supabase.from("social_provider_profile").delete().eq("creator_id", uid);
  console.log("done — throwaway creator:", email);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
