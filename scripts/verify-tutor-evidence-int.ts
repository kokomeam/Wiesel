/**
 * TUTOR-1 Wave 2 learning-evidence — INTEGRATION suite (live Supabase, no model
 * key). Self-provisions throwaway users each run. WRITE-ONLY in this package:
 * the orchestrator applies migrations 20260803110000/110100/110200 BEFORE
 * running it (record_quiz_attempt / quiz_attempt_detail / the mastery RPCs do
 * not exist until then). DO NOT run this before the migrations are applied.
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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
