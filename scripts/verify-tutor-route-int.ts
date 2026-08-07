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
 *   A3 Wave 3 (invocation policy, mock-model end-to-end on a FRESH learner):
 *     (a) a scripted generate_practice call on a QUESTION turn → the tool is
 *         NOT executed (no tutor_practice_gen model call), the turn settles
 *         with ONE invitation + zero practiceItems, tutor_tool_downgraded is
 *         logged, and the assistant grounding stamps the offered invitation;
 *     (b) a second turn CLAIMING acceptance of that invitation → the tool
 *         EXECUTES, items land in the payload, invitation null, and the
 *         learner row's grounding stamps the acceptance;
 *     (c) "Quiz me on this lesson" (the chip) → SERVER-derived
 *         practice_request: direct execution, no invitation;
 *     (d) two consecutively-IGNORED invitations → the third question turn with
 *         a practice attach settles with NO invitation (the two-ignore
 *         cooldown, counted including the offer the current message resolves);
 *     (e) an acceptance claim NOT matching the prior invitation (stale — the
 *         prior assistant turn carries none) → treated as question: the
 *         Class-A call is downgraded, never executed.
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
import { withPooledModel, poolFor, runStructuredCall } from "@/lib/ai/subagent";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import {
  ExplainBackGradeSchema,
  outcomeFromExplainBackGrade,
  type FadedExampleCard,
} from "@/lib/tutor/runtime/toolsA3";
import { refoldLearnerCourse } from "@/lib/tutor/mastery/loader";
import { writeMastery } from "@/lib/tutor/mastery/writer";
import {
  resolveTutorAccess,
  runTutorTurnForRequest,
  recordPracticeAnswer,
  type TurnEnvelope,
} from "@/lib/tutor/runtime/service";
import { recordToolEvidence } from "@/lib/tutor/runtime/evidenceRecord";

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

    /* ═══════ A3 Wave 3 — invocation policy: the three paths end-to-end ═══════ */
    console.log("\n# A3 Wave 3 — invocation policy (downgrade / acceptance / practice_request / cooldown / stale claim)");

    // A FRESH learner isolates the invitation lifecycle from the turns above.
    const learner2 = await provisionUser(url, anon, "learner2");
    const enrolled2 = await learner2.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: learner2.userId })
      .select("*")
      .single();
    check("second learner self-enrolls", !enrolled2.error, String(enrolled2.error?.message));

    /** A grounded, resolving turn output; `practiceItems` optionally attached
     *  (the model "imposing" practice — the exact §4-banned behavior on (a)/(d)). */
    const groundedOutput = (practiceItems?: unknown[]) =>
      JSON.stringify({
        proseWithSpanMarkers: "⟦g⟧A wash stays transparent when the binder holds little pigment.⟦/g⟧",
        citations: [citation],
        rung: 2,
        evidence: [],
        ...(practiceItems ? { practiceItems } : {}),
      });
    const practiceGenJson = JSON.stringify({
      items: [{ nodeId, kind: "mc", prompt: "Where does the pigment sit?", choices: ["a", "b", "c", "d"], correctChoiceIndex: 0, explanation: "In the wash." }],
    });
    const echoedItem = {
      nodeId,
      practiceItemRef: "echo-ref-1",
      kind: "mc",
      prompt: "Where does the pigment sit?",
      choices: ["a", "b", "c", "d"],
      correctChoiceIndex: 0,
      acceptedAnswers: null,
      explanation: "In the wash.",
      itemBankRef: null,
    };

    // (a) QUESTION turn + a scripted generate_practice call → NOT executed;
    //     downgraded to ONE invitation; the assistant grounding stamps it. The
    //     structured map DOES carry tutor_practice_gen, so a wrongly-executed
    //     tool would SUCCEED — non-execution is proven by the call's absence.
    const modelA3a = createMockModelClient(
      [
        { toolCalls: [{ name: "generate_practice", arguments: { nodeIds: [nodeId] } }] },
        { text: groundedOutput() },
      ],
      { structured: { tutor_practice_gen: practiceGenJson } }
    );
    const logsA3: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logsA3.push(a.map(String).join(" ")); };
    let turnA3a!: Awaited<ReturnType<typeof runTutorTurnForRequest>>;
    try {
      turnA3a = await runTutorTurnForRequest(
        { learnerClient: learner2.client, admin, model: withPooledModel(modelA3a, { pool: poolFor("learner") }), loadSnapshot },
        { userId: learner2.userId, envelope, learnerMessage: "Why does the wash stay transparent?" }
      );
    } finally {
      console.log = origLog;
    }
    check("(a) question turn settles ok", turnA3a.turn?.ok === true, JSON.stringify({ ok: turnA3a.turn?.ok, err: turnA3a.turn?.error }));
    check("(a) generate_practice NOT executed (no tutor_practice_gen model call)",
      modelA3a.getCalls().every((c) => c.responseFormat?.name !== "tutor_practice_gen"),
      modelA3a.getCalls().map((c) => c.responseFormat?.name ?? "-").join(","));
    check("(a) the turn surfaces ONE invitation {generate_practice, node, label}",
      turnA3a.turn?.invitation?.toolName === "generate_practice" &&
        turnA3a.turn?.invitation?.nodeId === nodeId &&
        turnA3a.turn?.invitation?.label === "Try a practice problem",
      JSON.stringify(turnA3a.turn?.invitation ?? null));
    check("(a) zero practiceItems in the settled output + side channel",
      (turnA3a.turn?.output?.practiceItems?.length ?? 0) === 0 && (turnA3a.turn?.practiceItems.length ?? 0) === 0);
    check("(a) tutor_tool_downgraded logged",
      logsA3.some((l) => l.includes('"tag":"tutor_tool_downgraded"') && l.includes(nodeId)),
      logsA3.filter((l) => l.includes("tutor_tool_downgraded")).join(" | "));
    const rowA3Asst = await admin.from("tutor_turns").select("grounding").eq("id", turnA3a.persistedTurnIds.assistant!).single();
    const invStamp = (rowA3Asst.data?.grounding as Record<string, unknown> | null)?.invitation as Record<string, unknown> | undefined;
    check("(a) assistant grounding stamps the offered invitation (the offered-marker)",
      invStamp?.toolName === "generate_practice" && invStamp?.nodeId === nodeId,
      JSON.stringify(invStamp ?? null));
    const rowA3Lrn = await admin.from("tutor_turns").select("grounding").eq("id", turnA3a.persistedTurnIds.learner!).single();
    check("(a) learner grounding carries NO initiation (question rows stay lean)",
      !(rowA3Lrn.data?.grounding as Record<string, unknown> | null)?.initiation);

    // (b) The learner PRESSES the invitation: a claim matching the stored offer
    //     → the tool EXECUTES, items render, invitation null.
    const modelA3b = createMockModelClient(
      [
        { toolCalls: [{ name: "generate_practice", arguments: { nodeIds: [nodeId] } }] },
        { text: groundedOutput([echoedItem]) },
      ],
      { structured: { tutor_practice_gen: practiceGenJson } }
    );
    const turnA3b = await runTutorTurnForRequest(
      { learnerClient: learner2.client, admin, model: withPooledModel(modelA3b, { pool: poolFor("learner") }), loadSnapshot },
      {
        userId: learner2.userId,
        envelope,
        learnerMessage: "Yes — try a practice problem.",
        initiation: { kind: "invitation_accepted", toolName: "generate_practice", nodeId },
      }
    );
    check("(b) acceptance turn ok", turnA3b.turn?.ok === true, JSON.stringify({ ok: turnA3b.turn?.ok, err: turnA3b.turn?.error }));
    check("(b) generate_practice EXECUTED (tutor_practice_gen model call made)",
      modelA3b.getCalls().some((c) => c.responseFormat?.name === "tutor_practice_gen"));
    check("(b) items in the settled payload + minted side channel",
      (turnA3b.turn?.output?.practiceItems?.length ?? 0) === 1 && (turnA3b.turn?.practiceItems.length ?? 0) === 1,
      JSON.stringify({ out: turnA3b.turn?.output?.practiceItems?.length, minted: turnA3b.turn?.practiceItems.length }));
    check("(b) invitation null on the delivery turn", (turnA3b.turn?.invitation ?? null) === null);
    const rowB3Lrn = await admin.from("tutor_turns").select("grounding").eq("id", turnA3b.persistedTurnIds.learner!).single();
    const initB3 = (rowB3Lrn.data?.grounding as Record<string, unknown> | null)?.initiation as Record<string, unknown> | undefined;
    check("(b) learner grounding stamps the acceptance initiation",
      initB3?.kind === "invitation_accepted" && initB3?.nodeId === nodeId,
      JSON.stringify(initB3 ?? null));

    // (c) "Quiz me on this lesson" (the suggestion chip) → SERVER-derived
    //     practice_request: direct execution, no invitation.
    const modelA3c = createMockModelClient(
      [
        { toolCalls: [{ name: "generate_practice", arguments: { nodeIds: [nodeId] } }] },
        { text: groundedOutput([echoedItem]) },
      ],
      { structured: { tutor_practice_gen: practiceGenJson } }
    );
    const turnA3c = await runTutorTurnForRequest(
      { learnerClient: learner2.client, admin, model: withPooledModel(modelA3c, { pool: poolFor("learner") }), loadSnapshot },
      { userId: learner2.userId, envelope, learnerMessage: "Quiz me on this lesson" }
    );
    check("(c) practice_request turn ok + tool EXECUTED",
      turnA3c.turn?.ok === true && modelA3c.getCalls().some((c) => c.responseFormat?.name === "tutor_practice_gen"),
      JSON.stringify({ ok: turnA3c.turn?.ok, err: turnA3c.turn?.error }));
    check("(c) items render, invitation null",
      (turnA3c.turn?.output?.practiceItems?.length ?? 0) === 1 && (turnA3c.turn?.invitation ?? null) === null);
    const rowC3Lrn = await admin.from("tutor_turns").select("grounding").eq("id", turnA3c.persistedTurnIds.learner!).single();
    check("(c) learner grounding stamps practice_request",
      ((rowC3Lrn.data?.grounding as Record<string, unknown> | null)?.initiation as Record<string, unknown> | undefined)?.kind === "practice_request");

    // (d) COOLDOWN: two consecutively-ignored invitations → the third question
    //     turn with a practice attach settles with NO invitation. Each turn's
    //     model attaches practiceItems in the OUTPUT (no tool call); each strip
    //     offers an invitation until the second brush-off activates the cooldown
    //     (the count includes the pending offer the current message resolves).
    const questionAttachTurn = async (msg: string) => {
      const model = createMockModelClient([], {
        structured: { tutor_turn_output: groundedOutput([echoedItem]) },
      });
      return runTutorTurnForRequest(
        { learnerClient: learner2.client, admin, model: withPooledModel(model, { pool: poolFor("learner") }), loadSnapshot },
        { userId: learner2.userId, envelope, learnerMessage: msg }
      );
    };
    const d1 = await questionAttachTurn("What about layering?");
    check("(d1) first question attach → stripped + invitation OFFERED",
      (d1.turn?.output?.practiceItems?.length ?? 0) === 0 && d1.turn?.invitation != null,
      JSON.stringify(d1.turn?.invitation ?? null));
    const d2 = await questionAttachTurn("And glazing?");
    check("(d2) second question attach (first offer ignored) → invitation OFFERED again",
      (d2.turn?.output?.practiceItems?.length ?? 0) === 0 && d2.turn?.invitation != null,
      JSON.stringify(d2.turn?.invitation ?? null));
    const d3 = await questionAttachTurn("And drybrush?");
    check("(d3) third question attach after TWO ignored offers → NO invitation (cooldown)",
      (d3.turn?.output?.practiceItems?.length ?? 0) === 0 && (d3.turn?.invitation ?? null) === null,
      JSON.stringify(d3.turn?.invitation ?? null));

    // (e) A stale acceptance claim — the prior assistant turn (d3's) carries NO
    //     invitation — is treated as QUESTION: the Class-A call is downgraded,
    //     never executed, and the learner row stays lean.
    const modelA3e = createMockModelClient(
      [
        { toolCalls: [{ name: "generate_practice", arguments: { nodeIds: [nodeId] } }] },
        { text: groundedOutput() },
      ],
      { structured: { tutor_practice_gen: practiceGenJson } }
    );
    const turnA3e = await runTutorTurnForRequest(
      { learnerClient: learner2.client, admin, model: withPooledModel(modelA3e, { pool: poolFor("learner") }), loadSnapshot },
      {
        userId: learner2.userId,
        envelope,
        learnerMessage: "Accepting that old invitation now.",
        initiation: { kind: "invitation_accepted", toolName: "generate_practice", nodeId },
      }
    );
    check("(e) stale acceptance claim → treated as question (tool NOT executed)",
      modelA3e.getCalls().every((c) => c.responseFormat?.name !== "tutor_practice_gen"),
      modelA3e.getCalls().map((c) => c.responseFormat?.name ?? "-").join(","));
    check("(e) turn still settles ok (downgraded, never blocked)",
      turnA3e.turn?.ok === true, JSON.stringify({ ok: turnA3e.turn?.ok, err: turnA3e.turn?.error }));
    const rowE3Lrn = await admin.from("tutor_turns").select("grounding").eq("id", turnA3e.persistedTurnIds.learner!).single();
    check("(e) learner grounding lean (the invalid claim resolved to question)",
      !(rowE3Lrn.data?.grounding as Record<string, unknown> | null)?.initiation);

    /* ═══════ A3 Wave 4 — checkUnderstanding + tool_evidence + renderStructure ═══ */
    console.log("\n# A3 Wave 4 — checkUnderstanding assessment → tool_evidence → tutor_evidence_recorded; renderStructure on a question turn");

    // A FRESH learner isolates the assessment lifecycle.
    const learner4 = await provisionUser(url, anon, "learner4");
    const enrolled4 = await learner4.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: learner4.userId })
      .select("*")
      .single();
    check("W4 learner self-enrolls", !enrolled4.error, String(enrolled4.error?.message));

    // (f) A practice_request turn ("Quiz me on this lesson") that SCRIPTS a
    //     checkUnderstanding tool call with a misconception-labeled distractor →
    //     the tool EXECUTES (practice_request is a delivery path), the card lands
    //     on turn.assessments with its answer key + misconceptions.
    const checkArgs = {
      conceptSlug: nodeId,
      stem: "Why does a wash stay transparent?",
      options: [
        { id: "a", text: "Little pigment in the binder", correct: true, feedback: "Right — the binder stays clear." },
        { id: "b", text: "The paper repels water", correct: false, misconceptionId: "paper-repels-water", feedback: "It's about pigment load, not the paper." },
        { id: "c", text: "The brush is dry", correct: false, misconceptionId: "drybrush-transparency", feedback: "Drybrush is a different technique." },
      ],
    };
    const modelW4f = createMockModelClient(
      [
        { toolCalls: [{ name: "checkUnderstanding", arguments: checkArgs }] },
        { text: groundedOutput() },
      ],
      {}
    );
    const turnW4f = await runTutorTurnForRequest(
      { learnerClient: learner4.client, admin, model: withPooledModel(modelW4f, { pool: poolFor("learner") }), loadSnapshot },
      { userId: learner4.userId, envelope, learnerMessage: "Quiz me on this lesson" }
    );
    check("(f) practice_request turn ok + checkUnderstanding executed", turnW4f.turn?.ok === true, JSON.stringify({ ok: turnW4f.turn?.ok, err: turnW4f.turn?.error }));
    const w4Assessments = turnW4f.turn?.assessments ?? [];
    const w4Card = w4Assessments[0] as { cardId: string; toolName: string; conceptSlug: string; initiation: string; options: { id: string; correct: boolean; misconceptionId: string | null }[] } | undefined;
    check("(f) the assessment card rides turn.assessments (checkUnderstanding, key + misconceptions)",
      w4Assessments.length === 1 &&
        w4Card?.toolName === "checkUnderstanding" &&
        w4Card?.conceptSlug === nodeId &&
        w4Card?.initiation === "practice_request" &&
        w4Card?.options.find((o) => o.id === "b")?.misconceptionId === "paper-repels-water" &&
        w4Card?.options.find((o) => o.id === "a")?.misconceptionId === null,
      JSON.stringify(w4Card ?? null));
    check("(f) a question-turn assessment is NEVER imposed — invitation null on this delivery turn", (turnW4f.turn?.invitation ?? null) === null);

    // The learner COMPLETES the card by selecting the wrong option (b) → the route's
    // tool_evidence handler. This suite drives the SERVICE, so it mirrors the route
    // handler exactly: recordToolEvidence with completionKey = "toolcard:" + cardId.
    const cardId = w4Card!.cardId;
    const evBefore = await countEvents(admin, learner4.userId, courseId, "tutor_evidence_recorded");
    const rec = await recordToolEvidence(admin, {
      courseId,
      publicationId: publication.id,
      version: publication.version,
      lessonId: envelope.lessonId ?? null,
      userId: learner4.userId,
      conceptSlug: nodeId,
      toolName: "checkUnderstanding",
      outcome: "not_demonstrated",
      misconceptionSlug: "paper-repels-water",
      confidence: "unsure",
      fadeLevel: null,
      initiation: "practice_request",
      itemSource: "generated",
      reviewedItemId: null,
      latencyMs: 4200,
      completionKey: `toolcard:${cardId}`,
    });
    check("(f) tool_evidence recorded", rec.recorded === true, JSON.stringify(rec));
    const evAfter = await countEvents(admin, learner4.userId, courseId, "tutor_evidence_recorded");
    check("(f) exactly ONE tutor_evidence_recorded row was appended", evAfter - evBefore === 1, JSON.stringify({ before: evBefore, after: evAfter }));

    const evRow = await admin
      .from("learning_events")
      .select("event_type, node_id, tool_name, outcome, misconception_slug, initiation")
      .eq("user_id", learner4.userId)
      .eq("course_id", courseId)
      .eq("event_type", "tutor_evidence_recorded")
      .single();
    check("(f) the row carries outcome + misconception + toolName + node",
      !evRow.error &&
        evRow.data?.node_id === nodeId &&
        evRow.data?.tool_name === "checkUnderstanding" &&
        evRow.data?.outcome === "not_demonstrated" &&
        evRow.data?.misconception_slug === "paper-repels-water" &&
        evRow.data?.initiation === "practice_request",
      String(evRow.error?.message ?? JSON.stringify(evRow.data)));

    // Idempotent: re-POSTing the SAME card (same completionKey) is a no-op.
    const recDup = await recordToolEvidence(admin, {
      courseId, publicationId: publication.id, version: publication.version, lessonId: envelope.lessonId ?? null,
      userId: learner4.userId, conceptSlug: nodeId, toolName: "checkUnderstanding", outcome: "not_demonstrated",
      misconceptionSlug: "paper-repels-water", confidence: "unsure", fadeLevel: null, initiation: "practice_request",
      itemSource: "generated", reviewedItemId: null, latencyMs: 4200, completionKey: `toolcard:${cardId}`,
    });
    const evAfterDup = await countEvents(admin, learner4.userId, courseId, "tutor_evidence_recorded");
    check("(f) a re-POST of the same card is a no-op (deterministic completionKey)", recDup.recorded === true && evAfterDup - evBefore === 1, JSON.stringify({ after: evAfterDup }));

    // An author-preview tool_evidence would no-op at the route (access gate). The
    // route no-ops BEFORE recordToolEvidence; assert the gate.
    const authorW4Access = await resolveTutorAccess(admin, { userId: author.userId, courseId });
    check("(f) an author-preview caller is gated (route no-ops before recordToolEvidence)", authorW4Access.kind === "author_preview");

    // (g) A renderStructure call on a QUESTION turn → the structure rides
    //     turn.structures, there is NO assessment, and NO evidence is emitted.
    const evBeforeG = await countEvents(admin, learner4.userId, courseId, "tutor_evidence_recorded");
    const modelW4g = createMockModelClient(
      [
        { toolCalls: [{ name: "renderStructure", arguments: { kind: "tree", title: "Layers", tree: { root: { label: "wash", children: [{ label: "glaze" }, { label: "drybrush" }] } } } }] },
        { text: groundedOutput() },
      ],
      {}
    );
    const turnW4g = await runTutorTurnForRequest(
      { learnerClient: learner4.client, admin, model: withPooledModel(modelW4g, { pool: poolFor("learner") }), loadSnapshot },
      { userId: learner4.userId, envelope, learnerMessage: "Show me how the layers relate" }
    );
    check("(g) question turn ok + a structure rides turn.structures", turnW4g.turn?.ok === true && (turnW4g.turn?.structures.length ?? 0) === 1, JSON.stringify({ ok: turnW4g.turn?.ok, n: turnW4g.turn?.structures.length, err: turnW4g.turn?.error }));
    check("(g) the built structure is a tree_diagram", turnW4g.turn?.structures[0]?.diagram?.kind === "tree_diagram");
    check("(g) NO assessment on a renderStructure turn", (turnW4g.turn?.assessments.length ?? -1) === 0);
    const evAfterG = await countEvents(admin, learner4.userId, courseId, "tutor_evidence_recorded");
    check("(g) renderStructure emits NO tool evidence", evAfterG - evBeforeG === 0, JSON.stringify({ before: evBeforeG, after: evAfterG }));

    /* ═══════ A3 Wave 5 — fadedExample (mastery-derived fade) + explain_back_grade ═══ */
    console.log("\n# A3 Wave 5 — fadedExample fadeLevel from seeded mastery; explain_back_grade → criteria + one tutor_evidence_recorded");

    // (h) Seed HIGH mastery on the concept, then ACCEPT a fadedExample invitation:
    //     the loop threads masteryByNode from learner_mastery → fadeLevel 3.
    const nowIsoW5 = new Date().toISOString();
    const seedMastery = await admin
      .from("learner_mastery" as never)
      .upsert(
        [
          {
            user_id: learner4.userId,
            course_id: courseId,
            node_id: nodeId,
            p_learned: 0.9,
            decayed_p: 0.9,
            evidence_count: 5,
            last_positive_at: nowIsoW5,
            computed_at: nowIsoW5,
          },
        ] as never,
        { onConflict: "user_id,course_id,node_id" } as never
      );
    check("(h) seeded high mastery (decayed_p 0.9) on the concept", !(seedMastery as { error: unknown }).error, JSON.stringify((seedMastery as { error: { message?: string } }).error ?? null));

    const fadedArgs = {
      conceptSlug: nodeId,
      title: "A worked wash",
      problem: "Lay a graded wash from dark to light.",
      steps: [
        { text: "Load the brush", answer: "heavy pigment" },
        { text: "First stroke at the top", answer: "darkest band" },
        { text: "Dilute and continue", answer: "lighter bands" },
        { text: "Finish at the bottom", answer: "near-clear" },
      ],
    };
    const modelW5h = createMockModelClient(
      [
        { toolCalls: [{ name: "fadedExample", arguments: fadedArgs }] },
        { text: groundedOutput() },
      ],
      {}
    );
    // Deliver via the practice_request path (a "let me try one" message the
    // classifier catches) — a bare invitation_accepted CLAIM would be stale here
    // (learner4 has no prior offered invitation in this thread), so it correctly
    // falls to `question` and the Class-A call downgrades to an invitation. The
    // practice_request path needs no prior offer (mirrors leg (c)/(f)).
    const turnW5h = await runTutorTurnForRequest(
      { learnerClient: learner4.client, admin, model: withPooledModel(modelW5h, { pool: poolFor("learner") }), loadSnapshot },
      {
        userId: learner4.userId,
        envelope,
        learnerMessage: "let me try one",
      }
    );
    check("(h) fadedExample acceptance turn ok", turnW5h.turn?.ok === true, JSON.stringify({ ok: turnW5h.turn?.ok, err: turnW5h.turn?.error }));
    const fadedCard = (turnW5h.turn?.assessments ?? [])[0] as FadedExampleCard | undefined;
    check(
      "(h) the fadedExample card rides turn.assessments with fadeLevel 3 (derived from seeded mastery, NOT the model)",
      (turnW5h.turn?.assessments.length ?? 0) === 1 &&
        fadedCard?.toolName === "fadedExample" &&
        fadedCard?.conceptSlug === nodeId &&
        fadedCard?.fadeLevel === 3 &&
        (fadedCard?.steps.every((s) => s.blanked) ?? false),
      JSON.stringify({ n: turnW5h.turn?.assessments.length, fade: fadedCard?.fadeLevel, blanked: fadedCard?.steps.map((s) => s.blanked) })
    );
    check("(h) every step ships its answer (blanked steps carry the key for local grading)", (fadedCard?.steps.every((s) => typeof s.answer === "string" && s.answer.length > 0) ?? false));

    // (i) explain_back_grade — mirror the ROUTE handler exactly (the suite drives the
    //     seam, not the HTTP layer): a POOLED structured model call (A3-20) grades
    //     rubric-criterion presence; the outcome maps to evidence; recordToolEvidence
    //     appends ONE tutor_evidence_recorded row (idempotent). The mock model returns
    //     a criteria verdict via the structured seam keyed by the outputName.
    const explainCardId = `explainback-${newRowId()}`;
    const explainRubric = [
      { criterion: "names supply and demand meeting", required: true },
      { criterion: "explains surplus/shortage pressure", required: false },
    ];
    const gradeJson = JSON.stringify({
      criteria: [
        { criterion: "names supply and demand meeting", present: true, note: "Clearly identified the crossing point." },
        { criterion: "explains surplus/shortage pressure", present: false, note: "Did not mention surplus or shortage." },
      ],
    });
    const baseGradeModel = createMockModelClient([], { structured: { tutor_explain_back_grade: gradeJson } });
    // A3-20 structural: the grade path uses withPooledModel (never a fresh unpooled
    // client) — wrap the mock exactly as the route does. The base mock records every
    // runTurn's params (getCalls), so we prove the pooled call carried the grading
    // responseFormat through the pool wrapper.
    const gradeModel = withPooledModel(baseGradeModel, { pool: poolFor("learner") });

    const evBeforeI = await countEvents(admin, learner4.userId, courseId, "tutor_evidence_recorded");
    const job = TUTOR_MODELS.practice_gen;
    const grade = await runStructuredCall(gradeModel, {
      system: "grade rubric presence",
      input: "RUBRIC:\n1. [required] names supply and demand meeting\n2. [optional] explains surplus/shortage pressure\n\nLEARNER EXPLANATION:\nPrice settles where the supply and demand curves cross.",
      outputName: "tutor_explain_back_grade",
      outputSchema: ExplainBackGradeSchema,
      model: job.model,
      effort: job.effort,
      timeoutMs: job.timeoutMs,
      maxRetries: job.maxRetries,
      maxOutputTokens: job.maxOutputTokens,
    });
    check(
      "(i) A3-20: the grade path ran a POOLED structured call (tutor_explain_back_grade through withPooledModel)",
      grade.ok === true && baseGradeModel.getCalls().some((c) => c.responseFormat?.name === "tutor_explain_back_grade"),
      JSON.stringify({ ok: grade.ok, used: baseGradeModel.getCalls().map((c) => c.responseFormat?.name ?? "-") })
    );
    const outcomeI = grade.ok && grade.data ? outcomeFromExplainBackGrade(explainRubric, grade.data) : "not_demonstrated";
    check("(i) outcome maps to demonstrated (the ONE required criterion present; a missing optional never blocks)", outcomeI === "demonstrated", outcomeI);

    const recI = await recordToolEvidence(admin, {
      courseId,
      publicationId: publication.id,
      version: publication.version,
      lessonId: envelope.lessonId ?? null,
      userId: learner4.userId,
      conceptSlug: nodeId,
      toolName: "explainBack",
      outcome: outcomeI,
      misconceptionSlug: null,
      confidence: null,
      fadeLevel: null,
      initiation: "practice_request",
      itemSource: "generated",
      reviewedItemId: null,
      latencyMs: 6100,
      completionKey: `toolcard:${explainCardId}`,
    });
    check("(i) explain_back_grade recorded evidence", recI.recorded === true, JSON.stringify(recI));
    const evAfterI = await countEvents(admin, learner4.userId, courseId, "tutor_evidence_recorded");
    check("(i) exactly ONE tutor_evidence_recorded row appended", evAfterI - evBeforeI === 1, JSON.stringify({ before: evBeforeI, after: evAfterI }));
    const explainRow = await admin
      .from("learning_events")
      .select("tool_name, outcome, misconception_slug, fade_level")
      .eq("user_id", learner4.userId)
      .eq("course_id", courseId)
      .eq("event_type", "tutor_evidence_recorded")
      .eq("tool_name", "explainBack")
      .single();
    check(
      "(i) the row is explainBack + the mapped outcome + null misconception/fadeLevel",
      !explainRow.error &&
        explainRow.data?.tool_name === "explainBack" &&
        explainRow.data?.outcome === outcomeI &&
        explainRow.data?.misconception_slug === null &&
        explainRow.data?.fade_level === null,
      String(explainRow.error?.message ?? JSON.stringify(explainRow.data))
    );
    // Idempotent replay: same completionKey → no new row.
    const recIDup = await recordToolEvidence(admin, {
      courseId, publicationId: publication.id, version: publication.version, lessonId: envelope.lessonId ?? null,
      userId: learner4.userId, conceptSlug: nodeId, toolName: "explainBack", outcome: outcomeI,
      misconceptionSlug: null, confidence: null, fadeLevel: null, initiation: "practice_request",
      itemSource: "generated", reviewedItemId: null, latencyMs: 6100, completionKey: `toolcard:${explainCardId}`,
    });
    const evAfterIDup = await countEvents(admin, learner4.userId, courseId, "tutor_evidence_recorded");
    check("(i) explain_back_grade replay is a no-op (deterministic completionKey)", recIDup.recorded === true && evAfterIDup - evBeforeI === 1, JSON.stringify({ after: evAfterIDup }));
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
