/**
 * Creator Tutor Console ANALYTICS — INTEGRATION suite (live Supabase; no OpenAI
 * key). TUTOR-1 Wave 5 (P5.3). Self-provisions throwaway users each run. WRITE-ONLY
 * in this package: the orchestrator applies 20260805120000_tutor_lesson_health.sql
 * BEFORE running it. DO NOT run before the migration.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) — quiz_attempt_detail
 * + the rollup_* tables are service-role writes; the cohort-floor + composite tests
 * seed them via the admin client.
 *
 * The AC matrix:
 *   1. AC-A1.3 (most_missed_questions author-gated + cohort-floored): with 6 learners
 *      on q-hard and only 4 on q-easy, the RPC returns q-hard (>=5) and OMITS q-easy
 *      (<5). q-hard's first_attempt_error_rate + second_attempt_error_rate +
 *      per-option distractor counts match a hand-computed fixture; conceptNodeIds is
 *      non-empty (anchored) and the deep link names lesson+block.
 *   2. AC-T5.6 (RLS matrix): a NON-author (enrolled learner AND a stranger) gets an
 *      ERROR / no data from most_missed_questions AND lesson_health (author-gate).
 *   3. AC-T5.5 (bad-lesson ranks #1 w/ evidence): with seeded rollups making
 *      "lesson-bad" the worst, recompute_lesson_health ranks it #1 and its inputs
 *      attribute the score to the right signals (first-attempt error dominates).
 *   4. Privacy (T5.6 half): the creator reads ZERO individual quiz_attempt_detail /
 *      learner_mastery / mastery_course_aggregate rows by any DIRECT path (RLS
 *      denies) — only aggregates come through the definer RPCs.
 *
 * Run (AFTER the migration): `npx tsx scripts/verify-tutor-analytics-console-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

dns.setDefaultResultOrder("ipv4first");

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
import { resolveLivePublicationBySlug, type PublicationRow } from "@/lib/learn/resolve";
import type { CourseDocument, QuizBlock, SlideDeckBlock } from "@/lib/course/types";
import { loadLessonHealth, loadMostMissed } from "@/lib/analytics/lessonHealth";

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
  const email = `tutor-analytics-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup ${tag} failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin ${tag} failed: ${error?.message}`);
  return { client, userId: data.user.id, email };
}

/** A course with ONE module, TWO lessons. Lesson A carries a quiz block with two
 *  MC questions (q-hard, q-easy). Both questions carry an objectiveId. */
function makeDoc(
  courseId: string,
  ownerId: string,
  ids: { moduleId: string; lessonAId: string; lessonBId: string; quizBlockId: string }
): CourseDocument {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title")];

  const quiz = createBlock("quiz", 1) as QuizBlock;
  quiz.id = ids.quizBlockId;
  quiz.title = "Checkpoint";
  quiz.questions = [
    {
      id: "q-hard",
      kind: "multiple_choice",
      prompt: "The genuinely hard one?",
      objectiveId: "obj-hard",
      choices: [
        { id: "opt-correct", text: "Right" },
        { id: "opt-distract-1", text: "Trap A" },
        { id: "opt-distract-2", text: "Trap B" },
      ],
      correctChoiceId: "opt-correct",
    },
    {
      id: "q-easy",
      kind: "multiple_choice",
      prompt: "The easy one?",
      objectiveId: "obj-easy",
      choices: [
        { id: "e-correct", text: "Right" },
        { id: "e-distract", text: "Wrong" },
      ],
      correctChoiceId: "e-correct",
    },
  ];

  const lessonA = createLesson("Bad lesson", 0);
  lessonA.id = ids.lessonAId;
  lessonA.blocks = [deck, quiz];
  const lessonB = createLesson("Healthy lesson", 1);
  lessonB.id = ids.lessonBId;
  lessonB.blocks = [createBlock("lecture_text", 0)];

  const mod = createModule("Module One", 0);
  mod.id = ids.moduleId;
  mod.lessons = [lessonA, lessonB];

  return {
    id: courseId,
    title: `Tutor analytics itest ${crypto.randomUUID().slice(0, 6)}`,
    description: "Tutor analytics integration fixture.",
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

/** Insert ONE quiz_attempt (admin) + its per-question detail row. attempt_number
 *  is 1-based per (user, block); the ordinal used by the RPC is DERIVED from
 *  created_at,id, so we stagger created_at across attempts of the same learner. */
async function seedAttemptDetail(
  admin: DB,
  args: {
    userId: string;
    courseId: string;
    publication: PublicationRow;
    blockId: string;
    attemptNumber: number;
    createdAtIso: string;
    detail: Array<{ questionId: string; correct: boolean; selected: string }>;
  }
): Promise<void> {
  const attempt = await admin
    .from("quiz_attempts")
    .insert({
      publication_id: args.publication.id,
      version: args.publication.version,
      course_id: args.courseId,
      block_id: args.blockId,
      user_id: args.userId,
      attempt_number: args.attemptNumber,
      score: args.detail.filter((d) => d.correct).length,
      max_score: Math.max(1, args.detail.length),
      submitted_at: args.createdAtIso,
    })
    .select("id")
    .single();
  if (attempt.error) throw new Error(`quiz_attempts insert: ${attempt.error.message}`);
  const attemptId = attempt.data!.id;

  const detailRows = args.detail.map((d) => ({
    attempt_id: attemptId,
    user_id: args.userId,
    course_id: args.courseId,
    publication_id: args.publication.id,
    block_id: args.blockId,
    question_id: d.questionId,
    correct: d.correct,
    response_summary: { selected: d.selected },
    created_at: args.createdAtIso,
  }));
  const det = await (admin as unknown as {
    from: (t: string) => { insert: (rows: unknown) => Promise<{ error: { message: string } | null }> };
  })
    .from("quiz_attempt_detail")
    .insert(detailRows);
  if (det.error) throw new Error(`quiz_attempt_detail insert: ${det.error.message}`);
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:tutor-analytics-console:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const stranger = await provisionUser(url, anon, "stranger");
  // 6 learners for q-hard (>= floor); q-easy will only be answered by 4 of them.
  const learners: Array<{ client: DB; userId: string; email: string }> = [];
  for (let i = 0; i < 6; i++) learners.push(await provisionUser(url, anon, `l${i}`));
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });
  console.log(`# provisioned author + stranger + ${learners.length} learners`);

  const ids = {
    moduleId: newRowId(),
    lessonAId: newRowId(),
    lessonBId: newRowId(),
    quizBlockId: newRowId(),
  };
  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, ids);
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded course");

  const cleanup = async () => {
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ── publish + enroll one learner (for the non-author RLS test) ── */
    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    check("published v1 live", v1.publication.version === 1 && v1.publication.status === "live");
    const found = await resolveLivePublicationBySlug(learners[0].client, v1.publication.slug);
    if (found.kind !== "found") throw new Error("publication not resolvable");
    const publication: PublicationRow = found.publication;

    const enrolled = await learners[0].client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: learners[0].userId });
    check("a learner self-enrolls", !enrolled.error, String(enrolled.error?.message));

    /* ── concept node anchored to the quiz block (concept mapping) ── */
    const node = await admin
      .from("concept_nodes")
      .insert({
        course_id: courseId,
        title: "Hard concept",
        status: "active",
        anchors: [{ lessonId: ids.lessonAId, blockId: ids.quizBlockId }],
      })
      .select("id")
      .single();
    check("seeded a concept node anchored to the quiz block", !node.error, String(node.error?.message));
    const nodeId = node.data?.id as string;

    /* ── seed quiz_attempt_detail: the hand-computed AC-A1.3 fixture ──
     * q-hard, 6 distinct learners on FIRST attempt:
     *   l0..l4 WRONG (l0,l1,l2 pick opt-distract-1; l3,l4 pick opt-distract-2),
     *   l5 CORRECT (opt-correct).
     *   → first_attempt_error_rate = 5/6 ≈ 0.833333
     * SECOND attempts on q-hard: l0 (wrong→right), l1 (wrong→wrong).
     *   → second_attempt_error_rate = 1/2 = 0.5
     * per_option over ALL attempts: opt-distract-1 = 3 (l0,l1,l2 first) +1 (l1 second) = 4;
     *   opt-distract-2 = 2 (l3,l4 first); opt-correct = 1 (l5 first) + 1 (l0 second) = 2.
     * q-easy: only l0..l3 answer (4 distinct → BELOW floor → OMITTED). */
    const base = Date.parse("2026-08-01T10:00:00Z");
    const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();

    // First attempts on q-hard for all six.
    const hardFirst: Array<[number, boolean, string]> = [
      [0, false, "opt-distract-1"],
      [1, false, "opt-distract-1"],
      [2, false, "opt-distract-1"],
      [3, false, "opt-distract-2"],
      [4, false, "opt-distract-2"],
      [5, true, "opt-correct"],
    ];
    for (const [li, correct, selected] of hardFirst) {
      const detail = [{ questionId: "q-hard", correct, selected }];
      // l0..l3 also answer q-easy on the SAME first attempt (4 distinct → sub-floor).
      if (li <= 3) detail.push({ questionId: "q-easy", correct: true, selected: "e-correct" });
      await seedAttemptDetail(admin, {
        userId: learners[li].userId,
        courseId,
        publication,
        blockId: ids.quizBlockId,
        attemptNumber: 1,
        createdAtIso: at(li),
        detail,
      });
    }
    // Second attempts on q-hard: l0 wrong→right, l1 wrong→wrong.
    await seedAttemptDetail(admin, {
      userId: learners[0].userId,
      courseId,
      publication,
      blockId: ids.quizBlockId,
      attemptNumber: 2,
      createdAtIso: at(60),
      detail: [{ questionId: "q-hard", correct: true, selected: "opt-correct" }],
    });
    await seedAttemptDetail(admin, {
      userId: learners[1].userId,
      courseId,
      publication,
      blockId: ids.quizBlockId,
      attemptNumber: 2,
      createdAtIso: at(61),
      detail: [{ questionId: "q-hard", correct: false, selected: "opt-distract-1" }],
    });
    console.log("# seeded quiz_attempt_detail");

    /* ── 1. AC-A1.3: most_missed_questions author-gated + cohort-floored ── */
    console.log("\n# 1. most_missed_questions (AC-A1.3)");
    const missed = await loadMostMissed(author.client, courseId);
    check("the RPC returns exactly ONE question (q-easy is sub-floor, omitted)", missed.length === 1, JSON.stringify(missed.map((m) => m.questionId)));
    const hard = missed.find((m) => m.questionId === "q-hard");
    check("q-hard survives the >=5 floor; q-easy does NOT", !!hard && !missed.some((m) => m.questionId === "q-easy"));
    check("q-hard distinctLearnerCount = 6", hard?.distinctLearnerCount === 6, String(hard?.distinctLearnerCount));
    check(
      "q-hard first_attempt_error_rate = 5/6 (≈0.8333)",
      !!hard && Math.abs(hard.firstAttemptErrorRate - 5 / 6) < 1e-4,
      String(hard?.firstAttemptErrorRate)
    );
    check(
      "q-hard second_attempt_error_rate = 1/2 (0.5)",
      !!hard && hard.secondAttemptErrorRate !== null && Math.abs(hard.secondAttemptErrorRate - 0.5) < 1e-6,
      String(hard?.secondAttemptErrorRate)
    );
    const optCount = (opt: string) => hard?.perOption.find((o) => o.option === opt)?.count ?? 0;
    check("per_option distractor count: opt-distract-1 = 4", optCount("opt-distract-1") === 4, String(optCount("opt-distract-1")));
    check("per_option distractor count: opt-distract-2 = 2", optCount("opt-distract-2") === 2, String(optCount("opt-distract-2")));
    check("per_option count: opt-correct = 2", optCount("opt-correct") === 2, String(optCount("opt-correct")));
    check("q-hard maps to the anchored concept node", !!hard && hard.conceptNodeIds.includes(nodeId), JSON.stringify(hard?.conceptNodeIds));
    check(
      "q-hard deep link names lesson + block",
      hard?.deepLink.lessonId === ids.lessonAId && hard?.deepLink.blockId === ids.quizBlockId
    );

    /* ── 2. AC-T5.6: a NON-author gets NO data from the RPCs ── */
    console.log("\n# 2. RLS matrix — non-authors are refused (AC-T5.6)");
    const learnerMissed = await callRpcRaw(learners[0].client, "most_missed_questions", { p_course_id: courseId });
    check("an ENROLLED learner is refused most_missed_questions (author-gate raise)", learnerMissed.error !== null, JSON.stringify(learnerMissed.data));
    const strangerMissed = await callRpcRaw(stranger.client, "most_missed_questions", { p_course_id: courseId });
    check("a STRANGER is refused most_missed_questions", strangerMissed.error !== null);
    const strangerHealth = await callRpcRaw(stranger.client, "lesson_health", { p_course_id: courseId });
    check("a STRANGER is refused lesson_health", strangerHealth.error !== null);
    // The loader collapses the RPC error to [] (the page renders an EmptyState).
    const learnerHealthLoad = await loadLessonHealth(learners[0].client, courseId);
    check("the loader collapses a non-author RPC error to [] (EmptyState)", learnerHealthLoad.length === 0);

    /* ── 3. AC-T5.5: bad-lesson ranks #1 with correct evidence attribution ──
     * Seed the 5 input rollups so lesson A ("Bad lesson") is worst (dominated by a
     * high first-attempt error), lesson B is clean. recompute → lesson_health ranks
     * A #1 and its inputs attribute the score to first-attempt error. */
    console.log("\n# 3. recompute_lesson_health ranks the degraded lesson #1 (AC-T5.5)");
    await seedRollups(admin, {
      courseId,
      publication,
      lessonBadId: ids.lessonAId,
      lessonGoodId: ids.lessonBId,
      quizBlockId: ids.quizBlockId,
    });
    const recompute = await callRpcRaw(admin, "recompute_lesson_health_admin", { cid: courseId });
    check("recompute_lesson_health_admin runs (service role)", recompute.error === null, String(recompute.error?.message));

    const health = await loadLessonHealth(author.client, courseId);
    check("lesson_health returns rows for the author", health.length >= 1, String(health.length));
    const ranked = health.map((h) => h.lessonId);
    check("the degraded lesson ('Bad lesson') ranks #1 by composite", ranked[0] === ids.lessonAId, JSON.stringify(ranked));
    const bad = health.find((h) => h.lessonId === ids.lessonAId);
    const good = health.find((h) => h.lessonId === ids.lessonBId);
    check("the bad lesson's composite > the good lesson's", !!bad && !!good && Number(bad.compositeScore) > Number(good.compositeScore), `${bad?.compositeScore} vs ${good?.compositeScore}`);
    check(
      "the bad lesson's score is attributed to first-attempt error + confusion (the seeded signals)",
      !!bad && Number(bad.firstAttemptErrorRate) > 0.5 && Number(bad.confusionDensity) > 0.3,
      JSON.stringify(bad)
    );
    check("rationale is NULL after a pure recompute (Terra fills it nightly)", bad?.rationale === null);

    /* ── 4. Privacy: the creator reads ZERO individual rows by any DIRECT path ── */
    console.log("\n# 4. privacy — no individual rows to the author (T5.6)");
    const directDetail = await author.client.from("quiz_attempt_detail").select("id").eq("course_id", courseId);
    check("author DIRECT-reads ZERO quiz_attempt_detail rows (RLS zero-policy)", (directDetail.data?.length ?? 0) === 0, String(directDetail.data?.length));
    const directMastery = await (author.client as unknown as {
      from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => Promise<{ data: unknown[] | null }> } };
    })
      .from("mastery_course_aggregate")
      .select("node_id")
      .eq("course_id", courseId);
    check("author DIRECT-reads ZERO mastery_course_aggregate rows (RLS zero-policy)", (directMastery.data?.length ?? 0) === 0);
    const directLearnerMastery = await (author.client as unknown as {
      from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => Promise<{ data: unknown[] | null }> } };
    })
      .from("learner_mastery")
      .select("node_id")
      .eq("course_id", courseId);
    check("author DIRECT-reads ZERO learner_mastery rows (own-only policy)", (directLearnerMastery.data?.length ?? 0) === 0);
  } finally {
    await cleanup();
    console.log("\n# cleaned up");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

/** Raw RPC call (surfaces the error object; the loaders swallow it to null/[]). */
async function callRpcRaw(
  client: DB,
  fn: string,
  args: Record<string, unknown>
): Promise<{ data: unknown; error: { message: string } | null }> {
  return (client as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc(fn, args);
}

/** Seed the five input rollups so the DEGRADED lesson is unambiguously worst. */
async function seedRollups(
  admin: DB,
  args: {
    courseId: string;
    publication: PublicationRow;
    lessonBadId: string;
    lessonGoodId: string;
    quizBlockId: string;
  }
): Promise<void> {
  const { courseId, publication, lessonBadId, lessonGoodId, quizBlockId } = args;
  const pub = { publication_id: publication.id, version: publication.version, course_id: courseId };

  const ins = async (table: string, rows: unknown[]) => {
    const { error } = await (admin as unknown as {
      from: (t: string) => { insert: (r: unknown) => Promise<{ error: { message: string } | null }> };
    })
      .from(table)
      .insert(rows);
    if (error) throw new Error(`${table} seed: ${error.message}`);
  };

  // question_stats: bad lesson has a hard question (25% correct → 75% error);
  // good lesson has an easy question (95% correct → 5% error).
  await ins("rollup_question_stats", [
    { ...pub, block_id: quizBlockId, question_id: "q-hard", lesson_id: lessonBadId, n: 41, pct_correct: 25, answer_distribution: {}, key_value: "opt-correct", discrimination: 0.05 },
    { ...pub, block_id: newRowId(), question_id: "q-easy2", lesson_id: lessonGoodId, n: 40, pct_correct: 95, answer_distribution: {}, key_value: "e-correct", discrimination: 0.4 },
  ]);
  // content_feedback (lesson-level = slide_id null): bad lesson confusing 50%, good 5%.
  await ins("rollup_content_feedback", [
    { ...pub, lesson_id: lessonBadId, block_id: null, slide_id: null, helpful_count: 5, confusing_count: 15, confusing_pct: 50, recent_comments: [] },
    { ...pub, lesson_id: lessonGoodId, block_id: null, slide_id: null, helpful_count: 18, confusing_count: 1, confusing_pct: 5, recent_comments: [] },
  ]);
  // funnel: bad lesson drops 40% entering it; good lesson 5%.
  await ins("rollup_lesson_funnel", [
    { ...pub, lesson_id: lessonBadId, lesson_order: 0, started_count: 30, completed_count: 12, dropoff_pct: 0.4 },
    { ...pub, lesson_id: lessonGoodId, lesson_order: 1, started_count: 25, completed_count: 22, dropoff_pct: 0.05 },
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
