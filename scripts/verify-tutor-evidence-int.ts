/**
 * TUTOR-1 Wave 2 learning-evidence — INTEGRATION suite (live Supabase, no model
 * key). Self-provisions throwaway users each run. WRITE-ONLY in this package:
 * the orchestrator applies migrations 20260803110000/110100/110200 BEFORE
 * running it (record_quiz_attempt / quiz_attempt_detail / the mastery RPCs do
 * not exist until then). DO NOT run this before the migrations are applied.
 *
 * ── AMENDMENT A3 Wave 2 (evidence spine) — `a3EvidenceSpine()` below ─────────
 * A second, self-contained phase covering the A3 tool-evidence contract
 * (tutor_evidence_recorded + the tutor_misconceptions registry + the
 * tutor_misconception_rollup RPC). It requires the A3 Wave-2 migration AND
 * lib/tutor/runtime/evidenceRecord.ts (Builder C's half) — it dynamic-imports
 * that module so the ORIGINAL Wave-2 sections above stay runnable before C
 * lands. DO NOT run the A3 phase before the A3 migration is applied. Sections:
 *   • A3-21a exactly-one — recordToolEvidence writes exactly ONE
 *     learning_events row per completionKey; a replay writes ZERO new rows and
 *     still returns recorded:true.
 *   • A3-21b registry conflict — two CONCURRENT calls proposing the SAME new
 *     (node, slug) yield exactly ONE tutor_misconceptions row + the SAME
 *     misconceptionId; plus the R-3 restatement: a direct optimistic UPDATE
 *     with a stale version matches 0 rows.
 *   • A3-22 not-approval-gated — a table-touch spy over the admin client
 *     (only learning_events + tutor_misconceptions + concept_nodes reads) and
 *     the live leg: the row lands with ZERO agent_runs rows on the course.
 *   • Concept-graph path — unknown node → unknown_concept + zero rows; a
 *     merged node resolves to its survivor (event + registry); retired →
 *     unknown_concept.
 *   • RLS matrix — author SELECTs registry rows; stranger/learner read zero;
 *     NO client can insert/update/delete the registry.
 *   • Rollup RPC — a 5-learner misconception is returned, a 2-learner one is
 *     OMITTED; a sub-5 cohort returns NOTHING; non-authors are gated;
 *     cohort_size is correct.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) — grading writes
 * are service-role by design (record_quiz_attempt is granted to service_role
 * only).
 *
 * Coverage:
 *   • Fixture: throwaway author + learner + a published quiz (mc + ms + sa) —
 *     mirrors verify-learn-int's fixture builder.
 *   • Grade a 3-question attempt through the REAL quizService path →
 *     quiz_attempt_detail rows exist, match the grading result, and
 *     response_summary carries ONLY the learner's selections (no key material).
 *   • Detail idempotency: replay record_quiz_attempt with the SAME
 *     p_attempt/p_responses/p_detail (same attempt id) → the attempt row and the
 *     detail rows do NOT duplicate (on conflict do nothing over the triple; the
 *     attempt row is the same id).
 *   • Ordinal derivation: a scripted 3-attempt sequence → the (created_at, id)
 *     ordering yields 1/2/3 even when the read is shuffled.
 *   • RLS matrix: the learner reads own detail ONLY via my_quiz_detail (a direct
 *     table select returns zero rows); the author reads ZERO detail rows by any
 *     path; a stranger reads zero.
 *   • content_engagement ingests via the batch RPC as the learner (full
 *     envelope) and lands; practice_answer via the batch RPC is REJECTED with
 *     'server-only event type'.
 *   • my_review_queue + concept_mastery_aggregate are callable: the aggregate
 *     RAISES for a non-author and returns an empty (evidence-less) shape for the
 *     author; my_review_queue returns empty for the learner.
 *
 * Run (AFTER the migrations are applied): `npx tsx scripts/verify-tutor-evidence-int.ts`
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

import type { Database, Json } from "@/lib/database.types";
import {
  createBlock,
  createLesson,
  createModule,
  createQuestion,
  createSlide,
  newRowId,
} from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import type { CourseDocument, QuizBlock, SlideDeckBlock } from "@/lib/course/types";
import {
  parsePublicationSnapshot,
  resolveLivePublicationBySlug,
  type PublicationRow,
} from "@/lib/learn/resolve";
import { submitQuizAttempt } from "@/lib/learn/quizService";
// A3 Wave 2 (the frozen evidence-spine contract) — TYPE-ONLY import here; the
// runtime module is dynamic-imported inside a3EvidenceSpine() so the original
// Wave-2 sections stay runnable before that half lands.
import type { ToolEvidenceInput } from "@/lib/tutor/runtime/evidenceRecord";

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
): Promise<{ client: DB; userId: string }> {
  const email = `tutor-ev-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
  return { client, userId: data.user.id };
}

/** Fixture: one lesson with a deck (2 slides) + a quiz (mc + ms + sa). */
function makeDoc(courseId: string, ownerId: string, title: string) {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];

  const quiz = createBlock("quiz", 1) as QuizBlock;
  const mc = createQuestion("multiple_choice");
  if (mc.kind !== "multiple_choice") throw new Error("unreachable");
  mc.prompt = "Pick B.";
  mc.correctChoiceId = mc.choices[1].id;
  mc.explanation = "B was correct.";
  const ms = createQuestion("multi_select");
  if (ms.kind !== "multi_select") throw new Error("unreachable");
  ms.prompt = "Pick the first two.";
  ms.correctChoiceIds = [ms.choices[0].id, ms.choices[1].id];
  ms.explanation = "Both were needed.";
  const sa = createQuestion("short_answer");
  if (sa.kind !== "short_answer") throw new Error("unreachable");
  sa.prompt = "Name the curve.";
  sa.expectedAnswer = "Supply";
  sa.acceptedAnswers = ["the supply curve"];
  quiz.questions = [mc, ms, sa];

  const lessonA = createLesson("Lesson A", 0);
  lessonA.blocks = [deck, quiz];
  const mod = createModule("Foundations", 0);
  mod.lessons = [lessonA];

  const doc: CourseDocument = {
    id: courseId,
    title,
    description: "Tutor evidence integration fixture.",
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
  return { doc, deck, quiz, mc, ms, sa };
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
  if (!service) throw new Error("verify:tutor:evidence:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const student = await provisionUser(url, anon, "student");
  const outsider = await provisionUser(url, anon, "outsider");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  const courseId = newRowId();
  const fixture = makeDoc(courseId, author.userId, `Tutor evidence itest ${crypto.randomUUID().slice(0, 6)}`);
  const { doc, quiz, mc, ms, sa } = fixture;
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded course");

  const cleanup = async () => {
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ── publish + enroll ── */
    console.log("\n# publish + enroll");
    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    check("published v1 live", v1.publication.version === 1 && v1.publication.status === "live");
    const found = await resolveLivePublicationBySlug(student.client, v1.publication.slug);
    if (found.kind !== "found") throw new Error("publication not resolvable");
    const publication: PublicationRow = found.publication;
    const snapshot = parsePublicationSnapshot(publication);

    const enrolled = await student.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: student.userId })
      .select("*")
      .single();
    check("student self-enrolls", !enrolled.error);

    const pubForCall = { id: publication.id, version: publication.version, snapshot };
    const gradeOneCorrect = async () =>
      submitQuizAttempt(admin, {
        userId: student.userId,
        role: "student",
        courseId,
        publication: pubForCall,
        request: {
          publicationId: publication.id,
          blockId: quiz.id,
          responses: [
            { kind: "multiple_choice", questionId: mc.id, choiceId: mc.correctChoiceId },
            { kind: "multi_select", questionId: ms.id, choiceIds: ms.correctChoiceIds },
            { kind: "short_answer", questionId: sa.id, text: " supply " },
          ],
          startedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      });

    /* ── grade through the REAL quizService → detail rows ── */
    console.log("\n# grade a 3-question attempt (real quizService path)");
    const graded = await gradeOneCorrect();
    check("all three correct: 3/3", graded.score === 3 && graded.maxScore === 3);
    check("attempt 1 recorded", graded.attemptNumber === 1 && graded.attemptId !== null);
    const attemptId = graded.attemptId as string;

    const detail = await admin
      .from("quiz_attempt_detail")
      .select("*")
      .eq("attempt_id", attemptId)
      .order("question_id");
    const detailRows = detail.data ?? [];
    check("3 detail rows exist for the attempt", detailRows.length === 3);
    check(
      "detail denormalizes (user, course, publication, block)",
      detailRows.every(
        (r) =>
          r.user_id === student.userId &&
          r.course_id === courseId &&
          r.publication_id === publication.id &&
          r.block_id === quiz.id
      )
    );
    check(
      "detail correctness matches the grade (all correct)",
      detailRows.every((r) => r.correct === true)
    );
    // response_summary carries ONLY the learner's selections — never key material.
    const byQ = new Map(detailRows.map((r) => [r.question_id, r.response_summary as Record<string, unknown>]));
    check(
      "mc summary is the selected id only",
      JSON.stringify(byQ.get(mc.id)) === JSON.stringify({ selected: mc.correctChoiceId })
    );
    check(
      "ms summary is the selected id set only",
      JSON.stringify(byQ.get(ms.id)) === JSON.stringify({ selected: ms.correctChoiceIds })
    );
    check(
      "sa summary is the trimmed submitted text only",
      JSON.stringify(byQ.get(sa.id)) === JSON.stringify({ text: "supply" })
    );
    check(
      "no answer-key material anywhere in the detail rows",
      !/expectedAnswer|correctChoice|acceptedAnswers|explanation/i.test(JSON.stringify(detailRows))
    );

    /* ── detail idempotency: replay the EXACT payload ── */
    console.log("\n# detail idempotency (replay the exact attempt payload)");
    const detailPayload = detailRows.map((r) => ({
      question_id: r.question_id,
      correct: r.correct,
      response_summary: r.response_summary,
    }));
    const responsePayload = detailRows.map((r) => ({
      question_id: r.question_id,
      response: (r.response_summary as Json),
      correct: r.correct,
    }));
    const replay = await admin.rpc("record_quiz_attempt", {
      p_attempt: {
        id: attemptId, // the SAME attempt id → PK conflict → idempotent
        publication_id: publication.id,
        version: publication.version,
        course_id: courseId,
        block_id: quiz.id,
        user_id: student.userId,
        score: graded.score,
        max_score: graded.maxScore,
        started_at: new Date(Date.now() - 60_000).toISOString(),
        submitted_at: new Date().toISOString(),
      } as unknown as Json,
      p_responses: responsePayload as unknown as Json,
      p_detail: detailPayload as unknown as Json,
    });
    check("replay RPC succeeds", !replay.error, String(replay.error?.message));
    const replayResult = replay.data as { attempt_id: string; attempt_number: number } | null;
    check(
      "replay returns the SAME attempt (id + number), not a fresh one",
      replayResult?.attempt_id === attemptId && replayResult?.attempt_number === 1
    );
    const detailAfterReplay = await admin
      .from("quiz_attempt_detail")
      .select("id")
      .eq("attempt_id", attemptId);
    check(
      "replay did NOT duplicate detail rows (still 3)",
      (detailAfterReplay.data ?? []).length === 3
    );
    const attemptsAfterReplay = await admin
      .from("quiz_attempts")
      .select("id")
      .eq("user_id", student.userId)
      .eq("block_id", quiz.id);
    check(
      "replay did NOT create a second attempt row (still 1)",
      (attemptsAfterReplay.data ?? []).length === 1
    );

    /* ── ordinal derivation over a scripted 3-attempt sequence ── */
    console.log("\n# ordinal derivation (created_at, id) over 3 attempts");
    const a2 = await gradeOneCorrect();
    const a3 = await gradeOneCorrect();
    check("attempts number 1/2/3 in sequence", a2.attemptNumber === 2 && a3.attemptNumber === 3);
    // Read all detail rows for this learner+course and DERIVE the ordinal per
    // attempt by (created_at, id) — even when the read comes back shuffled.
    const allDetail = await admin
      .from("quiz_attempt_detail")
      .select("attempt_id, created_at, id")
      .eq("user_id", student.userId)
      .eq("course_id", courseId);
    const shuffled = [...(allDetail.data ?? [])].sort(() => Math.random() - 0.5);
    // Distinct attempts ordered by the first (created_at, id) row of each.
    const firstByAttempt = new Map<string, { created_at: string; id: string }>();
    for (const r of shuffled) {
      const prev = firstByAttempt.get(r.attempt_id);
      if (!prev || r.created_at < prev.created_at || (r.created_at === prev.created_at && r.id < prev.id)) {
        firstByAttempt.set(r.attempt_id, { created_at: r.created_at, id: r.id });
      }
    }
    const orderedAttempts = [...firstByAttempt.entries()].sort((x, y) =>
      x[1].created_at === y[1].created_at
        ? x[1].id.localeCompare(y[1].id)
        : x[1].created_at.localeCompare(y[1].created_at)
    );
    check(
      "3 distinct attempts recovered from shuffled detail",
      orderedAttempts.length === 3
    );
    check(
      "derived ordinal 1 = the first attempt id",
      orderedAttempts[0][0] === attemptId
    );
    check(
      "derived ordinal 3 = the third attempt id",
      orderedAttempts[2][0] === (a3.attemptId as string)
    );

    /* ── RLS matrix ── */
    console.log("\n# RLS matrix (strict regime)");
    const learnerDirect = await student.client
      .from("quiz_attempt_detail")
      .select("id")
      .eq("course_id", courseId);
    check(
      "learner direct select on quiz_attempt_detail returns ZERO rows",
      (learnerDirect.data ?? []).length === 0
    );
    const learnerRpc = await student.client.rpc("my_quiz_detail", { p_course_id: courseId });
    check(
      "learner reads own detail ONLY via my_quiz_detail (9 rows: 3 attempts × 3 q)",
      !learnerRpc.error && (learnerRpc.data ?? []).length === 9
    );
    check(
      "my_quiz_detail exposes selections only (no key material)",
      !/expectedAnswer|correctChoice|acceptedAnswers|explanation/i.test(JSON.stringify(learnerRpc.data))
    );
    const authorDirect = await author.client
      .from("quiz_attempt_detail")
      .select("id")
      .eq("course_id", courseId);
    check(
      "author reads ZERO detail rows by direct select (no author policy)",
      (authorDirect.data ?? []).length === 0
    );
    const authorRpc = await author.client.rpc("my_quiz_detail", { p_course_id: courseId });
    check(
      "author's own my_quiz_detail is empty (they took no attempts)",
      !authorRpc.error && (authorRpc.data ?? []).length === 0
    );
    const strangerDirect = await outsider.client
      .from("quiz_attempt_detail")
      .select("id")
      .eq("course_id", courseId);
    check("a stranger reads ZERO detail rows", (strangerDirect.data ?? []).length === 0);

    /* ── ingest RPC: content_engagement lands, practice_answer rejected ── */
    console.log("\n# ingest RPC (client-batch isolation)");
    const engageEvent = {
      client_event_id: crypto.randomUUID(),
      event_type: "content_engagement",
      publication_id: publication.id,
      version: publication.version,
      course_id: courseId,
      lesson_id: doc.modules[0].lessons[0].id,
      metadata: { signal: "rewatch" },
      client_ts: new Date().toISOString(),
    };
    const ingestOk = await student.client.rpc("ingest_learning_events", {
      p_events: [engageEvent] as unknown as Json,
    });
    check(
      "content_engagement ingests via the batch RPC (accepted count 1)",
      !ingestOk.error && ingestOk.data === 1,
      String(ingestOk.error?.message)
    );
    const landed = await admin
      .from("learning_events")
      .select("event_type, metadata, publication_id, version, lesson_id")
      .eq("client_event_id", engageEvent.client_event_id)
      .maybeSingle();
    check(
      "content_engagement landed with the full envelope + metadata signal",
      landed.data?.event_type === "content_engagement" &&
        landed.data?.publication_id === publication.id &&
        landed.data?.version === publication.version &&
        landed.data?.lesson_id === doc.modules[0].lessons[0].id &&
        JSON.stringify(landed.data?.metadata) === JSON.stringify({ signal: "rewatch" })
    );

    const practiceEvent = {
      client_event_id: crypto.randomUUID(),
      event_type: "practice_answer",
      publication_id: publication.id,
      version: publication.version,
      course_id: courseId,
      lesson_id: doc.modules[0].lessons[0].id,
      node_id: crypto.randomUUID(),
      attempt_ordinal: 1,
      evidence_correct: true,
      practice_item_ref: crypto.randomUUID(),
      client_ts: new Date().toISOString(),
    };
    const ingestRejected = await student.client.rpc("ingest_learning_events", {
      p_events: [practiceEvent] as unknown as Json,
    });
    check(
      "practice_answer via the batch RPC is REJECTED (server-only event type)",
      ingestRejected.error !== null &&
        /server-only event type/.test(ingestRejected.error?.message ?? "")
    );

    /* ── mastery read RPCs ── */
    console.log("\n# mastery read RPCs");
    const queue = await student.client.rpc("my_review_queue", { p_course_id: courseId });
    check(
      "my_review_queue is callable + empty (no evidence yet)",
      !queue.error && (queue.data ?? []).length === 0,
      String(queue.error?.message)
    );
    const aggAuthor = await author.client.rpc("concept_mastery_aggregate", { p_course_id: courseId });
    check(
      "concept_mastery_aggregate callable by the author + empty (no cohort data)",
      !aggAuthor.error && (aggAuthor.data ?? []).length === 0,
      String(aggAuthor.error?.message)
    );
    const aggStranger = await outsider.client.rpc("concept_mastery_aggregate", { p_course_id: courseId });
    check(
      "concept_mastery_aggregate RAISES for a non-author",
      aggStranger.error !== null && /not the course author/.test(aggStranger.error?.message ?? "")
    );
    const aggAnon = await student.client.rpc("concept_mastery_aggregate", { p_course_id: courseId });
    check(
      "concept_mastery_aggregate RAISES for a non-author learner too",
      aggAnon.error !== null && /not the course author/.test(aggAnon.error?.message ?? "")
    );
  } finally {
    await cleanup();
    console.log("\n# cleaned up course (throwaway users remain — clean in Supabase → Auth)");
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * AMENDMENT A3 Wave 2 — the evidence spine (tutor_evidence_recorded +
 * tutor_misconceptions + tutor_misconception_rollup). Self-contained phase:
 * own fixture, own users, own cleanup. Requires the A3 Wave-2 migration.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Untyped handles for A3 tables/columns not yet spliced into database.types. */
type AnyDB = SupabaseClient;
const untyped = (c: DB | AnyDB): AnyDB => c as unknown as AnyDB;
type RpcCaller = {
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
const rpcOf = (c: DB | AnyDB): RpcCaller => c as unknown as RpcCaller;

/** The frozen rollup row shape (snake_case on the wire). */
interface RollupRow {
  node_id: string;
  node_title: string;
  misconception_slug: string;
  learner_count: number;
  evidence_count: number;
  cohort_size: number;
}

async function a3EvidenceSpine() {
  console.log(
    "\n════════ A3 Wave 2 — evidence spine (tutor_evidence_recorded · registry · rollup) ════════"
  );
  // Dynamic import: the module is Builder C's half of the frozen contract.
  const { recordToolEvidence } = await import("@/lib/tutor/runtime/evidenceRecord");

  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("the A3 evidence-spine phase needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "a3-author");
  const learner = await provisionUser(url, anon, "a3-learner");
  const stranger = await provisionUser(url, anon, "a3-stranger");
  // Four extra learners for the ≥5-distinct-learner rollup seed (loop provision —
  // learning_events.user_id FKs auth.users, so fake uuids can't be inserted).
  const extras: Array<{ client: DB; userId: string }> = [];
  for (let i = 1; i <= 4; i++) extras.push(await provisionUser(url, anon, `a3-extra${i}`));

  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });
  // An UNAUTHENTICATED client (anon key, no session) for the gate check.
  const anonClient = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });

  const courseId = newRowId();
  const { doc } = makeDoc(courseId, author.userId, `Tutor A3 evidence itest ${crypto.randomUUID().slice(0, 6)}`);
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded A3 course");

  const cleanup = async () => {
    // Explicit fixture deletes (events by course, registry by course), then the
    // course cascade (modules/lessons/blocks/publications/enrollments/nodes).
    await admin.from("learning_events").delete().eq("course_id", courseId);
    await untyped(admin).from("tutor_misconceptions").delete().eq("course_id", courseId);
    await author.client.from("courses").delete().eq("id", courseId);
  };

  /** Count the course's tutor_evidence_recorded rows. */
  const countEvidence = async (): Promise<number> => {
    const { count, error } = await admin
      .from("learning_events")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId)
      .eq("event_type", "tutor_evidence_recorded");
    if (error) throw new Error(`countEvidence: ${error.message}`);
    return count ?? 0;
  };

  /** Registry rows for (course [, node [, slug]]). */
  const registryRows = async (
    nodeId?: string,
    slug?: string
  ): Promise<Array<{ id: string; node_id: string; slug: string; version: number }>> => {
    let q = untyped(admin)
      .from("tutor_misconceptions")
      .select("id, node_id, slug, version")
      .eq("course_id", courseId);
    if (nodeId) q = q.eq("node_id", nodeId);
    if (slug) q = q.eq("slug", slug);
    const { data, error } = await q;
    if (error) throw new Error(`registryRows: ${error.message}`);
    return (data ?? []) as Array<{ id: string; node_id: string; slug: string; version: number }>;
  };

  try {
    /* ── publish + enroll the primary learner ── */
    console.log("\n# A3 fixture — publish + enroll + concept nodes");
    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    check("A3 course published live", v1.publication.version === 1 && v1.publication.status === "live");
    const found = await resolveLivePublicationBySlug(learner.client, v1.publication.slug);
    if (found.kind !== "found") throw new Error("A3 publication not resolvable");
    const publication: PublicationRow = found.publication;
    const lessonId = doc.modules[0].lessons[0].id;

    const enrolled = await learner.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: learner.userId })
      .select("*")
      .single();
    check("A3 primary learner self-enrolls", !enrolled.error, String(enrolled.error?.message));

    // Concept nodes: two active, one merged into a survivor, one retired.
    const nodeHash = crypto.randomUUID(); // active — "Hash tables"
    const nodeOrder = crypto.randomUUID(); // active survivor — "Insertion order"
    const nodeMerged = crypto.randomUUID(); // merged_into → nodeOrder
    const nodeRetired = crypto.randomUUID(); // retired
    const nodeInsert = await admin.from("concept_nodes").insert([
      {
        id: nodeHash,
        course_id: courseId,
        title: "Hash tables",
        description: "Buckets, hashing, collisions.",
        anchors: [{ lessonId }],
        status: "active",
      },
      {
        id: nodeOrder,
        course_id: courseId,
        title: "Insertion order",
        description: "What ordering a structure preserves.",
        anchors: [{ lessonId }],
        status: "active",
      },
      {
        id: nodeMerged,
        course_id: courseId,
        title: "Ordering (duplicate)",
        description: "Merged duplicate of Insertion order.",
        anchors: [{ lessonId }],
        status: "merged_into",
        merged_into_node_id: nodeOrder,
      },
      {
        id: nodeRetired,
        course_id: courseId,
        title: "Retired concept",
        description: "No longer taught.",
        anchors: [{ lessonId }],
        status: "retired",
      },
    ] as never);
    check("seeded 4 concept nodes (active ×2, merged, retired)", !nodeInsert.error, String(nodeInsert.error?.message));

    /** A full valid input; overrides layer on top. */
    const baseInput = (overrides: Partial<ToolEvidenceInput>): ToolEvidenceInput =>
      ({
        courseId,
        publicationId: publication.id,
        version: publication.version,
        lessonId,
        userId: learner.userId,
        conceptSlug: nodeHash, // R-1: the concept node's uuid IS the "slug"
        toolName: "check_understanding",
        outcome: "not_demonstrated",
        misconceptionSlug: "insertion-order-preserved",
        confidence: "sure",
        fadeLevel: 1,
        initiation: "invitation_accepted",
        itemSource: "generated",
        reviewedItemId: null,
        latencyMs: 1234,
        ...overrides,
      }) as ToolEvidenceInput;

    let expectedEvents = 0;

    /* ═══════════ A3-21a — exactly one row per completionKey; replay = no-op ═══ */
    console.log("\n# A3-21a — exactly-one: one learning_events row per completionKey; replay writes zero");

    const key21a = `a3-21a:${crypto.randomUUID()}`;
    const r1 = await recordToolEvidence(admin, baseInput({ completionKey: key21a }));
    check("first write returns recorded:true", r1.recorded === true, JSON.stringify(r1));
    check(
      "a misconceptionSlug input yields a non-null misconceptionId",
      r1.recorded === true && typeof r1.misconceptionId === "string" && r1.misconceptionId.length > 0,
      JSON.stringify(r1)
    );
    expectedEvents = 1;
    check("exactly ONE tutor_evidence_recorded row landed", (await countEvidence()) === 1);

    const landed = await untyped(admin)
      .from("learning_events")
      .select(
        "event_type, user_id, publication_id, version, lesson_id, node_id, tool_name, outcome, misconception_slug, confidence, fade_level, initiation, item_source, reviewed_item_id, latency_ms"
      )
      .eq("course_id", courseId)
      .eq("event_type", "tutor_evidence_recorded")
      .limit(2);
    const row = ((landed.data ?? []) as Array<Record<string, unknown>>)[0];
    check(
      "the row carries the typed evidence columns verbatim",
      !landed.error &&
        row !== undefined &&
        row.user_id === learner.userId &&
        row.publication_id === publication.id &&
        row.version === publication.version &&
        row.lesson_id === lessonId &&
        row.node_id === nodeHash &&
        row.tool_name === "check_understanding" &&
        row.outcome === "not_demonstrated" &&
        row.misconception_slug === "insertion-order-preserved" &&
        row.confidence === "sure" &&
        row.fade_level === 1 &&
        row.initiation === "invitation_accepted" &&
        row.item_source === "generated" &&
        row.reviewed_item_id === null &&
        row.latency_ms === 1234,
      JSON.stringify({ error: landed.error?.message, row })
    );

    const replay = await recordToolEvidence(admin, baseInput({ completionKey: key21a }));
    check("REPLAY of the same completionKey still returns recorded:true", replay.recorded === true, JSON.stringify(replay));
    check("REPLAY wrote ZERO new rows (count unchanged)", (await countEvidence()) === expectedEvents);

    /* ── sub-5 cohort: the rollup returns NOTHING (before the extra learners) ── */
    console.log("\n# rollup floor — a sub-5 cohort course returns NOTHING");
    const early = await rpcOf(author.client).rpc("tutor_misconception_rollup", { p_course_id: courseId });
    check(
      "cohort of 1 → rollup returns no rows (and no error for the author)",
      early.error === null && ((early.data as unknown[] | null) ?? []).length === 0,
      JSON.stringify({ error: early.error?.message, rows: early.data })
    );

    /* ═══════════ A3-21b — registry get-or-create race + version guard ═════════ */
    console.log("\n# A3-21b — two CONCURRENT calls proposing the same NEW (node, slug)");

    const raceSlug = "race-condition-slug";
    const [ra, rb] = await Promise.all([
      recordToolEvidence(
        admin,
        baseInput({ completionKey: `a3-21b-a:${crypto.randomUUID()}`, misconceptionSlug: raceSlug })
      ),
      recordToolEvidence(
        admin,
        baseInput({ completionKey: `a3-21b-b:${crypto.randomUUID()}`, misconceptionSlug: raceSlug })
      ),
    ]);
    expectedEvents += 2;
    check("both concurrent calls recorded:true", ra.recorded === true && rb.recorded === true, JSON.stringify({ ra, rb }));
    check(
      "both calls returned the SAME misconceptionId",
      ra.recorded === true &&
        rb.recorded === true &&
        typeof ra.misconceptionId === "string" &&
        ra.misconceptionId === rb.misconceptionId,
      JSON.stringify({ a: ra.recorded && ra.misconceptionId, b: rb.recorded && rb.misconceptionId })
    );
    const raceRows = await registryRows(nodeHash, raceSlug);
    check("exactly ONE tutor_misconceptions row exists for the raced (node, slug)", raceRows.length === 1, JSON.stringify(raceRows));
    check("both events landed (2 rows for the 2 distinct completionKeys)", (await countEvidence()) === expectedEvents);

    // R-3 restatement: the registry rows are VERSIONED — a direct optimistic
    // update carrying a stale version matches 0 rows; the current version wins.
    console.log("\n# A3-21b — registry version guard (stale optimistic update → 0 rows)");
    const regRow = raceRows[0];
    const stale = await untyped(admin)
      .from("tutor_misconceptions")
      .update({ version: regRow.version + 1 })
      .eq("id", regRow.id)
      .eq("version", regRow.version + 41) // a version nobody holds
      .select("id");
    check(
      "a STALE-version optimistic update matches 0 rows (no error, no effect)",
      !stale.error && ((stale.data as unknown[] | null) ?? []).length === 0,
      JSON.stringify({ error: stale.error?.message, data: stale.data })
    );
    const current = await untyped(admin)
      .from("tutor_misconceptions")
      .update({ version: regRow.version + 1 })
      .eq("id", regRow.id)
      .eq("version", regRow.version)
      .select("id, version");
    check(
      "the CURRENT-version optimistic update matches exactly 1 row (the idiom works)",
      !current.error && ((current.data as unknown[] | null) ?? []).length === 1,
      JSON.stringify({ error: current.error?.message, data: current.data })
    );

    /* ═══════════ A3-22 — NOT approval-gated (spy + live legs) ═════════════════ */
    console.log("\n# A3-22 — the write path touches NO approval/tool-tier machinery");

    const touchedTables: string[] = [];
    const rpcNames: string[] = [];
    const spyAdmin = new Proxy(admin as object, {
      get(target, prop) {
        if (prop === "from") {
          return (table: string) => {
            touchedTables.push(table);
            return (target as { from: (t: string) => unknown }).from(table);
          };
        }
        if (prop === "rpc") {
          return (...args: unknown[]) => {
            rpcNames.push(String(args[0]));
            return (target as { rpc: (...a: unknown[]) => unknown }).rpc(...args);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof admin;

    const spyResult = await recordToolEvidence(spyAdmin, baseInput({ completionKey: `a3-22:${crypto.randomUUID()}` }));
    expectedEvents += 1;
    check("the spied write recorded:true", spyResult.recorded === true, JSON.stringify(spyResult));
    const allowedTables = new Set(["learning_events", "tutor_misconceptions", "concept_nodes"]);
    check(
      "ONLY learning_events + tutor_misconceptions (+ concept_nodes read) are touched",
      touchedTables.length > 0 && touchedTables.every((t) => allowedTables.has(t)),
      JSON.stringify([...new Set(touchedTables)])
    );
    check("the event write itself went through learning_events", touchedTables.includes("learning_events"));
    check(
      "NO approval/tier/agent-run RPC or table is in the path",
      !touchedTables.some((t) => /approval|agent_run|change_set|tier/i.test(t)) &&
        !rpcNames.some((n) => /approval|agent_run|change_set|tier/i.test(n)),
      JSON.stringify({ tables: [...new Set(touchedTables)], rpcs: rpcNames })
    );
    // Live leg: the write landed although the course has NO agent_runs rows at all.
    const runs = await admin
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId);
    check(
      "live leg: the row landed with ZERO agent_runs/approval rows on the course",
      (runs.count ?? 0) === 0 && (await countEvidence()) === expectedEvents,
      `agent_runs=${runs.count}`
    );

    /* ═══════════ concept-graph path — unknown / merged / retired ══════════════ */
    console.log("\n# concept-graph path — unknown node, merged→survivor, retired");

    const unknown = await recordToolEvidence(
      admin,
      baseInput({ completionKey: `a3-unknown:${crypto.randomUUID()}`, conceptSlug: crypto.randomUUID() })
    );
    check(
      "an UNKNOWN node id → { recorded:false, reason:'unknown_concept' }",
      unknown.recorded === false && unknown.reason === "unknown_concept",
      JSON.stringify(unknown)
    );
    check("the unknown-node attempt wrote ZERO rows", (await countEvidence()) === expectedEvents);

    const mergedSlug = "merged-node-slug";
    const merged = await recordToolEvidence(
      admin,
      baseInput({
        completionKey: `a3-merged:${crypto.randomUUID()}`,
        conceptSlug: nodeMerged,
        misconceptionSlug: mergedSlug,
      })
    );
    expectedEvents += 1;
    check("a MERGED node records against its survivor (recorded:true)", merged.recorded === true, JSON.stringify(merged));
    const mergedEvent = await untyped(admin)
      .from("learning_events")
      .select("node_id")
      .eq("course_id", courseId)
      .eq("event_type", "tutor_evidence_recorded")
      .eq("misconception_slug", mergedSlug)
      .limit(2);
    const mergedRows = (mergedEvent.data ?? []) as Array<{ node_id: string }>;
    check(
      "the merged-node event carries the SURVIVOR's node_id",
      mergedRows.length === 1 && mergedRows[0].node_id === nodeOrder,
      JSON.stringify(mergedRows)
    );
    check(
      "the registry links the survivor, never the merged node",
      (await registryRows(nodeOrder, mergedSlug)).length === 1 &&
        (await registryRows(nodeMerged, mergedSlug)).length === 0
    );

    const retired = await recordToolEvidence(
      admin,
      baseInput({ completionKey: `a3-retired:${crypto.randomUUID()}`, conceptSlug: nodeRetired })
    );
    check(
      "a RETIRED node → { recorded:false, reason:'unknown_concept' }",
      retired.recorded === false && retired.reason === "unknown_concept",
      JSON.stringify(retired)
    );
    check("the retired-node attempt wrote ZERO rows", (await countEvidence()) === expectedEvents);

    /* ═══════════ RLS matrix — author-SELECT-only, service-role writer ═════════ */
    console.log("\n# RLS matrix — tutor_misconceptions is author-SELECT-only; no client writes");

    const authorSel = await untyped(author.client)
      .from("tutor_misconceptions")
      .select("id, node_id, slug")
      .eq("course_id", courseId);
    const authorRows = (authorSel.data ?? []) as unknown[];
    check(
      "the author SELECTs the course's registry rows (3 so far)",
      !authorSel.error && authorRows.length === 3,
      JSON.stringify({ error: authorSel.error?.message, n: authorRows.length })
    );
    const strangerSel = await untyped(stranger.client)
      .from("tutor_misconceptions")
      .select("id")
      .eq("course_id", courseId);
    check("a STRANGER reads ZERO registry rows", !strangerSel.error && ((strangerSel.data ?? []) as unknown[]).length === 0);
    const learnerSel = await untyped(learner.client)
      .from("tutor_misconceptions")
      .select("id")
      .eq("course_id", courseId);
    check("an enrolled LEARNER reads ZERO registry rows", !learnerSel.error && ((learnerSel.data ?? []) as unknown[]).length === 0);

    const regBefore = await registryRows();
    const authorIns = await untyped(author.client)
      .from("tutor_misconceptions")
      .insert({ course_id: courseId, node_id: nodeHash, slug: "author-forged-slug" })
      .select("id");
    const insBlocked = authorIns.error !== null || ((authorIns.data ?? []) as unknown[]).length === 0;
    check(
      "the AUTHOR cannot INSERT into the registry (service-role writer only)",
      insBlocked && (await registryRows()).length === regBefore.length,
      JSON.stringify({ error: authorIns.error?.message })
    );
    const learnerIns = await untyped(learner.client)
      .from("tutor_misconceptions")
      .insert({ course_id: courseId, node_id: nodeHash, slug: "learner-forged-slug" })
      .select("id");
    check(
      "a LEARNER cannot INSERT into the registry",
      (learnerIns.error !== null || ((learnerIns.data ?? []) as unknown[]).length === 0) &&
        (await registryRows()).length === regBefore.length
    );
    const authorUpd = await untyped(author.client)
      .from("tutor_misconceptions")
      .update({ slug: "author-renamed-slug" })
      .eq("id", regBefore[0].id)
      .select("id");
    const updBlocked = authorUpd.error !== null || ((authorUpd.data ?? []) as unknown[]).length === 0;
    const afterUpd = await registryRows();
    check(
      "the AUTHOR cannot UPDATE a registry row (0 rows / error; value unchanged)",
      updBlocked && afterUpd.some((r) => r.id === regBefore[0].id && r.slug === regBefore[0].slug),
      JSON.stringify({ error: authorUpd.error?.message })
    );
    const authorDel = await untyped(author.client)
      .from("tutor_misconceptions")
      .delete()
      .eq("id", regBefore[0].id)
      .select("id");
    check(
      "the AUTHOR cannot DELETE a registry row (row survives)",
      (authorDel.error !== null || ((authorDel.data ?? []) as unknown[]).length === 0) &&
        (await registryRows()).length === regBefore.length
    );

    /* ═══════════ rollup RPC — floors, omission, gate, cohort_size ═════════════ */
    console.log("\n# tutor_misconception_rollup — ≥5 disclosure floor + gate + cohort_size");

    // Enroll the 4 extras, then seed: slug A ← 5 distinct learners (primary + 4
    // extras) on nodeHash; slug B ← 2 distinct learners on nodeOrder. All through
    // the REAL writer (unique completionKeys). One call omits lessonId — the
    // envelope's lesson is optional for tutor evidence.
    for (const e of extras) {
      const en = await e.client
        .from("enrollments")
        .insert({ course_id: courseId, user_id: e.userId })
        .select("id")
        .single();
      if (en.error) throw new Error(`extra enroll: ${en.error.message}`);
    }
    const commonSlug = "rollup-common-misconception";
    const rareSlug = "rollup-rare-misconception";
    const fiveUsers = [learner.userId, ...extras.map((e) => e.userId)];
    for (const [i, uid] of fiveUsers.entries()) {
      const res = await recordToolEvidence(
        admin,
        baseInput({
          completionKey: `a3-rollup-common:${uid}`,
          userId: uid,
          conceptSlug: nodeHash,
          misconceptionSlug: commonSlug,
          // one of the five rides WITHOUT a lesson (optional in the envelope)
          lessonId: i === 0 ? undefined : lessonId,
        })
      );
      if (res.recorded !== true) throw new Error(`rollup seed (common, ${uid}): ${JSON.stringify(res)}`);
      expectedEvents += 1;
    }
    for (const uid of [learner.userId, extras[0].userId]) {
      const res = await recordToolEvidence(
        admin,
        baseInput({
          completionKey: `a3-rollup-rare:${uid}`,
          userId: uid,
          conceptSlug: nodeOrder,
          misconceptionSlug: rareSlug,
        })
      );
      if (res.recorded !== true) throw new Error(`rollup seed (rare, ${uid}): ${JSON.stringify(res)}`);
      expectedEvents += 1;
    }
    check("all rollup seed events landed (running total intact)", (await countEvidence()) === expectedEvents);

    const rollup = await rpcOf(author.client).rpc("tutor_misconception_rollup", { p_course_id: courseId });
    const rows = ((rollup.data as RollupRow[] | null) ?? []) as RollupRow[];
    check("the author calls the rollup without error", rollup.error === null, String(rollup.error?.message));
    const commonRow = rows.find((r) => r.misconception_slug === commonSlug);
    check(
      "the 5-learner misconception IS returned (learner_count 5, on the right node)",
      commonRow !== undefined &&
        commonRow.learner_count === 5 &&
        commonRow.node_id === nodeHash &&
        commonRow.node_title === "Hash tables" &&
        commonRow.evidence_count >= 5,
      JSON.stringify(commonRow ?? rows)
    );
    check(
      "the 2-learner misconception is OMITTED (below the ≥5 floor)",
      !rows.some((r) => r.misconception_slug === rareSlug)
    );
    check(
      "every single-learner slug from earlier sections is omitted too",
      !rows.some((r) =>
        ["insertion-order-preserved", raceSlug, mergedSlug].includes(r.misconception_slug)
      )
    );
    check("EVERY returned row satisfies learner_count >= 5", rows.every((r) => r.learner_count >= 5));
    check(
      "cohort_size is correct (5 distinct evidence-bearing learners)",
      rows.length > 0 && rows.every((r) => r.cohort_size === 5),
      JSON.stringify(rows.map((r) => r.cohort_size))
    );
    check("exactly ONE row survives the floor in this fixture", rows.length === 1, String(rows.length));

    // Gate: non-authors get an error or nothing — never data.
    const strangerRoll = await rpcOf(stranger.client).rpc("tutor_misconception_rollup", { p_course_id: courseId });
    check(
      "a STRANGER's rollup call is gated (error or empty)",
      strangerRoll.error !== null || ((strangerRoll.data as unknown[] | null) ?? []).length === 0,
      JSON.stringify({ error: strangerRoll.error?.message, rows: strangerRoll.data })
    );
    const learnerRoll = await rpcOf(learner.client).rpc("tutor_misconception_rollup", { p_course_id: courseId });
    check(
      "an enrolled LEARNER's rollup call is gated (error or empty)",
      learnerRoll.error !== null || ((learnerRoll.data as unknown[] | null) ?? []).length === 0
    );
    const anonRoll = await rpcOf(anonClient).rpc("tutor_misconception_rollup", { p_course_id: courseId });
    check(
      "an ANON (unauthenticated) rollup call is gated (error or empty)",
      anonRoll.error !== null || ((anonRoll.data as unknown[] | null) ?? []).length === 0,
      JSON.stringify({ error: anonRoll.error?.message })
    );
  } finally {
    await cleanup();
    console.log(
      "\n# A3 cleaned up (events by course, registry by course, course cascade — throwaway users remain, clean in Supabase → Auth)"
    );
  }
}

async function run() {
  await main();
  await a3EvidenceSpine();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void run().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
