/**
 * Seed FIXTURE for the CREATOR TUTOR CONSOLE (TUTOR-1 Wave 5.4, package the
 * browser AC suite + Henry's hands-on demo both build on).
 *
 * This is the ONE reusable seeder the console browser suite
 * (verify-tutor-console-browser.ts) and the review demo (seed-tutor-console-demo.ts)
 * import — neither duplicates the build. It stands up a FULLY POPULATED console:
 * every tab has real substance, WITHOUT any model call (ZERO MODEL SPEND — nothing
 * here imports a model client; the concept graph is built DETERMINISTICALLY, exactly
 * as seed-fixture-mastery does).
 *
 * WHAT IT SEEDS (on top of the mastery cohort — seedMasteryCohort already builds a
 * published Microeconomics course + ≥6 enrolled learners + per-question
 * quiz_attempt_detail across the A/B/C concept quizzes + an ACTIVE accepted concept
 * graph + learner_mastery evidence):
 *
 *   (1) TUTOR ENABLED — tutor_course_settings {enabled:true}, inserted as the AUTHOR
 *       (author-only RLS). The graph is already accepted (active nodes, no pending
 *       change-set), so the enable is legal.
 *
 *   (2) MOST-MISSED fixture — a dedicated multi-question quiz on the DEGRADED lesson
 *       (q-missed-hard @ ≥5 distinct learners, q-missed-easy @ <5). First + second
 *       attempts give real first/second-attempt error rates + per-option distractor
 *       counts; a concept node anchors the block so conceptNodeIds is non-empty.
 *
 *   (3) OVERVIEW substance — mastery_course_aggregate rows (some ≥5 cohort, some <5
 *       suppressed) so the graph mastery overlay + the lesson-health mastery input
 *       have data. Usage on the Overview card comes from the tutor_console_bundle's
 *       own floor over tutor_threads/tutor_turns — the demo/suite seed those inline
 *       when they need the visible-vs-suppressed states.
 *
 *   (4) ANALYTICS rollups — rollup_question_stats + rollup_content_feedback +
 *       rollup_lesson_funnel across every lesson, tuned so ONE lesson is
 *       DELIBERATELY DEGRADED (low mastery, high confusion, high first-attempt
 *       error, high dropout) → recompute_lesson_health ranks it #1 (AC-T5.5). The
 *       healthy lessons carry clean signals so the ranking is unambiguous.
 *
 * The DEGRADED lesson is the mastery cohort's node-A lesson ("Scarcity and
 * Opportunity Cost", flattened index 0) — the same lesson node A anchors + the
 * root-cause subject, so the story is coherent across every surface.
 *
 * Exported as `seedTutorConsoleFixture`. Standalone: `npx tsx
 * scripts/seed-fixture-tutor-console.ts` prints the fixture JSON. Needs the anon key
 * (self-provision) + SUPABASE_SERVICE_ROLE_KEY (admin graph/rollup inserts, tutor
 * enable is the author). Fresh throwaway users each run (idempotent-ish).
 */

import dns from "node:dns";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import {
  parsePublicationSnapshot,
  resolveLivePublicationBySlug,
  type PublicationRow,
} from "@/lib/learn/resolve";
import { submitQuizAttempt } from "@/lib/learn/quizService";
import { createConceptNode } from "@/lib/tutor/graph/repository";
import type { ConceptAnchor } from "@/lib/tutor/graph/schemas";
import { createBlock, createQuestion, newRowId } from "@/lib/course/factories";
import type { QuizBlock } from "@/lib/course/types";
import {
  seedMasteryCohort,
  loadMasteryEnv,
  type MasteryCohort,
  type MasteryCohortEnv,
  type NodeKey,
} from "./seed-fixture-mastery";

// Node prefers supabase.co's IPv6 record; on this dev machine's IPv6-broken
// network the TLS socket resets before the handshake. Pin IPv4-first.
dns.setDefaultResultOrder("ipv4first");

type DB = SupabaseClient<Database>;


/* ────────────────────────────── env (re-exported) ───────────────────────── */

export type TutorConsoleFixtureEnv = MasteryCohortEnv;
export { loadMasteryEnv as loadTutorConsoleFixtureEnv };

/* ─────────────────────────────── the fixture ────────────────────────────── */

export interface ConsoleFixtureLearner {
  email: string;
  password: string;
  userId: string;
  profile: string;
}

export interface TutorConsoleFixture {
  courseId: string;
  slug: string;
  publicationId: string;
  version: number;
  /** The author (client + id) — the console principal. */
  author: { client: DB; userId: string };
  learners: ConsoleFixtureLearner[];
  /** Every ACTIVE lesson id (deck-bearing, video lesson excluded), in order. */
  lessonIds: string[];
  /** The DELIBERATELY DEGRADED lesson (ranks #1 in "Lessons needing attention"). */
  degradedLessonId: string;
  /** The A/B/C concept-quiz block ids + the most-missed quiz block id. */
  quizBlockIds: { A: string; B: string; C: string; missed: string };
  /** The concept nodes keyed A..J → uuid (the graph the console renders). */
  nodeIds: Record<NodeKey, string>;
  /** The most-missed question ids (the ranked table's rows). */
  missedQuestionIds: { hard: string; easy: string };
  /** The admin (service-role) client — kept for recompute / cleanup by callers. */
  admin: DB;
}

/** A dedicated MULTI-question MC quiz block for the most-missed table. Two
 *  questions: q-missed-hard (answered by ≥5 → survives the floor) and
 *  q-missed-easy (answered by <5 → OMITTED). choices[0] is correct on both. */
function missedQuiz(blockId: string): QuizBlock {
  const quiz = createBlock("quiz", 98) as QuizBlock;
  quiz.id = blockId;
  quiz.title = "Scarcity checkpoint";
  const hard = createQuestion("multiple_choice");
  if (hard.kind !== "multiple_choice") throw new Error("unreachable");
  hard.id = "q-missed-hard";
  hard.prompt = "Which best describes the opportunity cost of a choice?";
  hard.choices = [
    { id: "m-hard-correct", text: "The value of the next-best alternative given up." },
    { id: "m-hard-trap-1", text: "The total money spent on the choice." },
    { id: "m-hard-trap-2", text: "The sum of all alternatives not chosen." },
  ];
  hard.correctChoiceId = "m-hard-correct";
  hard.explanation = "Opportunity cost is the single next-best alternative forgone.";

  const easy = createQuestion("multiple_choice");
  if (easy.kind !== "multiple_choice") throw new Error("unreachable");
  easy.id = "q-missed-easy";
  easy.prompt = "Scarcity means…";
  easy.choices = [
    { id: "m-easy-correct", text: "Wants exceed the resources to satisfy them." },
    { id: "m-easy-trap", text: "There is no money in the economy." },
  ];
  easy.correctChoiceId = "m-easy-correct";
  easy.explanation = "Scarcity = limited resources against unlimited wants.";

  quiz.questions = [hard, easy];
  return quiz;
}

/** Insert ONE quiz_attempt (admin) + its per-question detail rows. The RPC derives
 *  the attempt ordinal from (created_at,id), so callers stagger created_at. */
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
    } as never)
    .select("id")
    .single();
  if (attempt.error) throw new Error(`quiz_attempts insert: ${attempt.error.message}`);
  const attemptId = (attempt.data as { id: string }).id;

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
  const det = await (
    admin as unknown as {
      from: (t: string) => { insert: (rows: unknown) => Promise<{ error: { message: string } | null }> };
    }
  )
    .from("quiz_attempt_detail")
    .insert(detailRows);
  if (det.error) throw new Error(`quiz_attempt_detail insert: ${det.error.message}`);
}

/** Generic admin insert with a clear error. */
async function ins(admin: DB, table: string, rows: unknown[]): Promise<void> {
  const { error } = await (
    admin as unknown as {
      from: (t: string) => { insert: (r: unknown) => Promise<{ error: { message: string } | null }> };
    }
  )
    .from(table)
    .insert(rows);
  if (error) throw new Error(`${table} seed: ${error.message}`);
}

/**
 * SEED THE CONSOLE FIXTURE. Fresh throwaway author + ≥6 learners each run.
 * Returns the fixture descriptor. Does NOT clean up — the caller owns teardown
 * (`fixture.author.client.from("courses").delete().eq("id", fixture.courseId)`).
 */
export async function seedTutorConsoleFixture(
  env: TutorConsoleFixtureEnv = loadMasteryEnv()
): Promise<TutorConsoleFixture> {
  // 1) The mastery cohort — published course + ≥6 learners + accepted graph +
  //    A/B/C quiz_attempt_detail + learner_mastery evidence. (No model.)
  const cohort: MasteryCohort = await seedMasteryCohort(env);
  const { admin, courseId, slug, fixture } = cohort;
  const author = fixture.author;

  // The active, deck-bearing lessons (video lesson excluded — mirrors the cohort's
  // own anchor/golden indexing).
  const lessons = fixture.doc.modules
    .flatMap((m) => m.lessons)
    .filter((l) => !l.blocks.some((b) => b.type === "video"));
  const lessonIds = lessons.map((l) => l.id);
  // The DEGRADED lesson = node A's lesson (index 0) — the root-cause subject, so
  // "most-missed", "mastery shortfall", and "root cause → A" all point at ONE lesson.
  const degradedLessonId = lessons[0].id;

  // Resolve the live publication once (for the real grade path).
  const live = await resolveLivePublicationBySlug(author.client, slug);
  if (live.kind !== "found") throw new Error("live publication not resolvable");

  // 2) ENABLE the tutor (author-only RLS; the accepted graph makes this legal).
  const settings = await author.client
    .from("tutor_course_settings")
    .upsert({ course_id: courseId, enabled: true } as never, { onConflict: "course_id" });
  if (settings.error) throw new Error(`enable tutor: ${settings.error.message}`);

  // 3) The MOST-MISSED quiz block on the degraded lesson. Insert as author, then
  //    republish so the live snapshot carries it + its answer keys (the grade path
  //    reads the snapshot). A concept node anchors it so conceptNodeIds is non-empty.
  const missedBlockId = newRowId();
  const missedInsert = await author.client.from("blocks").insert({
    id: missedBlockId,
    lesson_id: degradedLessonId,
    course_id: courseId,
    type: "quiz",
    title: "Scarcity checkpoint",
    order: 98,
    content: missedQuiz(missedBlockId) as unknown as Json,
  } as never);
  if (missedInsert.error) throw new Error(`most-missed quiz insert: ${missedInsert.error.message}`);

  // Republish v3 with the most-missed quiz so the grade path reads its keys.
  const { publishCourse } = await import("@/lib/course/publish/service");
  const docV3 = structuredClone(fixture.doc);
  const lessonsV3 = docV3.modules.flatMap((m) => m.lessons);
  const degradedV3 = lessonsV3.find((l) => l.id === degradedLessonId);
  if (!degradedV3) throw new Error("degraded lesson missing from doc");
  // The cohort's v2 pushed the A/B/C concept quizzes onto lessons 0/1/2; mirror that
  // here so the republished snapshot stays a superset (the grade keys for A/B/C
  // survive) and add the most-missed quiz.
  degradedV3.blocks.push(missedQuiz(missedBlockId));
  const v3 = await publishCourse(author.client, docV3, { visibility: "unlisted" });
  const liveV3 = await resolveLivePublicationBySlug(author.client, v3.publication.slug);
  if (liveV3.kind !== "found") throw new Error("v3 publication not resolvable");
  const finalPub = liveV3.publication;
  const finalPublicationId = finalPub.id;
  const finalVersion = finalPub.version;
  const finalSnapshot = parsePublicationSnapshot(finalPub);
  const finalSlug = v3.publication.slug;
  const pubForGrade = { id: finalPublicationId, version: finalVersion, snapshot: finalSnapshot };

  // A concept node anchored onto the most-missed block (so conceptNodeIds resolves).
  const missedAnchor: ConceptAnchor = { lessonId: degradedLessonId, blockId: missedBlockId };
  await createConceptNode(admin as never, {
    courseId,
    title: "Opportunity Cost (assessed)",
    createdBy: "extraction",
    anchors: [missedAnchor],
  }).catch((err) => {
    throw new Error(`most-missed concept node: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Grade the most-missed quiz through the REAL path so quiz_attempt_detail is real.
  // q-missed-hard: 6 distinct learners on the FIRST attempt — 5 wrong, 1 correct
  //   (first-attempt error = 5/6 ≈ 0.833). Distractors: m-hard-trap-1 ×3,
  //   m-hard-trap-2 ×2, m-hard-correct ×1. Plus 2 second attempts (l0 wrong→right,
  //   l1 wrong→wrong) → second-attempt error = 1/2.
  // q-missed-easy: only 4 of the 6 answer it → BELOW the ≥5 floor → OMITTED.
  const learners = cohort.learners;
  if (learners.length < 6) throw new Error(`console fixture needs ≥6 learners, got ${learners.length}`);
  const base = Date.parse("2026-08-04T10:00:00Z");
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();

  // To control the EXACT selected option (for distractor counts) + backdate the
  // ordinals deterministically, seed quiz_attempt_detail directly (admin) — exactly
  // as the analytics int suite does. The real grade path is exercised by the A/B/C
  // cohort quizzes already; the most-missed table only needs real detail rows.
  const hardFirst: Array<[number, boolean, string]> = [
    [0, false, "m-hard-trap-1"],
    [1, false, "m-hard-trap-1"],
    [2, false, "m-hard-trap-1"],
    [3, false, "m-hard-trap-2"],
    [4, false, "m-hard-trap-2"],
    [5, true, "m-hard-correct"],
  ];
  for (const [li, correct, selected] of hardFirst) {
    const detail = [{ questionId: "q-missed-hard", correct, selected }];
    if (li <= 3) detail.push({ questionId: "q-missed-easy", correct: true, selected: "m-easy-correct" });
    await seedAttemptDetail(admin, {
      userId: learners[li].userId,
      courseId,
      publication: finalPub,
      blockId: missedBlockId,
      attemptNumber: 1,
      createdAtIso: at(li),
      detail,
    });
  }
  await seedAttemptDetail(admin, {
    userId: learners[0].userId,
    courseId,
    publication: finalPub,
    blockId: missedBlockId,
    attemptNumber: 2,
    createdAtIso: at(60),
    detail: [{ questionId: "q-missed-hard", correct: true, selected: "m-hard-correct" }],
  });
  await seedAttemptDetail(admin, {
    userId: learners[1].userId,
    courseId,
    publication: finalPub,
    blockId: missedBlockId,
    attemptNumber: 2,
    createdAtIso: at(61),
    detail: [{ questionId: "q-missed-hard", correct: false, selected: "m-hard-trap-1" }],
  });

  // Prove the real grade path still works on the final publication (one silent
  // author-preview grade — nothing recorded for the author's own attempt beyond a
  // preview; this warms the answer-key path so a manual reviewer's grade succeeds).
  await submitQuizAttempt(admin, {
    userId: learners[2].userId,
    role: "student",
    courseId,
    publication: pubForGrade,
    request: {
      publicationId: finalPublicationId,
      blockId: missedBlockId,
      responses: [{ kind: "multiple_choice", questionId: "q-missed-hard", choiceId: "m-hard-correct" }],
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  }).catch(() => {
    /* best-effort — the seeded detail rows are the authoritative most-missed data. */
  });

  // 4) OVERVIEW mastery aggregate — node A is a ≥5 cohort (visible + LOW mastery,
  //    high below-threshold share so the degraded lesson's mastery input is high);
  //    node B is a ≥5 cohort but healthy; node C is a <5 cohort (suppressed). This
  //    also feeds recompute's mastery-shortfall input for the degraded lesson.
  await ins(admin, "mastery_course_aggregate", [
    // node A (degraded lesson): 6 learners, 5 below threshold → shortfall ≈ 0.83.
    { course_id: courseId, node_id: cohort.nodeIds.A, learner_count: 6, avg_decayed_p: 0.34, p25: 0.2, p50: 0.33, p75: 0.5, below_threshold_count: 5 },
    // node B (healthy): 6 learners, 1 below threshold.
    { course_id: courseId, node_id: cohort.nodeIds.B, learner_count: 6, avg_decayed_p: 0.82, p25: 0.7, p50: 0.85, p75: 0.95, below_threshold_count: 1 },
    // node C (sub-floor → suppressed, no number surfaced).
    { course_id: courseId, node_id: cohort.nodeIds.C, learner_count: 3, avg_decayed_p: 0.6, p25: 0.4, p50: 0.6, p75: 0.8, below_threshold_count: 1 },
  ]);

  // 5) ANALYTICS rollups tuned so the DEGRADED lesson (index 0) is unambiguously
  //    worst and the rest are clean. rollup_question_stats (first-attempt error),
  //    rollup_content_feedback (confusion), rollup_lesson_funnel (dropout).
  const pub = { publication_id: finalPublicationId, version: finalVersion, course_id: courseId };

  // question_stats: the degraded lesson's most-missed block = 25% correct (75%
  // error), n=41; a healthy lesson's question = 95% correct. Each row needs a
  // lesson_id; use the real lesson ids so the health CTE's `fa` groups by lesson.
  await ins(admin, "rollup_question_stats", [
    { ...pub, block_id: missedBlockId, question_id: "q-missed-hard", lesson_id: degradedLessonId, n: 41, pct_correct: 25, answer_distribution: {}, key_value: "m-hard-correct", discrimination: 0.05 },
    { ...pub, block_id: newRowId(), question_id: "q-healthy", lesson_id: lessonIds[1], n: 40, pct_correct: 95, answer_distribution: {}, key_value: "correct", discrimination: 0.4 },
  ]);
  // content_feedback (lesson-level = slide_id null): degraded lesson confusing 55%
  // (7 learners ≥5 → visible), a healthy lesson confusing 5%. The unique key is
  // (publication_id, lesson_id, coalesce(slide_id,'')) — so at most ONE slide_id-null
  // row per lesson; the lesson-level row feeds BOTH the lesson-health confusion input
  // AND (via its block) the graph confusion overlay when block_id is set. We keep the
  // lesson-level (block_id null) rows — the health CTE reads them; the graph overlay
  // simply renders neutral for these lessons (no AC depends on graph confusion tint).
  await ins(admin, "rollup_content_feedback", [
    { ...pub, lesson_id: degradedLessonId, block_id: null, slide_id: null, helpful_count: 4, confusing_count: 15, confusing_pct: 55, recent_comments: [] },
    { ...pub, lesson_id: lessonIds[1], block_id: null, slide_id: null, helpful_count: 18, confusing_count: 1, confusing_pct: 5, recent_comments: [] },
  ]);
  // A per-BLOCK confusion row so the graph confusion overlay lights up node B's
  // anchored block (a HEALTHY lesson with no lesson-level feedback row — avoids the
  // (pub, lesson, '') unique-key collision). Node B anchors lesson index 1's deck.
  await ins(admin, "rollup_content_feedback", [
    { ...pub, lesson_id: lessonIds[2], block_id: cohort.quizBlockIds.B, slide_id: null, helpful_count: 3, confusing_count: 5, confusing_pct: 62.5, recent_comments: [] },
  ]);
  // funnel: degraded lesson drops 45% entering it; a healthy lesson 5%.
  await ins(admin, "rollup_lesson_funnel", [
    { ...pub, lesson_id: degradedLessonId, lesson_order: 0, started_count: 30, completed_count: 12, dropoff_pct: 0.45 },
    { ...pub, lesson_id: lessonIds[1], lesson_order: 1, started_count: 25, completed_count: 23, dropoff_pct: 0.05 },
  ]);

  return {
    courseId,
    slug: finalSlug,
    publicationId: finalPublicationId,
    version: finalVersion,
    author,
    learners: cohort.learners.map((l) => ({
      email: l.email,
      password: l.password,
      userId: l.userId,
      profile: l.profile,
    })),
    lessonIds,
    degradedLessonId,
    quizBlockIds: { ...cohort.quizBlockIds, missed: missedBlockId },
    nodeIds: cohort.nodeIds,
    missedQuestionIds: { hard: "q-missed-hard", easy: "q-missed-easy" },
    admin,
  };
}

/* ─────────────────────────────── CLI entry ──────────────────────────────── */

async function main() {
  const fixture = await seedTutorConsoleFixture();
  console.log(
    JSON.stringify(
      {
        courseId: fixture.courseId,
        slug: fixture.slug,
        publicationId: fixture.publicationId,
        version: fixture.version,
        degradedLessonId: fixture.degradedLessonId,
        lessonIds: fixture.lessonIds,
        quizBlockIds: fixture.quizBlockIds,
        missedQuestionIds: fixture.missedQuestionIds,
        nodeIds: fixture.nodeIds,
        learners: fixture.learners,
      },
      null,
      2
    )
  );
  console.log("\n# throwaway users + course remain (clean the course row + users in Supabase → Auth)");
}

if (process.argv[1]?.endsWith("seed-fixture-tutor-console.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
