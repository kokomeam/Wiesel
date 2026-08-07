/**
 * TUTOR-1 Wave 3 (W3.4) — the tutor RUNTIME SERVICE / route INTEGRATION suite
 * (live Supabase + the deterministic mock model; no OpenAI key needed).
 * Self-provisions throwaway users each run. Requires SUPABASE_SERVICE_ROLE_KEY
 * (or SUPABASE_SECRET_KEY) — the tutor threads/turns + evidence emits are
 * service-role writes.
 *
 * WRITE-ONLY package: the orchestrator applies migration
 * 20260804100000_tutor_threads_charter.sql (+ the concept-graph + mastery
 * migrations) BEFORE this runs. DO NOT run before the migrations.
 *
 * This suite drives lib/tutor/runtime/service.ts DIRECTLY (the route is a thin
 * SSE wrapper around it — the service is the int-testable seam):
 *
 *   AC-W3R.1 (the access gate + a real turn):
 *     • resolveTutorAccess = 'not_enrolled' for the stranger.
 *     • 'author_preview' for the author — attempting a turn AND a
 *       recordPracticeAnswer through the gate emits ZERO evidence rows.
 *     • ON BY DEFAULT: NO tutor_course_settings row → the enrolled learner is
 *       'ok' (a missing row means the tutor is on); an explicit enabled=false
 *       row → 'disabled'.
 *     • re-enable (settings enabled=true) → the enrolled learner's mock turn
 *       (a scripted tutor_turn_output with 2 tutor_inference items) → learner +
 *       assistant turns persisted (grounding/rung present), tutor_inference rows
 *       == 2, and the thread is REUSED on turn 2.
 *
 *   AC-W3R.2 (abort is resumable, leaves the pool clean):
 *     • an already-aborted signal → the pooled model call rejects AbortError, NO
 *       assistant turn / NO evidence added, the learner pool is clean
 *       (inFlight===0 && queued===0), and a fresh call on the SAME thread then
 *       succeeds.
 *
 *   AC-W3R.3 (discrete evidence → mastery, idempotent + gated):
 *     • recordPracticeAnswer(correct, ordinal 1) → one practice_answer row with
 *       typed columns; refoldLearnerCourse + writeMastery → a learner_mastery
 *       row for the node; a double-call with the same ids keeps the row count
 *       stable; an author-gated call writes ZERO rows.
 *
 * Run (AFTER the migrations): `npx tsx scripts/verify-tutor-route-int.ts`
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
import { refoldLearnerCourse } from "@/lib/tutor/mastery/loader";
import { writeMastery } from "@/lib/tutor/mastery/writer";
import {
  resolveTutorAccess,
  runTutorTurnForRequest,
  recordPracticeAnswer,
  type TurnEnvelope,
} from "@/lib/tutor/runtime/service";

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
  const email = `tutor-rt-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
    description: "Tutor route integration fixture.",
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

/** Count learning_events rows of a given type for (user, course). */
async function countEvents(admin: DB, userId: string, courseId: string, eventType: string): Promise<number> {
  const { count, error } = await admin
    .from("learning_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .eq("event_type", eventType);
  if (error) throw new Error(`countEvents(${eventType}): ${error.message}`);
  return count ?? 0;
}

/** A plain snapshot loader (bypasses getCachedSnapshot's Next.js unstable_cache,
 *  which needs a request context this script doesn't have): read the immutable
 *  snapshot jsonb by publication id + Zod-parse it, exactly like the cache does. */
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

/** Build a scripted tutor_turn_output with N tutor_inference evidence items for
 *  the given concept node. The prose carries ONE grounded span backed by a real
 *  citation (lesson+block from the snapshot) so grounding validates clean with a
 *  surviving citation. (A3 Wave 1: short uncited prose no longer flags
 *  `ungrounded` — only substantive >200-char citation-less prose without an
 *  escalation proposal does; the citation here exercises the resolution path.) */
function scriptedTurnOutput(
  nodeId: string,
  evidenceCount: number,
  citation: { lessonId: string; blockId: string }
): Record<string, unknown> {
  const evidence = Array.from({ length: evidenceCount }, (_, i) => ({
    nodeId,
    direction: i % 2 === 0 ? "positive" : "negative",
    strength: "moderate",
    turnRef: `turn-ref-${i}`,
  }));
  return {
    tutor_turn_output: {
      proseWithSpanMarkers: "⟦g⟧A wash stays transparent when the binder holds little pigment.⟦/g⟧",
      citations: [{ lessonId: citation.lessonId, blockId: citation.blockId }],
      rung: 2,
      evidence,
    },
  };
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:tutor:route:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");
  const stranger = await provisionUser(url, anon, "stranger");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, `Tutor route itest ${crypto.randomUUID().slice(0, 6)}`);
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded course");

  // A concept node for the course (the evidence + mastery target). Active so
  // loadTutorContext + refold pick it up.
  const nodeId = newRowId();

  const cleanup = async () => {
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
    check("learner self-enrolls (the stranger never does)", !enrolled.error, String(enrolled.error?.message));

    // Seed the concept node (admin — concept_nodes is author/service writable).
    const nodeInsert = await admin.from("concept_nodes").insert({
      id: nodeId,
      course_id: courseId,
      title: "Transparent washes",
      description: "Why a watercolor wash stays transparent.",
      anchors: [{ lessonId: doc.modules[0].lessons[0].id }] as never,
      status: "active",
    } as never);
    check("seeded an active concept node", !nodeInsert.error, String(nodeInsert.error?.message));

    const envelope: TurnEnvelope = {
      courseId,
      publicationId: publication.id,
      version: publication.version,
      lessonId: doc.modules[0].lessons[0].id,
    };

    // The injectable snapshot loader (this script has no Next.js request context,
    // so getCachedSnapshot's unstable_cache would throw — inject a plain loader).
    const loadSnapshot = makeSnapshotLoader(admin);

    // A real citation into the snapshot (ids are preserved verbatim on publish),
    // so the scripted grounded prose resolves and the turn validates ok.
    const citation = {
      lessonId: doc.modules[0].lessons[0].id,
      blockId: doc.modules[0].lessons[0].blocks[0].id,
    };

    /* ═══════════════════════ AC-W3R.1 — the access gate ══════════════════════ */
    console.log("\n# AC-W3R.1 — access gate (disabled / not_enrolled / author_preview) + a real turn");

    // (a) ON BY DEFAULT — no tutor_course_settings row yet ⇒ the enrolled learner
    //     is NOT disabled; the missing row means the tutor is on (falls through to
    //     enrollment → 'ok'). Only an explicit enabled=false disables.
    const defaultOnAccess = await resolveTutorAccess(admin, { userId: learner.userId, courseId });
    check("no settings row → access 'ok' (ON BY DEFAULT)", defaultOnAccess.kind === "ok", defaultOnAccess.kind);

    // An explicit enabled=false row DISABLES the enrolled learner.
    const disableInsert = await admin
      .from("tutor_course_settings")
      .insert({ course_id: courseId, enabled: false } as never);
    check("admin can explicitly disable the tutor (settings.enabled=false)", !disableInsert.error, String(disableInsert.error?.message));
    const disabledAccess = await resolveTutorAccess(admin, { userId: learner.userId, courseId });
    check("explicit enabled=false row → access 'disabled'", disabledAccess.kind === "disabled", disabledAccess.kind);

    // Re-enable for the rest of the flow (update the row to enabled=true).
    const settingsUpdate = await admin
      .from("tutor_course_settings")
      .update({ enabled: true } as never)
      .eq("course_id", courseId);
    check("admin re-enables the tutor (settings.enabled=true)", !settingsUpdate.error, String(settingsUpdate.error?.message));

    // (b) NOT_ENROLLED — the stranger.
    const strangerAccess = await resolveTutorAccess(admin, { userId: stranger.userId, courseId });
    check("stranger → access 'not_enrolled'", strangerAccess.kind === "not_enrolled", strangerAccess.kind);

    // (c) AUTHOR_PREVIEW — the creator. A turn + a practice record through the
    //     gate must emit ZERO evidence.
    const authorAccess = await resolveTutorAccess(admin, { userId: author.userId, courseId });
    check("author → access 'author_preview'", authorAccess.kind === "author_preview", authorAccess.kind);

    const authorEvidenceBefore = await countEvents(admin, author.userId, courseId, "tutor_inference");
    const authorModel = withPooledModel(
      createMockModelClient([], { structured: scriptedTurnOutput(nodeId, 2, citation) }),
      { pool: poolFor("learner") }
    );
    const authorTurn = await runTutorTurnForRequest(
      { learnerClient: author.client, admin, model: authorModel },
      { userId: author.userId, envelope, learnerMessage: "As the author, does this record anything?" }
    );
    check("author-preview turn runs NOTHING (access 'author_preview', no assistant turn)",
      authorTurn.access === "author_preview" && authorTurn.turn === null && authorTurn.persistedTurnIds.assistant === null,
      JSON.stringify({ access: authorTurn.access, turn: authorTurn.turn !== null }));

    const authorPractice = await recordPracticeAnswer(admin, {
      access: authorAccess,
      userId: author.userId,
      envelope,
      nodeId,
      practiceItemRef: newRowId(),
      attemptOrdinal: 1,
      evidenceCorrect: true,
    });
    check("author-gated recordPracticeAnswer no-ops (emitted=false)", authorPractice.emitted === false);
    const authorEvidenceAfter = await countEvents(admin, author.userId, courseId, "tutor_inference");
    const authorPracticeEvents = await countEvents(admin, author.userId, courseId, "practice_answer");
    check("an author preview wrote ZERO evidence rows (inference + practice)",
      authorEvidenceAfter === authorEvidenceBefore && authorPracticeEvents === 0,
      JSON.stringify({ inferenceDelta: authorEvidenceAfter - authorEvidenceBefore, practice: authorPracticeEvents }));

    // (d) OK — the enrolled learner runs a real (mock) turn.
    const learnerAccess = await resolveTutorAccess(admin, { userId: learner.userId, courseId });
    check("enrolled learner → access 'ok'", learnerAccess.kind === "ok", learnerAccess.kind);

    const turnModel1 = withPooledModel(
      createMockModelClient([], { structured: scriptedTurnOutput(nodeId, 2, citation) }),
      { pool: poolFor("learner") }
    );
    const turn1 = await runTutorTurnForRequest(
      { learnerClient: learner.client, admin, model: turnModel1, loadSnapshot },
      { userId: learner.userId, envelope, learnerMessage: "Why does a wash stay transparent?" }
    );
    check("learner turn 1 is ok + persisted (learner + assistant rows)",
      turn1.access === "ok" &&
        turn1.turn?.ok === true &&
        typeof turn1.persistedTurnIds.learner === "string" &&
        typeof turn1.persistedTurnIds.assistant === "string",
      JSON.stringify({ access: turn1.access, ok: turn1.turn?.ok, error: turn1.turn?.error }));

    // The assistant row carries grounding + a rung.
    const assistantRow = await admin
      .from("tutor_turns")
      .select("grounding, rung, role")
      .eq("id", turn1.persistedTurnIds.assistant!)
      .single();
    check("the assistant turn row has grounding jsonb + a rung",
      !assistantRow.error &&
        assistantRow.data?.role === "assistant" &&
        typeof assistantRow.data?.rung === "number" &&
        assistantRow.data?.grounding !== null,
      String(assistantRow.error?.message));

    // 2 tutor_inference rows landed.
    const inferenceCount1 = await countEvents(admin, learner.userId, courseId, "tutor_inference");
    check("the turn emitted exactly 2 tutor_inference rows", inferenceCount1 === 2, String(inferenceCount1));
    check("runTutorTurnForRequest reports evidenceEmitted === 2", turn1.evidenceEmitted === 2, String(turn1.evidenceEmitted));

    // Turn 2 REUSES the same thread.
    const turnModel2 = withPooledModel(
      createMockModelClient([], { structured: scriptedTurnOutput(nodeId, 2, citation) }),
      { pool: poolFor("learner") }
    );
    const turn2 = await runTutorTurnForRequest(
      { learnerClient: learner.client, admin, model: turnModel2, loadSnapshot },
      { userId: learner.userId, envelope, learnerMessage: "And what about layering?" }
    );
    check("learner turn 2 REUSES the same thread", turn2.threadId === turn1.threadId, JSON.stringify({ t1: turn1.threadId, t2: turn2.threadId }));
    const threadCount = await admin
      .from("tutor_threads")
      .select("id", { count: "exact", head: true })
      .eq("user_id", learner.userId)
      .eq("course_id", courseId);
    check("exactly ONE thread exists for (learner, course)", (threadCount.count ?? 0) === 1, String(threadCount.count));

    /* ═══════════════════════ AC-W3R.2 — abort is resumable ═══════════════════ */
    console.log("\n# AC-W3R.2 — an already-aborted signal frees the pool, persists nothing, then resumes");

    const learnerPool = poolFor("learner");
    const inferenceBeforeAbort = await countEvents(admin, learner.userId, courseId, "tutor_inference");
    const assistantRowsBeforeAbort = await admin
      .from("tutor_turns")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", turn1.threadId!)
      .eq("role", "assistant");

    const abortController = new AbortController();
    abortController.abort(); // already aborted BEFORE the call
    const abortModel = withPooledModel(
      createMockModelClient([], { structured: scriptedTurnOutput(nodeId, 2, citation) }),
      { pool: learnerPool }
    );
    const abortedTurn = await runTutorTurnForRequest(
      { learnerClient: learner.client, admin, model: abortModel, signal: abortController.signal, loadSnapshot },
      { userId: learner.userId, envelope, learnerMessage: "This one is cancelled before it starts." }
    );
    // The pooled acquire rejects AbortError → the loop settles ok:false with no
    // assistant persistence. (The learner turn IS written — it's real — but NO
    // assistant row + NO evidence.)
    check("an already-aborted turn settles NOT-ok (no output)",
      abortedTurn.turn !== null && abortedTurn.turn.ok === false && abortedTurn.persistedTurnIds.assistant === null,
      JSON.stringify({ ok: abortedTurn.turn?.ok, error: abortedTurn.turn?.error }));

    const inferenceAfterAbort = await countEvents(admin, learner.userId, courseId, "tutor_inference");
    check("the aborted turn added NO evidence rows", inferenceAfterAbort === inferenceBeforeAbort, JSON.stringify({ before: inferenceBeforeAbort, after: inferenceAfterAbort }));

    const assistantRowsAfterAbort = await admin
      .from("tutor_turns")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", turn1.threadId!)
      .eq("role", "assistant");
    check("the aborted turn added NO assistant row",
      (assistantRowsAfterAbort.count ?? 0) === (assistantRowsBeforeAbort.count ?? 0),
      JSON.stringify({ before: assistantRowsBeforeAbort.count, after: assistantRowsAfterAbort.count }));

    check("the learner pool is CLEAN after the abort (inFlight===0 && queued===0)",
      learnerPool.inFlight === 0 && learnerPool.queued === 0,
      JSON.stringify({ inFlight: learnerPool.inFlight, queued: learnerPool.queued }));

    // A fresh call on the SAME thread succeeds (resumable).
    const resumeModel = withPooledModel(
      createMockModelClient([], { structured: scriptedTurnOutput(nodeId, 2, citation) }),
      { pool: learnerPool }
    );
    const resumeTurn = await runTutorTurnForRequest(
      { learnerClient: learner.client, admin, model: resumeModel, loadSnapshot },
      { userId: learner.userId, envelope, learnerMessage: "Now retry the same thread." }
    );
    check("a fresh call on the SAME thread succeeds after the abort (resumable)",
      resumeTurn.turn?.ok === true && resumeTurn.threadId === turn1.threadId && resumeTurn.persistedTurnIds.assistant !== null,
      JSON.stringify({ ok: resumeTurn.turn?.ok, sameThread: resumeTurn.threadId === turn1.threadId }));

    /* ═══════════════════════ AC-W3R.3 — evidence → mastery ═══════════════════ */
    console.log("\n# AC-W3R.3 — recordPracticeAnswer → practice_answer → refold + writeMastery → learner_mastery");

    const practiceItemRef = newRowId();
    const rec1 = await recordPracticeAnswer(admin, {
      access: learnerAccess,
      userId: learner.userId,
      envelope,
      nodeId,
      practiceItemRef,
      attemptOrdinal: 1,
      evidenceCorrect: true,
    });
    check("recordPracticeAnswer (learner, correct, ordinal 1) emitted", rec1.emitted === true);

    const practiceRow = await admin
      .from("learning_events")
      .select("event_type, node_id, evidence_correct, attempt_ordinal, practice_item_ref")
      .eq("user_id", learner.userId)
      .eq("course_id", courseId)
      .eq("event_type", "practice_answer")
      .single();
    check("a practice_answer row exists with typed columns (node/correct/ordinal/ref)",
      !practiceRow.error &&
        practiceRow.data?.node_id === nodeId &&
        practiceRow.data?.evidence_correct === true &&
        practiceRow.data?.attempt_ordinal === 1 &&
        practiceRow.data?.practice_item_ref === practiceItemRef,
      String(practiceRow.error?.message ?? JSON.stringify(practiceRow.data)));

    // Refold + write mastery (the Inngest refold's synchronous core).
    const nowIso = new Date().toISOString();
    const refold = await refoldLearnerCourse(admin, { userId: learner.userId, courseId, nowIso });
    check("refoldLearnerCourse returns ≥1 evidence + ≥1 mastery row", refold.evidenceCount >= 1 && refold.rows.length >= 1,
      JSON.stringify({ evidence: refold.evidenceCount, rows: refold.rows.length }));
    await writeMastery(admin, { userId: learner.userId, courseId, rows: refold.rows, nowIso });

    const masteryRow = await admin
      .from("learner_mastery")
      .select("node_id, p_learned")
      .eq("user_id", learner.userId)
      .eq("course_id", courseId)
      .eq("node_id", nodeId)
      .maybeSingle();
    check("a learner_mastery row exists for the node", !masteryRow.error && masteryRow.data?.node_id === nodeId,
      String(masteryRow.error?.message ?? "no row"));

    const masteryCountBefore = await admin
      .from("learner_mastery")
      .select("node_id", { count: "exact", head: true })
      .eq("user_id", learner.userId)
      .eq("course_id", courseId);

    // Double-call with the SAME ids → the deterministic clientEventId makes the
    // event a no-op; a re-refold + re-write is idempotent → the row count is stable.
    const rec2 = await recordPracticeAnswer(admin, {
      access: learnerAccess,
      userId: learner.userId,
      envelope,
      nodeId,
      practiceItemRef,
      attemptOrdinal: 1,
      evidenceCorrect: true,
    });
    check("a second recordPracticeAnswer with the SAME ids still reports emitted (idempotent upsert)", rec2.emitted === true);
    const practiceCountAfter = await countEvents(admin, learner.userId, courseId, "practice_answer");
    check("the practice_answer row count is STILL 1 (deterministic id → no-op upsert)", practiceCountAfter === 1, String(practiceCountAfter));

    const refold2 = await refoldLearnerCourse(admin, { userId: learner.userId, courseId, nowIso });
    await writeMastery(admin, { userId: learner.userId, courseId, rows: refold2.rows, nowIso });
    const masteryCountAfter = await admin
      .from("learner_mastery")
      .select("node_id", { count: "exact", head: true })
      .eq("user_id", learner.userId)
      .eq("course_id", courseId);
    check("the learner_mastery row count is STABLE across the double-call",
      (masteryCountAfter.count ?? -1) === (masteryCountBefore.count ?? -2),
      JSON.stringify({ before: masteryCountBefore.count, after: masteryCountAfter.count }));

    // An author-gated recordPracticeAnswer writes ZERO rows.
    const authorPractice2 = await recordPracticeAnswer(admin, {
      access: authorAccess,
      userId: author.userId,
      envelope,
      nodeId,
      practiceItemRef: newRowId(),
      attemptOrdinal: 1,
      evidenceCorrect: true,
    });
    const authorPracticeRows = await countEvents(admin, author.userId, courseId, "practice_answer");
    check("an author-gated recordPracticeAnswer writes ZERO practice rows",
      authorPractice2.emitted === false && authorPracticeRows === 0,
      JSON.stringify({ emitted: authorPractice2.emitted, rows: authorPracticeRows }));
  } finally {
    await cleanup();
    console.log("\n# cleaned up course + tutor rows (throwaway users remain — clean in Supabase → Auth)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
