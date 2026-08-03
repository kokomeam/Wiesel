/**
 * Analytics pipeline integration test against LIVE Supabase — no OpenAI key.
 * Run: `npx tsx scripts/verify-analytics-int.ts`  (npm run verify:analytics:int)
 * Requires SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) in .env.local.
 *
 * Proves the Milestone 3 acceptance criteria against the real database:
 *   • ingest is IDEMPOTENT: replaying a batch (same client_event_ids) via the
 *     same RLS upsert the route uses changes nothing
 *   • RLS matrix: students insert only their OWN events into courses they're
 *     enrolled in (forged user_id and not-enrolled inserts fail), students
 *     read NO events, authors read only their own courses' events, and rollup
 *     tables are author-read-only
 *   • server-emitted events: quiz_submitted lands keyed by the attempt id,
 *     lesson_completed lands keyed by the progress row id, and re-emitting is
 *     a no-op (stable-uuid idempotency)
 *   • rollup outputs match hand-computed fixtures — including the SQL
 *     point-biserial equalling the TS mirror, percentile_cont dwell values,
 *     answer distributions with the key bucket resolved, quartile retention,
 *     and both stuck-learner flags
 *   • refresh_course_analytics is author-gated (author ok, non-author and
 *     anon rejected); the roster/overview RPCs likewise
 *   • M8 filing guards: learner risks file ONE per learner under the TS
 *     dedupe key; 5 days of silence trips the 4-day threshold; opted-out /
 *     suppressed / recently-messaged (14-day cooldown) learners are skipped,
 *     and lifting each guard files again
 *   • PERF-1 E1 (AC-PERF-14): perf_vital rides the SAME RPC — forged userId
 *     pinned to auth.uid(), NULL course envelope, metric columns intact,
 *     duplicate client_event_id accepted once, no enrollment requirement
 *     (but learner events in the batch still gated), DB CHECKs on the metric
 *     taxonomy, client-unreadable rows, service-role-only perf_vitals_daily
 *
 * Throwaway *@example.com users can't be deleted with the anon key — clean
 * them in Supabase → Auth. The course is deleted at the end (cascades).
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { OverviewSchema } from "@/lib/analytics/dashboard";
import {
  buildEvent,
  mapEventToColumns,
  type AnalyticsEvent,
  type EventContext,
} from "@/lib/analytics/events";
import { emitServerEvent } from "@/lib/analytics/serverEmit";
import { buildPerfVitalEvent } from "@/lib/analytics/vitals";
import { percentileCont, pointBiserial } from "@/lib/analytics/stats";
import {
  createBlock,
  createLesson,
  createModule,
  createQuestion,
  createSlide,
} from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import type { CourseDocument, QuizBlock, SlideDeckBlock } from "@/lib/course/types";
import { applyProgressAction } from "@/lib/learn/progressService";
import { submitQuizAttempt } from "@/lib/learn/quizService";
import { parsePublicationSnapshot, resolveLivePublicationBySlug } from "@/lib/learn/resolve";

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
  const email = `analytics-itest-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  console.log(`# provisioned ${email}`);
  return { client, userId: data.user.id };
}

/* Fixture: A = deck(2 slides) + quiz(mc + sa) · B = lecture · C = lecture. */
function makeDoc(courseId: string, ownerId: string) {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];
  const quiz = createBlock("quiz", 1) as QuizBlock;
  const mc = createQuestion("multiple_choice");
  if (mc.kind !== "multiple_choice") throw new Error("unreachable");
  mc.prompt = "Pick B.";
  mc.correctChoiceId = mc.choices[1].id;
  const sa = createQuestion("short_answer");
  if (sa.kind !== "short_answer") throw new Error("unreachable");
  sa.prompt = "Name the curve.";
  sa.expectedAnswer = "Supply";
  quiz.questions = [mc, sa];
  const lessonA = createLesson("Lesson A", 0);
  lessonA.blocks = [deck, quiz];
  const lessonB = createLesson("Lesson B", 1);
  lessonB.blocks = [createBlock("lecture_text", 0)];
  const lessonC = createLesson("Lesson C", 2);
  lessonC.blocks = [createBlock("lecture_text", 0)];
  const mod = createModule("Foundations", 0);
  mod.lessons = [lessonA, lessonB, lessonC];

  const doc: CourseDocument = {
    id: courseId,
    title: `Analytics itest ${crypto.randomUUID().slice(0, 6)}`,
    description: "Analytics integration fixture.",
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
  return { doc, deck, quiz, mc, sa, lessonA, lessonB, lessonC };
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

/** The exact call the ingest route performs (user-scoped RPC; the definer
 *  pins user_id to auth.uid() and enforces enrollment + publication↔course). */
async function ingest(client: DB, userId: string, events: AnalyticsEvent[]) {
  return client.rpc("ingest_learning_events", {
    p_events: events.map((e) => mapEventToColumns(e, userId)) as never,
  });
}

async function countEvents(admin: DB, courseId: string): Promise<number> {
  const { count, error } = await admin
    .from("learning_events")
    .select("id", { count: "exact", head: true })
    .eq("course_id", courseId);
  if (error) throw error;
  return count ?? 0;
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:analytics:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const student = await provisionUser(url, anon, "student");
  const student2 = await provisionUser(url, anon, "student2");
  const stranger = await provisionUser(url, anon, "stranger");
  const anonClient = createClient<Database>(url, anon);
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const courseId = crypto.randomUUID();
  const fx = makeDoc(courseId, author.userId);
  // perf_vital rows carry NO course_id — track their emitters for cleanup.
  const perfUserIds = [author.userId, student.userId, student2.userId, stranger.userId];

  try {
    /* ── 1. Publish + enroll ── */
    console.log("\n— Setup: publish + enroll —");
    await seedCourse(author.client, fx.doc, author.userId);
    const published = await publishCourse(author.client, fx.doc, {});
    check("published v1", published.publication.version === 1);
    const live = await resolveLivePublicationBySlug(student.client, published.publication.slug);
    if (live.kind !== "found") throw new Error("publication not resolvable");
    const publication = live.publication;
    const snapshot = parsePublicationSnapshot(publication);

    for (const u of [student, student2]) {
      const { error } = await u.client
        .from("enrollments")
        .insert({ course_id: courseId, user_id: u.userId });
      if (error) throw new Error(`enroll: ${error.message}`);
    }
    check("student + student2 enrolled", true);

    const ctxA: EventContext = {
      publicationId: publication.id,
      version: publication.version,
      courseId,
      lessonId: fx.lessonA.id,
    };
    const videoBlockId = crypto.randomUUID(); // events don't FK block ids

    /* ── 2. Ingest: idempotent replay + RLS matrix ── */
    console.log("\n— Ingest idempotency + RLS —");
    const batch: AnalyticsEvent[] = [
      buildEvent(ctxA, { eventType: "lesson_started" }),
      // Dwell fixture on slide 1: [1000, 2000, 3000, 10000] → median 2500, p90 7900.
      ...[1000, 2000, 3000, 10000].map((dwellMs) =>
        buildEvent(ctxA, {
          eventType: "slide_viewed",
          blockId: fx.deck.id,
          slideId: fx.deck.slides[0].id,
          dwellMs,
        })
      ),
      buildEvent(ctxA, { eventType: "video_progress", blockId: videoBlockId, quartile: 1 }),
      buildEvent(ctxA, { eventType: "video_progress", blockId: videoBlockId, quartile: 2 }),
      buildEvent(ctxA, { eventType: "session_heartbeat" }),
    ];
    const first = await ingest(student.client, student.userId, batch);
    check("student inserts own events", first.error === null, first.error?.message);
    check("RPC reports the accepted count", first.data === batch.length);
    const afterFirst = await countEvents(admin, courseId);
    check("batch landed", afterFirst === batch.length, `count ${afterFirst}`);

    const replay = await ingest(student.client, student.userId, batch);
    check("replaying the SAME batch does not error", replay.error === null);
    check("…reports 0 newly accepted", replay.data === 0);
    const afterReplay = await countEvents(admin, courseId);
    check("…and changes NOTHING (idempotent)", afterReplay === afterFirst);

    // Forged user_id via the ingest RPC: PINNED to the caller, not rejected —
    // the row lands attributed to the real session user.
    const forgedEvent = buildEvent(ctxA, { eventType: "session_heartbeat" });
    const forgedRpc = await ingest(student.client, student2.userId, [forgedEvent]);
    check("RPC ignores a forged user_id field", forgedRpc.error === null);
    const forgedRow = await admin
      .from("learning_events")
      .select("user_id")
      .eq("client_event_id", forgedEvent.clientEventId)
      .single();
    check(
      "…and pins the row to the real caller",
      forgedRow.data?.user_id === student.userId
    );
    // Direct-table path (defense-in-depth): the insert POLICY rejects a forged
    // user_id outright.
    const forgedDirect = await student.client
      .from("learning_events")
      .insert([
        mapEventToColumns(buildEvent(ctxA, { eventType: "session_heartbeat" }), student2.userId),
      ]);
    check("direct-table forged user_id rejected by RLS", forgedDirect.error !== null);

    const notEnrolled = await ingest(stranger.client, stranger.userId, [
      buildEvent(ctxA, { eventType: "session_heartbeat" }),
    ]);
    check("not-enrolled ingest rejected", notEnrolled.error !== null);
    const notEnrolledDirect = await stranger.client
      .from("learning_events")
      .insert([
        mapEventToColumns(buildEvent(ctxA, { eventType: "session_heartbeat" }), stranger.userId),
      ]);
    check("direct-table not-enrolled insert rejected by RLS", notEnrolledDirect.error !== null);
    const anonIngest = await anonClient.rpc("ingest_learning_events", { p_events: [] as never });
    check("anon ingest rejected (revoked)", anonIngest.error !== null);

    const studentRead = await student.client
      .from("learning_events")
      .select("id")
      .eq("course_id", courseId);
    check(
      "students read NO events (not even their own)",
      studentRead.error === null && (studentRead.data ?? []).length === 0
    );
    const authorRead = await author.client
      .from("learning_events")
      .select("id")
      .eq("course_id", courseId);
    check(
      "author reads their course's events",
      // afterFirst + the pinned forged heartbeat from the RPC test above.
      authorRead.error === null && (authorRead.data ?? []).length === afterFirst + 1
    );
    const strangerRead = await stranger.client
      .from("learning_events")
      .select("id")
      .eq("course_id", courseId);
    check(
      "outsider reads none",
      strangerRead.error === null && (strangerRead.data ?? []).length === 0
    );

    // student2's engagement (for retention): finishing the video.
    const s2ev = await ingest(student2.client, student2.userId, [
      buildEvent(ctxA, { eventType: "video_completed", blockId: videoBlockId }),
    ]);
    check("second student's events land", s2ev.error === null);

    /* ── 3. Server-emitted events (quiz + completion) ── */
    console.log("\n— Server-emitted events —");
    const pub = { id: publication.id, version: publication.version, snapshot };
    // student: full marks (mc correct + sa correct) → totals fixture (2).
    const a1 = await submitQuizAttempt(admin, {
      userId: student.userId,
      role: "student",
      courseId,
      publication: pub,
      request: {
        publicationId: publication.id,
        blockId: fx.quiz.id,
        responses: [
          { kind: "multiple_choice", questionId: fx.mc.id, choiceId: fx.mc.correctChoiceId },
          { kind: "short_answer", questionId: fx.sa.id, text: "Supply" },
        ],
      },
    });
    check("student scores 2/2", a1.score === 2 && a1.attemptId !== null);
    // student2: two failing attempts (repeated_quiz_failure fixture).
    const wrongChoice = fx.mc.choices[0].id;
    const a2 = await submitQuizAttempt(admin, {
      userId: student2.userId,
      role: "student",
      courseId,
      publication: pub,
      request: {
        publicationId: publication.id,
        blockId: fx.quiz.id,
        responses: [
          { kind: "multiple_choice", questionId: fx.mc.id, choiceId: wrongChoice },
        ],
      },
    });
    const a3 = await submitQuizAttempt(admin, {
      userId: student2.userId,
      role: "student",
      courseId,
      publication: pub,
      request: {
        publicationId: publication.id,
        blockId: fx.quiz.id,
        responses: [
          { kind: "multiple_choice", questionId: fx.mc.id, choiceId: wrongChoice },
          { kind: "short_answer", questionId: fx.sa.id, text: "demand" },
        ],
      },
    });
    check("student2 fails twice", a2.score === 0 && a3.score === 0);

    const quizEvents = await admin
      .from("learning_events")
      .select("client_event_id, attempt_id, lesson_id")
      .eq("course_id", courseId)
      .eq("event_type", "quiz_submitted");
    check(
      "quiz_submitted emitted per attempt, keyed by the attempt id",
      (quizEvents.data ?? []).length === 3 &&
        (quizEvents.data ?? []).every(
          (e) => e.client_event_id === e.attempt_id && e.lesson_id === fx.lessonA.id
        )
    );

    // Completing lesson A for student: both slides viewed (+ quiz already attempted).
    const progressCtx = {
      userId: student.userId,
      courseId,
      publicationId: publication.id,
      version: publication.version,
      snapshot,
    };
    const done = await applyProgressAction(admin, progressCtx, {
      action: "slides_viewed",
      lessonId: fx.lessonA.id,
      blockId: fx.deck.id,
      slideIds: fx.deck.slides.map((s) => s.id),
    });
    check("lesson A completes for student", done.status === "completed");
    const completedEvents = await admin
      .from("learning_events")
      .select("client_event_id")
      .eq("course_id", courseId)
      .eq("event_type", "lesson_completed")
      .eq("user_id", student.userId);
    check("lesson_completed server-emitted once", (completedEvents.data ?? []).length === 1);

    // Re-emitting with the same stable uuid is a no-op.
    const beforeReEmit = await countEvents(admin, courseId);
    await emitServerEvent(
      admin,
      student.userId,
      ctxA,
      { eventType: "lesson_completed" },
      completedEvents.data![0].client_event_id
    );
    check("re-emit with the same key is a no-op", (await countEvents(admin, courseId)) === beforeReEmit);

    /* ── 4. Refresh gating + rollup fixtures ── */
    console.log("\n— Refresh + rollups vs hand-computed fixtures —");
    const strangerRefresh = await stranger.client.rpc("refresh_course_analytics", {
      cid: courseId,
    });
    check("non-author refresh rejected", strangerRefresh.error !== null);
    const anonRefresh = await anonClient.rpc("refresh_course_analytics", { cid: courseId });
    check("anon refresh rejected (revoked)", anonRefresh.error !== null);
    // Inactive fixture: enroll stranger, then backdate the enrollment 8 days.
    const strollErr = (
      await stranger.client.from("enrollments").insert({ course_id: courseId, user_id: stranger.userId })
    ).error;
    if (strollErr) throw new Error(`stranger enroll: ${strollErr.message}`);
    const backdate = await admin
      .from("enrollments")
      .update({ enrolled_at: new Date(Date.now() - 8 * 86_400_000).toISOString() })
      .eq("course_id", courseId)
      .eq("user_id", stranger.userId);
    if (backdate.error) throw new Error(backdate.error.message);

    const refreshed = await author.client.rpc("refresh_course_analytics", { cid: courseId });
    check("author refresh succeeds", refreshed.error === null, refreshed.error?.message);

    // Funnel: A started by student(+events/progress) + student2(events/progress) → 2;
    // completed by student → 1. B and C exist with zero counts.
    const funnel = await author.client
      .from("rollup_lesson_funnel")
      .select("*")
      .eq("publication_id", publication.id)
      .order("lesson_order");
    const [fa, fb, fc] = funnel.data ?? [];
    check(
      "funnel covers every snapshot lesson in order",
      (funnel.data ?? []).length === 3 &&
        fa?.lesson_id === fx.lessonA.id &&
        fb?.lesson_id === fx.lessonB.id &&
        fc?.lesson_id === fx.lessonC.id
    );
    check(
      "lesson A: started 2, completed 1",
      fa?.started_count === 2 && fa?.completed_count === 1,
      `got ${fa?.started_count}/${fa?.completed_count}`
    );
    check(
      "untouched lessons roll up as zero (first-class empty state)",
      fb?.started_count === 0 && fc?.started_count === 0
    );
    check(
      "lesson B drop-off = 100% vs A",
      fb?.dropoff_pct !== null && Number(fb?.dropoff_pct) === 1
    );

    // Question stats: mc n=3 p=1/3 distribution {B:1, A:2} key=B r_pb = TS mirror.
    const qstats = await author.client
      .from("rollup_question_stats")
      .select("*")
      .eq("publication_id", publication.id);
    const mcRow = (qstats.data ?? []).find((r) => r.question_id === fx.mc.id);
    const saRow = (qstats.data ?? []).find((r) => r.question_id === fx.sa.id);
    check("mc stats: n=3, 33.3% correct", mcRow?.n === 3 && Number(mcRow?.pct_correct) === 33.3);
    const mcDist = (mcRow?.answer_distribution ?? {}) as Record<string, number>;
    check(
      "mc distribution buckets by choice id",
      mcDist[fx.mc.correctChoiceId] === 1 && mcDist[wrongChoice] === 2
    );
    check("mc key bucket resolved from answer keys", mcRow?.key_value === fx.mc.correctChoiceId);
    const mcMirror = pointBiserial([
      { correct: true, total: 2 },
      { correct: false, total: 0 },
      { correct: false, total: 0 },
    ]);
    check(
      "mc discrimination: SQL === TS mirror",
      mcRow?.discrimination !== null && Number(mcRow?.discrimination) === mcMirror,
      `sql ${mcRow?.discrimination} ts ${mcMirror}`
    );
    check(
      "sa has no key bucket (short answer) but has stats",
      saRow?.key_value === null && saRow?.n === 2
    );

    // Slide dwell: [1000,2000,3000,10000] → percentile_cont ↔ TS mirror.
    const dwell = await author.client
      .from("rollup_slide_dwell")
      .select("*")
      .eq("publication_id", publication.id)
      .eq("slide_id", fx.deck.slides[0].id)
      .maybeSingle();
    const fixture = [1000, 2000, 3000, 10000];
    check(
      "dwell median matches percentile_cont(0.5)",
      dwell.data?.median_dwell_ms === Math.round(percentileCont(fixture, 0.5) ?? -1) &&
        dwell.data?.median_dwell_ms === 2500
    );
    check(
      "dwell p90 matches percentile_cont(0.9)",
      dwell.data?.p90_dwell_ms === Math.round(percentileCont(fixture, 0.9) ?? -1) &&
        dwell.data?.p90_dwell_ms === 7900,
      `got ${dwell.data?.p90_dwell_ms}`
    );
    check("dwell n counts every view", dwell.data?.n === 4);

    // Video retention: student reached q2, student2 completed.
    const video = await author.client
      .from("rollup_video_retention")
      .select("*")
      .eq("publication_id", publication.id)
      .eq("block_id", videoBlockId)
      .maybeSingle();
    check(
      "video retention quartiles (2 viewers: q1 2 · q2 2 · q3 1 · q4 1 · done 1)",
      video.data?.viewers === 2 &&
        video.data?.q1_count === 2 &&
        video.data?.q2_count === 2 &&
        video.data?.q3_count === 1 &&
        video.data?.q4_count === 1 &&
        video.data?.completed_count === 1,
      JSON.stringify(video.data)
    );

    // Flags: student2 repeated failure; stranger inactive.
    const flags = await author.client
      .from("learner_flags")
      .select("*")
      .eq("course_id", courseId);
    const failureFlag = (flags.data ?? []).find(
      (f) => f.user_id === student2.userId && f.flag_type === "repeated_quiz_failure"
    );
    const inactiveFlag = (flags.data ?? []).find(
      (f) => f.user_id === stranger.userId && f.flag_type === "inactive_incomplete"
    );
    const failureDetail = (failureFlag?.detail ?? {}) as {
      quizzes?: { blockId: string; failedAttempts: number }[];
    };
    check(
      "repeated_quiz_failure flagged with the offending quiz",
      failureDetail.quizzes?.[0]?.blockId === fx.quiz.id &&
        failureDetail.quizzes?.[0]?.failedAttempts === 2
    );
    check("inactive_incomplete flagged for the silent enrollee", inactiveFlag !== undefined);
    check(
      "active learners are NOT flagged",
      !(flags.data ?? []).some((f) => f.user_id === student.userId)
    );

    // Rollups are author-only.
    const studentRollup = await student.client
      .from("rollup_lesson_funnel")
      .select("lesson_id")
      .eq("publication_id", publication.id);
    check(
      "students read no rollups",
      studentRollup.error === null && (studentRollup.data ?? []).length === 0
    );

    /* ── 5. Dashboard RPCs ── */
    console.log("\n— Dashboard RPCs —");
    const overviewRes = await author.client.rpc("course_analytics_overview", { cid: courseId });
    check("overview RPC returns for the author", overviewRes.error === null);
    const overview = OverviewSchema.parse(overviewRes.data);
    check(
      "overview counts: 3 enrollments, 2 active in 7d",
      overview.totalEnrollments === 3 && overview.active7d === 2,
      JSON.stringify(overview)
    );
    const overviewStranger = await stranger.client.rpc("course_analytics_overview", {
      cid: courseId,
    });
    check("overview rejected for non-author", overviewStranger.error !== null);

    const roster = await author.client.rpc("course_roster", { cid: courseId });
    check("roster RPC returns for the author", roster.error === null);
    const rows = roster.data ?? [];
    const studentRow = rows.find((r) => r.user_id === student.userId);
    const student2Row = rows.find((r) => r.user_id === student2.userId);
    check("roster covers every enrollee", rows.length === 3);
    check(
      "roster carries email + progress + lesson counts",
      Boolean(studentRow?.email) &&
        Number(studentRow?.progress_pct) > 0 &&
        studentRow?.completed_lessons === 1 &&
        studentRow?.total_lessons === 3
    );
    check(
      "roster carries the failure flag on student2",
      Array.isArray(student2Row?.flags) && (student2Row?.flags as unknown[]).length === 1
    );
    const rosterStudent = await student.client.rpc("course_roster", { cid: courseId });
    check("roster rejected for non-author", rosterStudent.error !== null);
    const rosterAnon = await anonClient.rpc("course_roster", { cid: courseId });
    check("roster rejected for anon (revoked)", rosterAnon.error !== null);

    /* ── 6. M8: threshold filing — merged learner key + nudge guards ── */
    console.log("\n— M8: filing guards —");
    const openRisk = async (userId: string) => {
      const res = await admin
        .from("agent_findings")
        .select("id, dedupe_key, severity")
        .eq("course_id", courseId)
        .eq("kind", "learner_risk")
        .eq("status", "open")
        .eq("dedupe_key", `learner_risk:${userId}`);
      if (res.error) throw res.error;
      return res.data ?? [];
    };
    const dismissRisk = async (userId: string) => {
      const res = await admin
        .from("agent_findings")
        .update({ status: "dismissed" })
        .eq("course_id", courseId)
        .eq("kind", "learner_risk")
        .eq("status", "open")
        .eq("dedupe_key", `learner_risk:${userId}`);
      if (res.error) throw res.error;
    };
    const refile = async () => {
      const res = await author.client.rpc("refresh_course_analytics", { cid: courseId });
      if (res.error) throw new Error(res.error.message);
    };

    // The earlier author refresh already filed: stranger (inactive) and
    // student2 (repeated failure) each got ONE finding under the TS key scheme.
    const strangerRisk = await openRisk(stranger.userId);
    check(
      "learner risk filed under the TS dedupe key (adoption mirror)",
      strangerRisk.length === 1 && strangerRisk[0].severity === "medium"
    );
    const student2Risk = await openRisk(student2.userId);
    check(
      "repeated-failure learner filed high, one finding per learner",
      student2Risk.length === 1 && student2Risk[0].severity === "high"
    );

    // 4-day threshold: 5 days of silence flags (would NOT have under old 7d).
    const fiveDays = await admin
      .from("enrollments")
      .update({ enrolled_at: new Date(Date.now() - 5 * 86_400_000).toISOString() })
      .eq("course_id", courseId)
      .eq("user_id", stranger.userId);
    if (fiveDays.error) throw new Error(fiveDays.error.message);
    await refile();
    const flagsAt5d = await admin
      .from("learner_flags")
      .select("flag_type")
      .eq("course_id", courseId)
      .eq("user_id", stranger.userId);
    check(
      "5 days of silence trips the 4-day threshold (old 7d would have missed it)",
      (flagsAt5d.data ?? []).some((f) => f.flag_type === "inactive_incomplete")
    );

    // Cooldown: a recent check-in (draft counts) blocks re-filing…
    await dismissRisk(stranger.userId);
    const recentMsg = await admin
      .from("learner_messages")
      .insert({
        course_id: courseId,
        user_id: stranger.userId,
        subject: "Cooldown fixture",
        body: [{ kind: "paragraph", text: "Hi" }] as never,
      })
      .select("id")
      .single();
    if (recentMsg.error) throw new Error(recentMsg.error.message);
    await refile();
    check(
      "cooldown: a check-in within 14 days blocks re-filing",
      (await openRisk(stranger.userId)).length === 0
    );
    // …and an old one doesn't.
    const backdateMsg = await admin
      .from("learner_messages")
      .update({ created_at: new Date(Date.now() - 15 * 86_400_000).toISOString() })
      .eq("id", recentMsg.data.id);
    if (backdateMsg.error) throw new Error(backdateMsg.error.message);
    await refile();
    check(
      "cooldown expires: a 15-day-old check-in no longer blocks",
      (await openRisk(stranger.userId)).length === 1
    );

    // Opt-out guard.
    await dismissRisk(stranger.userId);
    const optOutOn = await admin
      .from("enrollments")
      .update({ comms_opt_out: true })
      .eq("course_id", courseId)
      .eq("user_id", stranger.userId);
    if (optOutOn.error) throw new Error(optOutOn.error.message);
    await refile();
    check(
      "opted-out learners are never filed as learner risks",
      (await openRisk(stranger.userId)).length === 0
    );
    await admin
      .from("enrollments")
      .update({ comms_opt_out: false })
      .eq("course_id", courseId)
      .eq("user_id", stranger.userId);

    // Suppression guard (M7 table).
    const suppress = await admin
      .from("comms_suppressions")
      .upsert({ user_id: stranger.userId, reason: "hard_bounce" }, { onConflict: "user_id" });
    if (suppress.error) throw new Error(suppress.error.message);
    await refile();
    check(
      "suppressed learners are never filed as learner risks",
      (await openRisk(stranger.userId)).length === 0
    );
    await admin.from("comms_suppressions").delete().eq("user_id", stranger.userId);

    // All guards clear again → the finding files (sanity that the guards, not
    // something else, were doing the blocking).
    await refile();
    check(
      "guards lifted → the learner risk files again",
      (await openRisk(stranger.userId)).length === 1
    );

    /* ── 7. M9: course reviews — gate, upsert, RLS, rollup ── */
    console.log("\n— M9: course reviews —");
    // Ineligible (stranger has zero progress): RPC and forged direct insert
    // both fail — the gate lives in SQL twice (RPC + RLS write policies).
    const ineligibleRpc = await stranger.client.rpc("submit_course_review", {
      p_course_id: courseId,
      p_rating: 5,
      p_review_text: "forged" as string,
    });
    check(
      "ineligible learner rejected by the RPC",
      ineligibleRpc.error !== null && /not eligible/.test(ineligibleRpc.error?.message ?? "")
    );
    const ineligibleDirect = await stranger.client.from("course_reviews").insert({
      course_id: courseId,
      user_id: stranger.userId,
      rating: 5,
    });
    check("…and by a forged direct insert (RLS)", ineligibleDirect.error !== null);
    // Eligibility via the PROGRESS branch: push student to ≥70% while still
    // 'active' (sum(pct)/3 lessons = (100+80+40)/3 ≈ 73%).
    for (const [lessonId, pct] of [
      [fx.lessonA.id, 100],
      [fx.lessonB.id, 80],
      [fx.lessonC.id, 40],
    ] as const) {
      const up = await admin.from("learn_progress").upsert(
        {
          course_id: courseId,
          user_id: student.userId,
          lesson_id: lessonId,
          status: pct >= 100 ? "completed" : "in_progress",
          pct,
        },
        { onConflict: "user_id,course_id,lesson_id" }
      );
      if (up.error) throw new Error(up.error.message);
    }
    const studentState = await student.client.rpc("review_prompt_state", {
      p_course_id: courseId,
    });
    check(
      "≥70% progress makes an active learner eligible (prompt state RPC)",
      (studentState.data as { eligible?: boolean } | null)?.eligible === true
    );
    const submitted = await student.client.rpc("submit_course_review", {
      p_course_id: courseId,
      p_rating: 5,
      p_review_text: "Loved the worked examples." as string,
    });
    check("eligible learner submits (rating 5 + text)", submitted.error === null);

    // Rating bounds — RPC level and DB CHECK level.
    const zeroRating = await student.client.rpc("submit_course_review", {
      p_course_id: courseId,
      p_rating: 0,
      p_review_text: null as unknown as string,
    });
    const sixRating = await student.client.rpc("submit_course_review", {
      p_course_id: courseId,
      p_rating: 6,
      p_review_text: null as unknown as string,
    });
    check(
      "rating bounds enforced at the RPC (0 and 6 rejected)",
      zeroRating.error !== null && sixRating.error !== null
    );
    const checkViolation = await admin.from("course_reviews").insert({
      course_id: courseId,
      user_id: stranger.userId,
      rating: 7,
    });
    check(
      "rating bounds enforced at the DB (CHECK rejects 7 even for admin)",
      checkViolation.error !== null && /check/i.test(checkViolation.error?.message ?? "")
    );

    // Upsert semantics: re-submission updates the ONE row.
    const resubmitted = await student.client.rpc("submit_course_review", {
      p_course_id: courseId,
      p_rating: 3,
      p_review_text: "Revised after module 3." as string,
    });
    check("re-submission succeeds", resubmitted.error === null);
    const studentRows = await admin
      .from("course_reviews")
      .select("rating, review_text, created_at, updated_at")
      .eq("course_id", courseId)
      .eq("user_id", student.userId);
    check(
      "upsert: one row, updated rating/text, updated_at bumped",
      (studentRows.data ?? []).length === 1 &&
        studentRows.data?.[0]?.rating === 3 &&
        studentRows.data?.[0]?.review_text === "Revised after module 3." &&
        Date.parse(studentRows.data?.[0]?.updated_at ?? "") >
          Date.parse(studentRows.data?.[0]?.created_at ?? "")
    );

    // Eligibility via the COMPLETED branch (student2), then the RLS matrix.
    const flipDone = await admin
      .from("enrollments")
      .update({ status: "completed" })
      .eq("course_id", courseId)
      .eq("user_id", student2.userId);
    if (flipDone.error) throw new Error(flipDone.error.message);
    const submitted2 = await student2.client.rpc("submit_course_review", {
      p_course_id: courseId,
      p_rating: 4,
      p_review_text: null as unknown as string,
    });
    check("completed enrollment is eligible (second review lands)", submitted2.error === null);

    const studentReads = await student.client
      .from("course_reviews")
      .select("user_id")
      .eq("course_id", courseId);
    const authorReads = await author.client
      .from("course_reviews")
      .select("user_id")
      .eq("course_id", courseId);
    const strangerReads = await stranger.client
      .from("course_reviews")
      .select("user_id")
      .eq("course_id", courseId);
    check(
      "RLS: learner reads only their own review; author reads all; others none",
      (studentReads.data ?? []).length === 1 &&
        studentReads.data?.[0]?.user_id === student.userId &&
        (authorReads.data ?? []).length === 2 &&
        (strangerReads.data ?? []).length === 0
    );
    const authorSelfReview = await author.client.rpc("submit_course_review", {
      p_course_id: courseId,
      p_rating: 5,
      p_review_text: null as unknown as string,
    });
    check(
      "the author (not enrolled) can't review their own course",
      authorSelfReview.error !== null
    );

    // Rollup: correct stats, idempotent, author-only.
    await refile(); // refresh_course_analytics now also recomputes reviews
    const rollup1 = await author.client
      .from("rollup_course_reviews")
      .select("review_count, avg_rating, rating_distribution")
      .eq("course_id", courseId);
    await refile();
    const rollup2 = await author.client
      .from("rollup_course_reviews")
      .select("review_count, avg_rating, rating_distribution")
      .eq("course_id", courseId);
    const dist = (rollup1.data?.[0]?.rating_distribution ?? {}) as Record<string, number>;
    check(
      "reviews rollup: count 2, avg 3.50, distribution {3:1, 4:1}",
      rollup1.data?.length === 1 &&
        rollup1.data[0].review_count === 2 &&
        Number(rollup1.data[0].avg_rating) === 3.5 &&
        Number(dist["3"]) === 1 &&
        Number(dist["4"]) === 1 &&
        Number(dist["5"]) === 0,
      JSON.stringify(rollup1.data)
    );
    check(
      "reviews rollup is idempotent on re-run",
      rollup2.data?.length === 1 &&
        JSON.stringify(rollup1.data) === JSON.stringify(rollup2.data)
    );
    const studentRollupRead = await student.client
      .from("rollup_course_reviews")
      .select("course_id")
      .eq("course_id", courseId);
    check(
      "reviews rollup is author-only",
      studentRollupRead.error === null && (studentRollupRead.data ?? []).length === 0
    );

    // Dismissal state rides the enrollment via the RPC.
    await stranger.client.rpc("dismiss_review_prompt", { p_course_id: courseId });
    await stranger.client.rpc("dismiss_review_prompt", { p_course_id: courseId });
    const strangerState = await stranger.client.rpc("review_prompt_state", {
      p_course_id: courseId,
    });
    const parsedStranger = strangerState.data as {
      dismissCount?: number;
      dismissedAt?: string | null;
      review?: unknown;
    } | null;
    check(
      "dismissals persist (count 2 + timestamp) and ride the prompt state",
      parsedStranger?.dismissCount === 2 &&
        typeof parsedStranger?.dismissedAt === "string" &&
        parsedStranger?.review === null
    );
    const anonState = await anonClient.rpc("review_prompt_state", { p_course_id: courseId });
    check("prompt state RPC rejected for anon (revoked)", anonState.error !== null);

    /* ── 8. M10: slide feedback — ingest, latest-wins rollup, RLS ── */
    console.log("\n— M10: slide feedback —");
    const s1 = fx.deck.slides[0].id;
    const s2 = fx.deck.slides[1].id;
    const feedbackEvent = (
      reaction: "helpful" | "confusing",
      slideId: string,
      comment: string | null = null
    ) =>
      buildEvent(ctxA, {
        eventType: "slide_feedback",
        blockId: fx.deck.id,
        slideId,
        reaction,
        comment,
      });

    // Toggle sequence (SEPARATE calls → ordered server_ts): the stream stays
    // append-only; the rollup must keep only the LAST one.
    for (const r of ["helpful", "confusing", "helpful"] as const) {
      const res = await ingest(student.client, student.userId, [feedbackEvent(r, s1)]);
      if (res.error) throw new Error(res.error.message);
    }
    const ingested2 = await ingest(student2.client, student2.userId, [
      feedbackEvent("confusing", s1, "The notation jumps without explanation"),
    ]);
    const ingestedS2 = await ingest(student.client, student.userId, [
      feedbackEvent("helpful", s2),
    ]);
    check(
      "slide_feedback ingests through the existing RPC",
      ingested2.error === null && ingestedS2.error === null
    );

    // Malformed events die at the DB CHECKs even if someone bypasses Zod.
    const badReaction = await student.client.rpc("ingest_learning_events", {
      p_events: [
        {
          ...mapEventToColumns(feedbackEvent("helpful", s1), student.userId),
          client_event_id: crypto.randomUUID(),
          reaction: "meh",
        },
      ] as unknown as Json,
    });
    const longComment = await student.client.rpc("ingest_learning_events", {
      p_events: [
        {
          ...mapEventToColumns(feedbackEvent("helpful", s1), student.userId),
          client_event_id: crypto.randomUUID(),
          feedback_comment: "x".repeat(600),
        },
      ] as unknown as Json,
    });
    check(
      "malformed feedback rejected at the DB (reaction enum + comment cap CHECKs)",
      badReaction.error !== null && longComment.error !== null
    );

    await refile(); // refresh now also recomputes content feedback
    const feedbackRows = await author.client
      .from("rollup_content_feedback")
      .select("*")
      .eq("publication_id", publication.id);
    if (feedbackRows.error) throw feedbackRows.error;
    const s1Row = (feedbackRows.data ?? []).find((r) => r.slide_id === s1);
    const s2Row = (feedbackRows.data ?? []).find((r) => r.slide_id === s2);
    const lessonRow = (feedbackRows.data ?? []).find(
      (r) => r.slide_id === null && r.lesson_id === fx.lessonA.id
    );
    check(
      "latest reaction wins: 3 toggles collapse to ONE per learner (s1: 1👍 1👎, 50%)",
      s1Row?.helpful_count === 1 &&
        s1Row?.confusing_count === 1 &&
        Number(s1Row?.confusing_pct) === 50,
      JSON.stringify(s1Row)
    );
    check(
      "second slide rolls up independently (s2: 1👍 0👎)",
      s2Row?.helpful_count === 1 && s2Row?.confusing_count === 0
    );
    const s1Comments = (s1Row?.recent_comments ?? []) as {
      userId: string;
      comment: string;
      reaction: string;
    }[];
    check(
      "comments sample: newest-first non-null from the LATEST set only",
      s1Comments.length === 1 &&
        s1Comments[0].comment === "The notation jumps without explanation" &&
        s1Comments[0].reaction === "confusing" &&
        s1Comments[0].userId === student2.userId
    );
    check(
      "lesson-level row aggregates its slides (2👍 1👎)",
      lessonRow?.helpful_count === 2 &&
        lessonRow?.confusing_count === 1 &&
        (lessonRow?.recent_comments as unknown[]).length === 1
    );
    const comparable = (rows: typeof feedbackRows.data | null) =>
      JSON.stringify(
        (rows ?? [])
          .map((r) => ({
            lesson_id: r.lesson_id,
            slide_id: r.slide_id,
            helpful_count: r.helpful_count,
            confusing_count: r.confusing_count,
            confusing_pct: r.confusing_pct,
            recent_comments: r.recent_comments,
          }))
          .sort((a, b) =>
            `${a.lesson_id}${a.slide_id}`.localeCompare(`${b.lesson_id}${b.slide_id}`)
          )
      );
    const before = comparable(feedbackRows.data);
    await refile();
    const feedbackRows2 = await author.client
      .from("rollup_content_feedback")
      .select("*")
      .eq("publication_id", publication.id);
    check("feedback rollup is idempotent on re-run", before === comparable(feedbackRows2.data));
    const studentFeedbackRead = await student.client
      .from("rollup_content_feedback")
      .select("id")
      .eq("publication_id", publication.id);
    check(
      "feedback rollup is author-only",
      studentFeedbackRead.error === null && (studentFeedbackRead.data ?? []).length === 0
    );

    // The toggle UI's state source: each learner's OWN latest reactions only.
    const myFeedback = await student.client.rpc("my_slide_feedback", {
      p_course_id: courseId,
    });
    const mine = (myFeedback.data ?? {}) as Record<string, { reaction: string; comment: string | null }>;
    check(
      "my_slide_feedback returns the caller's latest per slide (toggle ended 'helpful')",
      mine[s1]?.reaction === "helpful" && mine[s2]?.reaction === "helpful"
    );
    const theirFeedback = await student2.client.rpc("my_slide_feedback", {
      p_course_id: courseId,
    });
    const theirs = (theirFeedback.data ?? {}) as Record<string, { reaction: string; comment: string | null }>;
    check(
      "…and never anyone else's (student2 sees only their own 'confusing')",
      theirs[s1]?.reaction === "confusing" &&
        theirs[s1]?.comment === "The notation jumps without explanation" &&
        theirs[s2] === undefined
    );

    /* ── 12. PERF-1 E1 (AC-PERF-14): perf_vital through the SAME RPC ── */
    console.log("\n— PERF-1 E1: perf_vital through the ingest RPC —");
    const vital = buildPerfVitalEvent({
      metric: "LCP",
      value: 2444.5,
      rating: "needs-improvement",
      route: "/learn/[slug]/[lessonId]",
      deviceClass: "desktop",
      navigationType: "navigate",
    });
    // FORGED userId in the mapped payload — the RPC must pin auth.uid().
    const vitalIngest = await ingest(student.client, student2.userId, [vital]);
    check("signed-in user posts a perf_vital batch", vitalIngest.error === null, vitalIngest.error?.message);
    check("…RPC reports 1 accepted", vitalIngest.data === 1);
    const vitalRow = await admin
      .from("learning_events")
      .select(
        "user_id, course_id, publication_id, version, lesson_id, metric_name, metric_value, metric_rating, route, device_class, navigation_type"
      )
      .eq("client_event_id", vital.clientEventId)
      .single();
    check("row lands pinned to the AUTH uid (forged id ignored)", vitalRow.data?.user_id === student.userId);
    check(
      "…with a NULL course envelope (app-scoped)",
      vitalRow.data?.course_id === null &&
        vitalRow.data?.publication_id === null &&
        vitalRow.data?.version === null &&
        vitalRow.data?.lesson_id === null
    );
    check(
      "…and the metric columns intact",
      vitalRow.data?.metric_name === "LCP" &&
        Number(vitalRow.data?.metric_value) === 2444.5 &&
        vitalRow.data?.metric_rating === "needs-improvement" &&
        vitalRow.data?.route === "/learn/[slug]/[lessonId]" &&
        vitalRow.data?.device_class === "desktop" &&
        vitalRow.data?.navigation_type === "navigate"
    );

    const vitalReplay = await ingest(student.client, student.userId, [vital]);
    check("duplicate client_event_id accepted once (replay = 0)", vitalReplay.data === 0);
    const vitalCount = await admin
      .from("learning_events")
      .select("id", { count: "exact", head: true })
      .eq("client_event_id", vital.clientEventId);
    check("…exactly one row exists", vitalCount.count === 1, `count ${vitalCount.count}`);

    // App-scoped means NO enrollment requirement: a fresh visitor (enrolled
    // in nothing — the stranger was enrolled back in the M8 fixture) reports
    // vitals fine, while their learner events still reject.
    const visitor = await provisionUser(url, anon, "visitor");
    perfUserIds.push(visitor.userId);
    const visitorVital = buildPerfVitalEvent({
      metric: "CLS",
      value: 0.083,
      rating: "good",
      route: "/dashboard",
      deviceClass: "mobile",
      navigationType: null,
    });
    const visitorIngest = await ingest(visitor.client, visitor.userId, [visitorVital]);
    check(
      "not-enrolled user can still report vitals (enrollment check skipped)",
      visitorIngest.error === null && visitorIngest.data === 1,
      visitorIngest.error?.message
    );
    const mixed = await ingest(visitor.client, visitor.userId, [
      buildPerfVitalEvent({
        metric: "TTFB",
        value: 512,
        rating: "good",
        route: "/dashboard",
        deviceClass: "mobile",
        navigationType: null,
      }),
      buildEvent(ctxA, { eventType: "session_heartbeat" }),
    ]);
    check("…but a learner event in the same batch still rejects the batch", mixed.error !== null);
    const anonVital = await anonClient.rpc("ingest_learning_events", {
      p_events: [mapEventToColumns(visitorVital, visitor.userId)] as never,
    });
    check("anon perf_vital ingest rejected (not authenticated)", anonVital.error !== null);

    // Malformed vitals die at the DB CHECK (whole batch rejects).
    const badVital = {
      ...mapEventToColumns(
        buildPerfVitalEvent({
          metric: "INP",
          value: 180,
          rating: "good",
          route: "/dashboard",
          deviceClass: "desktop",
          navigationType: null,
        }),
        student.userId
      ),
      metric_name: "FID",
    };
    const badIngest = await student.client.rpc("ingest_learning_events", {
      p_events: [badVital] as never,
    });
    check("DB CHECK rejects an unknown metric name", badIngest.error !== null);

    // Read surface: NULL course_id keeps perf rows outside the author-select
    // policy; the daily view is service-role-only.
    const authorPerfRead = await author.client
      .from("learning_events")
      .select("id")
      .eq("event_type", "perf_vital");
    check(
      "perf rows are unreadable client-side (author sees none)",
      authorPerfRead.error === null && (authorPerfRead.data ?? []).length === 0
    );
    const studentViewRead = await student.client.from("perf_vitals_daily").select("*");
    check("perf_vitals_daily denied to authenticated", studentViewRead.error !== null);
    const adminViewRead = await admin
      .from("perf_vitals_daily")
      .select("*")
      .eq("route", "/learn/[slug]/[lessonId]")
      .eq("metric_name", "LCP");
    check(
      "…and readable by the service role with aggregated percentiles",
      adminViewRead.error === null &&
        (adminViewRead.data ?? []).some(
          (r) => (r.n ?? 0) >= 1 && Number(r.p75) === 2444.5 && r.device_class === "desktop"
        ),
      adminViewRead.error?.message
    );
  } finally {
    /* ── Cleanup ── */
    console.log("\n— Cleanup —");
    const del = await author.client.from("courses").delete().eq("id", courseId);
    check("fixture course deleted", del.error === null, del.error?.message);
    const leftover = await countEvents(admin, courseId);
    check("events cascade-deleted with the course", leftover === 0, `count ${leftover}`);
    // perf_vital rows have NULL course_id — the course cascade can't reach
    // them (they cascade with the auth user, which the anon key can't delete).
    const perfDel = await admin
      .from("learning_events")
      .delete()
      .eq("event_type", "perf_vital")
      .in("user_id", perfUserIds);
    check("fixture perf_vital rows deleted", perfDel.error === null, perfDel.error?.message);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
