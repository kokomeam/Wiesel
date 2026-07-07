/**
 * Social Post Generator — INTEGRATION suite (live Supabase + the mock model,
 * no OpenAI key needed). Self-provisions throwaway users each run.
 *
 *   - happy path: generate 5 balanced drafts through executeMarketingTool →
 *     staged (reversible, NO approval card), 3/1/1 value-first, grounded in
 *     the fixture module, batch_order 1..5, spread_week planned times
 *     ascending, events on the single stream, promptVersion recorded
 *   - repair path: malformed first response → exactly ONE repair call → saved
 *   - repair-fail: double failure → typed error, NOTHING persisted,
 *     generation_failed event
 *   - lint-drop: the fabricated-result draft is dropped with a surfaced
 *     reason; clean drafts survive
 *   - template fallback: no model ⇒ grounded deterministic drafts
 *   - idempotency: same key replays the original batch, no new rows
 *   - rate limit: batch budget exhaustion → typed error
 *   - versioned writes: stale expectedVersion → 409-class conflict at both
 *     the repository and the tool layer; the agent-facing conflict message
 *     teaches re-read + re-apply
 *   - lifecycle: posted_manual stamps the timestamp; performance logging
 *     (one-tap qualitative) persists; logging on a draft is refused
 *   - soft delete only: archive + deleted_at; a raw DELETE is a no-op under
 *     RLS (the row survives)
 *   - reverts: rejecting the generate action archives the whole batch
 *     (composite snapshotter); rejecting a revision restores the body
 *     BYTE-FOR-BYTE
 *   - RLS matrix: creator B sees/edits NOTHING of creator A's
 *   - images: magic-byte finalize + platform-norm warning + path scoping +
 *     detach-keeps-object
 *   - voice profile: derives once, creator edit flips source, versions bump
 *   - the agent surface: a mock-model agent turn drives generation
 *     end-to-end with zero pauses (all tools reversible)
 *
 * Run: `npx tsx scripts/verify-social-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; on IPv6-broken networks (this dev
// machine's Clash setup) the TLS socket resets before the handshake. Pin
// IPv4-first — harmless everywhere else, load-bearing here.
dns.setDefaultResultOrder("ipv4first");

/** This network also drops connections sporadically mid-run. Retry transient
 *  TRANSPORT failures (never HTTP errors) so the suite is deterministic —
 *  test-only; production code is untouched. */
const retryingFetch: typeof fetch = async (input, init) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
};
import type { Database, Json } from "@/lib/database.types";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { runMarketingAgentTurn } from "@/lib/marketing/agent/loop";
import type { MarketingAgentEvent } from "@/lib/marketing/agent/events";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { executeMarketingTool, rejectMarketingAction } from "@/lib/marketing/tools";
import { MarketingToolError, type MarketingToolContext } from "@/lib/marketing/tools/types";
import {
  SocialGenerationError,
  SocialRateLimitError,
  SocialVersionConflictError,
} from "@/lib/marketing/social/errors";
import { ensureSocialVoiceProfile, generateSocialBatch } from "@/lib/marketing/social/generate";
import { finalizeImageAttachment, removeImageAttachment, SocialImageError } from "@/lib/marketing/social/images";
import {
  getSocialPost,
  listPostsForBatch,
  upsertSocialVoiceProfile,
  versionedUpdateSocialPost,
} from "@/lib/marketing/social/repository";
import type { GenerateRequest } from "@/lib/marketing/social/schemas";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

async function provisionUser(url: string, anon: string, tag: string) {
  const email = `social-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "test-password-1234";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup: ${await signup.text()}`);
  const supabase = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin: ${error?.message}`);
  return { supabase, userId: data.user.id, email };
}

/* ───────────────────────── model fixtures ──────────────────────────── */

const MODULE_NAME = "Wet-on-wet techniques";

function fixturePost(i: number, extra: Partial<Record<string, unknown>> = {}) {
  return {
    goal: "value",
    funnelStage: "tofu",
    tone: "friendly",
    body: `Draft ${i}: Most beginners think watercolor is about control. ${MODULE_NAME} teaches the opposite — you guide the water and the paper decides where the pigment blooms.`,
    cta: i > 3 ? "Take a look at the full curriculum." : null,
    hashtags: ["#watercolor", "#learntopaint"],
    suggestedImageIdea: "Photo of your palette mid-lesson, water still beading",
    ...extra,
  };
}

const VALID_BATCH_5 = { posts: [1, 2, 3, 4, 5].map((i) => fixturePost(i)) };

async function main() {
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY in .env.local");

  const A = await provisionUser(url, anon, "a");
  const B = await provisionUser(url, anon, "b");
  console.log("# provisioned two throwaway creators");

  // Fixture course with a real module + lesson (grounding + source pickers).
  const courseId = crypto.randomUUID();
  const moduleId = crypto.randomUUID();
  const lessonId = crypto.randomUUID();
  await A.supabase.from("courses").insert({
    id: courseId,
    author_id: A.userId,
    title: "Watercolor Foundations",
    description: "Learn transparent watercolor from first principles.",
    plan: {
      outcomes: ["Paint a controlled wet-on-wet wash"],
      prerequisites: [],
      teachingStyle: "warm and direct",
    } as unknown as Json,
  });
  await A.supabase.from("modules").insert({ id: moduleId, course_id: courseId, title: MODULE_NAME, order: 0 });
  await A.supabase
    .from("lessons")
    .insert({ id: lessonId, course_id: courseId, module_id: moduleId, title: "Loading the brush", order: 0 });

  const services = createMarketingServices();
  const ctxFor = (model?: ReturnType<typeof createMockModelClient>): MarketingToolContext => ({
    supabase: A.supabase as never,
    courseId,
    campaignId: null,
    ownerId: A.userId,
    services,
    model,
    requestedBy: "user",
  });
  const depsFor = (model?: ReturnType<typeof createMockModelClient>) => ({
    supabase: A.supabase as never,
    ownerId: A.userId,
    model,
    clock: services.clock,
    courseIdForEvents: courseId,
    rand: () => 0.5,
  });

  /* ───────────────── voice profile (seed deterministically) ─────────── */

  console.log("\n# voice profile");
  const voice = await ensureSocialVoiceProfile(depsFor(undefined));
  check("derives + persists on first use (deterministic, no key)", voice.version === 1 && voice.source === "derived");
  const again = await ensureSocialVoiceProfile(depsFor(undefined));
  check("second call reuses the stored profile (no re-derive)", again.version === 1 && again.id === voice.id);
  const edited = await upsertSocialVoiceProfile(A.supabase as never, A.userId, { ...voice.profile, bannedPhrases: ["game-changer", "rockstar"] }, "creator_edited");
  check("creator edit bumps version + flips source", edited.version === 2 && edited.source === "creator_edited");
  const voiceEvents = await A.supabase
    .from("analytics_event")
    .select("id")
    .eq("course_id", courseId)
    .eq("type", "social_voice_profile_derived");
  check("voice derivation landed on the single event stream", (voiceEvents.data ?? []).length >= 1);

  /* ─────────────────────────── happy path ────────────────────────────── */

  console.log("\n# happy path — 5 balanced drafts through the gate");
  const happyMock = createMockModelClient([], { structured: { social_post_batch: VALID_BATCH_5 } });
  const drafts: unknown[] = [];
  const out = await executeMarketingTool(
    "generate_social_post_drafts",
    {
      sourceType: "course",
      moduleId: null,
      lessonId: null,
      sourceText: null,
      platform: "linkedin",
      goal: null,
      funnelMix: "balanced",
      tone: "friendly",
      count: 5,
      timingPreset: "spread_week",
      customTimes: null,
      timeZone: "America/New_York",
      idempotencyKey: null,
    },
    { ...ctxFor(happyMock), progress: (e) => e.type === "draft" && drafts.push(e.data) }
  );
  check("reversible → staged, never an approval card", out.status === "staged" && out.actionId !== null);
  check("target is the batch (composite revert unit)", out.target?.entity === "social_post_batch");
  const happyBatchId = out.target!.id;
  const happyPosts = await listPostsForBatch(A.supabase as never, happyBatchId);
  check("5 posts persisted transactionally", happyPosts.length === 5);
  check("balanced mix 3/1/1, value-first ordering", happyPosts.map((p) => p.funnelStage).join(",") === "tofu,tofu,tofu,mofu,bofu");
  check("batch_order 1..5", happyPosts.map((p) => p.batchOrder).join(",") === "1,2,3,4,5");
  check("grounded: the real module name appears in every body", happyPosts.every((p) => p.body.includes(MODULE_NAME)));
  check("plan overrides model slot metadata (mofu slot = pain_point)", happyPosts[3].goal === "pain_point");
  check("spread_week planned times set + ascending",
    happyPosts.every((p) => p.plannedPostAt !== null) &&
      happyPosts.every((p, i) => i === 0 || Date.parse(p.plannedPostAt!) > Date.parse(happyPosts[i - 1].plannedPostAt!))
  );
  check("promptVersion recorded on every post", happyPosts.every((p) => p.aiMetadata.promptVersion === "social-v1"));
  check("drafts streamed incrementally via progress", drafts.length === 5);
  const genEvents = await A.supabase
    .from("analytics_event")
    .select("type")
    .eq("course_id", courseId)
    .in("type", ["social_post_batch_generated", "social_post_created"]);
  check(
    "events: 1 batch_generated + 5 created on the single stream",
    (genEvents.data ?? []).filter((e) => e.type === "social_post_batch_generated").length === 1 &&
      (genEvents.data ?? []).filter((e) => e.type === "social_post_created").length === 5
  );

  /* ─────────────────────────── repair path ───────────────────────────── */

  console.log("\n# repair path — exactly one repair call");
  const repairMock = createMockModelClient([], {
    structured: { social_post_batch: "{not valid json", social_post_batch_repair: VALID_BATCH_5 },
  });
  const repairResult = await generateSocialBatch(depsFor(repairMock), {
    sourceType: "course",
    courseId,
    platform: "linkedin",
    funnelMix: "balanced",
    tone: "friendly",
    count: 5,
    timingPreset: "none",
  } as GenerateRequest);
  check("repaired batch persists", repairResult.posts.length === 5 && repairResult.repairUsed);
  const repairCalls = repairMock.getCalls().filter((c) => c.responseFormat?.name === "social_post_batch_repair");
  check("exactly ONE repair call was made", repairCalls.length === 1, `got ${repairCalls.length}`);
  check("batch ai_metadata records repairUsed", repairResult.batch.aiMetadata.repairUsed === true);

  console.log("\n# repair-fail — typed error, nothing persisted");
  const { count: batchesBefore } = await A.supabase
    .from("social_post_batch")
    .select("id", { count: "exact", head: true });
  const failMock = createMockModelClient([], {
    structured: { social_post_batch: "{bad", social_post_batch_repair: "{still bad" },
  });
  let failErr: unknown = null;
  try {
    await generateSocialBatch(depsFor(failMock), {
      sourceType: "course",
      courseId,
      platform: "linkedin",
      funnelMix: "pinned",
      goal: "value",
      tone: "friendly",
      count: 3,
      timingPreset: "none",
    } as GenerateRequest);
  } catch (e) {
    failErr = e;
  }
  check("double failure → SocialGenerationError(repair)", failErr instanceof SocialGenerationError && failErr.stage === "repair");
  const { count: batchesAfter } = await A.supabase
    .from("social_post_batch")
    .select("id", { count: "exact", head: true });
  check("NOTHING was persisted", batchesAfter === batchesBefore);
  const failEvents = await A.supabase
    .from("analytics_event")
    .select("props")
    .eq("course_id", courseId)
    .eq("type", "social_post_generation_failed");
  check("generation_failed event recorded with its stage", (failEvents.data ?? []).some((e) => (e.props as { stage?: string }).stage === "repair"));

  /* ─────────────────────────── lint drop ─────────────────────────────── */

  console.log("\n# safety-lint drop — the dirty draft is removed, clean survives");
  const dirtyBatch = {
    posts: [
      fixturePost(1),
      fixturePost(2, { body: "Students achieved 300 point gains in two weeks with this simple trick from the course. Amazing outcomes await everyone." }),
    ],
  };
  const lintMock = createMockModelClient([], {
    structured: { social_post_batch: dirtyBatch, social_post_batch_repair: dirtyBatch },
  });
  const lintResult = await generateSocialBatch(depsFor(lintMock), {
    sourceType: "course",
    courseId,
    platform: "linkedin",
    funnelMix: "pinned",
    goal: "value",
    tone: "friendly",
    count: 2,
    timingPreset: "none",
  } as GenerateRequest);
  check("clean draft saved, dirty dropped", lintResult.posts.length === 1 && lintResult.dropped.length === 1);
  check("drop reason is creator-readable", lintResult.dropped[0].reason.includes("student result"));

  /* ─────────────────────── template fallback ─────────────────────────── */

  console.log("\n# template fallback — the zero-key path stays whole");
  const tplResult = await generateSocialBatch(depsFor(undefined), {
    sourceType: "course",
    courseId,
    platform: "facebook",
    funnelMix: "balanced",
    tone: "friendly",
    count: 3,
    timingPreset: "none",
  } as GenerateRequest);
  check("fallback persists grounded drafts", tplResult.via === "template-fallback" && tplResult.posts.length === 3);
  check("fallback bodies reference the course", tplResult.posts.some((p) => p.body.includes("Watercolor Foundations")));
  check("facebook hashtag cap respected", tplResult.posts.every((p) => p.hashtags.length <= 3));

  /* ───────────────────────── idempotency ─────────────────────────────── */

  console.log("\n# idempotency — a replay returns the ORIGINAL batch");
  const idemKey = `itest-${crypto.randomUUID().slice(0, 8)}`;
  const idemMock = () => createMockModelClient([], { structured: { social_post_batch: VALID_BATCH_5 } });
  const first = await generateSocialBatch(depsFor(idemMock()), {
    sourceType: "course", courseId, platform: "linkedin", funnelMix: "pinned", goal: "launch", tone: "friendly", count: 2, timingPreset: "none",
  } as GenerateRequest, { idempotencyKey: idemKey });
  const replay = await generateSocialBatch(depsFor(idemMock()), {
    sourceType: "course", courseId, platform: "linkedin", funnelMix: "pinned", goal: "launch", tone: "friendly", count: 2, timingPreset: "none",
  } as GenerateRequest, { idempotencyKey: idemKey });
  check("same key → same batch, flagged replayed", replay.replayed && replay.batch.id === first.batch.id);
  check("replay returns the original posts", replay.posts.length === first.posts.length);

  console.log("\n# DB layer of the 4-layer count cap");
  const { error: rpcErr } = await A.supabase.rpc("social_create_batch", {
    p_batch: { source_type: "manual", platform: "linkedin", requested_count: 5 } as Json,
    p_posts: Array.from({ length: 6 }, () => ({ goal: "value", funnel_stage: "tofu", tone: "friendly", body: "x".repeat(40), hashtags: [] })) as Json,
  });
  check("RPC rejects a 6-post batch", rpcErr !== null && rpcErr.message.includes("1-5"));

  /* ─────────────────────────── rate limit ────────────────────────────── */

  console.log("\n# rate limit — typed 429-class error");
  process.env.SOCIAL_MAX_BATCHES_PER_DAY = "1";
  let rateErr: unknown = null;
  try {
    await generateSocialBatch(depsFor(idemMock()), {
      sourceType: "course", courseId, platform: "linkedin", funnelMix: "pinned", goal: "value", tone: "friendly", count: 1, timingPreset: "none",
    } as GenerateRequest);
  } catch (e) {
    rateErr = e;
  }
  delete process.env.SOCIAL_MAX_BATCHES_PER_DAY;
  check("budget exhaustion → SocialRateLimitError('batches')", rateErr instanceof SocialRateLimitError && rateErr.kind === "batches");

  /* ─────────────────── versioned writes + 409 protocol ───────────────── */

  console.log("\n# versioned writes — stale versions never overwrite");
  const target = happyPosts[0];
  const v2 = await versionedUpdateSocialPost(A.supabase as never, target.id, target.version, { body: `${target.body} (edited)` });
  check("legal update bumps version", v2.version === target.version + 1);
  let conflict: unknown = null;
  try {
    await versionedUpdateSocialPost(A.supabase as never, target.id, target.version, { body: "stale write" });
  } catch (e) {
    conflict = e;
  }
  check("stale expectedVersion → SocialVersionConflictError", conflict instanceof SocialVersionConflictError);
  const fresh = await getSocialPost(A.supabase as never, target.id);
  check("the stale write changed nothing", fresh?.body === v2.body && fresh?.version === v2.version);

  let toolConflict: unknown = null;
  try {
    await executeMarketingTool(
      "update_social_post",
      { postId: target.id, expectedVersion: 1, body: "stale tool write", cta: null, hashtags: null, imageAltText: null, audience: null, funnelStage: null, goal: null, tone: null, suggestedImageIdea: null, plannedPostAt: null, clearNulls: null },
      ctxFor()
    );
  } catch (e) {
    toolConflict = e;
  }
  check(
    "tool-layer conflict teaches re-read + re-apply",
    toolConflict instanceof MarketingToolError && toolConflict.message.includes("re-read") && toolConflict.message.includes("Never overwrite"),
    String(toolConflict)
  );

  /* ──────────────── lifecycle + performance + soft delete ────────────── */

  console.log("\n# lifecycle, performance, soft delete");
  const lifecyclePost = happyPosts[1];
  let perfEarly: unknown = null;
  try {
    await executeMarketingTool("log_social_post_performance", { postId: lifecyclePost.id, impressions: 100, likes: null, comments: null, shares: null, clicks: null, qualitative: null }, ctxFor());
  } catch (e) {
    perfEarly = e;
  }
  check("performance on a draft is refused", perfEarly instanceof MarketingToolError && perfEarly.message.includes("posted_manual"));

  await executeMarketingTool("mark_social_post_status", { postId: lifecyclePost.id, status: "ready" }, ctxFor());
  await executeMarketingTool("mark_social_post_status", { postId: lifecyclePost.id, status: "posted_manual" }, ctxFor());
  const posted = await getSocialPost(A.supabase as never, lifecyclePost.id);
  check("posted_manual stamps postedManuallyAt", posted?.status === "posted_manual" && posted.postedManuallyAt !== null);

  await executeMarketingTool("log_social_post_performance", { postId: lifecyclePost.id, impressions: null, likes: null, comments: null, shares: null, clicks: null, qualitative: "good" }, ctxFor());
  const withPerf = await getSocialPost(A.supabase as never, lifecyclePost.id);
  check("one-tap qualitative log persists per schema", withPerf?.performance?.qualitative === "good" && withPerf.performance.source === "manual");

  const delTarget = happyPosts[2];
  await executeMarketingTool("delete_social_post", { postId: delTarget.id }, ctxFor());
  const deleted = await getSocialPost(A.supabase as never, delTarget.id);
  check("delete is SOFT (archived + deleted_at)", deleted?.status === "archived" && deleted.deletedAt !== null);
  await A.supabase.from("social_post").delete().eq("id", delTarget.id);
  const survivor = await getSocialPost(A.supabase as never, delTarget.id);
  check("a raw DELETE is a no-op under RLS — the row survives", survivor !== null);

  /* ───────────────────────────── reverts ─────────────────────────────── */

  console.log("\n# reverts — the gate's revert log actually reverts");
  const reviseMock = createMockModelClient([], {
    structured: {
      social_post_revision: {
        body: "A punchier take: stop trying to control watercolor. Wet-on-wet techniques reward the painter who lets the water lead the way across the paper.",
        cta: null,
        hashtags: ["#watercolor"],
        suggestedImageIdea: null,
      },
    },
  });
  const reviseTarget = await getSocialPost(A.supabase as never, happyPosts[4].id);
  const bodyBefore = reviseTarget!.body;
  const reviseOut = await executeMarketingTool(
    "revise_social_post",
    { postId: reviseTarget!.id, expectedVersion: reviseTarget!.version, instruction: "punchier" },
    ctxFor(reviseMock)
  );
  check("revision staged + applied", reviseOut.status === "staged");
  const revised = await getSocialPost(A.supabase as never, reviseTarget!.id);
  check("body changed + version bumped", revised!.body !== bodyBefore && revised!.version === reviseTarget!.version + 1);
  const revisionEvents = await A.supabase
    .from("analytics_event").select("id").eq("course_id", courseId).eq("type", "social_post_revised_by_agent");
  check("revision event recorded", (revisionEvents.data ?? []).length >= 1);

  await rejectMarketingAction(A.supabase as never, reviseOut.actionId!);
  const restored = await getSocialPost(A.supabase as never, reviseTarget!.id);
  check("revert restores the body BYTE-FOR-BYTE", restored!.body === bodyBefore, `got: ${restored!.body.slice(0, 60)}`);

  await rejectMarketingAction(A.supabase as never, out.actionId!);
  const afterBatchRevert = await listPostsForBatch(A.supabase as never, happyBatchId);
  check(
    "reverting the generate action archives the whole batch (soft-delete-only)",
    afterBatchRevert.every((p) => p.deletedAt !== null && p.status === "archived")
  );

  /* ─────────────────────────── RLS matrix ────────────────────────────── */

  console.log("\n# RLS matrix — creator B is blind to creator A");
  const anyPostId = repairResult.posts[0].id;
  const bRead = await B.supabase.from("social_post").select("id").eq("id", anyPostId);
  check("B cannot read A's posts", (bRead.data ?? []).length === 0);
  const bUpdate = await B.supabase.from("social_post").update({ body: "hijack" }).eq("id", anyPostId).select("id");
  check("B cannot update A's posts", (bUpdate.data ?? []).length === 0);
  const bInsert = await B.supabase.from("social_post").insert({
    creator_id: A.userId, source_type: "manual", platform: "linkedin", goal: "value",
    funnel_stage: "tofu", tone: "friendly", body: "forged row for creator A",
  } as never);
  check("B cannot insert rows as A", bInsert.error !== null);
  const bBatch = await B.supabase.from("social_post_batch").select("id").eq("id", repairResult.batch.id);
  check("B cannot read A's batches", (bBatch.data ?? []).length === 0);
  const bVoice = await B.supabase.from("social_voice_profile").select("id").eq("creator_id", A.userId);
  check("B cannot read A's voice profile", (bVoice.data ?? []).length === 0);

  /* ────────────────────────────── images ─────────────────────────────── */

  console.log("\n# images — magic-byte finalize, path scoping, detach");
  const imgPost = repairResult.posts[0];
  const pngBytes = new Uint8Array(24);
  pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  pngBytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(pngBytes.buffer).setUint32(16, 1200);
  new DataView(pngBytes.buffer).setUint32(20, 627);
  const imgPath = `${A.userId}/social/${imgPost.id}/${crypto.randomUUID()}.png`;
  const up = await A.supabase.storage.from("social-post-images").upload(imgPath, pngBytes.buffer, { contentType: "image/png" });
  check("own-folder upload allowed by storage RLS", up.error === null, up.error?.message);

  const finDeps = { supabase: A.supabase as never, ownerId: A.userId, courseIdForEvents: courseId };
  const finalized = await finalizeImageAttachment(finDeps, { post: imgPost, storagePath: imgPath, altText: "A watercolor palette mid-wash" });
  check("finalize attaches + reads dims by magic bytes", finalized.post.imageStoragePath === imgPath && finalized.meta.width === 1200);
  check("norm-matching image → no warning", finalized.warning === null);
  let badPath: unknown = null;
  try {
    await finalizeImageAttachment(finDeps, { post: imgPost, storagePath: `${A.userId}/social/other-post/x.png`, altText: null });
  } catch (e) {
    badPath = e;
  }
  check("wrong-post path refused", badPath instanceof SocialImageError);
  const detached = await removeImageAttachment(finDeps, imgPost.id);
  check("detach clears the reference", detached.imageStoragePath === null);
  const stillThere = await A.supabase.storage.from("social-post-images").download(imgPath);
  check("the object is RETAINED after detach (revert-friendly)", stillThere.error === null);
  const imgEvents = await A.supabase
    .from("analytics_event").select("type").eq("course_id", courseId)
    .in("type", ["social_post_image_attached", "social_post_image_removed"]);
  check("image events recorded", (imgEvents.data ?? []).length >= 2);

  /* ─────────────────────── the agent surface ─────────────────────────── */

  console.log("\n# agent surface — a mock agent turn generates end-to-end, zero pauses");
  const agentMock = createMockModelClient(
    [
      {
        toolCalls: [
          {
            name: "generate_social_post_drafts",
            arguments: {
              sourceType: "course", moduleId: null, lessonId: null, sourceText: null,
              platform: "linkedin", goal: null, funnelMix: "balanced", tone: "friendly",
              count: 3, timingPreset: "none", customTimes: null, timeZone: null, idempotencyKey: null,
            },
          },
        ],
      },
      { text: "Done — 3 LinkedIn drafts are in your queue (2 value posts, 1 benefit post, value first). They're drafts: review, copy, and post them yourself." },
    ],
    { structured: { social_post_batch: VALID_BATCH_5 } }
  );
  const events: MarketingAgentEvent[] = [];
  await runMarketingAgentTurn({
    supabase: A.supabase as never,
    model: agentMock,
    courseId,
    campaignId: null,
    ownerId: A.userId,
    conversationId: null,
    userMessage: "Generate 3 posts for my course, mostly value posts.",
    services,
    emit: (e) => events.push(e),
  });
  const toolResults = events.filter((e) => e.type === "tool_result");
  check("the agent ran the generate tool", toolResults.length >= 1);
  check("no pause — reversible tools never block", !events.some((e) => e.type === "agent_blocked"));
  const doneEvent = events.find((e) => e.type === "done");
  check("the run completed", doneEvent !== undefined);

  /* ────────────────────────────── done ───────────────────────────────── */

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
