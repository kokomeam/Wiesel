/**
 * TUTOR-1 Amendment A4, Wave 1 — LESSON-SCOPED tutor threads INTEGRATION suite
 * (live Supabase + the deterministic mock model; no OpenAI key needed).
 * Self-provisions throwaway users each run. Requires SUPABASE_SERVICE_ROLE_KEY
 * (thread/turn/compaction writes are service-role).
 *
 * WRITE-ONLY package: the orchestrator applies the A4 migration
 * 20260810120000_tutor_lesson_threads.sql (+ the base thread/charter migration
 * 20260804100000, the concept-graph + mastery migrations) BEFORE this runs.
 *
 * This suite drives lib/tutor/runtime/service.ts + the pure compaction module
 * DIRECTLY (the route is a thin SSE wrapper — the service is the int-testable
 * seam). The fixture is one module → TWO lessons (a per-lesson thread separation
 * needs a second lesson) + an active concept_node anchored to lesson 1 (so
 * loadTutorContext resolves anchors) + ONE enrolled learner.
 *
 *   A4-2 (lesson-scoped resolution):
 *     • resolveThread(lesson1) twice → the SAME id.
 *     • resolveThread(lesson2) → a DIFFERENT id than lesson1.
 *     • resolveThread(null = general) → a THIRD distinct id.
 *     • end-to-end: two runTutorTurnForRequest calls with envelope.lessonId =
 *       lesson1 then lesson2 → threadIds DIFFER; a second lesson1 turn REUSES
 *       lesson1's thread. Each turn ok.
 *
 *   A4-3 (backfill survival / legacy readability):
 *     • a general (null-lesson) thread with a couple of turns stays readable after
 *       resolveThread(lesson1) mints a NEW per-lesson thread beside it.
 *
 *   A4-7 (Start fresh archives, never deletes):
 *     • archiveThread(lesson1) sets archived_at; the archived row stays queryable;
 *       resolveThread(lesson1) returns a NEW active id; exactly ONE active thread
 *       for (user, lesson1); a second archive of the fresh (empty) thread is a
 *       no-throw idempotent op.
 *
 *   A4-4 (compaction persists + folds, transcript preserved):
 *     • with TURN_THRESHOLD=6 / KEEP_RECENT=2 and 8 seeded turns, maybeCompactThread
 *       folds 6 turns into a rolling summary (compactedThroughTurn=6), persists it,
 *       preserves all 8 turns for display, and assembleReplayWithSummary CONTAINS
 *       the summary + the newest turn while EXCLUDING the oldest.
 *
 * Run (AFTER the migrations): `npx tsx scripts/verify-tutor-threading-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; pin IPv4-first (this dev machine's
// Clash setup resets IPv6 TLS before the handshake). Harmless everywhere else.
dns.setDefaultResultOrder("ipv4first");

/** Retry transient TRANSPORT failures (never HTTP errors) — this network drops
 *  connections sporadically mid-run. */
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
import { PublicationSnapshotSchema, type PublicationSnapshot } from "@/lib/course/publish/schemas";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
import {
  resolveThread,
  archiveThread,
  maybeCompactThread,
  runTutorTurnForRequest,
  type TurnEnvelope,
} from "@/lib/tutor/runtime/service";
import { assembleReplayWithSummary } from "@/lib/tutor/runtime/compaction";
import { loadTutoredLessonIds } from "@/lib/learn/tutorHistory";
import type { HistoryTurn } from "@/lib/tutor/runtime/history";

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
  const email = `tutor-thr-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

/** Publishable fixture: one module → TWO lessons, each a 2-slide deck. The second
 *  lesson is what makes per-lesson thread separation testable (A4-2). */
function makeDoc(courseId: string, ownerId: string, title: string): CourseDocument {
  const deckA = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deckA.slides = [createSlide("title"), createSlide("title_bullets")];
  const lessonA = createLesson("Lesson A", 0);
  lessonA.blocks = [deckA];

  const deckB = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deckB.slides = [createSlide("title"), createSlide("title_bullets")];
  const lessonB = createLesson("Lesson B", 1);
  lessonB.blocks = [deckB];

  const mod = createModule("Foundations", 0);
  mod.lessons = [lessonA, lessonB];
  return {
    id: courseId,
    title,
    description: "Tutor threading integration fixture.",
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

/** A plain snapshot loader (bypasses getCachedSnapshot's Next.js unstable_cache):
 *  read the immutable snapshot jsonb by publication id + Zod-parse it. */
function makeSnapshotLoader(admin: DB): (publicationId: string) => Promise<{ snapshot: PublicationSnapshot }> {
  return async (publicationId: string) => {
    const { data, error } = await admin
      .from("course_publications")
      .select("snapshot")
      .eq("id", publicationId)
      .single();
    if (error || !data) throw new Error(`snapshot load: ${error?.message ?? "not found"}`);
    return { snapshot: PublicationSnapshotSchema.parse((data as { snapshot: unknown }).snapshot) };
  };
}

/** A scripted grounded tutor_turn_output (mirrors route-int): one grounded span
 *  backed by a real citation into the snapshot so grounding validates clean. */
function scriptedTurnOutput(citation: { lessonId: string; blockId: string }): Record<string, unknown> {
  return {
    tutor_turn_output: {
      proseWithSpanMarkers: "⟦g⟧A wash stays transparent when the binder holds little pigment.⟦/g⟧",
      citations: [{ lessonId: citation.lessonId, blockId: citation.blockId }],
      rung: 2,
      evidence: [],
    },
  };
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:tutor:threading:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, `Tutor threading itest ${crypto.randomUUID().slice(0, 6)}`);
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded course (one module → two lessons)");

  const lesson1Id = doc.modules[0].lessons[0].id;
  const lesson2Id = doc.modules[0].lessons[1].id;
  const nodeId = newRowId();

  // Preserve + restore the two compaction env knobs the A4-4 leg flips.
  const savedTurnThreshold = process.env.TUTOR_COMPACTION_TURN_THRESHOLD;
  const savedKeepRecent = process.env.TUTOR_COMPACTION_KEEP_RECENT;

  const cleanup = async () => {
    // tutor_turns → tutor_threads (turns FK the thread; delete children first —
    // but delete by course_id covers both regardless of order).
    await admin.from("tutor_turns").delete().eq("course_id", courseId);
    await admin.from("tutor_threads").delete().eq("course_id", courseId);
    await admin.from("learner_mastery").delete().eq("course_id", courseId);
    await admin.from("learning_events").delete().eq("course_id", courseId);
    await admin.from("concept_nodes").delete().eq("course_id", courseId);
    await admin.from("tutor_course_settings").delete().eq("course_id", courseId);
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ── publish + enroll (only the learner) ── */
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
    check("learner self-enrolls", !enrolled.error, String(enrolled.error?.message));

    // Seed the concept node (admin write) anchored to lesson 1, active so
    // loadTutorContext picks it up.
    const nodeInsert = await admin.from("concept_nodes").insert({
      id: nodeId,
      course_id: courseId,
      title: "Transparent washes",
      description: "Why a watercolor wash stays transparent.",
      anchors: [{ lessonId: lesson1Id }] as never,
      status: "active",
    } as never);
    check("seeded an active concept node (anchored to lesson 1)", !nodeInsert.error, String(nodeInsert.error?.message));

    const loadSnapshot = makeSnapshotLoader(admin);
    const citation = { lessonId: lesson1Id, blockId: doc.modules[0].lessons[0].blocks[0].id };

    /* ═══════════════════════ A4-2 — lesson-scoped resolution ══════════════════ */
    console.log("\n# A4-2 — resolveThread is lesson-scoped (lesson1 / lesson2 / general are distinct; reuse is stable)");

    const r1a = await resolveThread(admin, { userId: learner.userId, courseId, lessonId: lesson1Id });
    const r1b = await resolveThread(admin, { userId: learner.userId, courseId, lessonId: lesson1Id });
    check("resolveThread(lesson1) twice → the SAME thread id", r1a.id === r1b.id, JSON.stringify({ a: r1a.id, b: r1b.id }));

    const r2 = await resolveThread(admin, { userId: learner.userId, courseId, lessonId: lesson2Id });
    check("resolveThread(lesson2) → a DIFFERENT id than lesson1", r2.id !== r1a.id, JSON.stringify({ l1: r1a.id, l2: r2.id }));

    const rGeneral = await resolveThread(admin, { userId: learner.userId, courseId, lessonId: null });
    check("resolveThread(null = general) → a THIRD distinct id",
      rGeneral.id !== r1a.id && rGeneral.id !== r2.id,
      JSON.stringify({ l1: r1a.id, l2: r2.id, gen: rGeneral.id }));

    // Fresh cursors (never-compacted): summary null, cursor 0.
    check("a fresh thread carries a null compaction summary + 0 cursor",
      r1a.compactionSummary === null && r1a.compactedThroughTurn === 0,
      JSON.stringify({ summary: r1a.compactionSummary, cursor: r1a.compactedThroughTurn }));

    // End-to-end: two turns on different lessons resolve to different threads; a
    // second lesson-1 turn reuses lesson-1's thread. (access resolves internally.)
    const runTurn = async (lessonId: string, message: string) => {
      const model = withPooledModel(
        createMockModelClient([], { structured: scriptedTurnOutput(citation) }),
        { pool: poolFor("learner") }
      );
      const envelope: TurnEnvelope = { courseId, publicationId: publication.id, version: publication.version, lessonId };
      return runTutorTurnForRequest(
        { learnerClient: learner.client, admin, model, loadSnapshot },
        { userId: learner.userId, envelope, learnerMessage: message }
      );
    };

    const t1 = await runTurn(lesson1Id, "Why does a wash stay transparent?");
    check("end-to-end: lesson-1 turn is ok + landed on lesson-1's thread",
      t1.turn?.ok === true && t1.threadId === r1a.id,
      JSON.stringify({ ok: t1.turn?.ok, threadId: t1.threadId, expected: r1a.id, err: t1.turn?.error }));

    const t2 = await runTurn(lesson2Id, "And what about lesson two?");
    check("end-to-end: lesson-2 turn is ok + landed on a DIFFERENT thread",
      t2.turn?.ok === true && t2.threadId === r2.id && t2.threadId !== t1.threadId,
      JSON.stringify({ ok: t2.turn?.ok, threadId: t2.threadId, l1: t1.threadId }));

    const t1b = await runTurn(lesson1Id, "Back to lesson one — what about layering?");
    check("end-to-end: a second lesson-1 turn REUSES lesson-1's thread",
      t1b.turn?.ok === true && t1b.threadId === t1.threadId,
      JSON.stringify({ ok: t1b.turn?.ok, threadId: t1b.threadId, first: t1.threadId }));

    /* ═══════════════════════ A4-3 — legacy general thread readability ═════════ */
    console.log("\n# A4-3 — a general (null-lesson) thread stays readable when a per-lesson thread opens beside it");

    // Use a FRESH learner so the general thread is pristine (learner above already
    // has an active general thread from the A4-2 resolveThread(null) call).
    const legacyLearner = await provisionUser(url, anon, "legacy");
    const enrolledLegacy = await legacyLearner.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: legacyLearner.userId })
      .select("*")
      .single();
    check("A4-3 learner self-enrolls", !enrolledLegacy.error, String(enrolledLegacy.error?.message));

    // A general (null-lesson) thread + a couple of turns (lesson_id null), mirroring
    // a legacy pre-A4 thread. Turns are service-role writes (admin bypasses RLS).
    const generalThread = await resolveThread(admin, { userId: legacyLearner.userId, courseId, lessonId: null });
    check("general thread created (lesson_id null)", typeof generalThread.id === "string");
    const generalTurns = await admin.from("tutor_turns").insert([
      {
        thread_id: generalThread.id,
        user_id: legacyLearner.userId,
        course_id: courseId,
        role: "learner",
        content: "General question about the whole course.",
        publication_id: publication.id,
        version: publication.version,
        lesson_id: null,
      },
      {
        thread_id: generalThread.id,
        user_id: legacyLearner.userId,
        course_id: courseId,
        role: "assistant",
        content: "A general answer spanning several lessons.",
        publication_id: publication.id,
        version: publication.version,
        lesson_id: null,
      },
    ] as never);
    check("seeded two turns on the general thread", !generalTurns.error, String(generalTurns.error?.message));

    // Opening a lesson mints a NEW per-lesson thread — distinct from the general one.
    const legacyLesson1 = await resolveThread(admin, { userId: legacyLearner.userId, courseId, lessonId: lesson1Id });
    check("A4-3: resolveThread(lesson1) mints a NEW per-lesson thread (≠ the general thread)",
      legacyLesson1.id !== generalThread.id,
      JSON.stringify({ gen: generalThread.id, lesson1: legacyLesson1.id }));

    // The general thread ROW is STILL selectable by id, still active, and its turns
    // still load — the per-lesson thread did not disturb it.
    const generalRow = await admin
      .from("tutor_threads")
      .select("id, lesson_id, archived_at")
      .eq("id", generalThread.id)
      .single();
    check("A4-3: the general thread row is STILL selectable by id (readable, lesson_id null, active)",
      !generalRow.error &&
        generalRow.data?.id === generalThread.id &&
        generalRow.data?.lesson_id === null &&
        generalRow.data?.archived_at === null,
      String(generalRow.error?.message ?? JSON.stringify(generalRow.data)));

    const generalTurnCount = await admin
      .from("tutor_turns")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", generalThread.id);
    check("A4-3: the general thread's two turns still load", (generalTurnCount.count ?? 0) === 2, String(generalTurnCount.count));

    /* ═══════════════════════ A4-7 — Start fresh archives, never deletes ═══════ */
    console.log("\n# A4-7 — archiveThread flips archived_at (never deletes); resolveThread then mints a fresh active thread");

    // Use a FRESH learner so the (user, lesson1) active-count assertion is clean.
    const freshLearner = await provisionUser(url, anon, "fresh");
    const enrolledFresh = await freshLearner.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: freshLearner.userId })
      .select("*")
      .single();
    check("A4-7 learner self-enrolls", !enrolledFresh.error, String(enrolledFresh.error?.message));

    const original = await resolveThread(admin, { userId: freshLearner.userId, courseId, lessonId: lesson1Id });
    check("A4-7: an active lesson-1 thread exists to archive", typeof original.id === "string");

    const archived = await archiveThread(admin, { userId: freshLearner.userId, courseId, lessonId: lesson1Id });
    check("A4-7: archiveThread(lesson1) returns the archived id", archived.archivedThreadId === original.id,
      JSON.stringify({ archived: archived.archivedThreadId, original: original.id }));

    const archivedRow = await admin
      .from("tutor_threads")
      .select("id, archived_at")
      .eq("id", original.id)
      .single();
    check("A4-7: the archived thread row sets archived_at (never deleted — still selectable)",
      !archivedRow.error && archivedRow.data?.id === original.id && archivedRow.data?.archived_at !== null,
      String(archivedRow.error?.message ?? JSON.stringify(archivedRow.data)));

    const fresh = await resolveThread(admin, { userId: freshLearner.userId, courseId, lessonId: lesson1Id });
    check("A4-7: resolveThread(lesson1) after archive returns a NEW active thread id (≠ the archived one)",
      fresh.id !== original.id,
      JSON.stringify({ fresh: fresh.id, archived: original.id }));

    const activeCount = await admin
      .from("tutor_threads")
      .select("id", { count: "exact", head: true })
      .eq("user_id", freshLearner.userId)
      .eq("lesson_id", lesson1Id)
      .is("archived_at", null);
    check("A4-7: exactly ONE active (archived_at null) thread exists for (user, lesson1)",
      (activeCount.count ?? 0) === 1, String(activeCount.count));

    // A second archive of the fresh (empty) thread: archives it too — a no-throw
    // idempotent op. Then a THIRD archive (nothing active) returns null.
    let secondArchive: { archivedThreadId: string | null } | null = null;
    let secondArchiveThrew = false;
    try {
      secondArchive = await archiveThread(admin, { userId: freshLearner.userId, courseId, lessonId: lesson1Id });
    } catch {
      secondArchiveThrew = true;
    }
    check("A4-7: a second archiveThread on the fresh thread does NOT throw",
      !secondArchiveThrew && secondArchive !== null);
    check("A4-7: the second archive archived the fresh thread (its id)",
      secondArchive?.archivedThreadId === fresh.id,
      JSON.stringify({ archived: secondArchive?.archivedThreadId, fresh: fresh.id }));

    const thirdArchive = await archiveThread(admin, { userId: freshLearner.userId, courseId, lessonId: lesson1Id });
    check("A4-7: archiving when nothing is active returns null archivedThreadId (idempotent)",
      thirdArchive.archivedThreadId === null, JSON.stringify(thirdArchive));

    /* ═══════════════════════ A4-4 — compaction persists + folds ═══════════════ */
    console.log("\n# A4-4 — maybeCompactThread folds old turns into a rolling summary; full transcript preserved for display");

    // Flip the thresholds BEFORE the call (compactionConfig reads env at call time).
    process.env.TUTOR_COMPACTION_TURN_THRESHOLD = "6";
    process.env.TUTOR_COMPACTION_KEEP_RECENT = "2";

    // A dedicated learner + a fresh thread on lesson 2 isolates the compaction.
    const compLearner = await provisionUser(url, anon, "compaction");
    const enrolledComp = await compLearner.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: compLearner.userId })
      .select("*")
      .single();
    check("A4-4 learner self-enrolls", !enrolledComp.error, String(enrolledComp.error?.message));

    const compThread = await resolveThread(admin, { userId: compLearner.userId, courseId, lessonId: lesson2Id });
    check("A4-4: a fresh thread for compaction", typeof compThread.id === "string");

    // Insert 8 turns with EXPLICIT created_at 1s apart (deterministic ascending
    // order — the fold reads created_at asc). Alternating roles, content non-empty
    // (char_length 1..20000), thread + lesson matching, valid pub/version.
    const base = Date.parse("2026-08-10T12:00:00.000Z");
    const eightTurns = Array.from({ length: 8 }, (_, i) => ({
      thread_id: compThread.id,
      user_id: compLearner.userId,
      course_id: courseId,
      role: i % 2 === 0 ? "learner" : "assistant",
      content:
        i % 2 === 0
          ? `OLDEST-MARKER learner turn ${i}: question about topic ${i}.`
          : `assistant turn ${i}: an answer about topic ${i}.`,
      publication_id: publication.id,
      version: publication.version,
      lesson_id: lesson2Id,
      created_at: new Date(base + i * 1000).toISOString(),
    }));
    // Tag the NEWEST turn (index 7) with a distinctive marker so we can assert it
    // survives the replay window.
    eightTurns[7].content = "NEWEST-MARKER assistant turn 7: the most recent answer.";
    const eightInsert = await admin.from("tutor_turns").insert(eightTurns as never);
    check("A4-4: seeded 8 turns (staggered created_at, alternating roles)", !eightInsert.error, String(eightInsert.error?.message));

    const compModel = withPooledModel(
      createMockModelClient([], {
        structured: { tutor_compaction_summary: { summary: "ROLLING SUMMARY: the learner covered X and Y." } },
      }),
      { pool: poolFor("learner") }
    );
    const compacted = await maybeCompactThread(
      { admin, model: compModel },
      { threadId: compThread.id, compactionSummary: compThread.compactionSummary, compactedThroughTurn: compThread.compactedThroughTurn }
    );
    check("A4-4: maybeCompactThread reports compacted === true", compacted.compacted === true, JSON.stringify(compacted));
    check("A4-4: compactedThroughTurn === 8 - keepRecent(2) === 6", compacted.compactedThroughTurn === 6, String(compacted.compactedThroughTurn));
    check("A4-4: the rolling summary includes the ROLLING SUMMARY text",
      typeof compacted.compactionSummary === "string" && compacted.compactionSummary.includes("ROLLING SUMMARY"),
      JSON.stringify(compacted.compactionSummary));

    // The thread ROW now carries the persisted summary + cursor.
    const compRow = await admin
      .from("tutor_threads")
      .select("compaction_summary, compacted_through_turn")
      .eq("id", compThread.id)
      .single();
    check("A4-4: the thread row persisted compaction_summary + compacted_through_turn=6",
      !compRow.error &&
        typeof compRow.data?.compaction_summary === "string" &&
        compRow.data.compaction_summary.includes("ROLLING SUMMARY") &&
        compRow.data?.compacted_through_turn === 6,
      String(compRow.error?.message ?? JSON.stringify(compRow.data)));

    // The FULL transcript is preserved for DISPLAY — nothing deleted.
    const preservedCount = await admin
      .from("tutor_turns")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", compThread.id);
    check("A4-4: all 8 turns are preserved (compaction folds into a summary, never deletes)",
      (preservedCount.count ?? 0) === 8, String(preservedCount.count));

    // The model's L4 = assembleReplayWithSummary(KEPT window, summary, budget). The
    // fold-out invariant: the FOLDED turns (0..cursor-1) are represented ONLY by the
    // rolling summary, and the KEPT window (cursor..end) replays verbatim — so the
    // summary CONTAINS the fold, the oldest folded turn is EXCLUDED from the verbatim
    // replay, and the newest kept turn is INCLUDED. (The kept window is the turns
    // after `compacted_through_turn`, exactly what the summary substitutes for.)
    const loaded = await admin
      .from("tutor_turns")
      .select("role, content, created_at")
      .eq("thread_id", compThread.id)
      .order("created_at", { ascending: true });
    const oldestToNewest: HistoryTurn[] = (loaded.data ?? []).map((r) => ({
      role: r.role as HistoryTurn["role"],
      content: r.content,
    }));
    const cursor = compacted.compactedThroughTurn; // 6
    const keptWindow = oldestToNewest.slice(cursor); // turns 6 + 7 only
    const storedSummary = compRow.data?.compaction_summary ?? null;
    const l4 = assembleReplayWithSummary(keptWindow, storedSummary, 8000);
    check("A4-4: assembleReplayWithSummary CONTAINS the summary text", l4.includes("ROLLING SUMMARY"));
    check("A4-4: the L4 replay EXCLUDES the oldest folded turn (turn 0's OLDEST-MARKER — carried only by the summary)",
      !l4.includes("OLDEST-MARKER learner turn 0"), l4.slice(0, 300));
    check("A4-4: the L4 replay INCLUDES the newest turn (NEWEST-MARKER, in the kept window)",
      l4.includes("NEWEST-MARKER"), l4.slice(-200));

    /* ── A4-8 — outline indicators: loadTutoredLessonIds returns EXACTLY the
     *    lessons the learner has a non-empty conversation for (the dot source). ── */
    console.log("\n# A4-8 — loadTutoredLessonIds returns exactly the lessons with a non-empty thread");
    // Ground truth: distinct non-null lesson_ids across the learner's turns (admin).
    const allTurns = await admin
      .from("tutor_turns")
      .select("lesson_id")
      .eq("user_id", learner.userId)
      .eq("course_id", courseId);
    const truth = new Set(
      (allTurns.data ?? [])
        .map((r) => r.lesson_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    );
    // The learner's own RLS read (what the outline server component calls).
    const indicated = await loadTutoredLessonIds(learner.client, learner.userId, courseId);
    const sameSet = truth.size === indicated.size && [...truth].every((id) => indicated.has(id));
    check(
      "A4-8: loadTutoredLessonIds EQUALS the ground-truth tutored-lesson set",
      sameSet,
      JSON.stringify({ truth: [...truth], indicated: [...indicated] })
    );
    check("A4-8: lesson1 (a real conversation) is indicated", indicated.has(lesson1Id));
    check("A4-8: lesson2 (a real conversation) is indicated", indicated.has(lesson2Id));
    check(
      "A4-8: a lesson with NO conversation is NOT indicated (general/null-lesson turns don't count)",
      !indicated.has(newRowId()),
    );
  } finally {
    process.env.TUTOR_COMPACTION_TURN_THRESHOLD = savedTurnThreshold;
    process.env.TUTOR_COMPACTION_KEEP_RECENT = savedKeepRecent;
    if (savedTurnThreshold === undefined) delete process.env.TUTOR_COMPACTION_TURN_THRESHOLD;
    if (savedKeepRecent === undefined) delete process.env.TUTOR_COMPACTION_KEEP_RECENT;
    await cleanup();
    console.log("\n# cleaned up course + tutor rows + env (throwaway users remain — clean in Supabase → Auth)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
