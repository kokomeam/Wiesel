/**
 * Seed FIXTURE analytics for the maintenance-agent milestone (M5 acceptance:
 * "with seeded fixture analytics … a scheduled run produces ≥1 correct
 * evidence-annotated proposal on a deliberately-bad fixture quiz").
 *
 * Run: `npx tsx scripts/seed-fixture-analytics.ts`  (npm run seed:fixtures)
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env.local.
 *
 * What it builds (also exported as `seedFixture` for verify-maintenance-int):
 *   • a throwaway author + 2 learners, a published 3-lesson course whose quiz
 *     has a DELIBERATELY-BAD question (ambiguous wording, magnetic distractor)
 *   • hand-seeded ROLLUP rows at claimed scale (n=41, 36% correct, distractor
 *     3× the key, discrimination 0.05) — deterministic, no 41-user provisioning
 *   • a small amount of REAL learner state (enrollment, progress, an attempt)
 *   • a learner_flags row (repeated_quiz_failure) for the Comms path
 *
 * NOTE: deliberately does NOT call refresh_course_analytics afterwards — the
 * recompute would derive stats from the (small) real data and overwrite the
 * claimed-scale rollups. Threshold filing over these rollups is exercised by
 * the verify suite via direct finding seeding + the run's adoption path.
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
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
import { resolveLivePublicationBySlug } from "@/lib/learn/resolve";

type DB = SupabaseClient<Database>;

export function loadFixtureEnv(): { url: string; anon: string; service?: string } {
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

async function provision(url: string, anon: string, tag: string) {
  const email = `maint-fixture-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

export interface Fixture {
  courseId: string;
  author: { client: DB; userId: string };
  student: { client: DB; userId: string };
  student2: { client: DB; userId: string };
  publicationId: string;
  version: number;
  slug: string;
  lessonA: { id: string; title: string };
  quizBlockId: string;
  badQuestionId: string;
  badKeyChoiceId: string;
  badDistractorChoiceId: string;
}

export async function seedFixture(env: {
  url: string;
  anon: string;
  service: string;
}): Promise<Fixture> {
  const admin = createClient<Database>(env.url, env.service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const author = await provision(env.url, env.anon, "author");
  const student = await provision(env.url, env.anon, "student");
  const student2 = await provision(env.url, env.anon, "student2");

  // ── The course: 3 lessons; lesson A carries the deliberately-bad quiz. ──
  const courseId = crypto.randomUUID();
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];
  const quiz = createBlock("quiz", 1) as QuizBlock;
  quiz.title = "Supply and demand check";
  const bad = createQuestion("multiple_choice");
  if (bad.kind !== "multiple_choice") throw new Error("unreachable");
  // Deliberately ambiguous: "increases" reads as demand-shift OR quantity move.
  bad.prompt = "When the price of a good falls, demand increases. What happens?";
  bad.choices[0].text = "Demand increases";
  bad.choices[1].text = "Quantity demanded increases";
  bad.choices[2].text = "Supply decreases";
  bad.correctChoiceId = bad.choices[1].id;
  bad.explanation = "A price change moves along the demand curve.";
  const ok = createQuestion("true_false");
  if (ok.kind !== "true_false") throw new Error("unreachable");
  ok.prompt = "A demand curve slopes downward.";
  ok.correctAnswer = true;
  quiz.questions = [bad, ok];
  const lessonA = createLesson("Supply and demand", 0);
  lessonA.blocks = [deck, quiz];
  const lessonB = createLesson("Market equilibrium", 1);
  lessonB.blocks = [createBlock("lecture_text", 0)];
  const lessonC = createLesson("Elasticity", 2);
  lessonC.blocks = [createBlock("lecture_text", 0)];
  const mod = createModule("Micro foundations", 0);
  mod.lessons = [lessonA, lessonB, lessonC];
  const doc: CourseDocument = {
    id: courseId,
    title: `Econ fixture ${crypto.randomUUID().slice(0, 6)}`,
    description: "Maintenance-agent fixture.",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId: author.userId,
      aiReadableVersion: "1.0",
    },
  };
  const rows = courseDocToRows(doc, author.userId);
  for (const [table, data] of [
    ["courses", rows.course],
    ["modules", rows.modules],
    ["lessons", rows.lessons],
    ["blocks", rows.blocks],
  ] as const) {
    const { error } = await author.client.from(table).insert(data as never);
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }
  const published = await publishCourse(author.client, doc, {});
  const live = await resolveLivePublicationBySlug(author.client, published.publication.slug);
  if (live.kind !== "found") throw new Error("publication not resolvable");
  const publicationId = live.publication.id;
  const version = live.publication.version;

  // ── Real learner state (small): enrollments + a little progress. ──
  for (const u of [student, student2]) {
    const { error } = await u.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: u.userId });
    if (error) throw new Error(`enroll: ${error.message}`);
  }
  // NOTE: multi-row PostgREST inserts unify columns across rows (a missing key
  // becomes an explicit null) — every row must carry last_activity_at.
  const progress = await admin.from("learn_progress").insert([
    {
      course_id: courseId,
      user_id: student.userId,
      lesson_id: lessonA.id,
      status: "in_progress",
      pct: 60,
      last_activity_at: new Date().toISOString(),
    },
    {
      course_id: courseId,
      user_id: student2.userId,
      lesson_id: lessonA.id,
      status: "in_progress",
      pct: 40,
      last_activity_at: new Date(Date.now() - 9 * 86_400_000).toISOString(),
    },
  ]);
  if (progress.error) throw new Error(progress.error.message);

  // ── Claimed-scale rollups: the deliberately-bad question's damning stats. ──
  const distribution: Record<string, number> = {
    [bad.choices[0].id]: 24, // the magnetic distractor — 3× the key
    [bad.choices[1].id]: 8, // the key
    [bad.choices[2].id]: 9,
  };
  const qstats = await admin.from("rollup_question_stats").upsert(
    [
      {
        course_id: courseId,
        publication_id: publicationId,
        version,
        block_id: quiz.id,
        question_id: bad.id,
        lesson_id: lessonA.id,
        n: 41,
        pct_correct: 36,
        answer_distribution: distribution as unknown as Json,
        key_value: bad.correctChoiceId,
        discrimination: 0.05,
      },
      {
        course_id: courseId,
        publication_id: publicationId,
        version,
        block_id: quiz.id,
        question_id: ok.id,
        lesson_id: lessonA.id,
        n: 41,
        pct_correct: 88,
        answer_distribution: { true: 36, false: 5 } as unknown as Json,
        key_value: "true",
        discrimination: 0.42,
      },
    ],
    { onConflict: "publication_id,question_id" }
  );
  if (qstats.error) throw new Error(qstats.error.message);

  const funnel = await admin.from("rollup_lesson_funnel").upsert(
    [
      {
        course_id: courseId,
        publication_id: publicationId,
        version,
        lesson_id: lessonA.id,
        lesson_order: 1,
        started_count: 41,
        completed_count: 24,
        dropoff_pct: null,
      },
      {
        course_id: courseId,
        publication_id: publicationId,
        version,
        lesson_id: lessonB.id,
        lesson_order: 2,
        started_count: 19,
        completed_count: 14,
        dropoff_pct: 0.5366,
      },
      {
        course_id: courseId,
        publication_id: publicationId,
        version,
        lesson_id: lessonC.id,
        lesson_order: 3,
        started_count: 12,
        completed_count: 9,
        dropoff_pct: 0.3684,
      },
    ],
    { onConflict: "publication_id,lesson_id" }
  );
  if (funnel.error) throw new Error(funnel.error.message);

  // ── The struggling learner (Comms path). ──
  const flag = await admin.from("learner_flags").upsert(
    [
      {
        course_id: courseId,
        user_id: student2.userId,
        flag_type: "repeated_quiz_failure",
        detail: {
          quizzes: [{ blockId: quiz.id, failedAttempts: 2, lastScorePct: 30 }],
        } as unknown as Json,
      },
    ],
    { onConflict: "course_id,user_id,flag_type" }
  );
  if (flag.error) throw new Error(flag.error.message);

  return {
    courseId,
    author,
    student,
    student2,
    publicationId,
    version,
    slug: published.publication.slug,
    lessonA: { id: lessonA.id, title: lessonA.title },
    quizBlockId: quiz.id,
    badQuestionId: bad.id,
    badKeyChoiceId: bad.correctChoiceId,
    badDistractorChoiceId: bad.choices[0].id,
  };
}

async function main() {
  const env = loadFixtureEnv();
  if (!env.url || !env.anon) throw new Error("Missing Supabase env in .env.local");
  if (!env.service) throw new Error("seed:fixtures needs SUPABASE_SERVICE_ROLE_KEY");
  const fx = await seedFixture({ url: env.url, anon: env.anon, service: env.service });
  console.log(`\nSeeded fixture course: ${fx.courseId}`);
  console.log(`  live publication: ${fx.publicationId} (v${fx.version}, /learn/${fx.slug})`);
  console.log(`  deliberately-bad question: ${fx.badQuestionId} in quiz ${fx.quizBlockId}`);
  console.log(`  struggling learner: ${fx.student2.userId}`);
  console.log(
    "\nOpen the studio on this course and ask the agent to 'analyze course health',"
  );
  console.log("or POST /api/ai/maintenance/cron after queueing a run.");
}

// Only run as a CLI (the verify suite imports seedFixture instead).
if (process.argv[1]?.endsWith("seed-fixture-analytics.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
