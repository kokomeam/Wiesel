/**
 * verify-accounts — pure suite for the M-A social-publishing foundation
 * (no key, no DB, no browser). Run: npx tsx scripts/verify-accounts.ts
 *
 * Sections (the *.spec names map to the checkpoint ACs):
 *   adapter.spec      — AC-MA-01: the Upload-Post adapter against the RECORDED
 *                       Task 0a fixtures (lib/marketing/accounts/fixtures/task0a)
 *   crypto.spec       — profile_ref encryption-at-rest round-trip + tamper
 *   events.spec       — AC-MA-04 (pure half): TS union ↔ migration drift guard
 *   language.spec     — AC-MA-06: no publish/schedule copy on the M-A surface
 *   confinement.spec  — AC-MA-05 (static half): vendor + secret import fences;
 *                       versioned-writes-only (repository confinement)
 *   usage.spec        — AC-MA-07 (pure half): usageLevel threshold logic
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

process.env.SOCIAL_ACCOUNTS_ENC_KEY = Buffer.alloc(32, 7).toString("base64");

import {
  createUploadPostProvider,
  UploadPostError,
} from "../lib/marketing/publish/provider/uploadPostClient";
import { isPermanentPublishError } from "../lib/marketing/publish/provider/types";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "../lib/marketing/accounts/crypto";
import { usageLevel, BANNED_ACCOUNTS_COPY, accountsUsageConfig } from "../lib/marketing/accounts/constants";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURES = join(ROOT, "lib", "marketing", "accounts", "fixtures", "task0a");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function fixtureBody(name: string): unknown {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
  return raw.response?.body ?? raw;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(entry)) yield p;
  }
}

/* ───────────────────────── adapter.spec (AC-MA-01) ───────────────────── */

type RecordedCall = { url: string; method: string; body: unknown };

function providerWith(
  handler: (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined,
  calls: RecordedCall[] = []
) {
  return createUploadPostProvider({
    apiKey: "test-key",
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
      const out = handler(String(url), init) ?? { status: 404, body: { error: "Not Found" } };
      return new Response(JSON.stringify(out.body), {
        status: out.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });
}

async function adapterSpec() {
  console.log("\nadapter.spec — Upload-Post adapter vs recorded Task 0a fixtures");

  // profile creation — idempotent per creator
  {
    const p = providerWith(() => ({ status: 201, body: { success: true } }));
    const r = await p.createCreatorProfile("ws_abc");
    check("createCreatorProfile 201 → created:true", r.created === true && r.profileRef === "ws_abc");
  }
  {
    const p = providerWith(() => ({ status: 409, body: { success: false, message: "exists" } }));
    const r = await p.createCreatorProfile("ws_abc");
    check("createCreatorProfile 409 (already exists) → success, created:false", r.created === false);
  }
  {
    const p = providerWith(() => ({ status: 400, body: { success: false, message: "bad username" } }));
    let err: unknown = null;
    await p.createCreatorProfile("!!").catch((e) => (err = e));
    check(
      "createCreatorProfile 400 → UploadPostError permanent",
      err instanceof UploadPostError && err.permanent === true && isPermanentPublishError(err)
    );
  }

  // link URL (JWT flow) — recorded generate-jwt fixture
  {
    const p = providerWith(() => ({ body: fixtureBody("generate-jwt") }));
    const r = await p.getLinkUrl("ws_abc", ["linkedin", "youtube"], "https://x.test/return");
    check("getLinkUrl parses access_url", typeof r.url === "string" && r.url.length > 0);
    check("getLinkUrl parses 48h duration", r.expiresInHours === 48, String(r.expiresInHours));
  }
  {
    const p = providerWith(() => ({ body: { success: true } }));
    let threw = false;
    await p.getLinkUrl("ws_abc", [], "https://x.test").catch(() => (threw = true));
    check("getLinkUrl missing access_url → throws", threw);
  }

  // listConnectedAccounts — recorded profile listing ("henry")
  {
    const p = providerWith(() => ({ body: fixtureBody("list-profiles") }));
    const accounts = await p.listConnectedAccounts("henry");
    const platforms = accounts.map((a) => a.platform).sort();
    check(
      "listConnectedAccounts: connected platforms parsed, '' placeholder skipped",
      platforms.join(",") === "facebook,linkedin,youtube",
      platforms.join(",")
    );
    const yt = accounts.find((a) => a.platform === "youtube");
    check(
      "account fields: display_name/handle/avatar/reauth",
      yt?.displayName === "Henry Lai" &&
        yt?.handle === "@henrylai4667" &&
        typeof yt?.avatarUrl === "string" &&
        yt?.reauthRequired === false
    );
    const none = await providerWith(() => ({ body: fixtureBody("list-profiles") })).listConnectedAccounts("ghost");
    check("unknown profile → empty list", none.length === 0);
  }

  // publish (text, sync) — the Task 0a test-1 recordings
  {
    const calls: RecordedCall[] = [];
    const p = providerWith(() => ({ body: fixtureBody("publish-text-sync-success") }), calls);
    const r = await p.publish({
      profileRef: "henry",
      platform: "linkedin",
      kind: "text",
      title: "hello",
      clientRef: "manifest-1",
      firstComment: "first!",
    });
    check("publish text sync → mode sync", r.mode === "sync");
    check(
      "publish text sync → platform post id + url (external_ref source)",
      r.platformPostId === "urn:li:share:7485955623193542656" &&
        r.postUrl === "https://www.linkedin.com/feed/update/urn:li:share:7485955623193542656/"
    );
    check("publish text sync → usage {count:1, limit:10}", r.usage?.count === 1 && r.usage?.limit === 10);
    check("publish text sync → provider request id", typeof r.providerRequestId === "string");
    check("publish sends multipart FormData", calls[0].body instanceof FormData);
    const form = calls[0].body as FormData;
    check(
      "publish carries first_comment + platform[] + user",
      form.get("first_comment") === "first!" &&
        form.get("platform[]") === "linkedin" &&
        form.get("user") === "henry"
    );
    check("publish text never sets async_upload", form.get("async_upload") === null);
    check("publish text targets /upload_text", calls[0].url.endsWith("/upload_text"));
  }
  {
    const p = providerWith(() => ({ body: fixtureBody("publish-text-duplicate-rejected") }));
    const r = await p.publish({
      profileRef: "henry",
      platform: "linkedin",
      kind: "text",
      title: "hello",
      clientRef: "manifest-2",
    });
    check(
      "duplicate rejection (HTTP 200 envelope) → platformError, no refs",
      r.platformError !== null &&
        r.platformError.includes("Duplicate post detected") &&
        r.platformPostId === null
    );
  }

  // publish (video, async) — the Task 0a test-2 recording
  {
    const calls: RecordedCall[] = [];
    const p = providerWith(() => ({ body: fixtureBody("publish-video-async-accepted") }), calls);
    const r = await p.publish({
      profileRef: "henry",
      platform: "youtube",
      kind: "video",
      title: "clip",
      clientRef: "manifest-3",
      videoBytes: Buffer.from("fake-mp4"),
      filename: "clip.mp4",
    });
    check(
      "publish video async → mode async + request id",
      r.mode === "async" && r.providerRequestId === "42e9c735c9f64a5ba6d9fa3ae3432cb8"
    );
    const form = calls[0].body as FormData;
    check("publish video sets async_upload=true", form.get("async_upload") === "true");
    check("publish video targets /upload", calls[0].url.endsWith("/upload"));
    let threw = false;
    await p
      .publish({ profileRef: "h", platform: "youtube", kind: "video", title: "x", clientRef: "m" })
      .catch(() => (threw = true));
    check("publish video without bytes → throws", threw);
  }

  // verifyPost — poll semantics per FINDINGS
  {
    const p = providerWith(() => ({ body: fixtureBody("status-poll-completed") }));
    const r = await p.verifyPost({
      profileRef: "henry",
      platform: "youtube",
      providerRequestId: "42e9c735c9f64a5ba6d9fa3ae3432cb8",
    });
    check(
      "verifyPost completed → live + refs FROM THE STATUS POLL (richer than spec)",
      r.state === "live" &&
        r.platformPostId === "oG1hZXB2EJ8" &&
        r.postUrl === "https://www.youtube.com/watch?v=oG1hZXB2EJ8"
    );
  }
  {
    const p = providerWith(() => ({ body: { status: "in_progress", completed: 0, total: 1, results: [] } }));
    const r = await p.verifyPost({ profileRef: "h", platform: "youtube", providerRequestId: "req" });
    check("verifyPost in_progress → pending", r.state === "pending");
  }
  {
    const p = providerWith(() => ({
      body: {
        status: "completed",
        results: [{ platform: "linkedin", success: false, error_message: "Duplicate post detected." }],
      },
    }));
    const r = await p.verifyPost({ profileRef: "h", platform: "linkedin", providerRequestId: "req" });
    check(
      "verifyPost platform failure → failed + error (terminal)",
      r.state === "failed" && (r.error ?? "").includes("Duplicate")
    );
  }
  {
    // Spec-shaped status (success but NO refs — the vendor-spec shape never
    // observed live) → history is the audit backstop, limit=10 pinned.
    const calls: RecordedCall[] = [];
    const p = providerWith((url) => {
      if (url.includes("/uploadposts/status")) {
        return { body: { status: "completed", results: [{ platform: "youtube", success: true }] } };
      }
      if (url.includes("/uploadposts/history")) {
        return {
          body: {
            history: [
              {
                platform: "youtube",
                success: true,
                request_id: "req-hist",
                platform_post_id: "oG1hZXB2EJ8",
                post_url: "https://www.youtube.com/watch?v=oG1hZXB2EJ8",
              },
            ],
          },
        };
      }
      return undefined;
    }, calls);
    const r = await p.verifyPost({ profileRef: "h", platform: "youtube", providerRequestId: "req-hist" });
    check(
      "verifyPost spec-shaped status → history fallback fills refs",
      r.state === "live" && r.platformPostId === "oG1hZXB2EJ8"
    );
    const histCall = calls.find((c) => c.url.includes("/uploadposts/history"));
    check("history fallback pins limit=10 (other limits are rejected live)", histCall?.url.includes("limit=10") === true);
  }

  // deletePost — honest refusal, ZERO requests (Task 0a Test 3)
  {
    const calls: RecordedCall[] = [];
    const p = providerWith(() => ({ body: {} }), calls);
    const r = await p.deletePost({ profileRef: "h", platform: "linkedin", platformPostId: "urn:li:share:1" });
    check(
      "deletePost → {deleted:false, reason:'unsupported_by_provider'}",
      r.deleted === false && r.reason === "unsupported_by_provider"
    );
    check("deletePost fires ZERO provider requests", calls.length === 0);
  }

  // getComments — the live-verified first-comment retrieval path
  {
    const calls: RecordedCall[] = [];
    const p = providerWith(() => ({ body: fixtureBody("comments-linkedin") }), calls);
    const comments = await p.getComments({
      profileRef: "henry",
      platform: "linkedin",
      platformPostId: "urn:li:share:7485955623193542656",
    });
    check(
      "getComments parses id + text",
      comments.length === 1 &&
        comments[0].id === "7485955646044143616" &&
        comments[0].text.startsWith("First comment via API")
    );
    check(
      "getComments queries with `user` (NOT `profile` — 400 live)",
      calls[0].url.includes("user=henry") && !calls[0].url.includes("profile=")
    );
  }

  // error permanence taxonomy
  for (const [status, permanent] of [
    [401, true],
    [404, true],
    [408, false],
    [429, false],
    [500, false],
  ] as const) {
    const e = new UploadPostError("op", status, "detail");
    check(`UploadPostError ${status} → permanent:${permanent}`, e.permanent === permanent);
  }
}

/* ───────────────────────────── crypto.spec ───────────────────────────── */

function cryptoSpec() {
  console.log("\ncrypto.spec — profile_ref encryption at rest");
  check("isEncryptionConfigured with a 32-byte key", isEncryptionConfigured());
  const enc = encryptSecret("henry");
  check("ciphertext is versioned v1.<iv>.<tag>.<ct>", enc.startsWith("v1.") && enc.split(".").length === 4);
  check("round-trip decrypts", decryptSecret(enc) === "henry");
  check("fresh IV per call, both decrypt", encryptSecret("henry") !== enc && decryptSecret(encryptSecret("henry")) === "henry");
  {
    const parts = enc.split(".");
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] = ct[0] ^ 0xff;
    parts[3] = ct.toString("base64url");
    let threw = false;
    try {
      decryptSecret(parts.join("."));
    } catch {
      threw = true;
    }
    check("tampered ciphertext → GCM auth failure", threw);
  }
  {
    let threw = false;
    try {
      decryptSecret("v9.a.b.c");
    } catch {
      threw = true;
    }
    check("unknown format version → throws", threw);
  }
  {
    const saved = process.env.SOCIAL_ACCOUNTS_ENC_KEY;
    delete process.env.SOCIAL_ACCOUNTS_ENC_KEY;
    check("unset key → not configured", !isEncryptionConfigured());
    let msg = "";
    try {
      encryptSecret("x");
    } catch (e) {
      msg = e instanceof Error ? e.message : "";
    }
    check("unset key → encrypt throws the setup message", msg.includes("SOCIAL_ACCOUNTS_ENC_KEY"));
    process.env.SOCIAL_ACCOUNTS_ENC_KEY = Buffer.alloc(8).toString("base64");
    check("wrong-length key → not configured", !isEncryptionConfigured());
    process.env.SOCIAL_ACCOUNTS_ENC_KEY = saved;
  }
}

/* ─────────────────────── events.spec (AC-MA-04 pure) ─────────────────── */

const ACCOUNT_EVENTS = ["social_account_linked", "social_account_expired", "social_account_revoked"];

function eventsSpec() {
  console.log("\nevents.spec — TS union ↔ DB check drift guard");
  const migration = readFileSync(
    join(ROOT, "supabase", "migrations", "20260723120000_social_accounts.sql"),
    "utf8"
  );
  const typesSrc = readFileSync(join(ROOT, "lib", "marketing", "types.ts"), "utf8");
  const emitSrc = readFileSync(join(ROOT, "lib", "marketing", "accounts", "events.ts"), "utf8");
  check(
    "all 3 account events in the migration check constraint",
    ACCOUNT_EVENTS.every((e) => migration.includes(`'${e}'`))
  );
  check(
    "all 3 account events in the AnalyticsEventType union",
    ACCOUNT_EVENTS.every((e) => typesSrc.includes(`"${e}"`))
  );
  check(
    "emitAccountEvent's Extract covers all 3",
    ACCOUNT_EVENTS.every((e) => emitSrc.includes(`"${e}"`))
  );
  check(
    "snake_case convention (no dotted event names)",
    !migration.includes("social_account.") && !ACCOUNT_EVENTS.some((e) => e.includes("."))
  );
}

/* ────────────────────── language.spec (AC-MA-06) ─────────────────────── */

const SURFACE_DIRS = [
  join(ROOT, "components", "marketing", "accounts"),
  join(ROOT, "app", "(app)", "marketing", "accounts"),
];

/** User-visible strings only: string literals + JSX text nodes. Comments are
 *  stripped FIRST (an apostrophe in a docblock must not open a phantom
 *  literal), import/export lines are excluded (paths like lib/marketing/
 *  publish are code, not copy), and quote literals never span lines. */
function extractCopy(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const noImports = noComments
    .split("\n")
    .filter((l) => !/^\s*(import|export)\b/.test(l) && !l.includes(' from "') && !l.includes(" from '"))
    .join("\n");
  const out: string[] = [];
  const litRe = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = litRe.exec(noImports))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  const jsxRe = />([^<>{}]+)</g;
  while ((m = jsxRe.exec(noComments))) out.push(m[1]);
  return out;
}

function languageSpec() {
  console.log("\nlanguage.spec — connected-account wording only on the M-A surface");
  const offenders: string[] = [];
  for (const dir of SURFACE_DIRS) {
    for (const file of walk(dir)) {
      for (const copy of extractCopy(readFileSync(file, "utf8"))) {
        for (const banned of BANNED_ACCOUNTS_COPY) {
          if (copy.toLowerCase().includes(banned)) {
            offenders.push(`${file.replace(ROOT + "/", "")}: "${copy.trim().slice(0, 60)}"`);
          }
        }
      }
    }
  }
  check("no publish/schedule copy anywhere on the accounts surface", offenders.length === 0, offenders.join("; "));
  check(
    "the banned list itself is pinned",
    BANNED_ACCOUNTS_COPY.length === 2 && BANNED_ACCOUNTS_COPY.includes("publish") && BANNED_ACCOUNTS_COPY.includes("schedule")
  );
}

/* ─────────────── confinement.spec (AC-MA-05 static half) ─────────────── */

function confinementSpec() {
  console.log("\nconfinement.spec — vendor/secret fences + repository-only writes");

  const adapterPath = join(ROOT, "lib", "marketing", "publish", "provider", "uploadPostClient.ts");
  // Fences test CODE, not documentation — strip comments first (the docblock
  // legitimately NAMES the banned parameters while explaining the fence).
  const adapterCode = readFileSync(adapterPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // scheduling fence: our runtime owns fire times — no provider scheduling
  // parameter is ever sent by the adapter.
  check(
    "adapter code never references provider scheduling (scheduled_date/timezone/add_to_queue/queue/schedule)",
    !/scheduled_date|add_to_queue|"timezone"|\/schedule|queue/i.test(adapterCode)
  );
  check(
    "adapter code never references the webhook notifications endpoint (poll-only)",
    !adapterCode.includes("notifications")
  );

  // vendor-host confinement across all TS sources
  const scanRoots = [join(ROOT, "lib"), join(ROOT, "app"), join(ROOT, "components"), join(ROOT, "scripts")];
  const hostOffenders: string[] = [];
  for (const root of scanRoots) {
    for (const file of walk(root)) {
      if (
        file === adapterPath ||
        file.endsWith("verify-accounts.ts") ||
        file.endsWith("verify-accounts-bundle.ts")
      )
        continue;
      if (readFileSync(file, "utf8").includes("api.upload-post.com")) {
        hostOffenders.push(file.replace(ROOT + "/", ""));
      }
    }
  }
  check("api.upload-post.com appears ONLY in uploadPostClient.ts", hostOffenders.length === 0, hostOffenders.join(", "));

  // repository confinement for the three tables (the verify-social grep shape)
  const allowed = join(ROOT, "lib", "marketing", "accounts", "accountsRepository.ts");
  const writeOffenders: string[] = [];
  for (const root of [join(ROOT, "lib"), join(ROOT, "app"), join(ROOT, "components")]) {
    for (const file of walk(root)) {
      if (file === allowed) continue;
      const collapsed = readFileSync(file, "utf8").replace(/\s+/g, " ");
      for (const table of ["social_provider_profile", "social_account", "social_publish_ledger"]) {
        if (new RegExp(`from\\(["']${table}["']\\) *\\.(update|insert|upsert|delete)`).test(collapsed)) {
          writeOffenders.push(`${file.replace(ROOT + "/", "")} writes ${table}`);
        }
      }
    }
  }
  check(
    "social_provider_profile / social_account / social_publish_ledger writes confined to accountsRepository.ts",
    writeOffenders.length === 0,
    writeOffenders.join("; ")
  );

  // client-bundle fences: no "use client" file may import the adapter, the
  // crypto module, or the server-only service.
  const fenceTargets = ["publish/provider/uploadPostClient", "accounts/crypto", "accounts/accountsService"];
  const clientOffenders: string[] = [];
  for (const root of [join(ROOT, "components"), join(ROOT, "app")]) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      if (!/^\s*"use client"/.test(src)) continue;
      for (const target of fenceTargets) {
        if (src.includes(target)) clientOffenders.push(`${file.replace(ROOT + "/", "")} imports ${target}`);
      }
    }
  }
  check(
    "no client component imports the adapter / crypto / server service",
    clientOffenders.length === 0,
    clientOffenders.join("; ")
  );

  // fixtures provenance — the recorded samples the adapter tests run on
  const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
  check("Task 0a fixtures are tracked in the feature dir (10 recordings)", fixtures.length === 10, String(fixtures.length));
  const fixtureText = fixtures.map((f) => readFileSync(join(FIXTURES, f), "utf8")).join("");
  check(
    "fixtures stay redacted (no live API key / JWT material)",
    !fixtureText.includes("Apikey ey") && !/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(fixtureText)
  );
}

/* ─────────────────────── usage.spec (AC-MA-07 pure) ──────────────────── */

function usageSpec() {
  console.log("\nusage.spec — self-tracked monthly allowance thresholds");
  check("below warn → ok", usageLevel(0, 10, 8) === "ok" && usageLevel(7, 10, 8) === "ok");
  check("at warn → warning", usageLevel(8, 10, 8) === "warning");
  check("between warn and limit → warning", usageLevel(9, 10, 8) === "warning");
  check("at limit → exceeded", usageLevel(10, 10, 8) === "exceeded");
  check("over limit → exceeded", usageLevel(12, 10, 8) === "exceeded");
  const cfg = accountsUsageConfig();
  check("defaults: 10/month, warn at 8 (free tier; env-overridable)", cfg.uploadsPerMonth === 10 && cfg.warnAt === 8);
}

/* ────────────────────────────── main ─────────────────────────────────── */

async function main() {
  console.log("verify-accounts — M-A social publishing foundation (pure)");
  await adapterSpec();
  cryptoSpec();
  eventsSpec();
  languageSpec();
  confinementSpec();
  usageSpec();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
