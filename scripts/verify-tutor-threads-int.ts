/**
 * TUTOR-1 Wave 3 (W3.2) — tutor threads / turns / charter / escalation
 * INTEGRATION suite (live Supabase, no OpenAI key needed). Self-provisions
 * throwaway users each run. WRITE-ONLY in this package: the orchestrator applies
 * migration 20260804100000_tutor_threads_charter.sql BEFORE running it (the
 * tutor_threads / tutor_turns / tutor_charter_versions / tutor_escalation_candidates
 * surfaces do not exist until then). DO NOT run this before the migration.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) — assistant/
 * instructor turns and escalation candidates are SERVICE-ROLE-ONLY writes by
 * design (no client insert policy can represent them).
 *
 * The AC-W3S.1 + AC-T5.2-schema matrix:
 *   1. Learner creates their OWN thread (RLS insert) + inserts a role='learner'
 *      turn with the full envelope (publication_id/version from the fixture) —
 *      both succeed.
 *   2. unique (user_id, course_id): a second thread insert for the same pair fails.
 *   3. Learner INSERT of a role='assistant' turn → rejected by the with-check policy.
 *   4. Admin inserts an assistant turn (grounding jsonb + rung) — succeeds.
 *   5. ANY update of a turn (learner client AND admin client) fails with 'immutable'.
 *   6. Stranger reads ZERO threads/turns; AUTHOR reads ZERO threads/turns/candidates
 *      (the strict regime — no author policy).
 *   7. applyCharterChange(author, courseId, authorId, {guidanceStyle, toneNotes}) →
 *      a tutor_charter_versions row exists with actor=authorId + the full snapshot;
 *      tutor_course_settings.current_charter_version_id points at it;
 *      serializeCharter(resolveCharter(re-read row)) CONTAINS the changed values and
 *      differs from the pre-change serialization (AC-T5.2 schema half).
 *   8. Admin inserts a tutor_escalation_candidates row (consent_pending). Learner
 *      reads it; stranger + author read zero.
 *   9. Learner updates status → 'withdrawn' (succeeds); a learner attempt to change
 *      learner_question raises 'only the status may change'; a 'withdrawn' →
 *      'consented' transition raises 'illegal status transition'.
 *  10. Learner direct INSERT into candidates → rejected (no insert policy).
 *
 * Run (AFTER the migration is applied): `npx tsx scripts/verify-tutor-threads-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; on IPv6-broken networks (this dev
// machine's Clash setup) the TLS socket resets before the handshake. Pin
// IPv4-first — harmless everywhere else, load-bearing here.
dns.setDefaultResultOrder("ipv4first");

/** This network also drops connections sporadically mid-run. Retry transient
 *  TRANSPORT failures (never HTTP errors) so the suite is deterministic. */
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
import { resolveLivePublicationBySlug, type PublicationRow } from "@/lib/learn/resolve";
import { applyCharterChange, resolveCharter, serializeCharter } from "@/lib/tutor/runtime/charter";

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
  const email = `tutor-th-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
    description: "Tutor threads integration fixture.",
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

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:tutor:threads:int needs SUPABASE_SERVICE_ROLE_KEY");

  // One CREATOR (author of a minimal published course), one ENROLLED learner,
  // one STRANGER (a second learner who NEVER enrolls — tutor_threads RLS requires
  // private.is_enrolled, so the stranger has no thread surface at all).
  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");
  const stranger = await provisionUser(url, anon, "stranger");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, `Tutor threads itest ${crypto.randomUUID().slice(0, 6)}`);
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded course");

  const cleanup = async () => {
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ── publish + enroll (only the learner; the stranger stays unenrolled) ── */
    console.log("\n# publish + enroll");
    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    check("published v1 live", v1.publication.version === 1 && v1.publication.status === "live");
    const found = await resolveLivePublicationBySlug(learner.client, v1.publication.slug);
    if (found.kind !== "found") throw new Error("publication not resolvable");
    const publication: PublicationRow = found.publication;

    const enrolled = await learner.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: learner.userId })
      .select("*")
      .single();
    check("learner self-enrolls (the stranger never does)", !enrolled.error, String(enrolled.error?.message));

    /* ───── 1. learner creates their OWN thread + a role=learner turn ───────── */
    console.log("\n# 1. learner creates their own thread + a role=learner turn");
    const thread = await learner.client
      .from("tutor_threads")
      .insert({ user_id: learner.userId, course_id: courseId })
      .select("*")
      .single();
    check("learner creates their own thread (RLS insert)", !thread.error && thread.data !== null, String(thread.error?.message));
    const threadId = thread.data!.id;

    const learnerTurn = await learner.client
      .from("tutor_turns")
      .insert({
        thread_id: threadId,
        user_id: learner.userId,
        course_id: courseId,
        role: "learner",
        content: "How does a transparent watercolor wash stay transparent?",
        publication_id: publication.id,
        version: publication.version,
      })
      .select("*")
      .single();
    check(
      "learner inserts a role='learner' turn with the full envelope",
      !learnerTurn.error && learnerTurn.data?.role === "learner" && learnerTurn.data?.publication_id === publication.id,
      String(learnerTurn.error?.message)
    );

    /* ───── 2. unique (user_id, course_id): a second thread fails ───────────── */
    console.log("\n# 2. unique (user_id, course_id) — one thread per learner per course");
    const dupThread = await learner.client
      .from("tutor_threads")
      .insert({ user_id: learner.userId, course_id: courseId });
    check("a second thread for the same (user, course) is refused (unique)", dupThread.error !== null);

    /* ───── 3. learner INSERT of a role='assistant' turn is rejected ────────── */
    console.log("\n# 3. learner cannot forge a non-learner turn");
    const forged = await learner.client.from("tutor_turns").insert({
      thread_id: threadId,
      user_id: learner.userId,
      course_id: courseId,
      role: "assistant",
      content: "A forged assistant reply.",
      publication_id: publication.id,
      version: publication.version,
    });
    check("a learner INSERT of a role='assistant' turn is refused (with-check pins role)", forged.error !== null);

    /* ───── 4. admin inserts an assistant turn (grounding + rung) ───────────── */
    console.log("\n# 4. service role writes the assistant turn");
    const grounding = { citedAnchors: [{ nodeId: newRowId(), kind: "grounded" }], spanMap: [] };
    const assistantTurn = await admin
      .from("tutor_turns")
      .insert({
        thread_id: threadId,
        user_id: learner.userId,
        course_id: courseId,
        role: "assistant",
        content: "Watercolor stays transparent because the binder holds little pigment; let each wash dry.",
        publication_id: publication.id,
        version: publication.version,
        grounding: grounding as never,
        rung: 1,
      })
      .select("*")
      .single();
    check(
      "admin (service role) inserts an assistant turn with grounding + rung",
      !assistantTurn.error && assistantTurn.data?.role === "assistant" && assistantTurn.data?.rung === 1,
      String(assistantTurn.error?.message)
    );
    const assistantTurnId = assistantTurn.data!.id;

    /* ───── 5. any update of a turn fails with 'immutable' (learner + admin) ── */
    console.log("\n# 5. turns are append-only (immutable trigger)");
    const learnerUpdateTurn = await learner.client
      .from("tutor_turns")
      .update({ content: "edited by the learner" })
      .eq("id", learnerTurn.data!.id);
    // With NO update policy, RLS silently filters the learner's UPDATE to zero
    // rows — it never even reaches the immutability trigger (defense in depth:
    // RLS stops clients; the trigger stops even the service role, check below).
    const learnerTurnAfter = await learner.client
      .from("tutor_turns")
      .select("content")
      .eq("id", learnerTurn.data!.id)
      .single();
    check(
      "a learner UPDATE of their own turn is a silent no-op (no update policy; content unchanged)",
      learnerUpdateTurn.error === null && learnerTurnAfter.data?.content !== "edited by the learner",
      String(learnerUpdateTurn.error?.message ?? learnerTurnAfter.data?.content)
    );
    const adminUpdateTurn = await admin
      .from("tutor_turns")
      .update({ content: "edited by the service role" })
      .eq("id", assistantTurnId);
    check(
      "an admin (service role) UPDATE of a turn also raises 'immutable'",
      adminUpdateTurn.error !== null && /immutable/.test(adminUpdateTurn.error?.message ?? ""),
      String(adminUpdateTurn.error?.message)
    );

    /* ───── 6. strict regime: stranger + author read nothing ────────────────── */
    console.log("\n# 6. strict regime — no author (or stranger) visibility");
    const strangerThreads = await stranger.client.from("tutor_threads").select("id").eq("course_id", courseId);
    const strangerTurns = await stranger.client.from("tutor_turns").select("id").eq("course_id", courseId);
    check(
      "a stranger reads ZERO threads and ZERO turns",
      (strangerThreads.data ?? []).length === 0 && (strangerTurns.data ?? []).length === 0
    );
    const authorThreads = await author.client.from("tutor_threads").select("id").eq("course_id", courseId);
    const authorTurns = await author.client.from("tutor_turns").select("id").eq("course_id", courseId);
    check(
      "the AUTHOR reads ZERO threads and ZERO turns (no author policy — creator visibility is Wave 6)",
      (authorThreads.data ?? []).length === 0 && (authorTurns.data ?? []).length === 0
    );
    // The learner (owner + enrolled) DOES see their own transcript — proves the
    // above zeros are the strict regime, not a broken fixture.
    const learnerReadsOwn = await learner.client.from("tutor_turns").select("id").eq("course_id", courseId);
    check("the learner reads their OWN turns (both the learner + assistant rows)", (learnerReadsOwn.data ?? []).length === 2);

    /* ───── 7. AC-T5.2 schema half — applyCharterChange + serialize ─────────── */
    console.log("\n# 7. applyCharterChange writes a version + repoints settings (AC-T5.2 schema)");
    // Pre-change serialization: no settings row yet → defaults.
    const beforeSettings = await author.client
      .from("tutor_course_settings")
      .select("*")
      .eq("course_id", courseId)
      .maybeSingle();
    const beforeSerialized = serializeCharter(resolveCharter(beforeSettings.data ?? null));

    // applyCharterChange upserts the settings row (there may be none yet) and
    // writes the version row FIRST, then repoints current_charter_version_id.
    const applied = await applyCharterChange(author.client, courseId, author.userId, {
      guidanceStyle: "socratic_strict",
      toneNotes: "Warm, concise, and Socratic — always end on a question.",
    });
    check("applyCharterChange returns a versionId", typeof applied.versionId === "string" && applied.versionId.length > 0);

    const versionRow = await author.client
      .from("tutor_charter_versions")
      .select("*")
      .eq("id", applied.versionId)
      .single();
    check(
      "a tutor_charter_versions row exists with actor=authorId + the full snapshot",
      !versionRow.error &&
        versionRow.data?.actor === author.userId &&
        versionRow.data?.course_id === courseId &&
        (versionRow.data?.snapshot as Record<string, unknown>)?.guidanceStyle === "socratic_strict" &&
        (versionRow.data?.snapshot as Record<string, unknown>)?.toneNotes ===
          "Warm, concise, and Socratic — always end on a question.",
      String(versionRow.error?.message)
    );

    const afterSettings = await author.client
      .from("tutor_course_settings")
      .select("*")
      .eq("course_id", courseId)
      .single();
    check(
      "tutor_course_settings.current_charter_version_id points at the new version",
      !afterSettings.error && afterSettings.data?.current_charter_version_id === applied.versionId,
      String(afterSettings.error?.message)
    );

    const afterSerialized = serializeCharter(resolveCharter(afterSettings.data ?? null));
    check(
      "serializeCharter(resolveCharter(re-read row)) reflects the changed values",
      afterSerialized.includes(
        "Never state the answer outright. Lead the learner to it with questions and hints only."
      ) && afterSerialized.includes("Warm, concise, and Socratic — always end on a question.")
    );
    check("the post-change serialization DIFFERS from the pre-change one", afterSerialized !== beforeSerialized);

    /* ───── 8. escalation candidate: learner reads own; stranger+author zero ── */
    console.log("\n# 8. escalation candidate (service-role write, learner-owned read)");
    const candidate = await admin
      .from("tutor_escalation_candidates")
      .insert({
        user_id: learner.userId,
        course_id: courseId,
        learner_question: "I keep muddying my washes — is that a pigment or a water problem?",
        node_ids: [] as never,
        anchors: [] as never,
        rung_trail: [{ rung: 3 }] as never,
        tutor_proposed_answer: "Likely too much pigment; try more water and fewer layers.",
        status: "consent_pending",
      })
      .select("*")
      .single();
    check(
      "admin (service role) inserts a consent_pending candidate",
      !candidate.error && candidate.data?.status === "consent_pending",
      String(candidate.error?.message)
    );
    const candidateId = candidate.data!.id;

    const learnerReadsCandidate = await learner.client
      .from("tutor_escalation_candidates")
      .select("id, status")
      .eq("id", candidateId);
    check("the learner reads their OWN candidate", (learnerReadsCandidate.data ?? []).length === 1);
    const strangerCandidate = await stranger.client
      .from("tutor_escalation_candidates")
      .select("id")
      .eq("course_id", courseId);
    const authorCandidate = await author.client
      .from("tutor_escalation_candidates")
      .select("id")
      .eq("course_id", courseId);
    check(
      "a stranger AND the author read ZERO candidates (strict regime — no author policy)",
      (strangerCandidate.data ?? []).length === 0 && (authorCandidate.data ?? []).length === 0
    );

    /* ───── 9. status-only + legal-transition trigger ───────────────────────── */
    console.log("\n# 9. status-only UPDATE + legal consent transitions");
    const withdraw = await learner.client
      .from("tutor_escalation_candidates")
      .update({ status: "withdrawn" })
      .eq("id", candidateId)
      .select("status")
      .single();
    check(
      "the learner flips status consent_pending → withdrawn",
      !withdraw.error && withdraw.data?.status === "withdrawn",
      String(withdraw.error?.message)
    );

    // Any non-status column change raises, regardless of a legal-looking status.
    const mutateContent = await learner.client
      .from("tutor_escalation_candidates")
      .update({ learner_question: "a different question" })
      .eq("id", candidateId);
    check(
      "a learner change to learner_question raises 'only the status may change'",
      mutateContent.error !== null && /only the status may change/.test(mutateContent.error?.message ?? ""),
      String(mutateContent.error?.message)
    );

    // withdrawn is terminal — withdrawn → consented is illegal.
    const illegalTransition = await learner.client
      .from("tutor_escalation_candidates")
      .update({ status: "consented" })
      .eq("id", candidateId);
    check(
      "a withdrawn → consented transition raises 'illegal status transition'",
      illegalTransition.error !== null && /illegal status transition/.test(illegalTransition.error?.message ?? ""),
      String(illegalTransition.error?.message)
    );

    /* ───── 10. learner direct INSERT into candidates is refused ────────────── */
    console.log("\n# 10. candidates have no client insert policy");
    const learnerInsertCandidate = await learner.client.from("tutor_escalation_candidates").insert({
      user_id: learner.userId,
      course_id: courseId,
      learner_question: "a self-filed escalation",
      status: "consent_pending",
    });
    check("a learner direct INSERT into candidates is refused (no insert policy)", learnerInsertCandidate.error !== null);
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
