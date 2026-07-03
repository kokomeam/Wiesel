/**
 * Student-runtime integration test against LIVE Supabase — no OpenAI key.
 * Run: `npx tsx scripts/verify-learn-int.ts`  (npm run verify:learn:int)
 * Requires SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) in .env.local —
 * grading and progress writes are service-role by design.
 *
 * Drives the REAL services + RLS end-to-end, exactly as the /api/learn routes
 * compose them:
 *   • publish → slug resolution (incl. previous_slugs redirect) → enroll
 *   • the whole happy path: open lessons, view slides, take the quiz (graded
 *     server-side, attempt recorded, explanations returned, zero key leaks),
 *     submit homework, mark untrackable lessons complete → course completion
 *     flips the enrollment
 *   • RLS matrix for every new table (student/author/outsider), the
 *     no-client-writes rules (progress, attempts, responses), the
 *     review-only-update trigger, and storage per-user paths
 *   • republish: progress + attempt numbering survive (node ids stable);
 *     "continue" targets the new lesson; enrollment never downgrades
 *   • RPC surfaces: marketplace_listings + my_learning (+ anon revocation)
 *   • unlisted visibility gating
 *
 * Throwaway *@example.com users can't be deleted with the anon key — clean
 * them in Supabase → Auth. The course is deleted at the end (cascades).
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  createBlock,
  createLesson,
  createModule,
  createQuestion,
  createSlide,
  newRowId,
} from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse, updatePublicationSettings } from "@/lib/course/publish/service";
import type {
  CourseDocument,
  HomeworkBlock,
  QuizBlock,
  SlideDeckBlock,
} from "@/lib/course/types";
import { getLearnerAccess } from "@/lib/learn/access";
import { LearnError } from "@/lib/learn/errors";
import { applyProgressAction } from "@/lib/learn/progressService";
import { submitQuizAttempt } from "@/lib/learn/quizService";
import {
  parsePublicationSnapshot,
  resolveLivePublicationBySlug,
  type PublicationRow,
} from "@/lib/learn/resolve";
import { buildCourseProgressSummary } from "@/lib/learn/summary";

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
  const email = `learn-itest-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

/* Fixture: A = deck(2 slides) + quiz(mc + sa) · B = lecture only · C = homework. */
function makeDoc(courseId: string, ownerId: string, title: string) {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];
  const quiz = createBlock("quiz", 1) as QuizBlock;
  const mc = createQuestion("multiple_choice");
  if (mc.kind !== "multiple_choice") throw new Error("unreachable");
  mc.prompt = "Pick B.";
  mc.correctChoiceId = mc.choices[1].id;
  mc.explanation = "B was correct.";
  const sa = createQuestion("short_answer");
  if (sa.kind !== "short_answer") throw new Error("unreachable");
  sa.prompt = "Name the curve.";
  sa.expectedAnswer = "Supply";
  quiz.questions = [mc, sa];
  const lessonA = createLesson("Lesson A", 0);
  lessonA.blocks = [deck, quiz];

  const lessonB = createLesson("Lesson B", 1);
  lessonB.blocks = [createBlock("lecture_text", 0)];

  const homework = createBlock("homework", 0) as HomeworkBlock;
  homework.deliverableType = "text_response";
  const lessonC = createLesson("Lesson C", 2);
  lessonC.blocks = [homework];

  const mod = createModule("Foundations", 0);
  mod.lessons = [lessonA, lessonB, lessonC];

  const doc: CourseDocument = {
    id: courseId,
    title,
    description: "Learn integration fixture.",
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
  return { doc, deck, quiz, mc, sa, lessonA, lessonB, lessonC, mod };
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
  if (!service) throw new Error("verify:learn:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const student = await provisionUser(url, anon, "student");
  const outsider = await provisionUser(url, anon, "outsider");
  const anonClient = createClient<Database>(url, anon);
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const courseId = newRowId();
  const fixture = makeDoc(courseId, author.userId, `Learn itest ${crypto.randomUUID().slice(0, 6)}`);
  const { doc, deck, quiz, mc, sa, lessonA, lessonB, lessonC } = fixture;
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded course");

  const cleanup = async () => {
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ── 1. publish + slug resolution ── */
    console.log("\n1. Publish + slug resolution");
    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    check("published v1 live", v1.publication.version === 1 && v1.publication.status === "live");
    const slug0 = v1.publication.slug;

    const anonFound = await resolveLivePublicationBySlug(anonClient, slug0);
    check("anon resolves a public slug", anonFound.kind === "found");
    check(
      "unknown slug is not_found",
      (await resolveLivePublicationBySlug(anonClient, "no-such-course-xyz")).kind === "not_found"
    );

    const renamed = `${slug0}-renamed`;
    await updatePublicationSettings(author.client, courseId, { action: "set_slug", slug: renamed });
    const redirect = await resolveLivePublicationBySlug(student.client, slug0);
    check(
      "old slug redirects to the new one",
      redirect.kind === "redirect" && redirect.slug === renamed
    );
    const found = await resolveLivePublicationBySlug(student.client, renamed);
    check("new slug resolves", found.kind === "found");
    if (found.kind !== "found") throw new Error("cannot continue without the publication");
    let publication: PublicationRow = found.publication;
    let snapshot = parsePublicationSnapshot(publication);

    /* ── 2. enrollment + access roles ── */
    console.log("\n2. Enrollment + access");
    const enrolled = await student.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: student.userId })
      .select("*")
      .single();
    check("student self-enrolls", !enrolled.error);
    check(
      "student access role",
      (await getLearnerAccess(student.client, student.userId, courseId))?.role === "student"
    );
    check(
      "author access role",
      (await getLearnerAccess(author.client, author.userId, courseId))?.role === "author"
    );
    check(
      "outsider has no access",
      (await getLearnerAccess(outsider.client, outsider.userId, courseId)) === null
    );
    const forged = await outsider.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: student.userId });
    check("can't enroll someone else", forged.error !== null);

    const ctx = {
      userId: student.userId,
      courseId,
      publicationId: publication.id,
      version: publication.version,
      snapshot,
    };

    /* ── 3. progress: server-written, client-read ── */
    console.log("\n3. Progress writes + RLS");
    const opened = await applyProgressAction(admin, ctx, {
      action: "lesson_opened",
      lessonId: lessonA.id,
    });
    check("lesson opened → in_progress 0%", opened.status === "in_progress" && opened.pct === 0);
    const p1 = await applyProgressAction(admin, ctx, {
      action: "slides_viewed",
      lessonId: lessonA.id,
      blockId: deck.id,
      slideIds: [deck.slides[0].id],
    });
    check("1/2 slides → 25%", p1.pct === 25);
    const p2 = await applyProgressAction(admin, ctx, {
      action: "slides_viewed",
      lessonId: lessonA.id,
      blockId: deck.id,
      slideIds: [deck.slides[1].id],
    });
    check("2/2 slides, quiz pending → 50%", p2.pct === 50 && p2.status === "in_progress");

    // Lost-update regression: two CONCURRENT reports for different slides of a
    // fresh lesson-B-like row must BOTH survive (optimistic-lock retry).
    await admin
      .from("learn_progress")
      .delete()
      .eq("user_id", student.userId)
      .eq("lesson_id", lessonA.id);
    await Promise.all([
      applyProgressAction(admin, ctx, {
        action: "slides_viewed",
        lessonId: lessonA.id,
        blockId: deck.id,
        slideIds: [deck.slides[0].id],
      }),
      applyProgressAction(admin, ctx, {
        action: "slides_viewed",
        lessonId: lessonA.id,
        blockId: deck.id,
        slideIds: [deck.slides[1].id],
      }),
    ]);
    const merged = await admin
      .from("learn_progress")
      .select("progress_state, pct")
      .eq("user_id", student.userId)
      .eq("lesson_id", lessonA.id)
      .single();
    const mergedState = (merged.data?.progress_state ?? {}) as {
      viewedSlides?: Record<string, string[]>;
    };
    check(
      "concurrent slide reports both survive (no lost update)",
      (mergedState.viewedSlides?.[deck.id] ?? []).length === 2 && Number(merged.data?.pct) === 50
    );

    const ownRows = await student.client
      .from("learn_progress")
      .select("*")
      .eq("course_id", courseId);
    check("student reads own progress", (ownRows.data ?? []).length === 1);
    const authorRows = await author.client
      .from("learn_progress")
      .select("*")
      .eq("course_id", courseId);
    check("author reads learner progress", (authorRows.data ?? []).length === 1);
    const outsiderRows = await outsider.client
      .from("learn_progress")
      .select("*")
      .eq("course_id", courseId);
    check("outsider reads none", (outsiderRows.data ?? []).length === 0);

    const clientInsert = await student.client.from("learn_progress").insert({
      course_id: courseId,
      user_id: student.userId,
      lesson_id: lessonB.id,
      status: "completed",
      pct: 100,
    });
    check("client can NOT insert progress", clientInsert.error !== null);
    const clientUpdate = await student.client
      .from("learn_progress")
      .update({ status: "completed", pct: 100 })
      .eq("course_id", courseId)
      .eq("user_id", student.userId)
      .select("*");
    check("client can NOT update progress", (clientUpdate.data ?? []).length === 0);

    /* ── 4. quiz grading (server-side) ── */
    console.log("\n4. Quiz grading");
    const correct = await submitQuizAttempt(admin, {
      userId: student.userId,
      role: "student",
      courseId,
      publication: { id: publication.id, version: publication.version, snapshot },
      request: {
        publicationId: publication.id,
        blockId: quiz.id,
        responses: [
          { kind: "multiple_choice", questionId: mc.id, choiceId: mc.correctChoiceId },
          { kind: "short_answer", questionId: sa.id, text: " supply " },
        ],
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    check("perfect attempt scores 2/2", correct.score === 2 && correct.maxScore === 2);
    check("attempt 1 recorded", correct.attemptNumber === 1 && correct.attemptId !== null);
    check(
      "explanation returned",
      correct.questions.find((q) => q.questionId === mc.id)?.explanation === "B was correct."
    );
    check(
      "grade payload has zero key fields",
      !/correctChoiceId|correctChoiceIds|correctAnswer|expectedAnswer|acceptedAnswers/.test(
        JSON.stringify(correct)
      )
    );
    check(
      "quiz attempt completed lesson A",
      correct.progress?.status === "completed" && correct.progress.pct === 100
    );

    const wrong = await submitQuizAttempt(admin, {
      userId: student.userId,
      role: "student",
      courseId,
      publication: { id: publication.id, version: publication.version, snapshot },
      request: {
        publicationId: publication.id,
        blockId: quiz.id,
        responses: [{ kind: "multiple_choice", questionId: mc.id, choiceId: mc.choices[0].id }],
      },
    });
    check("retake is attempt 2, graded honestly", wrong.attemptNumber === 2 && wrong.score === 0);

    const preview = await submitQuizAttempt(admin, {
      userId: author.userId,
      role: "author",
      courseId,
      publication: { id: publication.id, version: publication.version, snapshot },
      request: {
        publicationId: publication.id,
        blockId: quiz.id,
        responses: [{ kind: "multiple_choice", questionId: mc.id, choiceId: mc.correctChoiceId }],
      },
    });
    check("author preview grades but records nothing", preview.attemptId === null && preview.score === 1);
    const authorAttempts = await admin
      .from("quiz_attempts")
      .select("id")
      .eq("user_id", author.userId);
    check("no author attempt rows", (authorAttempts.data ?? []).length === 0);

    const studentAttempts = await student.client
      .from("quiz_attempts")
      .select("*")
      .eq("block_id", quiz.id)
      .order("attempt_number");
    check("student reads own attempts", (studentAttempts.data ?? []).length === 2);
    check(
      "author reads learner attempts",
      ((await author.client.from("quiz_attempts").select("id").eq("course_id", courseId)).data ?? [])
        .length === 2
    );
    check(
      "outsider reads no attempts",
      ((await outsider.client.from("quiz_attempts").select("id").eq("course_id", courseId)).data ?? [])
        .length === 0
    );
    const forgedAttempt = await student.client.from("quiz_attempts").insert({
      publication_id: publication.id,
      version: publication.version,
      course_id: courseId,
      block_id: quiz.id,
      user_id: student.userId,
      attempt_number: 99,
      score: 2,
      max_score: 2,
    });
    check("client can NOT insert an attempt (no self-grading)", forgedAttempt.error !== null);

    const responses = await student.client
      .from("question_responses")
      .select("*")
      .eq("attempt_id", correct.attemptId as string);
    check("student reads own responses", (responses.data ?? []).length === 2);
    check(
      "outsider reads no responses",
      (
        (await outsider.client
          .from("question_responses")
          .select("id")
          .eq("attempt_id", correct.attemptId as string)).data ?? []
      ).length === 0
    );
    const keysVisible = await student.client
      .from("quiz_answer_keys")
      .select("*")
      .eq("publication_id", publication.id);
    check("answer keys stay invisible to the student", (keysVisible.data ?? []).length === 0);

    /* ── 5. homework submissions ── */
    console.log("\n5. Homework");
    const homeworkBlock = lessonC.blocks[0];
    const submission = await student.client
      .from("homework_submissions")
      .insert({
        publication_id: publication.id,
        course_id: courseId,
        block_id: homeworkBlock.id,
        user_id: student.userId,
        content: { text: "My essay." },
        file_paths: [],
      })
      .select("*")
      .single();
    check("enrolled student submits homework", !submission.error && submission.data !== null);
    const outsiderSub = await outsider.client.from("homework_submissions").insert({
      publication_id: publication.id,
      course_id: courseId,
      block_id: homeworkBlock.id,
      user_id: outsider.userId,
      content: { text: "sneak" },
      file_paths: [],
    });
    check("non-enrolled can NOT submit", outsiderSub.error !== null);
    const forgedSub = await student.client.from("homework_submissions").insert({
      publication_id: publication.id,
      course_id: courseId,
      block_id: homeworkBlock.id,
      user_id: author.userId,
      content: { text: "as someone else" },
      file_paths: [],
    });
    check("can't submit as someone else", forgedSub.error !== null);

    const subId = submission.data!.id;
    const studentEdit = await student.client
      .from("homework_submissions")
      .update({ content: { text: "edited!" } })
      .eq("id", subId)
      .select("*");
    check("student can NOT edit after submitting", (studentEdit.data ?? []).length === 0);
    const studentSelfReview = await student.client
      .from("homework_submissions")
      .update({ status: "reviewed" })
      .eq("id", subId)
      .select("*");
    check("student can NOT self-review", (studentSelfReview.data ?? []).length === 0);

    const authorContentEdit = await author.client
      .from("homework_submissions")
      .update({ content: { text: "rewritten by author" } })
      .eq("id", subId);
    check(
      "author can NOT rewrite submitted content (trigger)",
      authorContentEdit.error !== null &&
        authorContentEdit.error.message.includes("review status")
    );
    const reviewed = await author.client
      .from("homework_submissions")
      .update({ status: "reviewed" })
      .eq("id", subId)
      .select("status")
      .single();
    check("author marks reviewed", reviewed.data?.status === "reviewed");
    check(
      "outsider sees no submissions",
      (
        (await outsider.client.from("homework_submissions").select("id").eq("course_id", courseId))
          .data ?? []
      ).length === 0
    );

    /* ── 6. completion cascade ── */
    console.log("\n6. Completion cascade");
    const badMark = await applyProgressAction(admin, ctx, {
      action: "mark_complete",
      lessonId: lessonA.id,
    }).then(
      () => null,
      (err) => (err instanceof LearnError ? err : null)
    );
    check("trackable lesson refuses manual completion", badMark?.code === "invalid_request");

    const doneB = await applyProgressAction(admin, ctx, {
      action: "mark_complete",
      lessonId: lessonB.id,
    });
    check("lesson B marked complete", doneB.status === "completed" && !doneB.courseCompleted);
    const doneC = await applyProgressAction(admin, ctx, {
      action: "mark_complete",
      lessonId: lessonC.id,
    });
    check("last lesson completes the course", doneC.courseCompleted);
    const enrollment = await student.client
      .from("enrollments")
      .select("status")
      .eq("course_id", courseId)
      .eq("user_id", student.userId)
      .single();
    check("enrollment flipped to completed", enrollment.data?.status === "completed");

    /* ── 7. republish resilience ── */
    console.log("\n7. Republish");
    const lessonD = createLesson("Lesson D", 3);
    lessonD.blocks = [createBlock("lecture_text", 0)];
    const draft2: CourseDocument = structuredClone(doc);
    draft2.modules[0].lessons = [...draft2.modules[0].lessons, lessonD];
    // Insert only the NEW rows (the rest already exist).
    const rows2 = courseDocToRows(draft2, author.userId);
    const lessonInsert = await author.client
      .from("lessons")
      .insert(rows2.lessons.filter((l) => l.id === lessonD.id));
    if (lessonInsert.error) throw new Error(`lesson D insert: ${lessonInsert.error.message}`);
    const blockInsert = await author.client
      .from("blocks")
      .insert(rows2.blocks.filter((b) => b.id === lessonD.blocks[0].id));
    if (blockInsert.error) throw new Error(`block D insert: ${blockInsert.error.message}`);

    const v2 = await publishCourse(author.client, draft2, {});
    check("v2 published", v2.publication.version === 2);
    const live2 = await resolveLivePublicationBySlug(student.client, renamed);
    if (live2.kind !== "found") throw new Error("v2 not resolvable");
    publication = live2.publication;
    snapshot = parsePublicationSnapshot(publication);
    check("live snapshot now has 4 lessons", snapshot.modules[0].lessons.length === 4);

    const ctx2 = { ...ctx, publicationId: publication.id, version: publication.version, snapshot };
    const stillDone = await applyProgressAction(admin, ctx2, {
      action: "lesson_opened",
      lessonId: lessonA.id,
    });
    check("lesson A stays completed across versions", stillDone.status === "completed");

    const attempt3 = await submitQuizAttempt(admin, {
      userId: student.userId,
      role: "student",
      courseId,
      publication: { id: publication.id, version: publication.version, snapshot },
      request: {
        publicationId: publication.id,
        blockId: quiz.id,
        responses: [{ kind: "multiple_choice", questionId: mc.id, choiceId: mc.correctChoiceId }],
      },
    });
    check("attempt numbering continues across versions", attempt3.attemptNumber === 3);
    check(
      "enrollment never downgrades after a republish",
      (
        await student.client
          .from("enrollments")
          .select("status")
          .eq("course_id", courseId)
          .eq("user_id", student.userId)
          .single()
      ).data?.status === "completed"
    );

    const progressRows = await student.client
      .from("learn_progress")
      .select("lesson_id, status, pct, last_activity_at")
      .eq("course_id", courseId);
    const summary = buildCourseProgressSummary(snapshot, progressRows.data ?? []);
    check(
      "summary: 3/4 complete, continue = the new lesson",
      summary.completedLessons === 3 && summary.continueLessonId === lessonD.id
    );

    /* ── 8. RPC surfaces ── */
    console.log("\n8. RPCs");
    const listings = await student.client.rpc("marketplace_listings");
    const listing = (listings.data ?? []).find((l) => l.course_id === courseId);
    check(
      "marketplace listing has real metadata",
      listing !== undefined && listing.lesson_count === 4 && listing.title === doc.title
    );
    const anonListings = await anonClient.rpc("marketplace_listings");
    check("anon can NOT call marketplace_listings", anonListings.error !== null);

    const learning = await student.client.rpc("my_learning");
    const mine = (learning.data ?? []).find((l) => l.course_id === courseId);
    check(
      "my_learning: counts + status",
      mine !== undefined &&
        mine.total_lessons === 4 &&
        mine.completed_lessons === 3 &&
        mine.enrollment_status === "completed"
    );
    check(
      "my_learning empty for the outsider",
      ((await outsider.client.rpc("my_learning")).data ?? []).find(
        (l) => l.course_id === courseId
      ) === undefined
    );

    /* ── 9. unlisted visibility ── */
    console.log("\n9. Unlisted");
    await updatePublicationSettings(author.client, courseId, {
      action: "set_visibility",
      visibility: "unlisted",
    });
    check(
      "anon can no longer resolve",
      (await resolveLivePublicationBySlug(anonClient, renamed)).kind === "not_found"
    );
    check(
      "signed-in student still resolves (link possession)",
      (await resolveLivePublicationBySlug(student.client, renamed)).kind === "found"
    );
    const unlistedListings = await student.client.rpc("marketplace_listings");
    check(
      "unlisted course leaves the marketplace",
      (unlistedListings.data ?? []).find((l) => l.course_id === courseId) === undefined
    );

    /* ── 10. storage per-user paths ── */
    console.log("\n10. Storage");
    const ownPath = `${student.userId}/homework/${courseId}/test-${crypto.randomUUID().slice(0, 6)}.txt`;
    const ownUpload = await student.client.storage
      .from("course-assets")
      .upload(ownPath, new Blob(["hello"], { type: "text/plain" }));
    check("student uploads under own uid folder", ownUpload.error === null);
    const foreignUpload = await student.client.storage
      .from("course-assets")
      .upload(`${author.userId}/homework/sneak.txt`, new Blob(["nope"], { type: "text/plain" }));
    check("student can NOT upload into another user's folder", foreignUpload.error !== null);
    await student.client.storage.from("course-assets").remove([ownPath]);
  } finally {
    await cleanup();
    console.log("\n# cleaned up course (throwaway users remain — see header)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
