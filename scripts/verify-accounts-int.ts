/**
 * verify-accounts-int — M-A social-publishing foundation vs LIVE Supabase
 * (mock provider — no real Upload-Post traffic, no uploads). Requires the
 * 20260723120000_social_accounts migration applied.
 * Run: npx tsx scripts/verify-accounts-int.ts
 *
 * Sections:
 *   rls.spec      — AC-MA-02: creator isolation, both directions, all 3 tables
 *   linking.spec  — AC-MA-03: idempotent profile, link URL, reconcile
 *                   transitions, multi-account selection, disconnect,
 *                   versioned-write conflict
 *   events.spec   — AC-MA-04 (live half): the 3 event types insert + read back
 *   usage.spec    — AC-MA-07: ledger counting incl. the month boundary +
 *                   threshold levels
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
  ProviderConnectedAccount,
  PublishPlatform,
  SocialPublishProvider,
} from "@/lib/marketing/publish/provider/types";
import { decryptSecret } from "@/lib/marketing/accounts/crypto";
import { AccountVersionConflictError } from "@/lib/marketing/accounts/errors";
import {
  countUploadsThisMonth,
  getProviderProfile,
  insertLedgerRow,
  listAccounts,
  versionedUpdateSocialAccount,
} from "@/lib/marketing/accounts/accountsRepository";
import {
  accountsUsage,
  applyImportSelection,
  beginLink,
  disconnectAccount,
  ensureProviderProfile,
  reconcileAccounts,
} from "@/lib/marketing/accounts/accountsService";

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
    if (m) {
      env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      if (process.env[m[1]] === undefined) process.env[m[1]] = env[m[1]];
    }
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

async function provisionUser(url: string, anon: string, tag: string) {
  const email = `accounts-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

/** In-memory SocialPublishProvider — configurable connection truth +
 *  call counters (the verify-clips-int fakeProvider precedent). */
function makeMockProvider() {
  const calls = { createProfile: 0, linkUrl: 0, list: 0 };
  let connected: ProviderConnectedAccount[] = [];
  let lastRedirect = "";
  const provider: SocialPublishProvider = {
    id: "upload_post",
    async createCreatorProfile(profileRef) {
      calls.createProfile++;
      return { profileRef, created: true };
    },
    async getLinkUrl(_profileRef, _platforms, redirectUrl) {
      calls.linkUrl++;
      lastRedirect = redirectUrl;
      return { url: `https://mock.link/page?back=${encodeURIComponent(redirectUrl)}`, expiresInHours: 48 };
    },
    async listConnectedAccounts() {
      calls.list++;
      return connected;
    },
    async publish() {
      throw new Error("publish is out of scope for M-A");
    },
    async verifyPost() {
      throw new Error("verifyPost is out of scope for M-A");
    },
    async listRecentPosts() {
      throw new Error("listRecentPosts is out of scope for M-A");
    },
    async deletePost() {
      return { deleted: false, reason: "unsupported_by_provider" };
    },
    async getComments() {
      return [];
    },
  };
  return {
    provider,
    calls,
    setConnected(next: ProviderConnectedAccount[]) {
      connected = next;
    },
    lastRedirect: () => lastRedirect,
  };
}

const acct = (platform: PublishPlatform, reauth = false): ProviderConnectedAccount => ({
  platform,
  displayName: `${platform} person`,
  handle: `@${platform}`,
  avatarUrl: null,
  reauthRequired: reauth,
});

async function main() {
  console.log("verify-accounts-int — live Supabase + mock provider");
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("NEXT_PUBLIC_SUPABASE_URL / ANON_KEY missing from .env.local");
  if (!process.env.SOCIAL_ACCOUNTS_ENC_KEY) throw new Error("SOCIAL_ACCOUNTS_ENC_KEY missing from .env.local");

  const [A, B] = await Promise.all([provisionUser(url, anon, "a"), provisionUser(url, anon, "b")]);
  const anonClient = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  console.log(`  creators: A=${A.userId.slice(0, 8)} B=${B.userId.slice(0, 8)}`);

  const courseId = crypto.randomUUID();
  {
    const { error } = await A.supabase
      .from("courses")
      .insert({ id: courseId, author_id: A.userId, title: "Accounts int fixture" });
    if (error) throw new Error(`course insert: ${error.message}`);
  }

  const mock = makeMockProvider();
  const deps = { provider: mock.provider };

  /* ───────────────────── linking.spec (AC-MA-03) ─────────────────────── */
  console.log("\nlinking.spec — profile idempotency, reconcile transitions, selection");

  const ensured = await ensureProviderProfile(A.supabase, A.userId, deps);
  check("ensureProviderProfile creates once (provider called)", ensured.created && mock.calls.createProfile === 1);
  check("minted profile ref shape ws_*", /^ws_[a-z0-9]{20}$/.test(ensured.profileRef));

  const again = await ensureProviderProfile(A.supabase, A.userId, deps);
  check(
    "second ensure is idempotent — no provider call, same ref",
    !again.created && again.profileRef === ensured.profileRef && mock.calls.createProfile === 1
  );

  {
    const row = await getProviderProfile(A.supabase, A.userId, "upload_post");
    check(
      "profile_ref stored ENCRYPTED (v1.*), decrypts to the minted ref",
      row !== null && row.profileRefEnc.startsWith("v1.") && decryptSecret(row.profileRefEnc) === ensured.profileRef
    );
  }

  {
    const link = await beginLink(A.supabase, A.userId, ["linkedin"], "https://site.test/marketing/accounts?linked=1", deps);
    check(
      "beginLink returns the hosted URL and threads the redirect",
      link.url.startsWith("https://mock.link/") && mock.lastRedirect().includes("linked=1")
    );
  }

  mock.setConnected([acct("linkedin"), acct("youtube")]);
  const rec1 = await reconcileAccounts(A.supabase, A.userId, courseId, deps);
  check(
    "reconcile inserts linked accounts + reports newlyLinked",
    rec1.accounts.filter((a) => a.status === "linked").length === 2 && rec1.newlyLinked.length === 2
  );

  const rec2 = await reconcileAccounts(A.supabase, A.userId, courseId, deps);
  check("re-reconcile is quiet — no new links, rows stable", rec2.newlyLinked.length === 0 && rec2.accounts.length === 2);

  mock.setConnected([acct("linkedin", true), acct("youtube")]);
  const rec3 = await reconcileAccounts(A.supabase, A.userId, courseId, deps);
  check(
    "reauth_required → expired",
    rec3.accounts.find((a) => a.platform === "linkedin")?.status === "expired"
  );

  mock.setConnected([acct("linkedin"), acct("youtube")]);
  const rec4 = await reconcileAccounts(A.supabase, A.userId, courseId, deps);
  check(
    "healthy again → linked (re-link transition)",
    rec4.accounts.find((a) => a.platform === "linkedin")?.status === "linked" &&
      rec4.newlyLinked.includes("linkedin")
  );

  mock.setConnected([acct("linkedin")]);
  const rec5 = await reconcileAccounts(A.supabase, A.userId, courseId, deps);
  check(
    "absent at provider → revoked",
    rec5.accounts.find((a) => a.platform === "youtube")?.status === "revoked"
  );

  // multi-account import: two NEW platforms arrive in one linking trip
  mock.setConnected([acct("linkedin"), acct("tiktok"), acct("instagram")]);
  const rec6 = await reconcileAccounts(A.supabase, A.userId, courseId, deps);
  check(
    "multi-account import surfaces both new platforms",
    rec6.newlyLinked.sort().join(",") === "instagram,tiktok"
  );
  const afterSelect = await applyImportSelection(A.supabase, A.userId, courseId, ["tiktok"], ["tiktok", "instagram"]);
  check(
    "keep-selection revokes the deselected platform only",
    afterSelect.find((a) => a.platform === "instagram")?.status === "revoked" &&
      afterSelect.find((a) => a.platform === "tiktok")?.status === "linked" &&
      afterSelect.find((a) => a.platform === "linkedin")?.status === "linked"
  );

  {
    const linkedin = afterSelect.find((a) => a.platform === "linkedin")!;
    const afterDisconnect = await disconnectAccount(A.supabase, A.userId, courseId, linkedin.id);
    check(
      "manual disconnect → revoked (our-side)",
      afterDisconnect.find((a) => a.platform === "linkedin")?.status === "revoked"
    );
  }

  {
    const tiktok = (await listAccounts(A.supabase, A.userId)).find((a) => a.platform === "tiktok")!;
    let conflict = false;
    await versionedUpdateSocialAccount(A.supabase, tiktok.id, tiktok.version + 5, { status: "linked" }).catch(
      (e) => (conflict = e instanceof AccountVersionConflictError)
    );
    check("stale version → AccountVersionConflictError (never force-writes)", conflict);
  }

  /* ─────────────────────── rls.spec (AC-MA-02) ───────────────────────── */
  console.log("\nrls.spec — creator isolation, both directions");

  {
    const { data } = await B.supabase.from("social_provider_profile").select("*");
    check("B reads NONE of A's provider profiles", (data ?? []).length === 0);
  }
  {
    const { data } = await B.supabase.from("social_account").select("*");
    check("B reads NONE of A's accounts", (data ?? []).length === 0);
  }
  {
    const { error } = await B.supabase
      .from("social_provider_profile")
      .insert({ creator_id: A.userId, provider: "upload_post", profile_ref_enc: "v1.x.y.z" });
    check("B cannot insert a profile AS A (with-check)", error !== null);
  }
  {
    const aAccounts = await listAccounts(A.supabase, A.userId);
    const target = aAccounts[0];
    const { data } = await B.supabase
      .from("social_account")
      .update({ status: "revoked" })
      .eq("id", target.id)
      .select("*");
    check("B's update of A's account touches 0 rows", (data ?? []).length === 0);
    const { error } = await B.supabase
      .from("social_publish_ledger")
      .insert({ creator_id: A.userId, social_account_id: target.id, platform: target.platform, client_ref: "x" });
    check("B cannot write A's ledger", error !== null);
  }
  {
    // symmetric direction: B's own rows are invisible to A
    const { error } = await B.supabase
      .from("social_provider_profile")
      .insert({ creator_id: B.userId, provider: "upload_post", profile_ref_enc: "v1.b.b.b" });
    check("B inserts B's own profile", error === null);
    const { data } = await A.supabase.from("social_provider_profile").select("*").eq("creator_id", B.userId);
    check("A reads NONE of B's profiles", (data ?? []).length === 0);
  }
  {
    const { data: anonProfiles } = await anonClient.from("social_provider_profile").select("*");
    const { data: anonAccounts } = await anonClient.from("social_account").select("*");
    const { data: anonLedger } = await anonClient.from("social_publish_ledger").select("*");
    check(
      "anon reads nothing from all 3 tables",
      (anonProfiles ?? []).length === 0 && (anonAccounts ?? []).length === 0 && (anonLedger ?? []).length === 0
    );
  }

  /* ─────────────────── events.spec (AC-MA-04 live half) ──────────────── */
  console.log("\nevents.spec — the 3 event types on the single stream");
  {
    const { data } = await A.supabase
      .from("analytics_event")
      .select("type")
      .eq("course_id", courseId)
      .in("type", ["social_account_linked", "social_account_expired", "social_account_revoked"]);
    const seen = new Set((data ?? []).map((r) => r.type));
    check(
      "linked + expired + revoked all inserted and read back (DB check accepted them)",
      seen.has("social_account_linked") && seen.has("social_account_expired") && seen.has("social_account_revoked"),
      [...seen].join(",")
    );
    const { data: revokeRows } = await A.supabase
      .from("analytics_event")
      .select("props")
      .eq("course_id", courseId)
      .eq("type", "social_account_revoked");
    const reasons = new Set((revokeRows ?? []).map((r) => (r.props as { reason?: string }).reason));
    check(
      "revoked events carry machine-readable reasons",
      reasons.has("absent_at_provider") && reasons.has("deselected_on_import") && reasons.has("manual_disconnect"),
      [...reasons].join(",")
    );
  }

  /* ─────────────────────── usage.spec (AC-MA-07) ─────────────────────── */
  console.log("\nusage.spec — self-tracked ledger counting + thresholds");
  {
    const accounts = await listAccounts(A.supabase, A.userId);
    const target = accounts.find((a) => a.platform === "tiktok")!;
    const nowIso = new Date().toISOString();
    const lastMonth = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    for (let i = 0; i < 8; i++) {
      await insertLedgerRow(A.supabase, {
        creator_id: A.userId,
        social_account_id: target.id,
        platform: target.platform,
        client_ref: `manifest-${i}`,
        provider_request_id: `req-${i}`,
      });
    }
    await insertLedgerRow(A.supabase, {
      creator_id: A.userId,
      social_account_id: target.id,
      platform: target.platform,
      client_ref: "manifest-old",
      provider_request_id: "req-old",
      created_at: lastMonth,
    });
    const counts = await countUploadsThisMonth(A.supabase, A.userId, nowIso);
    check("ledger counts THIS month only (8, not 9)", counts.get(target.id) === 8, String(counts.get(target.id)));

    const usage = await accountsUsage(A.supabase, A.userId, accounts, nowIso);
    const u = usage.find((x) => x.accountId === target.id)!;
    check("usage level hits WARNING at the threshold (8 of 10)", u.level === "warning" && u.warnAt === 8);

    for (let i = 8; i < 10; i++) {
      await insertLedgerRow(A.supabase, {
        creator_id: A.userId,
        social_account_id: target.id,
        platform: target.platform,
        client_ref: `manifest-${i}`,
        provider_request_id: `req-${i}`,
      });
    }
    const usage2 = await accountsUsage(A.supabase, A.userId, accounts, nowIso);
    check(
      "usage level EXCEEDED at the allowance (10 of 10)",
      usage2.find((x) => x.accountId === target.id)?.level === "exceeded"
    );

    const { data: updated } = await A.supabase
      .from("social_publish_ledger")
      .update({ client_ref: "tampered" })
      .eq("social_account_id", target.id)
      .select("*");
    check("ledger is append-only even for its owner (no update policy)", (updated ?? []).length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
