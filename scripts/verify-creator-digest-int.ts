/**
 * TUTOR-1 Wave 6 (P6.5) — Creator DIGEST INTEGRATION suite (live Supabase, NO
 * OpenAI key, NO mail leaves the box). Self-provisions throwaway users each run.
 * Requires the W6.5 migration (20260806150000_creator_digest.sql) APPLIED AND
 * SUPABASE_SERVICE_ROLE_KEY (creator_digest writes are service-role only).
 *
 * ⚠ RUNS UNDER DIGEST_DRY_RUN — we FORCE dry-run at the top (delete any inherited
 * override) so provider_mode resolves to 'dry_run' and NO send is ever attempted.
 *
 * ── AC-W6E.1 — idempotent, opt-out at send, provider_mode on the row ──────────
 *   • A course with an open cluster mover → sendCreatorDigest writes ONE row with
 *     provider_mode='dry_run', status='dry_run', content persisted, NOTHING sent.
 *   • A SECOND same-day call is a no-op (unique idempotency_key) — still exactly
 *     ONE row (same course/day never sends — or here, never re-persists — twice).
 *   • Flipping digest_opt_out=true → the NEXT UTC day's key would write, but AT
 *     SEND the opt-out is re-checked and the call SKIPS (reason 'opted_out', no
 *     new row). Same for digest_cadence='off'.
 *   • An empty course (no clusters, no missed questions) → no row (reason 'empty').
 *   • EVERY written row carries a non-null provider_mode.
 *
 * ── AC-W6E.2 — the verify:comms negatives are green ───────────────────────────
 *   Run the pure grep guards here too (single lib/comms send site; tutor imports
 *   no send path) so the int gate fails if a later edit breaks the invariant.
 *
 * Run (AFTER the migration): `npx tsx scripts/verify-creator-digest-int.ts`
 */

// FORCE dry-run BEFORE any module reads the env (belt to the provider_mode braces).
delete process.env.DIGEST_DRY_RUN; // default (unset) is ON → 'dry_run'

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; pin IPv4-first for this dev machine.
dns.setDefaultResultOrder("ipv4first");

/** Retry transient TRANSPORT failures (never HTTP errors) so the suite is stable. */
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
import { sendCreatorDigest, digestIdempotencyKey } from "@/lib/notify/creatorDigest";

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

type DB = SupabaseClient<Database>;

function loadEnv(): { url: string; anon: string; service?: string } {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return {
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    service: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY,
  };
}

async function provisionUser(
  url: string,
  anon: string,
  tag: string
): Promise<{ client: DB; userId: string; email: string }> {
  const email = `digest-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  console.log(`# provisioned ${email}`);
  return { client, userId: data.user.id, email };
}

/** Insert an OPEN cluster mover (member_count > 1) so the digest has content. */
async function seedCluster(admin: DB, courseId: string, question: string, memberCount: number): Promise<string> {
  const { data, error } = await admin
    .from("escalation_cluster")
    .insert({
      course_id: courseId,
      node_id: crypto.randomUUID(),
      representative_question: question,
      representative_answer: "The instructor should confirm the exact bound.",
      member_count: memberCount,
      status: "open",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`cluster insert: ${error?.message}`);
  return data.id;
}

/* ─── the pure grep guards (AC-W6E.2), re-run at the int gate ─────────────────── */
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
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:creator-digest:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  // Course WITH content (a cluster) and a SEPARATE empty course.
  const courseId = crypto.randomUUID();
  const emptyCourseId = crypto.randomUUID();
  const now = new Date();

  const cleanup = async () => {
    await admin.from("creator_digest").delete().eq("course_id", courseId);
    await admin.from("creator_digest").delete().eq("course_id", emptyCourseId);
    await admin.from("escalation_cluster").delete().eq("course_id", courseId);
    await admin.from("tutor_course_settings").delete().eq("course_id", courseId);
    await admin.from("tutor_course_settings").delete().eq("course_id", emptyCourseId);
    await author.client.from("courses").delete().eq("id", courseId);
    await author.client.from("courses").delete().eq("id", emptyCourseId);
  };

  try {
    const { error: cErr } = await author.client.from("courses").insert([
      { id: courseId, author_id: author.userId, title: `Digest itest ${crypto.randomUUID().slice(0, 6)}`, description: "P6.5 fixture" },
      { id: emptyCourseId, author_id: author.userId, title: `Digest empty ${crypto.randomUUID().slice(0, 6)}`, description: "P6.5 empty" },
    ] as never);
    if (cErr) throw new Error(`course insert: ${cErr.message}`);

    // Enable tutor + daily digest on the content course; leave the empty course enabled too.
    const { error: sErr } = await admin.from("tutor_course_settings").insert([
      { course_id: courseId, enabled: true, digest_cadence: "daily", digest_opt_out: false },
      { course_id: emptyCourseId, enabled: true, digest_cadence: "daily", digest_opt_out: false },
    ] as never);
    if (sErr) throw new Error(`settings insert: ${sErr.message}`);

    await seedCluster(admin, courseId, "Why does my Theta bound differ from the book?", 4);
    console.log("# seeded course + settings + 1 open cluster");

    /* ───── AC-W6E.1 — first send under dry-run ──────────────────────────────── */
    console.log("\n# AC-W6E.1 — dry-run digest: rendered + persisted, NOTHING sent");
    const first = await sendCreatorDigest(admin, { courseId, now });
    check("first call ok", first.ok, first.reason ?? "");
    check("provider_mode is 'dry_run' (DIGEST_DRY_RUN default ON)", first.providerMode === "dry_run", String(first.providerMode));
    check("status is 'dry_run' — NEVER 'sent' under dry-run", first.status === "dry_run", String(first.status));
    check("a digest row was written", first.digestId != null);

    const rowRes = await admin.from("creator_digest").select("*").eq("course_id", courseId);
    const rows = rowRes.data ?? [];
    check("exactly ONE row for the course/day", rows.length === 1, `count=${rows.length}`);
    const row = rows[0];
    check("row.provider_mode is non-null (footgun: mode on EVERY row)", row?.provider_mode === "dry_run");
    check("row.status is 'dry_run'", row?.status === "dry_run");
    check("row.sent_at is NULL (nothing sent)", row?.sent_at == null);
    check("row.content is persisted (identity-free aggregate)", row?.content != null && !JSON.stringify(row?.content).includes(author.userId));
    check(
      "row.idempotency_key matches digest:{courseId}:{utcDate}",
      row?.idempotency_key === digestIdempotencyKey(courseId, now),
      String(row?.idempotency_key)
    );

    /* ───── AC-W6E.1 — same course/day never writes twice (idempotency) ──────── */
    console.log("\n# AC-W6E.1 — a same-day second call is a no-op (unique key)");
    const second = await sendCreatorDigest(admin, { courseId, now });
    check("second call ok", second.ok, second.reason ?? "");
    check("second call reports 'duplicate' (unique idempotency_key)", second.reason === "duplicate", String(second.reason));
    const afterSecond = await admin.from("creator_digest").select("id").eq("course_id", courseId);
    check("still exactly ONE row after the second call", (afterSecond.data ?? []).length === 1, `count=${(afterSecond.data ?? []).length}`);

    /* ───── AC-W6E.1 — opt-out at send skips (next day) ──────────────────────── */
    console.log("\n# AC-W6E.1 — opt-out re-checked AT SEND → skip, no row");
    await admin.from("tutor_course_settings").update({ digest_opt_out: true }).eq("course_id", courseId);
    const nextDay = new Date(now.getTime() + 25 * 3600_000);
    const optedOut = await sendCreatorDigest(admin, { courseId, now: nextDay });
    check("opted-out call is ok + reason 'opted_out'", optedOut.ok && optedOut.reason === "opted_out", String(optedOut.reason));
    check("opted-out call wrote NO row", optedOut.digestId == null);
    const afterOptOut = await admin.from("creator_digest").select("id").eq("course_id", courseId);
    check("still exactly ONE row after opt-out skip", (afterOptOut.data ?? []).length === 1, `count=${(afterOptOut.data ?? []).length}`);

    /* ───── AC-W6E.1 — cadence 'off' at send skips ───────────────────────────── */
    console.log("\n# AC-W6E.1 — cadence 'off' re-checked AT SEND → skip");
    await admin.from("tutor_course_settings").update({ digest_opt_out: false, digest_cadence: "off" }).eq("course_id", courseId);
    const cadenceOff = await sendCreatorDigest(admin, { courseId, now: nextDay });
    check("cadence-off call is ok + reason 'cadence_off'", cadenceOff.ok && cadenceOff.reason === "cadence_off", String(cadenceOff.reason));
    check("cadence-off call wrote NO row", cadenceOff.digestId == null);

    /* ───── AC-W6E.1 — empty course → no row ─────────────────────────────────── */
    console.log("\n# AC-W6E.1 — empty course (no clusters) → no digest row");
    const empty = await sendCreatorDigest(admin, { courseId: emptyCourseId, now });
    check("empty course call is ok + reason 'empty'", empty.ok && empty.reason === "empty", String(empty.reason));
    check("empty course wrote NO row", empty.digestId == null);
    const emptyRows = await admin.from("creator_digest").select("id").eq("course_id", emptyCourseId);
    check("no rows for the empty course", (emptyRows.data ?? []).length === 0, `count=${(emptyRows.data ?? []).length}`);

    /* ───── AC-W6E.2 — the verify:comms negatives are green ───────────────────── */
    console.log("\n# AC-W6E.2 — no-auto-send greps (single send site + tutor unreachable)");
    const commsFiles = walk(join(repoRoot, "lib/comms"));
    const commsSendSites = commsFiles.filter((f) => /\.send\s*\(/.test(readFileSync(f, "utf8")));
    check(
      "lib/comms/*.ts has EXACTLY ONE `.send(` call site (service.ts)",
      commsSendSites.length === 1 && commsSendSites[0].endsWith(join("lib", "comms", "service.ts")),
      commsSendSites.map((f) => f.replace(repoRoot, "")).join(", ")
    );
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
  } finally {
    await cleanup();
    console.log("# cleaned up");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
