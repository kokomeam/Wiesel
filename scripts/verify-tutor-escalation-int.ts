/**
 * TUTOR-1 Wave 6 (P6.1) — escalation CONSENT + RLS matrix INTEGRATION suite
 * (live Supabase, no OpenAI key needed). Self-provisions throwaway users each run.
 * Requires the W6.1 migration (20260806100000_escalation_consent.sql) to be
 * APPLIED (the orchestrator applies it before this runs).
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) — escalation
 * candidates are SERVICE-ROLE-ONLY writes by design (no client insert policy).
 *
 * ── AC-T6.4 — THE CONSENT-INVARIANT RLS MATRIX ───────────────────────────────
 *   1. A consent_pending candidate: the author/creator reads ZERO rows — by a
 *      direct select AND by any join (courses ⋈ candidates). The learner reads own.
 *   2. A withdrawn candidate: the author still reads ZERO (direct + join).
 *   3. The consent transition consent_pending → consented WITH AN EDITED QUESTION
 *      SUCCEEDS (the relaxed trigger permits it) — and carries consented_at.
 *   4. On a DIFFERENT pending candidate, editing learner_question WITHOUT the
 *      consent flip STILL raises 'only the status may change'.
 *   5. Editing an always-immutable column (tutor_proposed_answer) DURING consent
 *      STILL raises.
 *   6. withdrawn is terminal (withdrawn → consented raises); consented is terminal
 *      (consented → withdrawn raises).
 *   7. After consent, the author STILL reads ZERO (consent doesn't open THIS table
 *      to the creator — P6.2's derived rows are the only creator surface).
 *
 * Run (AFTER the migration): `npx tsx scripts/verify-tutor-escalation-int.ts`
 */

import { readFileSync } from "node:fs";
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
import { createBlock, createLesson, createModule, createSlide, newRowId } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import { resolveLivePublicationBySlug } from "@/lib/learn/resolve";

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
  const email = `tutor-esc-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

/** Minimal publishable fixture: one module → one lesson → one 2-slide deck. */
function makeDoc(courseId: string, ownerId: string, title: string): CourseDocument {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];
  const lesson = createLesson("Lesson A", 0);
  lesson.blocks = [deck];
  const mod = createModule("Foundations", 0);
  mod.lessons = [lesson];
  return {
    id: courseId,
    title,
    description: "Tutor escalation consent integration fixture.",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId,
      aiReadableVersion: "1.0",
    },
  };
}

async function seedCourse(client: DB, doc: CourseDocument, ownerId: string): Promise<void> {
  const rows = courseDocToRows(doc, ownerId);
  for (const [table, data] of [
    ["courses", rows.course],
    ["modules", rows.modules],
    ["lessons", rows.lessons],
    ["blocks", rows.blocks],
  ] as const) {
    const { error } = await client.from(table).insert(data as never);
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }
}

/** Insert a consent_pending candidate for the learner (service-role). */
async function seedCandidate(
  admin: DB,
  learnerUserId: string,
  courseId: string,
  question: string
): Promise<string> {
  const { data, error } = await admin
    .from("tutor_escalation_candidates")
    .insert({
      user_id: learnerUserId,
      course_id: courseId,
      learner_question: question,
      node_ids: ["node-x"] as never,
      anchors: [] as never,
      rung_trail: [{ rung: 2 }] as never,
      tutor_proposed_answer: "The tutor's best guess, for the instructor to confirm.",
      status: "consent_pending",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`candidate insert: ${error?.message}`);
  return data.id;
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:tutor:escalation:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");
  const stranger = await provisionUser(url, anon, "stranger");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, `Tutor escalation itest ${crypto.randomUUID().slice(0, 6)}`);
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded course");

  const cleanup = async () => {
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ── publish + enroll (only the learner) ── */
    console.log("\n# publish + enroll");
    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    check("published v1 live", v1.publication.version === 1 && v1.publication.status === "live");
    const found = await resolveLivePublicationBySlug(learner.client, v1.publication.slug);
    if (found.kind !== "found") throw new Error("publication not resolvable");
    const enrolled = await learner.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: learner.userId })
      .select("*")
      .single();
    check("learner self-enrolls (the stranger never does)", !enrolled.error, String(enrolled.error?.message));

    /* ───── 1. consent_pending: author reads ZERO (direct + join) ───────────── */
    console.log("\n# 1. AC-T6.4 — consent_pending is creator-unreachable");
    const pendingId = await seedCandidate(admin, learner.userId, courseId, "Why does my wash go muddy?");
    const learnerReadsPending = await learner.client
      .from("tutor_escalation_candidates")
      .select("id, status")
      .eq("id", pendingId);
    check("the learner reads their OWN consent_pending candidate", (learnerReadsPending.data ?? []).length === 1);

    const authorDirect = await author.client
      .from("tutor_escalation_candidates")
      .select("id")
      .eq("course_id", courseId);
    check("the AUTHOR reads ZERO candidates by direct select (no author policy)", (authorDirect.data ?? []).length === 0);

    // BY ANY JOIN: even walking from the author's OWN course row, the join yields
    // no candidate rows (RLS filters the joined table for the author principal).
    const authorJoin = await author.client
      .from("courses")
      .select("id, tutor_escalation_candidates(id, status)")
      .eq("id", courseId)
      .maybeSingle();
    const joinedRows = ((authorJoin.data as { tutor_escalation_candidates?: unknown[] } | null)
      ?.tutor_escalation_candidates ?? []) as unknown[];
    check(
      "the AUTHOR reads ZERO candidates through a courses ⋈ candidates JOIN",
      !authorJoin.error && joinedRows.length === 0,
      String(authorJoin.error?.message ?? `join returned ${joinedRows.length}`)
    );

    const strangerPending = await stranger.client
      .from("tutor_escalation_candidates")
      .select("id")
      .eq("course_id", courseId);
    check("a stranger reads ZERO candidates", (strangerPending.data ?? []).length === 0);

    /* ───── 2. withdrawn is also creator-unreachable (direct + join) ────────── */
    console.log("\n# 2. AC-T6.4 — a withdrawn candidate is creator-unreachable too");
    const withdrawnId = await seedCandidate(admin, learner.userId, courseId, "A second question, to be withdrawn.");
    const wd = await learner.client
      .from("tutor_escalation_candidates")
      .update({ status: "withdrawn" })
      .eq("id", withdrawnId)
      .eq("user_id", learner.userId)
      .eq("status", "consent_pending")
      .select("status")
      .single();
    check("the learner withdraws the second candidate", !wd.error && wd.data?.status === "withdrawn", String(wd.error?.message));

    const authorDirect2 = await author.client
      .from("tutor_escalation_candidates")
      .select("id, status")
      .eq("course_id", courseId);
    check("the AUTHOR STILL reads ZERO (a withdrawn row is unreachable, direct)", (authorDirect2.data ?? []).length === 0);
    const authorJoin2 = await author.client
      .from("courses")
      .select("id, tutor_escalation_candidates(id, status)")
      .eq("id", courseId)
      .maybeSingle();
    const joined2 = ((authorJoin2.data as { tutor_escalation_candidates?: unknown[] } | null)
      ?.tutor_escalation_candidates ?? []) as unknown[];
    check("the AUTHOR reads ZERO through the JOIN with a withdrawn row present", joined2.length === 0);

    /* ───── 3. the consent transition WITH AN EDITED QUESTION succeeds ──────── */
    console.log("\n# 3. AC-T6.4 — consent transition may edit the question (relaxed trigger)");
    const editedQuestion = "Edited at consent: is muddiness a pigment-load or a water problem?";
    const consentedAt = new Date().toISOString();
    const consent = await learner.client
      .from("tutor_escalation_candidates")
      .update({ status: "consented", learner_question: editedQuestion, consented_at: consentedAt })
      .eq("id", pendingId)
      .eq("user_id", learner.userId)
      .eq("status", "consent_pending")
      .select("status, learner_question, consented_at")
      .single();
    check(
      "consent_pending → consented WITH an edited learner_question SUCCEEDS",
      !consent.error && consent.data?.status === "consented" && consent.data?.learner_question === editedQuestion,
      String(consent.error?.message)
    );
    check("consented_at is set on the consented row", consent.data?.consented_at != null);

    // Verify via a fresh service-role read that the edit persisted.
    const reread = await admin
      .from("tutor_escalation_candidates")
      .select("learner_question, status")
      .eq("id", pendingId)
      .single();
    check(
      "the consented row carries the LEARNER'S EDIT (verified service-role)",
      reread.data?.learner_question === editedQuestion && reread.data?.status === "consented"
    );

    /* ───── 4. a non-consent question edit STILL raises ─────────────────────── */
    console.log("\n# 4. AC-T6.4 — a payload edit WITHOUT the consent flip still raises");
    const pending2 = await seedCandidate(admin, learner.userId, courseId, "A third pending question.");
    const idleEdit = await learner.client
      .from("tutor_escalation_candidates")
      .update({ learner_question: "sneaky edit with no consent flip" })
      .eq("id", pending2);
    check(
      "editing learner_question with NO status flip raises 'only the status may change'",
      idleEdit.error !== null && /only the status may change/.test(idleEdit.error?.message ?? ""),
      String(idleEdit.error?.message)
    );

    /* ───── 5. an always-immutable column edit DURING consent still raises ──── */
    console.log("\n# 5. AC-T6.4 — an always-immutable column can't ride the consent transition");
    const badConsent = await learner.client
      .from("tutor_escalation_candidates")
      .update({ status: "consented", tutor_proposed_answer: "rewritten by the learner" })
      .eq("id", pending2)
      .eq("status", "consent_pending");
    check(
      "consent + tutor_proposed_answer edit raises 'only the status may change'",
      badConsent.error !== null && /only the status may change/.test(badConsent.error?.message ?? ""),
      String(badConsent.error?.message)
    );

    /* ───── 6. terminal states are frozen ───────────────────────────────────── */
    console.log("\n# 6. AC-T6.4 — terminal states (consented, withdrawn) are frozen");
    // consented is terminal — consented → withdrawn raises.
    const consentedTerminal = await learner.client
      .from("tutor_escalation_candidates")
      .update({ status: "withdrawn" })
      .eq("id", pendingId);
    check(
      "consented → withdrawn raises 'illegal status transition'",
      consentedTerminal.error !== null && /illegal status transition/.test(consentedTerminal.error?.message ?? ""),
      String(consentedTerminal.error?.message)
    );
    // withdrawn is terminal — withdrawn → consented raises.
    const withdrawnTerminal = await learner.client
      .from("tutor_escalation_candidates")
      .update({ status: "consented" })
      .eq("id", withdrawnId);
    check(
      "withdrawn → consented raises 'illegal status transition'",
      withdrawnTerminal.error !== null && /illegal status transition/.test(withdrawnTerminal.error?.message ?? ""),
      String(withdrawnTerminal.error?.message)
    );

    /* ───── 7. after consent, the author STILL reads ZERO ───────────────────── */
    console.log("\n# 7. AC-T6.4 — consent does NOT open THIS table to the creator");
    const authorAfterConsent = await author.client
      .from("tutor_escalation_candidates")
      .select("id, status")
      .eq("course_id", courseId);
    check(
      "the AUTHOR reads ZERO candidates EVEN after a consented row exists (consent invariant holds)",
      (authorAfterConsent.data ?? []).length === 0
    );
    // And the learner still sees their own rows — proving the zeros are RLS, not empty.
    const learnerAll = await learner.client
      .from("tutor_escalation_candidates")
      .select("id, status")
      .eq("course_id", courseId);
    check(
      "the learner reads their OWN candidates (>=3: consented + withdrawn + pending)",
      (learnerAll.data ?? []).length >= 3
    );
  } finally {
    await cleanup();
    console.log("\n# cleaned up course (throwaway users remain — clean in Supabase → Auth)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
