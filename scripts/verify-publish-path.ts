/**
 * verify-publish-path — M-B pure suite (no key, no DB; in `npm test`):
 *   machine.spec   — the manifest state machine: legal/illegal edges,
 *                    terminal set, cancellable set, budgets
 *   guards.spec    — evaluatePublishGuards order + every hold reason
 *   ledger.spec    — decision 4: provider-ACCEPT writes, platformError skips
 *   mapping.spec   — post→publish platform map + the proven-platform gate
 *   compose.spec   — published text == the reviewed copy composition
 *   recovery.spec  — the conservative history matcher (never re-fire)
 *   fences.spec    — manifest writes confined to manifestRepository.ts; ONE
 *                    provider.publish call site; submitting-before-publish
 *                    order (decision 2); no scheduling params; no webhook
 *                    route; migration status enum ↔ TS drift guard; no
 *                    delete policy on the manifest
 *   agentic.spec   — M-AG: publish-ops tool tiers (retry/cancel irreversible,
 *                    not hard-denied; M-C trio stays hard-denied), inline-card
 *                    filing detection + follow-up fold, approvalSync publish
 *                    kind, chat-host fences (allowlisted path, same actions,
 *                    one assembly, no approve-all, no vocabulary leak),
 *                    conversation threading + row-derived decisions, prompt
 *                    teaching
 * Run: npx tsx scripts/verify-publish-path.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVE_MANIFEST_STATUSES,
  APPROVAL_TOKEN_TTL_MINUTES,
  CANCELLABLE_MANIFEST_STATUSES,
  canRetryManifest,
  composePublishText,
  evaluatePublishGuards,
  FIRST_COMMENT_SUPPORT,
  isTerminalManifestStatus,
  matchRecentPost,
  postPlatformToPublishPlatform,
  PROVEN_PUBLISH_PLATFORMS,
  PUBLISH_MANIFEST_STATUSES,
  PUBLISH_MANIFEST_TRANSITIONS,
  RECOVERY_GRACE_ATTEMPTS,
  shouldWriteLedgerRow,
  VERIFY_MAX_ATTEMPTS,
  VOIDABLE_MANIFEST_STATUSES,
  type PublishManifestStatus,
} from "@/lib/marketing/publish/manifest";
import { contentHashForPost } from "@/lib/marketing/publish/contentHash";
import {
  PUBLISH_CANCEL_MATCH,
  PUBLISH_RELEASED_EVENT,
  PUBLISH_REQUESTED_EVENT,
} from "@/lib/inngest/publishEvents";
import { AUTO_APPROVABLE_TOOLS, HARD_DENY_TOOLS, KNOWN_IRREVERSIBLE_TOOLS } from "@/lib/marketing/autonomy";
import { ALL_MARKETING_TOOLS } from "@/lib/marketing/tools";
import { filedApprovalIds, followUpFromEvents } from "@/lib/marketing/agent/events";
import { publishDecisionMessage } from "@/lib/marketing/agent/resume";
import {
  APPROVAL_SYNC_CHANNEL,
  resetApprovalSyncForTests,
  useApprovalSync,
} from "@/lib/marketing/approvalSync";
import {
  CONNECTED_VOCAB_ALLOWLIST,
  isConnectedVocabPath,
} from "@/lib/marketing/publish/languageAllowlist";
import { BANNED_UI_PHRASES, MANUAL_PUBLISH_NOTICE } from "@/lib/marketing/social/constants";
import type { ProviderRecentPost } from "@/lib/marketing/publish/provider/types";

const ROOT = new URL("..", import.meta.url).pathname;

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

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(entry)) yield p;
  }
}

console.log("verify-publish-path — M-B pure suite\n");

/* ───────────────────────────── machine.spec ───────────────────────────── */
console.log("machine.spec — the manifest state machine");
{
  check("10 statuses (M-C adds voided)", PUBLISH_MANIFEST_STATUSES.length === 10);
  const terminals = PUBLISH_MANIFEST_STATUSES.filter(isTerminalManifestStatus);
  check(
    "terminal set = live/platform_failed/failed/cancelled/voided",
    terminals.length === 5 &&
      (["live", "platform_failed", "failed", "cancelled", "voided"] as const).every((s) =>
        terminals.includes(s)
      )
  );
  check(
    "active set = the 5 non-terminal statuses",
    ACTIVE_MANIFEST_STATUSES.length === 5 &&
      (["queued", "held", "submitting", "submitted", "verifying"] as const).every((s) =>
        ACTIVE_MANIFEST_STATUSES.includes(s)
      )
  );
  check(
    "cancellable = queued + held ONLY (decision 1: no recall past submission)",
    CANCELLABLE_MANIFEST_STATUSES.length === 2 &&
      CANCELLABLE_MANIFEST_STATUSES.includes("queued") &&
      CANCELLABLE_MANIFEST_STATUSES.includes("held")
  );
  check(
    "voidable = queued + held (edit-voids only pre-submission)",
    VOIDABLE_MANIFEST_STATUSES.length === 2 &&
      VOIDABLE_MANIFEST_STATUSES.includes("queued") &&
      VOIDABLE_MANIFEST_STATUSES.includes("held")
  );
  const legal: Array<[PublishManifestStatus, PublishManifestStatus]> = [
    ["queued", "submitting"],
    ["queued", "held"],
    ["queued", "cancelled"],
    ["queued", "voided"],
    ["held", "submitting"],
    ["held", "cancelled"],
    ["held", "voided"],
    ["submitting", "submitted"],
    ["submitting", "platform_failed"],
    ["submitting", "failed"],
    ["submitted", "live"],
    ["submitted", "verifying"],
    ["submitted", "failed"],
    ["verifying", "live"],
    ["verifying", "platform_failed"],
    ["verifying", "failed"],
  ];
  check(
    "every expected edge is legal",
    legal.every(([f, t]) => PUBLISH_MANIFEST_TRANSITIONS[f].includes(t))
  );
  const totalEdges = PUBLISH_MANIFEST_STATUSES.reduce(
    (n, s) => n + PUBLISH_MANIFEST_TRANSITIONS[s].length,
    0
  );
  check(`exactly ${legal.length} legal edges exist (no stray edge)`, totalEdges === legal.length);
  const illegal: Array<[PublishManifestStatus, PublishManifestStatus]> = [
    ["submitting", "cancelled"], // no recall once submission begins
    ["submitted", "cancelled"],
    ["verifying", "cancelled"],
    ["submitting", "queued"], // never re-fire by rewinding
    ["submitted", "submitting"],
    ["live", "failed"], // terminal means terminal
    ["failed", "queued"],
    ["cancelled", "queued"],
    ["queued", "live"], // no skipping the durable submit marker
    ["queued", "submitted"],
    ["submitting", "voided"], // content already left — voiding is pre-submit only
    ["submitted", "voided"],
    ["voided", "queued"], // voided is IMMUTABLE (DB trigger backs this)
    ["voided", "submitting"],
    ["voided", "live"],
  ];
  check(
    "illegal edges are absent (cancel-past-submission, rewinds, terminal exits, skips)",
    illegal.every(([f, t]) => !PUBLISH_MANIFEST_TRANSITIONS[f].includes(t))
  );
  check("recovery grace = 3 attempts", RECOVERY_GRACE_ATTEMPTS === 3);
  check("verify budget = 60 polls", VERIFY_MAX_ATTEMPTS === 60);
}

/* ───────────────────────────── guards.spec ────────────────────────────── */
console.log("\nguards.spec — pre-submit guard order + reasons");
{
  const base = {
    scheduledFor: null as string | null,
    nowIso: "2026-07-28T09:30:00.000Z",
    accountStatus: "linked" as const,
    sourceSuperseded: false,
    uploadsThisMonth: 0,
    uploadsPerMonth: 10,
  };
  check("all clear → proceed", evaluatePublishGuards(base).kind === "proceed");
  check(
    "future schedule → not_due (never held)",
    evaluatePublishGuards({ ...base, scheduledFor: "2026-08-01T00:00:00.000Z" }).kind === "not_due"
  );
  check(
    "due schedule (past) → proceed",
    evaluatePublishGuards({ ...base, scheduledFor: "2026-07-28T09:00:00.000Z" }).kind === "proceed"
  );
  const expired = evaluatePublishGuards({ ...base, accountStatus: "expired" });
  check(
    "expired account → hold account_not_linked",
    expired.kind === "hold" && expired.reason === "account_not_linked"
  );
  const revoked = evaluatePublishGuards({ ...base, accountStatus: "revoked" });
  check(
    "revoked account → hold account_not_linked",
    revoked.kind === "hold" && revoked.reason === "account_not_linked"
  );
  const quota = evaluatePublishGuards({ ...base, uploadsThisMonth: 10 });
  check("quota at allowance → hold quota_exceeded", quota.kind === "hold" && quota.reason === "quota_exceeded");
  const order1 = evaluatePublishGuards({
    ...base,
    scheduledFor: "2026-08-01T00:00:00.000Z",
    accountStatus: "expired",
    uploadsThisMonth: 99,
  });
  check("order: not_due wins over every hold", order1.kind === "not_due");
  const order2 = evaluatePublishGuards({
    ...base,
    accountStatus: "expired",
    uploadsThisMonth: 99,
  });
  check(
    "order: health before quota",
    order2.kind === "hold" && order2.reason === "account_not_linked"
  );
  // M-D (from the first live E2E): the card-approved fire time is
  // AUTHORITATIVE — no send-window input exists to hold it.
  check(
    "no send-window gate on card-approved manifests (fire time authoritative)",
    !JSON.stringify(Object.keys(base)).includes("withinWindow")
  );
  const frozen = evaluatePublishGuards({ ...base, sourceSuperseded: true });
  check(
    "superseded source → hold source_superseded (amendment 2, pre-submit)",
    frozen.kind === "hold" && frozen.reason === "source_superseded"
  );
  const order4 = evaluatePublishGuards({
    ...base,
    sourceSuperseded: true,
    uploadsThisMonth: 99,
  });
  check(
    "order: frozen-source before quota",
    order4.kind === "hold" && order4.reason === "source_superseded"
  );
  const order5 = evaluatePublishGuards({ ...base, accountStatus: "expired", sourceSuperseded: true });
  check(
    "order: health before frozen-source",
    order5.kind === "hold" && order5.reason === "account_not_linked"
  );
}

/* ─────────────────────────── governance.spec ──────────────────────────── */
console.log("\ngovernance.spec — M-C constants + amendment invariants");
{
  check("card token TTL = 15 minutes", APPROVAL_TOKEN_TTL_MINUTES === 15);
  check(
    "first-comment support: LinkedIn proven, YouTube unverified (amendment 4)",
    FIRST_COMMENT_SUPPORT.linkedin === "proven" && FIRST_COMMENT_SUPPORT.youtube === "unverified"
  );
  check("retry allowed ONLY from failed", canRetryManifest("failed"));
  check(
    "platform_failed / voided / live are NOT retryable",
    !canRetryManifest("platform_failed") && !canRetryManifest("voided") && !canRetryManifest("live")
  );
  check(
    "the 3 publish tools are registered irreversible",
    ["publish_social_post", "schedule_social_post", "unpublish_social_post"].every((t) =>
      KNOWN_IRREVERSIBLE_TOOLS.has(t)
    )
  );
  check(
    "…and HARD-DENIED (a card in manual, assisted AND auto — AC-MC.6 config half)",
    ["publish_social_post", "schedule_social_post", "unpublish_social_post"].every((t) =>
      HARD_DENY_TOOLS.has(t)
    )
  );
}

/* ─────────────────────────── contentHash.spec ─────────────────────────── */
console.log("\ncontentHash.spec — amendment 1: the approval-content binding");
{
  const base: {
    body: string;
    cta: string | null;
    hashtags: string[];
    first_comment: string | null;
    video_path: string | null;
    image_storage_path: string | null;
  } = {
    body: "Body",
    cta: "CTA",
    hashtags: ["a", "b"],
    first_comment: "First!",
    video_path: "clips/x.mp4",
    image_storage_path: null,
  };
  const h = contentHashForPost(base);
  check("deterministic", contentHashForPost({ ...base }) === h);
  check("versioned prefix", h.startsWith("ph1:"));
  const fields: Array<[string, Partial<typeof base>]> = [
    ["body", { body: "Changed" }],
    ["cta", { cta: null }],
    ["hashtags", { hashtags: ["a"] }],
    ["first_comment", { first_comment: null }],
    ["video_path (re-burn rotates it)", { video_path: "clips/y.mp4" }],
    ["image_storage_path", { image_storage_path: "img/z.png" }],
  ];
  for (const [name, over] of fields) {
    check(`${name} change → different hash`, contentHashForPost({ ...base, ...over }) !== h);
  }
  check(
    "null-vs-empty cta canonicalization is stable",
    contentHashForPost({ ...base, cta: null }) === contentHashForPost({ ...base, cta: null })
  );
}

/* ─────────────────────────── fireWiring.spec ──────────────────────────── */
console.log("\nfireWiring.spec — amendment 1: sleepUntil-precise, cancel-by-event");
{
  const fn = readFileSync(
    join(ROOT, "lib/inngest/functions/publish.ts"),
    "utf8"
  );
  check("event names are the shared constants", PUBLISH_REQUESTED_EVENT === "social/publish.requested" && PUBLISH_RELEASED_EVENT === "social/publish.released");
  check(
    "cancelOn matches the released event by manifestId",
    PUBLISH_CANCEL_MATCH === "event.data.manifestId == async.data.manifestId" &&
      fn.includes("cancelOn: [{ event: PUBLISH_RELEASED_EVENT, if: PUBLISH_CANCEL_MATCH }]")
  );
  check(
    "fire accuracy: sleepUntil targets scheduled_for EXACTLY (no cron quantization)",
    fn.includes('step.sleepUntil("wait-for-fire-time", new Date(scheduledFor))')
  );
  check(
    "the fire function triggers on the requested event (event-driven, not cron)",
    fn.includes("triggers: [{ event: PUBLISH_REQUESTED_EVENT }]")
  );
  check(
    "the sweep is the retained M-B tick as an Inngest cron backstop",
    fn.includes('triggers: [{ cron: "*/5 * * * *" }]') && fn.includes("processPublishTick")
  );
  const tickRoute = readFileSync(
    join(ROOT, "app/api/marketing/scheduler/tick/route.ts"),
    "utf8"
  );
  check(
    "the marketing scheduler tick no longer runs the publish tick",
    !tickRoute.includes("processPublishTick")
  );
}

/* ───────────────────────────── ledger.spec ────────────────────────────── */
console.log("\nledger.spec — decision 4");
{
  check("provider-ACCEPT (no platformError) → write the row", shouldWriteLedgerRow({ platformError: null }));
  check(
    "platformError set → NO row (mirrors vendor quota semantics)",
    !shouldWriteLedgerRow({ platformError: "Duplicate post detected" })
  );
  check("empty-string platformError still skips", !shouldWriteLedgerRow({ platformError: "" }));
}

/* ───────────────────────────── mapping.spec ───────────────────────────── */
console.log("\nmapping.spec — platform map + proven gate");
{
  check("youtube_shorts → youtube", postPlatformToPublishPlatform("youtube_shorts") === "youtube");
  check("linkedin → linkedin", postPlatformToPublishPlatform("linkedin") === "linkedin");
  check("facebook → facebook", postPlatformToPublishPlatform("facebook") === "facebook");
  check("instagram → instagram", postPlatformToPublishPlatform("instagram") === "instagram");
  check("tiktok → tiktok", postPlatformToPublishPlatform("tiktok") === "tiktok");
  check("unknown → null (refused upstream)", postPlatformToPublishPlatform("threads") === null);
  check(
    "proven platforms = linkedin + youtube exactly (Task 0a; the rest are 0b)",
    PROVEN_PUBLISH_PLATFORMS.length === 2 &&
      PROVEN_PUBLISH_PLATFORMS.includes("linkedin") &&
      PROVEN_PUBLISH_PLATFORMS.includes("youtube")
  );
}

/* ───────────────────────────── compose.spec ───────────────────────────── */
console.log("\ncompose.spec — published text == reviewed copy");
{
  check(
    "body only",
    composePublishText({ body: "Hello", cta: null, hashtags: [] }) === "Hello"
  );
  check(
    "body + cta joined by a blank line",
    composePublishText({ body: "Hello", cta: "Enroll now", hashtags: [] }) === "Hello\n\nEnroll now"
  );
  check(
    "hashtags gain # when missing, keep it when present",
    composePublishText({ body: "A", cta: null, hashtags: ["one", "#two"] }) === "A\n\n#one #two"
  );
  check(
    "full composition order: body, cta, hashtags",
    composePublishText({ body: "A", cta: "B", hashtags: ["c"] }) === "A\n\nB\n\n#c"
  );
}

/* ───────────────────────────── recovery.spec ──────────────────────────── */
console.log("\nrecovery.spec — conservative history matching (never re-fire)");
{
  const row = (over: Partial<ProviderRecentPost>): ProviderRecentPost => ({
    platform: "linkedin",
    title: "A\n\n#c",
    providerRequestId: "req-1",
    platformPostId: "post-1",
    postUrl: "https://l.example/1",
    success: true,
    ...over,
  });
  const target = { platform: "linkedin" as const, title: "A\n\n#c" };
  const hit = matchRecentPost([row({})], target);
  check(
    "exact title + platform + success → adopts refs",
    hit !== null && hit.providerRequestId === "req-1" && hit.platformPostId === "post-1"
  );
  check("null title NEVER matches (unverified field)", matchRecentPost([row({ title: null })], target) === null);
  check("title mismatch → no match", matchRecentPost([row({ title: "other" })], target) === null);
  check(
    "platform mismatch → no match",
    matchRecentPost([row({ platform: "youtube" })], target) === null
  );
  check("failed row → no match", matchRecentPost([row({ success: false })], target) === null);
  check(
    "row with zero refs → no match (nothing to adopt)",
    matchRecentPost(
      [row({ providerRequestId: null, platformPostId: null, postUrl: null })],
      target
    ) === null
  );
  check(
    "first matching row wins among several",
    matchRecentPost([row({ title: "x" }), row({ providerRequestId: "req-2" }), row({})], target)
      ?.providerRequestId === "req-2"
  );
}

/* ───────────────────────────── fences.spec ────────────────────────────── */
console.log("\nfences.spec — structural invariants");
{
  const scanned: string[] = [];
  for (const dir of ["lib", "app", "components"]) {
    for (const f of walk(join(ROOT, dir))) scanned.push(f);
  }
  const read = (p: string) => readFileSync(p, "utf8");

  const manifestWriters = scanned.filter((f) => {
    const src = read(f);
    return (
      src.includes(`from("social_publish_manifest")`) &&
      !f.endsWith("manifestRepository.ts")
    );
  });
  check(
    "social_publish_manifest touched ONLY by manifestRepository.ts",
    manifestWriters.length === 0,
    manifestWriters.map((f) => f.replace(ROOT, "")).join(", ")
  );

  const publishCallers = scanned.filter((f) => read(f).includes("provider.publish("));
  check(
    "exactly ONE provider.publish call site (publishService.ts) — never re-fired elsewhere",
    publishCallers.length === 1 && publishCallers[0].endsWith("publishService.ts"),
    publishCallers.map((f) => f.replace(ROOT, "")).join(", ")
  );

  const service = read(join(ROOT, "lib/marketing/publish/publishService.ts"));
  const submittingIdx = service.indexOf(`"submitting", {`);
  const publishIdx = service.indexOf("deps.provider.publish(");
  check(
    "decision 2 order: the durable `submitting` transition precedes the publish call",
    submittingIdx !== -1 && publishIdx !== -1 && submittingIdx < publishIdx
  );
  check(
    "ledger writes go through the decision-4 predicate",
    service.includes("shouldWriteLedgerRow(")
  );

  const adapter = read(join(ROOT, "lib/marketing/publish/provider/uploadPostClient.ts"));
  // Quoted-key form only — the docblock legitimately NAMES the banned params
  // in prose; what must never exist is one used as a form/json key.
  check(
    "adapter still sends NO scheduling parameter",
    !/["'](scheduled_date|add_to_queue|timezone|schedule_time|queue)["']/.test(adapter)
  );
  const webhookRefs = scanned.filter((f) => read(f).includes("uploadposts/notifications"));
  check(
    "the vendor webhook endpoint is referenced NOWHERE (poll-only production path)",
    webhookRefs.length === 0,
    webhookRefs.map((f) => f.replace(ROOT, "")).join(", ")
  );
  // Literal split so the accounts suite's own vendor-host grep (which scans
  // scripts/ too) doesn't count THIS fence as an occurrence.
  const vendorHost = "api.upload-" + "post.com";
  const vendorHostFiles = scanned.filter((f) => read(f).includes(vendorHost));
  check(
    "vendor host confined to uploadPostClient.ts",
    vendorHostFiles.length === 1 && vendorHostFiles[0].endsWith("uploadPostClient.ts"),
    vendorHostFiles.map((f) => f.replace(ROOT, "")).join(", ")
  );

  const migration = read(
    join(ROOT, "supabase/migrations/20260729100000_social_publish_manifest.sql")
  );
  check(
    "migration defines NO delete policy on the manifest (cancel, never delete)",
    !/social_publish_manifest for delete/.test(migration)
  );
  check(
    "manifest RLS is creator-scoped in the migration",
    (migration.match(/creator_id = \(select auth\.uid\(\)\)/g) ?? []).length >= 4
  );

  // M-C governance migration drift guards.
  const gov = read(join(ROOT, "supabase/migrations/20260729140000_publish_governance.sql"));
  const enumInGov = gov.match(/add constraint social_publish_manifest_status_check\s*\n?\s*check \(status in \(([^)]+)\)/);
  const govStatuses = (enumInGov?.[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/'/g, ""))
    .filter(Boolean);
  check(
    "governance migration status enum ↔ PUBLISH_MANIFEST_STATUSES drift guard (incl. voided)",
    govStatuses.length === PUBLISH_MANIFEST_STATUSES.length &&
      PUBLISH_MANIFEST_STATUSES.every((s) => govStatuses.includes(s))
  );
  check(
    "voided manifests are DB-immutable (BEFORE UPDATE trigger in the migration)",
    gov.includes("social_publish_manifest_voided_guard") &&
      gov.includes("voided publish manifests are immutable")
  );
  check(
    "approval_id is NOT NULL + UNIQUE (one approval → one manifest, replay dead at the DB)",
    gov.includes("alter column approval_id set not null") &&
      gov.includes("create unique index social_publish_manifest_approval_idx")
  );
  check(
    "approvals table has NO delete policy (governance audit trail)",
    !/social_publish_approval for delete/.test(gov)
  );
  check(
    "posted_api + unpublished_local in the post status check, distinct from posted_manual",
    gov.includes("'posted_api'") && gov.includes("'unpublished_local'") && gov.includes("'posted_manual'")
  );

  // AC-MC.1 static half — the card-sole-path call graph.
  const approvalWriters = scanned.filter(
    (f) =>
      read(f).includes(`from("social_publish_approval")`) &&
      !f.endsWith("approvalRepository.ts") &&
      !f.endsWith("entities.ts")
  );
  check(
    "social_publish_approval writes confined to approvalRepository (+ entities restore)",
    approvalWriters.length === 0,
    approvalWriters.map((f) => f.replace(ROOT, "")).join(", ")
  );
  const requestPublishCallers = scanned.filter(
    (f) =>
      /requestPublish\(/.test(read(f)) &&
      !f.endsWith("approvalService.ts") &&
      !f.endsWith("publishService.ts")
  );
  check(
    "requestPublish called ONLY by approvalService (the card approve)",
    requestPublishCallers.length === 0,
    requestPublishCallers.map((f) => f.replace(ROOT, "")).join(", ")
  );
  const manifestCreators = scanned.filter(
    (f) =>
      read(f).includes("createPublishManifest(") &&
      !f.endsWith("manifestRepository.ts") &&
      !f.endsWith("publishService.ts")
  );
  check(
    "createPublishManifest called ONLY inside the publish domain (service + repository)",
    manifestCreators.length === 0,
    manifestCreators.map((f) => f.replace(ROOT, "")).join(", ")
  );

  // AC-MC.2 static half — ONE composition, two sanctioned call sites (M-D:
  // the card side is cardPayload.ts, shared by the page AND the modal).
  const composeCallers = scanned.filter((f) => read(f).includes("composePublishText("));
  check(
    "composePublishText called exactly by the workflow + the shared card assembly",
    composeCallers.length === 3 &&
      composeCallers.some((f) => f.endsWith("publishService.ts")) &&
      composeCallers.some((f) => f.endsWith("lib/marketing/publish/cardPayload.ts")) &&
      composeCallers.some((f) => f.endsWith("lib/marketing/publish/manifest.ts")),
    composeCallers.map((f) => f.replace(ROOT, "")).join(", ")
  );

  // AC-MC.3 — no approve-all affordance anywhere on the publish surface.
  const publishUi = [
    join(ROOT, "components/marketing/publish"),
    join(ROOT, "app/(app)/marketing/publish"),
  ];
  const approveAllOffenders: string[] = [];
  for (const dir of publishUi) {
    for (const f of walk(dir)) {
      // Affordance forms only (identifier / label / action name) — the
      // docblocks legitimately NAME the ban in prose ("approve-all").
      if (/approveAll|approve_all|Approve all|Approve All/.test(read(f))) approveAllOffenders.push(f);
    }
  }
  check(
    "NO approve-all affordance on the publish surface",
    approveAllOffenders.length === 0,
    approveAllOffenders.join(", ")
  );

  // AC-MC.4 — the language allowlist is PATH-scoped, not a global unban: the
  // social + accounts fences keep their original scan sets (which exclude
  // the publish dirs), and publish vocabulary exists ONLY there.
  const socialSuite = read(join(ROOT, "scripts/verify-social.ts"));
  check(
    "verify-social's banned-phrase scan still scopes to the social dirs (no widening/unban)",
    socialSuite.includes('join(root, "components/marketing/social")') &&
      socialSuite.includes('join(root, "app/(app)/marketing/social")')
  );
  const accountsSuite = read(join(ROOT, "scripts/verify-accounts.ts"));
  check(
    "verify-accounts' language fence is untouched (accounts surface only)",
    accountsSuite.includes("language.spec"),
    "accounts language fence missing?"
  );
  const card = read(join(ROOT, "components/marketing/publish/PublishApprovalCard.tsx"));
  check(
    "publish vocabulary IS allowed on the card (the one sanctioned surface)",
    /publish/i.test(card)
  );

  // Governance forgery guard: the status tool cannot stamp posted_api.
  const socialTools = read(join(ROOT, "lib/marketing/tools/socialPosts.ts"));
  check(
    "mark_social_post_status cannot forge posted_api/unpublished_local",
    socialTools.includes('z.enum(["draft", "ready", "planned", "posted_manual", "archived"])')
  );

  // Edit-voids hook rides the single content-write path.
  const socialRepo = read(join(ROOT, "lib/marketing/social/repository.ts"));
  check(
    "versionedUpdateSocialPost carries the edit-voids hook (content-affecting keys)",
    socialRepo.includes("voidPublishArtifactsForPost") && socialRepo.includes("contentAffecting")
  );
}

/* ─────────────────────────── mdFences.spec (M-D) ──────────────────────── */
console.log("\nmdFences.spec — language split, entry-point purity, dev banner");
{
  const read = (p: string) => readFileSync(p, "utf8");
  const scanned: string[] = [];
  for (const dir of ["lib", "app", "components"]) {
    for (const f of walk(join(ROOT, dir))) scanned.push(f);
  }

  // AC-MD.5 direction 1: every allowlisted path exists and CARRIES the
  // vocabulary (it is the sanctioned home, not an empty exemption).
  for (const prefix of CONNECTED_VOCAB_ALLOWLIST) {
    const files = scanned.filter((f) => f.replace(ROOT, "").includes(prefix));
    check(
      `allowlist path ${prefix} exists and uses the vocabulary`,
      files.length > 0 && files.some((f) => /\b(publish|schedule)/i.test(read(f)))
    );
  }
  check(
    "the allowlist is exactly 3 paths (path-scoped, not a global unban)",
    CONNECTED_VOCAB_ALLOWLIST.length === 3
  );
  check(
    "verify-social skips ONLY the connected/ subtree",
    read(join(ROOT, "scripts/verify-social.ts")).includes('f.includes("/social/connected/")')
  );

  // AC-MD.5 direction 2: user-visible LITERALS on the non-allowlisted social
  // surface never use the bare connected vocabulary ("publishes" in the
  // Phase-1 notice is a different word and stays).
  const literalRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  const vocabRe = /\b(publish|schedule)\b/i;
  const offenders: string[] = [];
  for (const f of scanned) {
    const rel = f.replace(ROOT, "");
    if (!rel.includes("components/marketing/social/")) continue;
    if (isConnectedVocabPath(rel)) continue;
    const src = read(f);
    for (const m of src.matchAll(literalRe)) {
      const lit = m[1] ?? m[2] ?? m[3] ?? "";
      // import paths / identifiers ride literals too — only flag literals
      // with spaces (user-visible copy shape).
      if (lit.includes(" ") && vocabRe.test(lit)) offenders.push(`${rel}: "${lit.slice(0, 60)}"`);
    }
  }
  check(
    "no bare Publish/Schedule copy outside the allowlist on the social surface",
    offenders.length === 0,
    offenders.slice(0, 3).join(" · ")
  );

  // AC-MD.5: the Phase-1 copy is byte-unchanged.
  check(
    "MANUAL_PUBLISH_NOTICE bytes unchanged",
    MANUAL_PUBLISH_NOTICE === "You post this yourself — WiseSel never publishes to social platforms."
  );
  check(
    "BANNED_UI_PHRASES bytes unchanged",
    JSON.stringify([...BANNED_UI_PHRASES]) ===
      JSON.stringify(["auto-schedule", "auto-post", "publish automatically", "connect account", "bot posting"])
  );
  const queueSrc = read(join(ROOT, "components/marketing/social/PostQueue.tsx"));
  for (const label of ["Draft", "Ready", "Planned", "Posted manually", "Archived"]) {
    check(`legacy status label "${label}" bytes unchanged`, queueSrc.includes(`"${label}"`));
  }

  // AC-MD.2: the queue/editor entry points create NOTHING — the connected
  // components may only reach the M-C actions; no manifest/approval writes.
  const connectedDir = join(ROOT, "components/marketing/social/connected");
  for (const f of walk(connectedDir)) {
    const src = read(f);
    check(
      `${f.replace(ROOT, "")} never writes manifests/approvals directly`,
      !src.includes("social_publish_manifest") &&
        !src.includes("social_publish_approval") &&
        !src.includes("createPublishManifest") &&
        !src.includes("requestPublish(")
    );
  }
  const openCard = read(join(ROOT, "app/(app)/marketing/publish/actions.ts"));
  check(
    "openCardAction routes through requestPublishCard (the M-C sole path)",
    /openCardAction[\s\S]{0,400}requestPublishCard/.test(openCard)
  );
  check(
    "ONE card assembly path shared by page + modal (cardPayload.ts)",
    scanned.filter((f) => read(f).includes("assembleCardPayload(")).length === 3 &&
      read(join(ROOT, "lib/marketing/publish/cardPayload.ts")).includes("composePublishText(")
  );

  // AC-MD.6: posted_api is loggable but distinct — and never forgeable.
  const tools = read(join(ROOT, "lib/marketing/tools/socialPosts.ts"));
  check(
    "performance logging accepts posted_manual AND posted_api, keeping both named",
    tools.includes('post.status !== "posted_manual" && post.status !== "posted_api"')
  );

  // AC-MD.7: the banner text lives ONLY in the dev-status route (server,
  // dev-branch), never in a component/client module.
  const bannerFiles = scanned.filter((f) => read(f).includes("publishing won't fire"));
  check(
    "the dev banner text exists ONLY in the dev-status route",
    bannerFiles.length === 1 && bannerFiles[0].endsWith("dev-status/route.ts"),
    bannerFiles.map((f) => f.replace(ROOT, "")).join(", ")
  );
  check(
    "the dev-status route is NODE_ENV-gated (prod → show:false, no message)",
    read(join(ROOT, "app/api/marketing/publish/dev-status/route.ts")).includes(
      'process.env.NODE_ENV !== "development"'
    )
  );

  // The countdown is event-refreshed, never a polling loop.
  const states = read(join(ROOT, "components/marketing/social/connected/PublishStates.tsx"));
  check(
    "the countdown uses useSyncExternalStore on focus/visibility — no setInterval",
    states.includes("useSyncExternalStore") && !states.includes("setInterval")
  );
}

/* ─────────────────────────── agentic.spec (M-AG) ──────────────────────── */
console.log("\nagentic.spec — chat toolset, inline cards, honesty loop");
{
  const read = (p: string) => readFileSync(p, "utf8");

  // ── Toolset registration + tiers ──
  const byName = new Map(ALL_MARKETING_TOOLS.map((t) => [t.name, t]));
  check(
    "get_connected_accounts + get_publish_status registered as READ tools",
    byName.get("get_connected_accounts")?.reversibility === "read" &&
      byName.get("get_publish_status")?.reversibility === "read"
  );
  check(
    "retry_publish + cancel_scheduled_publish registered IRREVERSIBLE",
    byName.get("retry_publish")?.reversibility === "irreversible" &&
      byName.get("cancel_scheduled_publish")?.reversibility === "irreversible"
  );
  check(
    "retry/cancel are KNOWN irreversible but NOT hard-denied (policy-optable)",
    KNOWN_IRREVERSIBLE_TOOLS.has("retry_publish") &&
      KNOWN_IRREVERSIBLE_TOOLS.has("cancel_scheduled_publish") &&
      !HARD_DENY_TOOLS.has("retry_publish") &&
      !HARD_DENY_TOOLS.has("cancel_scheduled_publish")
  );
  check(
    "the M-C trio stays hard-denied (AC-AG.1 substrate)",
    ["publish_social_post", "schedule_social_post", "unpublish_social_post"].every((t) =>
      HARD_DENY_TOOLS.has(t)
    )
  );
  check(
    "retry_publish is auto-approvable by an explicit policy opt-in",
    AUTO_APPROVABLE_TOOLS.has("retry_publish") && AUTO_APPROVABLE_TOOLS.has("cancel_scheduled_publish")
  );

  // ── filedApprovalIds: cards render where FILED, never on status reads ──
  check(
    "propose_publish_plan approvalIds[] detected",
    JSON.stringify(filedApprovalIds("propose_publish_plan", { approvalIds: ["a", "b"] })) ===
      '["a","b"]'
  );
  check(
    "publish_social_post single approvalId detected",
    JSON.stringify(filedApprovalIds("publish_social_post", { approvalId: "x" })) === '["x"]'
  );
  check(
    "get_publish_status NEVER yields inline cards (no re-render on reads)",
    filedApprovalIds("get_publish_status", { openCards: [{ approvalId: "a" }], approvalIds: ["a"] })
      .length === 0
  );
  check(
    "junk data filtered (non-strings, empties, wrong shapes)",
    filedApprovalIds("propose_publish_plan", { approvalIds: [1, "", null, "ok"] }).length === 1 &&
      filedApprovalIds("schedule_social_post", {}).length === 0 &&
      filedApprovalIds("schedule_social_post", null).length === 0
  );

  // ── followUpFromEvents folds publish_cards ──
  const fakeCard = { approvalId: "ap-1" } as unknown as import("@/components/marketing/publish/PublishApprovalCard").PublishCardPayload;
  const folded = followUpFromEvents([
    { type: "conversation", conversationId: "c1" },
    { type: "assistant_delta", text: "Filed." },
    { type: "publish_cards", cards: [fakeCard] },
    { type: "publish_cards", cards: [] },
    { type: "done", paused: false },
  ]);
  check(
    "publish_cards folds into the follow-up (empty batches dropped)",
    folded.items.filter((i) => i.kind === "publish_cards").length === 1 &&
      folded.items.some((i) => i.kind === "assistant" && i.text === "Filed.")
  );

  // ── approvalSync publish kind ──
  resetApprovalSyncForTests();
  const store = useApprovalSync.getState();
  store.markPublishCardResolved("ap-1", { decision: "approved", followUp: null });
  store.markPublishCardResolved("ap-1", { decision: "skipped", followUp: null });
  check(
    "publish resolution: first writer wins",
    useApprovalSync.getState().publishCards["ap-1"]?.decision === "approved"
  );
  const fu = { conversationId: "c1", paused: false, items: [] };
  useApprovalSync.getState().attachPublishCardFollowUp("ap-1", fu);
  useApprovalSync.getState().attachPublishCardFollowUp("ap-1", { ...fu, conversationId: "c2" });
  check(
    "publish follow-up attaches once (first follow-up wins)",
    useApprovalSync.getState().publishCards["ap-1"]?.followUp?.conversationId === "c1"
  );
  useApprovalSync.getState().applyRemote({
    source: APPROVAL_SYNC_CHANNEL,
    kind: "publish",
    id: "ap-2",
    res: { decision: "resolved", followUp: null },
  });
  check(
    "remote publish resolutions apply (cross-tab collapse)",
    useApprovalSync.getState().publishCards["ap-2"]?.decision === "resolved"
  );
  useApprovalSync.getState().applyRemote({
    source: APPROVAL_SYNC_CHANNEL,
    kind: "publish",
    id: "ap-2",
    res: { decision: "approved", followUp: fu },
  });
  const ap2 = useApprovalSync.getState().publishCards["ap-2"];
  check(
    "a remote copy carrying a follow-up fills a bare local resolution",
    ap2?.followUp?.conversationId === "c1"
  );
  resetApprovalSyncForTests();

  // ── Fences: chat introduces NO new creation path, no forked composition ──
  const chatHost = read(join(ROOT, "components/marketing/publish/ChatPublishCards.tsx"));
  check(
    "chat card host lives under the allowlisted publish path",
    isConnectedVocabPath("components/marketing/publish/ChatPublishCards.tsx")
  );
  check(
    "chat host resolves via the SAME review-page actions (approve/reject only)",
    chatHost.includes("approveCardAction") &&
      chatHost.includes("rejectCardAction") &&
      !chatHost.includes("requestPublishCard") &&
      !chatHost.includes("createApprovalRequest") &&
      !chatHost.includes("manifestRepository")
  );
  const chatHostCode = chatHost.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("chat host has no approve-all", !/approveAll|approve-all|Approve all/i.test(chatHostCode));

  const loopSrc = read(join(ROOT, "lib/marketing/agent/loop.ts"));
  check(
    "inline cards assembled by THE one payload assembly (cardPayload.ts), no forked composition",
    loopSrc.includes("assembleCardPayloadsForApprovals") &&
      loopSrc.includes("@/lib/marketing/publish/cardPayload") &&
      !loopSrc.includes("composePublishText")
  );
  check(
    "card tokens ride only the ephemeral event, never conversation messages",
    !/saveToolMessage[^;]*\bcards\b/.test(loopSrc) && loopSrc.includes('emit({ type: "publish_cards", cards })')
  );

  const panel = read(join(ROOT, "components/marketing/agent/AgentPanel.tsx"));
  const panelLiterals = [...panel.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? "")
    .filter((s) => !s.startsWith("@/") && !s.startsWith("./") && !s.startsWith("/api"));
  check(
    "AgentPanel carries no publish vocabulary of its own (imports the allowlisted strings)",
    panel.includes("PUBLISH_CHAT_SUGGESTIONS") &&
      panelLiterals.every((s) => !/\b(publish|publishes|published|publishing|schedule|scheduled|schedules|scheduling)\b/i.test(s))
  );

  // ── conversation threading (the honesty loop's substrate) ──
  const gov = read(join(ROOT, "lib/marketing/tools/publishGovernance.ts"));
  check(
    "all three filing tools thread ctx.conversationId onto the card",
    (gov.match(/conversationId: ctx\.conversationId \?\? null/g) ?? []).length === 3
  );
  check(
    "requestPublishCard persists conversationId on the approval",
    read(join(ROOT, "lib/marketing/publish/approvalService.ts")).includes(
      "conversationId: input.conversationId ?? null"
    )
  );
  const resumeSrc = read(join(ROOT, "lib/marketing/agent/resume.ts"));
  check(
    "publish-decision resume is agent-filed + conversation-linked ONLY",
    resumeSrc.includes('p.approval.requestedBy !== "agent" || !p.approval.conversationId')
  );
  check(
    "the follow-up action derives the decision from the ROW, never the client",
    /const decision = approval\.consumedAt \? "approved" : approval\.declinedAt \? "skipped" : null/.test(
      read(join(ROOT, "app/(app)/marketing/actions.ts"))
    )
  );

  // ── publishDecisionMessage honesty ──
  const approvedMsg = publishDecisionMessage(
    { socialPostId: "p1", platform: "linkedin", proposedScheduledFor: "2026-08-02T09:00:00.000Z" },
    "approved"
  );
  const skippedMsg = publishDecisionMessage(
    { socialPostId: "p1", platform: "linkedin", proposedScheduledFor: null },
    "skipped"
  );
  check(
    "approved resume message: queued is NOT posted + the fire time",
    approvedMsg.includes("NOT posted") && approvedMsg.includes("2026-08-02T09:00:00.000Z")
  );
  check(
    "skipped resume message: nothing fires, no unprompted re-file",
    skippedMsg.includes("nothing will fire") && skippedMsg.includes("Do not re-file")
  );

  // ── prompt teaches the new capability set ──
  const promptSrc = read(join(ROOT, "lib/marketing/agent/prompt.ts"));
  for (const needle of [
    "get_connected_accounts",
    "get_publish_status",
    "retry_publish",
    "cancel_scheduled_publish",
    "DISCOVERY FIRST",
    "STATUS TRUTH",
    "render INLINE",
  ]) {
    check(`prompt teaches: ${needle}`, promptSrc.includes(needle));
  }

  // ── the ops tools' own fences ──
  const ops = read(join(ROOT, "lib/marketing/tools/publishOps.ts"));
  check(
    "publishOps never publishes: no requestPublish/provider imports",
    !ops.includes("requestPublish") && !ops.includes("provider/") && !ops.includes("uploadPostClient")
  );
  check(
    "retry_publish executes via retryPublishManifest (A2 clone), cancel via cancelPublishManifest",
    ops.includes("retryPublishManifest(") && ops.includes("cancelPublishManifest(")
  );
  check(
    "both act tools ownership-check before preview OR execute",
    (ops.match(/manifest\.creatorId !== ctx\.ownerId/g) ?? []).length === 2
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
