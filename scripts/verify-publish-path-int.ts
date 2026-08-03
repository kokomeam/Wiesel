/**
 * verify-publish-path-int — M-C approval governance + the M-B workflow vs
 * LIVE Supabase (fake provider — zero Upload-Post traffic). Requires
 * migrations 20260729100000 + 20260729140000 and SOCIAL_ACCOUNTS_ENC_KEY.
 * Run: npx tsx scripts/verify-publish-path-int.ts
 *
 *   ac1.spec   — card-SOLE-path bypass matrix (repo assert, DB FK, unconsumed
 *                approval, garbage/replayed/expired/foreign tokens)
 *   ac2.spec   — byte-identity: card text === publish() title === compose()
 *   ac3.spec   — batch = N independent tokens; one approve consumes one
 *   lifecycle  — approve → queued → sync accept → submitted+refs+ONE ledger
 *                row → live → post stamped posted_api (amendment 3)
 *   async/platform/permanent/ambiguous/replay — the M-B chaos list under
 *                card-created manifests (incl. NEVER-re-fire + grace)
 *   ac5.spec   — edit-voids both directions: eager hook, stale-hash belt,
 *                DB voided-immutability trigger, fresh-card-after-edit,
 *                retry-without-fresh-card (amendment: approval-linked clone)
 *   guards     — quota/health/window holds self-heal (card manifests)
 *   control    — cancel/reschedule legality + races
 *   ac7.spec   — frozen-source fence at token mint AND pre-submit
 *                (held source_superseded) via a real course→lesson→takes chain
 *   ac6.spec   — AUTO mode + a policy opting the tool in still yields a
 *                pending card and ZERO manifests (hard-deny)
 *   agentic.spec — M-AG (needs migration 20260731100000): a mock-model agent
 *                turn in AUTO mode files inline cards (publish_cards event,
 *                agent-requested, conversation-threaded) with ZERO manifests
 *                (AC-AG.1 + hard-deny belt); chat-card byte-identity through
 *                to publish() (AC-AG.2); cross-surface single-use tokens both
 *                directions (AC-AG.3); the honesty loop — same-conversation
 *                follow-up, truth-sourced status answers, failure → explained
 *                → A2-clone retry, policy-opted cancel (AC-AG.4)
 *   ac8.spec   — unpublish valve: zero provider calls, honest state + copy
 *   rls.spec   — approvals + manifests isolation; owner can't delete either
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";

dns.setDefaultResultOrder("ipv4first");

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

import type { Database } from "@/lib/database.types";
import type {
  ProviderRecentPost,
  PublishAccepted,
  PublishInput,
  SocialPublishProvider,
  VerifyPostResult,
} from "@/lib/marketing/publish/provider/types";
import { encryptSecret } from "@/lib/marketing/accounts/crypto";
import { contentHashForPost } from "@/lib/marketing/publish/contentHash";
import { composePublishText } from "@/lib/marketing/publish/manifest";
import {
  createApprovalRequest,
  getApproval,
  listOpenApprovals,
} from "@/lib/marketing/publish/approvalRepository";
import {
  approvePublishCard,
  mintCardToken,
  rejectPublishCard,
  requestPublishCard,
} from "@/lib/marketing/publish/approvalService";
import {
  createPublishManifest,
  getPublishManifest,
  reschedulePublishManifest,
  transitionPublishManifest,
  type PublishManifest,
} from "@/lib/marketing/publish/manifestRepository";
import {
  cancelPublishManifest,
  processPublishTick,
  retryPublishManifest,
  unpublishLocally,
  type PublishTickDeps,
} from "@/lib/marketing/publish/publishService";
import { versionedUpdateSocialPost } from "@/lib/marketing/social/repository";
import { executeMarketingTool } from "@/lib/marketing/tools/index";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { runMarketingAgentTurn } from "@/lib/marketing/agent/loop";
import { resumeAgentAfterPublishDecision } from "@/lib/marketing/agent/resume";
import type { MarketingAgentEvent } from "@/lib/marketing/agent/events";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  };
}

async function provisionUser(url: string, anon: string, tag: string) {
  const email = `mc-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

const acceptedSync = (over: Partial<PublishAccepted> = {}): PublishAccepted => ({
  mode: "sync",
  providerRequestId: "req-sync",
  providerJobId: null,
  platformPostId: "plat-1",
  postUrl: "https://platform.example/1",
  platformError: null,
  usage: null,
  ...over,
});

function makeFakeProvider() {
  const calls = { publish: 0, verify: 0, history: 0, delete: 0, comments: 0 };
  let publishImpl: (input: PublishInput) => Promise<PublishAccepted> = async () => acceptedSync();
  let verifyImpl: () => Promise<VerifyPostResult> = async () => ({
    state: "pending",
    platformPostId: null,
    postUrl: null,
    error: null,
  });
  let recent: ProviderRecentPost[] = [];
  let lastInput: PublishInput | null = null;
  const provider: SocialPublishProvider = {
    id: "upload_post",
    async createCreatorProfile(profileRef) {
      return { profileRef, created: true };
    },
    async getLinkUrl() {
      return { url: "https://mock.link", expiresInHours: 48 };
    },
    async listConnectedAccounts() {
      return [];
    },
    async publish(input) {
      calls.publish++;
      lastInput = input;
      return publishImpl(input);
    },
    async verifyPost() {
      calls.verify++;
      return verifyImpl();
    },
    async listRecentPosts() {
      calls.history++;
      return recent;
    },
    async deletePost() {
      calls.delete++;
      return { deleted: false, reason: "unsupported_by_provider" };
    },
    async getComments() {
      calls.comments++;
      return [];
    },
  };
  return {
    provider,
    calls,
    lastInput: () => lastInput,
    setPublish: (fn: typeof publishImpl) => (publishImpl = fn),
    setVerify: (fn: typeof verifyImpl) => (verifyImpl = fn),
    setRecent: (rows: ProviderRecentPost[]) => (recent = rows),
  };
}

const IN_WINDOW = "2026-07-28T09:30:00.000Z"; // Tuesday 09:30 UTC
const OUT_WINDOW = "2026-07-28T23:00:00.000Z";
const NEXT_MONTH = "2026-08-03T09:30:00.000Z"; // Monday

async function main() {
  const { url, anon } = loadEnv();
  console.log("verify-publish-path-int — M-C governance vs live Supabase\n");

  const A = await provisionUser(url, anon, "a");
  const B = await provisionUser(url, anon, "b");
  console.log(`  creators: A=${A.userId.slice(0, 8)} B=${B.userId.slice(0, 8)}\n`);

  await A.supabase
    .from("social_provider_profile")
    .insert({ creator_id: A.userId, provider: "upload_post", profile_ref_enc: encryptSecret("ws_mc_a") })
    .throwOnError();
  const { data: accountRows } = await A.supabase
    .from("social_account")
    .insert([
      { creator_id: A.userId, provider: "upload_post", platform: "linkedin", status: "linked", last_synced_at: IN_WINDOW },
      { creator_id: A.userId, provider: "upload_post", platform: "youtube", status: "linked", last_synced_at: IN_WINDOW },
    ])
    .select("id,platform")
    .throwOnError();
  const li = accountRows!.find((r) => r.platform === "linkedin")!;
  const yt = accountRows!.find((r) => r.platform === "youtube")!;

  const post = async (over: Partial<Database["public"]["Tables"]["social_post"]["Insert"]> = {}) => {
    const { data } = await A.supabase
      .from("social_post")
      .insert({
        creator_id: A.userId,
        body: over.body ?? `Governance check ${crypto.randomUUID().slice(0, 8)}`,
        platform: "linkedin",
        post_type: "text",
        funnel_stage: "tofu",
        goal: "value",
        tone: "friendly",
        source_type: "manual",
        status: "ready",
        hashtags: ["wisesel"],
        ...over,
      })
      .select("*")
      .single()
      .throwOnError();
    return data!;
  };

  const fake = makeFakeProvider();
  const deps: PublishTickDeps = { supabase: A.supabase, provider: fake.provider, nowIso: () => IN_WINDOW };
  const tick = (d: PublishTickDeps = deps) => processPublishTick(d, { creatorId: A.userId });
  const ledgerCount = async (clientRef: string) => {
    const { count } = await A.supabase
      .from("social_publish_ledger")
      .select("id", { count: "exact", head: true })
      .eq("client_ref", clientRef)
      .throwOnError();
    return count ?? 0;
  };

  /** The governed path: request → mint → approve. */
  const cardApprove = async (
    postId: string,
    accountId: string,
    schedule: string | null = null
  ): Promise<PublishManifest> => {
    const req = await requestPublishCard(A.supabase, A.userId, {
      socialPostId: postId,
      socialAccountId: accountId,
      proposedScheduledFor: schedule,
    });
    if (!req.ok) throw new Error(`request card: ${req.reason}`);
    const mint = await mintCardToken(A.supabase, A.userId, req.approval.id);
    if (!mint.ok) throw new Error(`mint: ${mint.reason}`);
    const app = await approvePublishCard(A.supabase, A.userId, mint.token, {});
    if (!app.ok) throw new Error(`approve: ${app.reason}`);
    return app.manifest;
  };

  /* ─────────────────────────────── ac1.spec ─────────────────────────── */
  console.log("ac1.spec — the card-SOLE-path bypass matrix");
  {
    const p = await post();
    let repoAssert: unknown = null;
    try {
      await createPublishManifest(A.supabase, {
        creatorId: A.userId,
        socialPostId: p.id,
        socialAccountId: li.id,
        platform: "linkedin",
        approvalId: "",
        contentHash: "",
      });
    } catch (err) {
      repoAssert = err;
    }
    check(
      "direct repository call without an approval → runtime assert throws",
      repoAssert instanceof Error && /card-sole-path/.test(repoAssert.message)
    );
    let fkErr: unknown = null;
    try {
      await createPublishManifest(A.supabase, {
        creatorId: A.userId,
        socialPostId: p.id,
        socialAccountId: li.id,
        platform: "linkedin",
        approvalId: crypto.randomUUID(),
        contentHash: "ph1:forged",
      });
    } catch (err) {
      fkErr = err;
    }
    check("forged approval id → the DB foreign key refuses", fkErr instanceof Error);

    const req = await requestPublishCard(A.supabase, A.userId, {
      socialPostId: p.id,
      socialAccountId: li.id,
    });
    if (!req.ok) throw new Error("ac1 request failed");
    let unconsumed: unknown = null;
    try {
      const { requestPublish } = await import("@/lib/marketing/publish/publishService");
      await requestPublish(A.supabase, A.userId, req.approval, null);
    } catch (err) {
      unconsumed = err;
    }
    check(
      "service call with an UNCONSUMED approval → refused (never consumed)",
      unconsumed instanceof Error && /never consumed/.test(unconsumed.message)
    );

    const garbage = await approvePublishCard(A.supabase, A.userId, "not-a-real-token");
    check("garbage token → invalid_or_expired", !garbage.ok && garbage.reason === "invalid_or_expired_token");

    const mint = await mintCardToken(A.supabase, A.userId, req.approval.id);
    if (!mint.ok) throw new Error("ac1 mint failed");
    const foreign = await approvePublishCard(B.supabase, B.userId, mint.token);
    check("another creator replaying the token → invalid (RLS + owner check)", !foreign.ok);

    const first = await approvePublishCard(A.supabase, A.userId, mint.token);
    check("the real approve consumes the token once", first.ok);
    const replay = await approvePublishCard(A.supabase, A.userId, mint.token);
    check("token REPLAY → invalid (atomic consume)", !replay.ok && replay.reason === "invalid_or_expired_token");

    const p2 = await post();
    const req2 = await requestPublishCard(A.supabase, A.userId, { socialPostId: p2.id, socialAccountId: li.id });
    if (!req2.ok) throw new Error("ac1 expiry request failed");
    const mintT = "2026-07-28T09:00:00.000Z";
    const mint2 = await mintCardToken(A.supabase, A.userId, req2.approval.id, mintT);
    if (!mint2.ok) throw new Error("ac1 expiry mint failed");
    const late = await approvePublishCard(A.supabase, A.userId, mint2.token, {}, "2026-07-28T09:16:00.000Z");
    check("expired token (15-min TTL) → invalid", !late.ok && late.reason === "invalid_or_expired_token");
    await rejectPublishCard(A.supabase, A.userId, req2.approval.id);

    check(
      "every manifest so far carries approved_via='card' + a content hash",
      (first.ok ? first.manifest.approvedVia === "card" && first.manifest.contentHash.startsWith("ph1:") : false)
    );
    if (first.ok) {
      await transitionPublishManifest(A.supabase, first.manifest, "queued", "cancelled", {});
    }
  }

  /* ────────────────────── ac2.spec + lifecycle.spec ─────────────────── */
  console.log("\nac2.spec + lifecycle — byte-identity, ledger, posted_api");
  let livePostId = "";
  {
    const p = await post();
    const expected = composePublishText({ body: p.body, cta: p.cta, hashtags: p.hashtags });
    const m = await cardApprove(p.id, li.id);
    check("approved with no future time → immediate (scheduled_for null)", m.scheduledFor === null);
    fake.setPublish(async () => acceptedSync());
    await tick();
    check(
      "AC-MC.2: publish() title === the card's composePublishText output, byte-identical",
      fake.lastInput()?.title === expected
    );
    check("clientRef = manifest id rides the call", fake.lastInput()?.clientRef === m.id);
    let cur = (await getPublishManifest(A.supabase, m.id))!;
    check("sync accept → submitted + refs + ONE ledger row", cur.status === "submitted" && (await ledgerCount(m.id)) === 1);
    await tick();
    cur = (await getPublishManifest(A.supabase, m.id))!;
    check("→ live", cur.status === "live");
    const { data: stamped } = await A.supabase.from("social_post").select("status").eq("id", p.id).single().throwOnError();
    check("amendment 3: post stamped posted_api (distinct from posted_manual)", stamped!.status === "posted_api");
    livePostId = p.id;
  }

  /* ─────────────────────────────── ac3.spec ─────────────────────────── */
  console.log("\nac3.spec — batch = N independent tokens");
  {
    const posts = await Promise.all([post(), post(), post()]);
    const approvals = [];
    for (const p of posts) {
      const req = await requestPublishCard(A.supabase, A.userId, { socialPostId: p.id, socialAccountId: li.id });
      if (!req.ok) throw new Error("ac3 request failed");
      approvals.push(req.approval);
    }
    const mints = [];
    for (const a of approvals) {
      const mint = await mintCardToken(A.supabase, A.userId, a.id);
      if (!mint.ok) throw new Error("ac3 mint failed");
      mints.push(mint.token);
    }
    check("3 cards → 3 distinct tokens", new Set(mints).size === 3);
    const one = await approvePublishCard(A.supabase, A.userId, mints[1]);
    check("approving ONE consumes only its own", one.ok);
    const openAfter = await listOpenApprovals(A.supabase, A.userId);
    check(
      "the other two approvals remain open and consumable",
      approvals.filter((a) => openAfter.some((o) => o.id === a.id)).length === 2
    );
    const two = await approvePublishCard(A.supabase, A.userId, mints[0]);
    check("…and still approve later", two.ok);
    for (const res of [one, two]) {
      if (res.ok) await transitionPublishManifest(A.supabase, res.manifest, "queued", "cancelled", {});
    }
    await rejectPublishCard(A.supabase, A.userId, approvals[2].id);
    check("skip/reject leaves the post in ready", (await A.supabase.from("social_post").select("status").eq("id", posts[2].id).single().throwOnError()).data!.status === "ready");
  }

  /* ───────────── M-B chaos under card manifests (regression) ────────── */
  console.log("\nchaos.spec — platformError / permanent / ambiguous / replay");
  {
    const p = await post();
    const m = await cardApprove(p.id, li.id);
    fake.setPublish(async () => acceptedSync({ platformError: "Duplicate post detected" }));
    await tick();
    const cur = (await getPublishManifest(A.supabase, m.id))!;
    check("platformError → platform_failed + NO ledger row", cur.status === "platform_failed" && (await ledgerCount(m.id)) === 0);
    const noRetry = await retryPublishManifest(A.supabase, A.userId, m.id);
    check("platform_failed is NOT retryable (edit → fresh card is the fix)", !noRetry.ok && noRetry.reason === "not_retryable");
  }
  {
    const p = await post();
    const m = await cardApprove(p.id, li.id);
    fake.setPublish(async () => {
      throw Object.assign(new Error("bad payload"), { permanent: true });
    });
    const before = fake.calls.publish;
    await tick();
    await tick();
    check(
      "permanent 4xx → failed, publish fired exactly once",
      (await getPublishManifest(A.supabase, m.id))!.status === "failed" && fake.calls.publish === before + 1
    );
  }
  let failedManifest: PublishManifest | null = null;
  let failedPostId = "";
  {
    const p = await post({ body: "Ambiguous governance body", hashtags: [] });
    const m = await cardApprove(p.id, li.id);
    fake.setPublish(async () => {
      throw new Error("timeout");
    });
    fake.setRecent([]);
    const before = fake.calls.publish;
    await tick(); // fires once → stays submitting
    await tick(); // recovery 1
    await tick(); // recovery 2
    await tick(); // recovery 3 → grace-fail
    const cur = (await getPublishManifest(A.supabase, m.id))!;
    check(
      "transient+no history → failed after grace; publish NEVER re-fired",
      cur.status === "failed" && fake.calls.publish === before + 1
    );
    failedManifest = cur;
    failedPostId = p.id;
  }
  {
    const p = await post();
    const req = await requestPublishCard(A.supabase, A.userId, { socialPostId: p.id, socialAccountId: li.id });
    if (!req.ok) throw new Error("replay request failed");
    const mint = await mintCardToken(A.supabase, A.userId, req.approval.id);
    if (!mint.ok) throw new Error("replay mint failed");
    const app = await approvePublishCard(A.supabase, A.userId, mint.token);
    if (!app.ok) throw new Error("replay approve failed");
    const s1 = await transitionPublishManifest(A.supabase, app.manifest, "queued", "submitting", {});
    await transitionPublishManifest(A.supabase, s1, "submitting", "submitted", {
      providerRequestId: "req-crash",
      platformPostId: "plat-crash",
      postUrl: "https://p/crash",
    });
    await tick();
    await tick();
    check("crash-between-refs-and-ledger replays to exactly ONE row + live", (await ledgerCount(app.manifest.id)) === 1 && (await getPublishManifest(A.supabase, app.manifest.id))!.status === "live");
  }

  /* ─────────────────────────────── ac5.spec ─────────────────────────── */
  console.log("\nac5.spec — edit-voids-approval, both directions");
  {
    // Eager hook: an edit through the single write path voids everything.
    const p = await post();
    const m = await cardApprove(p.id, li.id, "2026-09-01T10:00:00.000Z");
    check("future time → scheduled manifest", m.scheduledFor !== null && m.status === "queued");
    const openBefore = await requestPublishCard(A.supabase, A.userId, { socialPostId: p.id, socialAccountId: li.id });
    if (!openBefore.ok) throw new Error("ac5 second card failed");
    await versionedUpdateSocialPost(A.supabase, p.id, p.version, { body: "Edited after approval" });
    const cur = (await getPublishManifest(A.supabase, m.id))!;
    check("content edit → live manifest VOIDED (eager hook)", cur.status === "voided");
    const openApproval = await getApproval(A.supabase, openBefore.approval.id);
    check("…and the open card request voided too", openApproval?.voidedAt !== null);

    // DB backstop: voided is immutable even to a raw write.
    const { error: trigErr } = await A.supabase
      .from("social_publish_manifest")
      .update({ status: "queued" })
      .eq("id", m.id);
    check(
      "AC-MC.5 DB constraint: the voided-immutability trigger rejects a raw revive",
      trigErr !== null && /immutable/.test(trigErr.message)
    );

    // A voided manifest is invisible to the workflow (terminal, never listed).
    const before = fake.calls.publish;
    await tick();
    check("a voided manifest can NEVER be published", fake.calls.publish === before);

    // Fresh card after the edit works.
    const fresh = await requestPublishCard(A.supabase, A.userId, { socialPostId: p.id, socialAccountId: li.id });
    check("the edited post cards afresh", fresh.ok);
    if (fresh.ok) await rejectPublishCard(A.supabase, A.userId, fresh.approval.id);
  }
  {
    // The BELT: a stale hash that slipped past the eager hook aborts pre-submit.
    const p = await post();
    const staleApproval = await createApprovalRequest(A.supabase, {
      creatorId: A.userId,
      socialPostId: p.id,
      socialAccountId: li.id,
      platform: "linkedin",
      contentHash: "ph1:stale-hash-from-before-an-edit",
      kind: "retry",
      consumedAt: new Date().toISOString(),
    });
    const m = await createPublishManifest(A.supabase, {
      creatorId: A.userId,
      socialPostId: p.id,
      socialAccountId: li.id,
      platform: "linkedin",
      approvalId: staleApproval.id,
      contentHash: "ph1:stale-hash-from-before-an-edit",
    });
    const before = fake.calls.publish;
    const res = await tick();
    check(
      "pre-submit hash re-check → voided (approval_stale), publish never called",
      res.voided === 1 &&
        (await getPublishManifest(A.supabase, m.id))!.status === "voided" &&
        fake.calls.publish === before
    );
  }
  {
    // Amendment 2 retry semantics: transient failure retries WITHOUT a card.
    if (!failedManifest) throw new Error("no failed manifest staged");
    const retry = await retryPublishManifest(A.supabase, A.userId, failedManifest.id);
    check("retry of a transiently-failed manifest needs NO fresh card", retry.ok);
    if (retry.ok) {
      const cloneApproval = await getApproval(A.supabase, retry.manifest.approvalId);
      check(
        "the clone rides a consumed kind='retry' approval chained to the card approval",
        cloneApproval?.kind === "retry" &&
          cloneApproval.consumedAt !== null &&
          cloneApproval.parentApprovalId === failedManifest.approvalId
      );
      await transitionPublishManifest(A.supabase, retry.manifest, "queued", "cancelled", {});
    }
    // …but an edit invalidates the retry path (fresh card required).
    const { data: fp } = await A.supabase.from("social_post").select("version").eq("id", failedPostId).single().throwOnError();
    await versionedUpdateSocialPost(A.supabase, failedPostId, fp!.version, { body: "Edited before retry" });
    const retry2 = await retryPublishManifest(A.supabase, A.userId, failedManifest.id);
    check("retry after an edit → needs_fresh_card", !retry2.ok && retry2.reason === "needs_fresh_card");
  }

  /* ─────────────────────────── guards + control ─────────────────────── */
  console.log("\nguards+control.spec — holds self-heal; cancel/reschedule law");
  {
    // M-D (from the first live E2E): the card-approved fire time is
    // AUTHORITATIVE — a night-time clock does NOT hold the publish.
    const p = await post();
    const m = await cardApprove(p.id, li.id);
    fake.setPublish(async () => acceptedSync({ providerRequestId: "req-window2" }));
    await tick({ ...deps, nowIso: () => OUT_WINDOW });
    const cur = (await getPublishManifest(A.supabase, m.id))!;
    check("23:00 UTC clock → still submits (approved fire time is authoritative)", cur.status === "submitted");
  }
  {
    const p = await post();
    const m = await cardApprove(p.id, li.id, "2026-09-01T10:00:00.000Z");
    await tick();
    check("not due → stays queued", (await getPublishManifest(A.supabase, m.id))!.status === "queued");
    const resched = await reschedulePublishManifest(A.supabase, m, "2026-09-02T10:00:00.000Z");
    check("reschedule while queued bumps version", resched.version === m.version + 1);
    const cancel = await cancelPublishManifest(A.supabase, m.id);
    check("cancel while queued → cancelled", cancel.cancelled);
    const again = await cancelPublishManifest(A.supabase, m.id);
    check("cancel a terminal → already_terminal", !again.cancelled && again.reason === "already_terminal");
  }

  /* ─────────────────────────────── ac7.spec ─────────────────────────── */
  console.log("\nac7.spec — frozen-source fence (mint + pre-submit)");
  {
    const { data: course } = await A.supabase
      .from("courses")
      .insert({ author_id: A.userId, title: "MC governance course" })
      .select("id")
      .single()
      .throwOnError();
    const { data: mod } = await A.supabase
      .from("modules")
      .insert({ course_id: course!.id, title: "M1" })
      .select("id")
      .single()
      .throwOnError();
    const { data: lesson } = await A.supabase
      .from("lessons")
      .insert({ course_id: course!.id, module_id: mod!.id, title: "L1" })
      .select("id")
      .single()
      .throwOnError();
    const va = async (createdAt: string) => {
      const { data } = await A.supabase
        .from("video_assets")
        .insert({
          course_id: course!.id,
          owner_id: A.userId,
          lesson_id: lesson!.id,
          status: "ready",
          mux_asset_id: `mux-${crypto.randomUUID().slice(0, 8)}`,
          created_at: createdAt,
        })
        .select("id")
        .single()
        .throwOnError();
      return data!.id;
    };
    const takeOld = await va("2026-07-20T10:00:00.000Z");
    const { data: transcript } = await A.supabase
      .from("lesson_transcript")
      .insert({
        creator_id: A.userId,
        lesson_id: lesson!.id,
        duration_seconds: 120,
        recording_format: "camera_only",
        source: "platform",
        text: "hello",
        words: [],
      })
      .select("id")
      .single()
      .throwOnError();
    const { data: candidate } = await A.supabase
      .from("clip_moment_candidate")
      .insert({
        creator_id: A.userId,
        lesson_id: lesson!.id,
        transcript_id: transcript!.id,
        request_id: crypto.randomUUID(),
        start_ms: 0,
        end_ms: 30000,
        rank: 1,
        moment_type: "concrete_win",
        funnel_stage: "tofu",
        hook_text: "h",
        rationale: "r",
        rubric_scores: {},
        prompt_version: "clips-v3",
      })
      .select("id")
      .single()
      .throwOnError();
    const { data: job } = await A.supabase
      .from("clip_render_job")
      .insert({
        creator_id: A.userId,
        course_id: course!.id,
        lesson_id: lesson!.id,
        candidate_id: candidate!.id,
        layout: "face_track",
        provider: "wisesel_ffmpeg",
        status: "completed",
        source: {
          videoAssetRowId: takeOld,
          sourceMuxAssetId: "mux-old",
          playbackId: null,
          startMs: 0,
          endMs: 30000,
          recordingFormat: "camera_only",
        },
      })
      .select("id")
      .single()
      .throwOnError();
    const clipPost = await post({
      platform: "youtube_shorts",
      post_type: "clip",
      video_path: "test/frozen.mp4",
      clip_job_id: job!.id,
      hashtags: [],
    });

    // While the job's take IS the current take, the card mints fine.
    const okReq = await requestPublishCard(A.supabase, A.userId, { socialPostId: clipPost.id, socialAccountId: yt.id });
    check("current take → card request allowed", okReq.ok);

    // Re-record: a NEWER ready take supersedes the job's source.
    await va("2026-07-25T10:00:00.000Z");
    if (okReq.ok) {
      const mintStale = await mintCardToken(A.supabase, A.userId, okReq.approval.id);
      check(
        "AC-MC.7: token mint refuses a superseded source",
        !mintStale.ok && mintStale.reason === "source_superseded"
      );
    }
    const refused = await requestPublishCard(A.supabase, A.userId, { socialPostId: clipPost.id, socialAccountId: yt.id });
    check("a fresh card request refuses too", !refused.ok && refused.reason === "source_superseded");

    // Pre-submit half (amendment 2): a manifest approved BEFORE the
    // re-record goes held, not published.
    const preApproval = await createApprovalRequest(A.supabase, {
      creatorId: A.userId,
      socialPostId: clipPost.id,
      socialAccountId: yt.id,
      platform: "youtube",
      contentHash: contentHashForPost(clipPost),
      kind: "retry",
      consumedAt: new Date().toISOString(),
    });
    const preM = await createPublishManifest(A.supabase, {
      creatorId: A.userId,
      socialPostId: clipPost.id,
      socialAccountId: yt.id,
      platform: "youtube",
      approvalId: preApproval.id,
      contentHash: contentHashForPost(clipPost),
    });
    const before = fake.calls.publish;
    await tick({ ...deps, nowIso: () => NEXT_MONTH, loadVideoBytes: async () => ({ bytes: Buffer.from("x"), filename: "f.mp4" }) });
    const held = (await getPublishManifest(A.supabase, preM.id))!;
    check(
      "pre-submit guard → held source_superseded; publish never called",
      held.status === "held" && held.holdReason === "source_superseded" && fake.calls.publish === before
    );
  }

  /* ─────────────────────────────── ac6.spec ─────────────────────────── */
  console.log("\nac6.spec — AUTO mode still yields a card, never a manifest");
  {
    const { data: course } = await A.supabase
      .from("courses")
      .insert({ author_id: A.userId, title: "MC autonomy course" })
      .select("id")
      .single()
      .throwOnError();
    await A.supabase
      .from("marketing_autonomy_settings")
      .insert({
        course_id: course!.id,
        mode: "auto",
        policy: {
          autoApproveTools: ["publish_social_post"],
          maxRecipients: 10000,
          maxBudgetCents: 10000,
          allowedHours: { startHour: 0, endHour: 24, timezone: null },
          firstSendToNewSegmentManual: false,
        },
      })
      .throwOnError();
    const p = await post();
    const { count: manifestsBefore } = await A.supabase
      .from("social_publish_manifest")
      .select("id", { count: "exact", head: true })
      .throwOnError();
    const outcome = await executeMarketingTool(
      "publish_social_post",
      { postId: p.id, accountId: li.id },
      {
        supabase: A.supabase,
        courseId: course!.id,
        campaignId: null,
        ownerId: A.userId,
        services: createMarketingServices(),
        requestedBy: "user",
      }
    );
    const { count: manifestsAfter } = await A.supabase
      .from("social_publish_manifest")
      .select("id", { count: "exact", head: true })
      .throwOnError();
    check(
      "AUTO mode + an opting policy → the hard-deny yields a PENDING card",
      (outcome as { status?: string }).status === "pending_approval"
    );
    check("…and ZERO manifests were created", manifestsAfter === manifestsBefore);
  }

  /* ───────────────────────── agentic.spec (M-AG) ────────────────────── */
  console.log("\nagentic.spec (M-AG) — chat files cards inline; honesty loop");
  {
    const { data: agCourse } = await A.supabase
      .from("courses")
      .insert({ author_id: A.userId, title: "M-AG agentic course" })
      .select("id")
      .single()
      .throwOnError();
    const courseId = agCourse!.id;
    // AUTO mode, policy opting in every publish-adjacent tool — the hard-deny
    // trio must STILL card (AC-AG.1); retry/cancel may auto-execute (audited).
    await A.supabase
      .from("marketing_autonomy_settings")
      .insert({
        course_id: courseId,
        mode: "auto",
        policy: {
          autoApproveTools: [
            "publish_social_post",
            "schedule_social_post",
            "retry_publish",
            "cancel_scheduled_publish",
          ],
          maxRecipients: 10000,
          maxBudgetCents: 10000,
          allowedHours: { startHour: 0, endHour: 24, timezone: null },
          firstSendToNewSegmentManual: false,
        },
      })
      .throwOnError();
    const services = createMarketingServices();
    const FUTURE = "2099-01-02T09:00:00.000Z";
    const p1 = await post({ body: "M-AG scheduled plan item" });
    const p2 = await post({ body: "M-AG immediate plan item" });

    // ── AC-AG.1: an agent TURN in auto mode files cards, ZERO manifests ──
    const { count: mBefore } = await A.supabase
      .from("social_publish_manifest")
      .select("id", { count: "exact", head: true })
      .throwOnError();
    const ev: MarketingAgentEvent[] = [];
    const planModel = createMockModelClient(
      [
        { text: "Checking accounts.", toolCalls: [{ name: "get_connected_accounts", arguments: {} }] },
        {
          text: "Filing the plan.",
          toolCalls: [
            {
              name: "propose_publish_plan",
              arguments: {
                items: [
                  { postId: p1.id, accountId: li.id, scheduledFor: FUTURE },
                  { postId: p2.id, accountId: li.id, scheduledFor: null },
                ],
              },
            },
          ],
        },
      ],
      { finalText: "Two cards await your decision — nothing goes out until you approve each." }
    );
    const run = await runMarketingAgentTurn({
      supabase: A.supabase,
      model: planModel,
      courseId,
      campaignId: null,
      ownerId: A.userId,
      userMessage: "Plan this week's posts",
      services,
      emit: (e) => ev.push(e),
    });
    check(
      "discovery read executes (get_connected_accounts, status read)",
      ev.some((e) => e.type === "tool_result" && e.tool === "get_connected_accounts" && e.status === "read")
    );
    check("the reversible plan does not pause the run", run.paused === false);
    const { count: mAfter } = await A.supabase
      .from("social_publish_manifest")
      .select("id", { count: "exact", head: true })
      .throwOnError();
    check("AC-AG.1: ZERO manifests from the auto-mode agent turn", mAfter === mBefore);
    const cardsEvt = ev.find((e) => e.type === "publish_cards");
    const cards = cardsEvt && cardsEvt.type === "publish_cards" ? cardsEvt.cards : [];
    check("publish_cards event carries BOTH assembled cards", cards.length === 2);
    check(
      "each inline card carries its own live token",
      cards.every((c) => typeof c.token === "string" && c.token.length > 0)
    );
    check("cards are marked agent-requested", cards.every((c) => c.requestedBy === "agent"));
    const { data: filed } = await A.supabase
      .from("social_publish_approval")
      .select("id,social_post_id,conversation_id")
      .in("social_post_id", [p1.id, p2.id])
      .throwOnError();
    check(
      "chat-filed approvals carry the conversation id (honesty-loop substrate)",
      (filed ?? []).length === 2 && filed!.every((f) => f.conversation_id === run.conversationId)
    );

    // ── AC-AG.2: chat-card byte-identity through to publish() ──
    // (match cards→posts via the filed approvals; timestamptz round-trips
    //  normalize the ISO form, so never compare raw schedule strings)
    const approvalByPost = new Map((filed ?? []).map((f) => [f.social_post_id, f.id]));
    const card1 = cards.find((c) => c.approvalId === approvalByPost.get(p1.id));
    const card2 = cards.find((c) => c.approvalId === approvalByPost.get(p2.id));
    check(
      "AC-AG.2: inline card text === composePublishText, byte-identical",
      card1?.finalText === composePublishText({ body: p1.body, cta: p1.cta, hashtags: p1.hashtags }) &&
        card2?.finalText === composePublishText({ body: p2.body, cta: p2.cta, hashtags: p2.hashtags })
    );
    const appImmediate = await approvePublishCard(A.supabase, A.userId, card2!.token!, {});
    check("approving with the CHAT token creates the manifest", appImmediate.ok);
    fake.setPublish(async () => acceptedSync());
    await tick(); // → submitted (captures the publish input)
    check(
      "AC-AG.2: publish() title === the chat card's text, byte-identical",
      fake.lastInput()?.title === card2!.finalText
    );
    await tick(); // → live
    const { data: p2After } = await A.supabase
      .from("social_post")
      .select("status")
      .eq("id", p2.id)
      .single()
      .throwOnError();
    check("fired post stamped posted_api", p2After!.status === "posted_api");

    // ── AC-AG.3: token single-use ACROSS surfaces, both directions ──
    const mintConsumed = await mintCardToken(A.supabase, A.userId, card2!.approvalId);
    check(
      "AC-AG.3: chat-approved card → the review page can no longer mint",
      !mintConsumed.ok && mintConsumed.reason === "approval_not_open"
    );
    const reviewMint = await mintCardToken(A.supabase, A.userId, card1!.approvalId);
    if (!reviewMint.ok) throw new Error("review re-mint failed");
    const staleChat = await approvePublishCard(A.supabase, A.userId, card1!.token!, {});
    check(
      "AC-AG.3: review-page re-mint invalidates the chat token (last mint wins)",
      !staleChat.ok && staleChat.reason === "invalid_or_expired_token"
    );
    const appScheduled = await approvePublishCard(A.supabase, A.userId, reviewMint.token, {});
    check("…and the review token approves the SAME approval", appScheduled.ok);
    check(
      "scheduled manifest carries the card's fire time",
      appScheduled.ok &&
        appScheduled.manifest.scheduledFor !== null &&
        new Date(appScheduled.manifest.scheduledFor).getTime() === new Date(FUTURE).getTime() &&
        appScheduled.manifest.status === "queued"
    );

    // ── AC-AG.4a: the follow-up resumes the SAME conversation, truthfully ──
    const approval1 = (await getApproval(A.supabase, card1!.approvalId))!;
    const fuEv: MarketingAgentEvent[] = [];
    const fuModel = createMockModelClient(
      [{ text: "Confirming.", toolCalls: [{ name: "get_publish_status", arguments: { postId: p1.id, limit: null } }] }],
      { finalText: "Scheduled — I'll only call it published once the run is live." }
    );
    const fu = await resumeAgentAfterPublishDecision({
      supabase: A.supabase,
      model: fuModel,
      services,
      ownerId: A.userId,
      approval: approval1,
      decision: "approved",
      courseId,
      emit: (e) => fuEv.push(e),
    });
    check("the publish follow-up resumes the SAME conversation", fu?.conversationId === run.conversationId);
    check(
      "the resume message states queued-is-NOT-posted",
      JSON.stringify(fuModel.getCalls()[0]?.input ?? []).includes("Queued is NOT posted")
    );
    const statusLine = fuEv.find((e) => e.type === "tool_result" && e.tool === "get_publish_status");
    check(
      "get_publish_status answers from manifest state (queued, not published)",
      !!statusLine && statusLine.type === "tool_result" && /queued/.test(statusLine.summary)
    );
    const creatorReq = await requestPublishCard(A.supabase, A.userId, {
      socialPostId: p1.id,
      socialAccountId: li.id,
    });
    if (!creatorReq.ok) throw new Error("creator card failed");
    const nullResume = await resumeAgentAfterPublishDecision({
      supabase: A.supabase,
      model: fuModel,
      services,
      ownerId: A.userId,
      approval: creatorReq.approval,
      decision: "skipped",
      courseId,
    });
    check("a non-chat card never resumes a conversation", nullResume === null);
    await rejectPublishCard(A.supabase, A.userId, creatorReq.approval.id);

    // ── AC-AG.4b: "did my post go out?" answered from truth ──
    const qEv: MarketingAgentEvent[] = [];
    const qModel = createMockModelClient(
      [{ text: "Checking.", toolCalls: [{ name: "get_publish_status", arguments: { postId: p2.id, limit: null } }] }],
      { finalText: "Yes — live." }
    );
    await runMarketingAgentTurn({
      supabase: A.supabase,
      model: qModel,
      courseId,
      campaignId: null,
      ownerId: A.userId,
      conversationId: run.conversationId,
      userMessage: "Did my post go out?",
      services,
      emit: (e) => qEv.push(e),
    });
    const qLine = qEv.find((e) => e.type === "tool_result" && e.tool === "get_publish_status");
    check(
      "AC-AG.4: the later turn reads TRUTH — Published (posted_api) + the platform link",
      !!qLine && qLine.type === "tool_result" && qLine.summary.includes("Published (posted_api)")
    );
    check("status reads NEVER re-render inline cards", !qEv.some((e) => e.type === "publish_cards"));

    // ── AC-AG.4c: failure → explained → retried (A2 clone, policy-opted) ──
    const p3 = await post({ body: "M-AG transient failure" });
    const m3 = await cardApprove(p3.id, li.id);
    const sub3 = await transitionPublishManifest(A.supabase, m3, "queued", "submitting", {});
    await transitionPublishManifest(A.supabase, sub3, "submitting", "failed", {
      lastError: { message: "socket hangup (transient)" },
    });
    const rEv: MarketingAgentEvent[] = [];
    const rModel = createMockModelClient(
      [
        { text: "Diagnosing.", toolCalls: [{ name: "get_publish_status", arguments: { postId: p3.id, limit: null } }] },
        { text: "Transient — re-firing the approved bytes.", toolCalls: [{ name: "retry_publish", arguments: { manifestId: m3.id } }] },
      ],
      { finalText: "Retry queued — same approved content, no new card needed." }
    );
    const rRun = await runMarketingAgentTurn({
      supabase: A.supabase,
      model: rModel,
      courseId,
      campaignId: null,
      ownerId: A.userId,
      conversationId: run.conversationId,
      userMessage: "Why did it fail? Fix it.",
      services,
      emit: (e) => rEv.push(e),
    });
    const failLine = rEv.find((e) => e.type === "tool_result" && e.tool === "get_publish_status");
    check(
      "the failure is explained from typed state (failed, transient)",
      !!failLine && failLine.type === "tool_result" && /failed/.test(failLine.summary)
    );
    const retryLine = rEv.find((e) => e.type === "tool_result" && e.tool === "retry_publish");
    check(
      "policy-opted retry auto-executes under auto mode (audited, no pause)",
      !!retryLine && retryLine.type === "tool_result" && retryLine.status === "executed" && rRun.paused === false
    );
    const { data: clones } = await A.supabase
      .from("social_publish_manifest")
      .select("id,approval_id,status")
      .eq("social_post_id", p3.id)
      .neq("id", m3.id)
      .throwOnError();
    check("the retry is an A2 clone manifest", (clones ?? []).length === 1);
    const cloneApproval = clones?.length ? await getApproval(A.supabase, clones[0].approval_id) : null;
    check(
      "clone rides a retry approval born consumed, chained to the human card",
      cloneApproval?.kind === "retry" &&
        cloneApproval.consumedAt !== null &&
        cloneApproval.parentApprovalId === m3.approvalId
    );
    check("NO new publish CARD was minted for the retry", cloneApproval?.mintedAt === null);

    // ── AC-AG.1 belt: the hard-denied direct tool STILL cards from chat ──
    const p4 = await post({ body: "M-AG hard deny belt" });
    const { count: mB2 } = await A.supabase
      .from("social_publish_manifest")
      .select("id", { count: "exact", head: true })
      .throwOnError();
    const dEv: MarketingAgentEvent[] = [];
    const dModel = createMockModelClient(
      [{ text: "Filing the card.", toolCalls: [{ name: "publish_social_post", arguments: { postId: p4.id, accountId: li.id } }] }],
      { finalText: "(unreached — pauses)" }
    );
    const dRun = await runMarketingAgentTurn({
      supabase: A.supabase,
      model: dModel,
      courseId,
      campaignId: null,
      ownerId: A.userId,
      conversationId: run.conversationId,
      userMessage: "Just put it out now",
      services,
      emit: (e) => dEv.push(e),
    });
    const { count: mA2 } = await A.supabase
      .from("social_publish_manifest")
      .select("id", { count: "exact", head: true })
      .throwOnError();
    check(
      "AC-AG.1: hard-denied publish_social_post PAUSES even in auto mode (chat turn)",
      dRun.paused === true && dEv.some((e) => e.type === "agent_blocked" && e.kind === "approval")
    );
    check("…and created nothing", mA2 === mB2);

    // ── cancel_scheduled_publish auto-executes on the queued schedule ──
    const cEv: MarketingAgentEvent[] = [];
    const scheduledId = appScheduled.ok ? appScheduled.manifest.id : "";
    const cModel = createMockModelClient(
      [{ text: "Stopping the scheduled run.", toolCalls: [{ name: "cancel_scheduled_publish", arguments: { manifestId: scheduledId } }] }],
      { finalText: "Cancelled — a fresh card is needed to re-run it." }
    );
    await runMarketingAgentTurn({
      supabase: A.supabase,
      model: cModel,
      courseId,
      campaignId: null,
      ownerId: A.userId,
      conversationId: run.conversationId,
      userMessage: "Actually cancel the scheduled one",
      services,
      emit: (e) => cEv.push(e),
    });
    const cancelledManifest = scheduledId ? await getPublishManifest(A.supabase, scheduledId) : null;
    check(
      "cancel_scheduled_publish stops the queued run (auto, audited)",
      cancelledManifest?.status === "cancelled"
    );
  }

  /* ─────────────────────────────── ac8.spec ─────────────────────────── */
  console.log("\nac8.spec — the unpublish valve (honest-refusal form)");
  {
    const callsBefore = { ...fake.calls };
    const res = await unpublishLocally(A.supabase, A.userId, livePostId);
    check("unpublish marks the post unpublished_local", res.ok);
    const { data: p } = await A.supabase.from("social_post").select("status").eq("id", livePostId).single().throwOnError();
    check("post status = unpublished_local", p!.status === "unpublished_local");
    check(
      "AC-MC.8: ZERO provider calls of any kind during unpublish",
      fake.calls.publish === callsBefore.publish &&
        fake.calls.delete === callsBefore.delete &&
        fake.calls.verify === callsBefore.verify
    );
    if (res.ok) {
      check("the honest state carries the live platform link", res.postUrl !== null && res.platform === "linkedin");
    }
    const again = await unpublishLocally(A.supabase, A.userId, livePostId);
    check("re-unpublish refuses (not posted_api anymore)", !again.ok && again.reason === "not_published_api");
  }

  /* ─────────────────────────────── rls.spec ─────────────────────────── */
  console.log("\nrls.spec — governance isolation + no-delete audit trails");
  {
    const { data: mineA } = await A.supabase.from("social_publish_approval").select("id").throwOnError();
    check("A sees own approvals", (mineA ?? []).length > 0);
    const { data: mineB } = await B.supabase.from("social_publish_approval").select("id").throwOnError();
    check("B reads NONE of A's approvals", (mineB ?? []).length === 0);
    const { data: delApproval } = await A.supabase
      .from("social_publish_approval")
      .delete()
      .eq("id", mineA![0].id)
      .select("id");
    check("even the OWNER cannot delete an approval", (delApproval ?? []).length === 0);
    const { data: manifests } = await A.supabase.from("social_publish_manifest").select("id").limit(1).throwOnError();
    const { data: delManifest } = await A.supabase
      .from("social_publish_manifest")
      .delete()
      .eq("id", manifests![0].id)
      .select("id");
    check("manifests still undeletable", (delManifest ?? []).length === 0);
  }

  // Cleanup: account deletion cascades manifests + approvals + ledger.
  await A.supabase.from("social_account").delete().eq("creator_id", A.userId);
  await A.supabase.from("social_provider_profile").delete().eq("creator_id", A.userId);
  console.log(`\n  throwaway creators: ${A.email} ${B.email}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
