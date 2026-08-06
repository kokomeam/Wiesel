/**
 * TUTOR-1 Wave 6 (P6.5) — Creator DIGEST, PURE suite (no key, no DB, no browser).
 *
 * The digest is the ONE sanctioned creator-addressed mail seam
 * (lib/notify/creatorDigest.ts). This suite pins the load-bearing pure contracts
 * + the no-auto-send greps:
 *
 *   IDEMPOTENCY   digestIdempotencyKey shape (digest:{courseId}:{utcDate}) — same
 *                 course + day → same key (a DB no-op); different day → different.
 *   MODE          resolveProviderMode truth table: DIGEST_DRY_RUN default ON →
 *                 'dry_run'; off + no key → 'mock'; off + configured → 'resend'.
 *   STATUS        the footgun golden — digestStatusFor: 'sent' ONLY when
 *                 provider_mode==='resend' AND the send succeeded; every other
 *                 combination is 'dry_run' (non-resend) or 'failed' (resend fail).
 *   RENDER        renderDigestEmail produces a subject + escaped HTML + a compliant
 *                 footer (opt-out / identity-free statements) + the escalations CTA.
 *   GREP          (a) lib/comms/*.ts has EXACTLY ONE `.send(` call site, service.ts;
 *                 (b) lib/tutor/** + app/api/learn/tutor/** import NO send path
 *                 (neither lib/comms/service nor lib/notify/creatorDigest) — a tutor
 *                 turn can never reach a provider.send.
 *   SKIP          the opt-out / cadence-off / suppression branches are wired (a
 *                 static assertion that the send orchestrator names them).
 *
 * Run: `npx tsx scripts/verify-creator-digest.ts`
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveProviderMode,
  digestStatusFor,
  digestIdempotencyKey,
  renderDigestEmail,
  type DigestContent,
  type ProviderMode,
} from "@/lib/notify/creatorDigest";

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

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
function walkSafe(dir: string): string[] {
  try {
    return walk(dir);
  } catch {
    return [];
  }
}

async function main() {
  /* ────────────────────────────── IDEMPOTENCY ─────────────────────────────── */
  console.log("— idempotency key —");
  const courseA = "11111111-1111-1111-1111-111111111111";
  const courseB = "22222222-2222-2222-2222-222222222222";
  const day1 = new Date("2026-08-06T07:00:00.000Z");
  const day1Late = new Date("2026-08-06T23:59:59.000Z");
  const day2 = new Date("2026-08-07T00:00:01.000Z");

  check(
    "key shape is digest:{courseId}:{utcDate}",
    digestIdempotencyKey(courseA, day1) === `digest:${courseA}:2026-08-06`
  );
  check(
    "same course + same UTC day → identical key (a DB no-op)",
    digestIdempotencyKey(courseA, day1) === digestIdempotencyKey(courseA, day1Late)
  );
  check(
    "next UTC day → different key",
    digestIdempotencyKey(courseA, day1) !== digestIdempotencyKey(courseA, day2)
  );
  check(
    "different course, same day → different key",
    digestIdempotencyKey(courseA, day1) !== digestIdempotencyKey(courseB, day1)
  );

  /* ─────────────────────────── PROVIDER-MODE TRUTH TABLE ───────────────────── */
  console.log("\n— provider_mode resolution —");
  check(
    "DIGEST_DRY_RUN on (default) → 'dry_run' even when configured",
    resolveProviderMode({ dryRun: true, emailConfigured: true }) === "dry_run"
  );
  check(
    "dry-run on + no key → 'dry_run'",
    resolveProviderMode({ dryRun: true, emailConfigured: false }) === "dry_run"
  );
  check(
    "dry-run off + no key → 'mock' (silent-mock footgun surfaced on the row)",
    resolveProviderMode({ dryRun: false, emailConfigured: false }) === "mock"
  );
  check(
    "dry-run off + configured → 'resend'",
    resolveProviderMode({ dryRun: false, emailConfigured: true }) === "resend"
  );

  /* ───────────────────────────── STATUS RULE (GOLDEN) ──────────────────────── */
  console.log("\n— status rule (the footgun golden) —");
  check(
    "resend + send SUCCEEDED → 'sent'",
    digestStatusFor("resend", true) === "sent"
  );
  check(
    "resend + send FAILED → 'failed' (never 'sent')",
    digestStatusFor("resend", false) === "failed"
  );
  check(
    "mock (any send outcome) → 'dry_run', NEVER 'sent'",
    digestStatusFor("mock", true) === "dry_run" &&
      digestStatusFor("mock", false) === "dry_run"
  );
  check(
    "dry_run (any send outcome) → 'dry_run', NEVER 'sent'",
    digestStatusFor("dry_run", true) === "dry_run" &&
      digestStatusFor("dry_run", false) === "dry_run"
  );
  // Exhaustive: 'sent' is reachable from EXACTLY ONE (mode, success) pair.
  const modes: ProviderMode[] = ["resend", "mock", "dry_run"];
  const sentCombos = modes
    .flatMap((m) => [true, false].map((s) => ({ m, s })))
    .filter(({ m, s }) => digestStatusFor(m, s) === "sent");
  check(
    "'sent' is reachable ONLY from (resend, succeeded)",
    sentCombos.length === 1 && sentCombos[0].m === "resend" && sentCombos[0].s === true,
    JSON.stringify(sentCombos)
  );

  /* ──────────────────────────────── RENDER ─────────────────────────────────── */
  console.log("\n— renderDigestEmail —");
  const content: DigestContent = {
    courseTitle: "Intro to <Microeconomics>",
    generatedAt: day1.toISOString(),
    newClusters: [
      {
        clusterId: "c1",
        nodeId: "n1",
        representativeQuestion: "Why does the demand curve slope down & not up?",
        memberCount: 4,
        status: "open",
      },
    ],
    clusterMovers: [
      {
        clusterId: "c2",
        nodeId: "n2",
        representativeQuestion: "What is deadweight loss?",
        memberCount: 3,
        status: "open",
      },
    ],
    mostMissed: [{ questionId: "q1", lessonId: "l1", pctCorrect: 0.32, n: 41 }],
    openClusterTotal: 5,
  };
  const rendered = renderDigestEmail(content);
  check("subject is non-empty", rendered.subject.length > 0);
  check(
    "subject counts the attention items (1 new + 1 mover = 2)",
    /\b2 learner questions\b/.test(rendered.subject),
    rendered.subject
  );
  check("html includes the representative question", rendered.html.includes("Why does the demand curve slope down"));
  check(
    "html ESCAPES the course title angle-brackets (no raw <Microeconomics>)",
    rendered.html.includes("&lt;Microeconomics&gt;") && !rendered.html.includes("<Microeconomics>")
  );
  check("html surfaces the most-missed pct (32%)", rendered.html.includes("32%"));
  check(
    "compliant footer: says it is identity-free",
    /never a learner'?s identity/i.test(rendered.html) && /never a learner'?s identity/i.test(rendered.text)
  );
  check(
    "compliant footer: an opt-out affordance (cadence → off)",
    /off/i.test(rendered.html) && /tutor settings/i.test(rendered.html)
  );
  check("html carries the escalations-queue CTA", /Open the escalations queue/i.test(rendered.html));
  check(
    "empty-attention subject falls back to the insights headline",
    /insights/i.test(
      renderDigestEmail({ ...content, newClusters: [], clusterMovers: [] }).subject
    )
  );

  /* ──────────────────────── GREP (a): single comms send site ───────────────── */
  console.log("\n— no-send-site grep (lib/comms) —");
  const commsFiles = walk(join(repoRoot, "lib/comms"));
  const commsSendSites = commsFiles.filter((f) => /\.send\s*\(/.test(readFileSync(f, "utf8")));
  check(
    "lib/comms/*.ts has EXACTLY ONE `.send(` call site",
    commsSendSites.length === 1,
    commsSendSites.map((f) => f.replace(repoRoot, "")).join(", ")
  );
  check(
    "the ONE lib/comms `.send(` site is service.ts",
    commsSendSites.length === 1 && commsSendSites[0].endsWith(join("lib", "comms", "service.ts")),
    commsSendSites.map((f) => f.replace(repoRoot, "")).join(", ")
  );

  /* ──────────────────── GREP (b): tutor unreachable from any send ──────────── */
  console.log("\n— tutor-unreachable grep —");
  const tutorFiles = [
    ...walkSafe(join(repoRoot, "lib/tutor")),
    ...walkSafe(join(repoRoot, "app/api/learn/tutor")),
  ];
  const importsSendSeam =
    /from\s+["'](?:@\/lib\/comms\/service|\.{1,2}\/[^"']*comms\/service|@\/lib\/notify\/creatorDigest|\.{1,2}\/[^"']*notify\/creatorDigest)["']/;
  const sendImporters = tutorFiles.filter((f) => importsSendSeam.test(readFileSync(f, "utf8")));
  check(
    "lib/tutor/** + app/api/learn/tutor/** import NO send path",
    sendImporters.length === 0,
    sendImporters.map((f) => f.replace(repoRoot, "")).join(", ")
  );
  // The digest seam must NOT import lib/comms's send site (only the provider factory).
  const digestSrc = readFileSync(join(repoRoot, "lib/notify/creatorDigest.ts"), "utf8");
  check(
    "lib/notify/creatorDigest.ts does NOT import lib/comms/service (the learner send site)",
    !/from\s+["']@?\/?.*comms\/service["']/.test(digestSrc)
  );
  check(
    "lib/notify/creatorDigest.ts DOES import the comms provider FACTORY (createResendProvider)",
    /createResendProvider/.test(digestSrc) && /comms\/resendProvider/.test(digestSrc)
  );

  /* ────────────────────────── SKIP-BRANCH assertions ──────────────────────── */
  console.log("\n— send-orchestrator skip branches —");
  check("orchestrator re-checks digest_opt_out", /digest_opt_out/.test(digestSrc) && /opted_out/.test(digestSrc));
  check("orchestrator re-checks digest_cadence off", /digest_cadence/.test(digestSrc) && /cadence_off/.test(digestSrc));
  check("orchestrator re-checks comms_suppressions", /comms_suppressions/.test(digestSrc) && /suppressed/.test(digestSrc));
  check("orchestrator handles the unique-key duplicate (23505)", /23505/.test(digestSrc) && /duplicate/.test(digestSrc));
  check(
    "orchestrator NEVER throws (fail-benign catch settles a result)",
    /catch\s*\(/.test(digestSrc) && /creator_digest_error/.test(digestSrc)
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
