/**
 * Student-runtime PURE test suite — no key, no DB, no browser.
 * Run: `npx tsx scripts/verify-learn.ts`  (npm run verify:learn)
 *
 * Covers: server-side grading (every question kind + normalization + tamper
 * shapes), the fixed completion rule (trackable detection, fractions,
 * mark-complete gating, snapshot intersection), progress-state merging,
 * course summaries ("continue where you left off"), startedAt clamping, and
 * the /api/learn Zod contracts. Fixtures run through the REAL
 * buildPublicationSnapshot so lesson shapes and answer keys are exactly what
 * production grades against.
 */

import {
  createBlock,
  createLesson,
  createModule,
  createQuestion,
  createSlide,
  newRowId,
} from "@/lib/course/factories";
import { defaultCourseTheme } from "@/lib/course/persistence";
import { buildPublicationSnapshot } from "@/lib/course/publish/snapshot";
import type { PublicationSnapshot, QuizBlockAnswerKeys } from "@/lib/course/publish/schemas";
import type {
  CourseDocument,
  HomeworkBlock,
  ImportedDeckBlock,
  LectureTextBlock,
  QuizBlock,
  SlideDeckBlock,
  VideoLessonBlock,
} from "@/lib/course/types";
import {
  computeLessonProgress,
  isCourseComplete,
  lessonTrackables,
  snapshotLessonIds,
  VIDEO_COMPLETE_PCT,
} from "@/lib/learn/completion";
import { LearnError } from "@/lib/learn/errors";
import { gradeQuiz, normalizeShortAnswer } from "@/lib/learn/grading";
import { mergeProgressState } from "@/lib/learn/progressService";
import { clampStartedAt } from "@/lib/learn/quizService";
import {
  HomeworkSubmissionRequestSchema,
  ProgressActionSchema,
  ProgressStateSchema,
  QuizSubmissionRequestSchema,
  type QuizQuestionResponse,
} from "@/lib/learn/schemas";
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

function expectLearnError(fn: () => unknown): LearnError | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof LearnError ? err : null;
  }
}

/* ─────────────────────────────── Fixture ───────────────────────────────── */
// Lesson A: 2-slide deck + 4-kind quiz  (trackable: slides + quiz)
// Lesson B: lecture text only            (untrackable → mark complete)
// Lesson C: ready video + ready deck + homework (trackable: video + deck)

const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
deck.slides = [createSlide("title"), createSlide("title_bullets")];
const [slide1, slide2] = deck.slides;

const quiz = createBlock("quiz", 1) as QuizBlock;
function question<K extends QuizBlock["questions"][number]["kind"]>(
  kind: K
): Extract<QuizBlock["questions"][number], { kind: K }> {
  const q = createQuestion(kind);
  if (q.kind !== kind) throw new Error("unreachable");
  return q as Extract<QuizBlock["questions"][number], { kind: K }>;
}
const mc = question("multiple_choice");
mc.prompt = "Pick B.";
mc.correctChoiceId = mc.choices[1].id;
mc.explanation = "B is right.";
const ms = question("multi_select");
ms.correctChoiceIds = [ms.choices[0].id, ms.choices[2].id];
const tf = question("true_false");
tf.correctAnswer = true;
const sa = question("short_answer");
sa.expectedAnswer = "Supply Curve";
sa.acceptedAnswers = ["the supply curve"];
quiz.questions = [mc, ms, tf, sa];

const lecture = createBlock("lecture_text", 0) as LectureTextBlock;

const video = createBlock("video", 0) as VideoLessonBlock;
video.asset = { ...video.asset, status: "ready", videoAssetId: newRowId() };
const importedDeck = createBlock("imported_deck", 1) as ImportedDeckBlock;
importedDeck.status = "ready";
importedDeck.pageCount = 3;
importedDeck.deckImportId = newRowId();
const homework = createBlock("homework", 2) as HomeworkBlock;

const lessonA = createLesson("Lesson A", 0);
lessonA.blocks = [deck, quiz];
const lessonB = createLesson("Lesson B", 1);
lessonB.blocks = [lecture];
const lessonC = createLesson("Lesson C", 2);
lessonC.blocks = [video, importedDeck, homework];

const mod = createModule("Module 1", 0);
mod.lessons = [lessonA, lessonB, lessonC];

const doc: CourseDocument = {
  id: newRowId(),
  title: "Learn fixture",
  description: "Pure-suite fixture.",
  plan: { outcomes: [], prerequisites: [] },
  modules: [mod],
  theme: defaultCourseTheme(),
  metadata: {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownerId: newRowId(),
    aiReadableVersion: "1.0",
  },
};

const { snapshot, answerKeys } = buildPublicationSnapshot(doc);
const quizKeys = answerKeys.find((k) => k.blockId === quiz.id)?.keys as QuizBlockAnswerKeys;
const snapLessonA = snapshot.modules[0].lessons[0];
const snapLessonB = snapshot.modules[0].lessons[1];
const snapLessonC = snapshot.modules[0].lessons[2];

async function main() {
  /* ── 1. grading ── */
  console.log("1. Grading");
  check("keys extracted for the quiz", quizKeys !== undefined && quizKeys.questions.length === 4);

  const allCorrect: QuizQuestionResponse[] = [
    { kind: "multiple_choice", questionId: mc.id, choiceId: mc.correctChoiceId },
    { kind: "multi_select", questionId: ms.id, choiceIds: [...ms.correctChoiceIds].reverse() },
    { kind: "true_false", questionId: tf.id, answer: true },
    { kind: "short_answer", questionId: sa.id, text: "  the   SUPPLY curve " },
  ];
  const perfect = gradeQuiz(quizKeys, allCorrect);
  check("perfect score", perfect.score === 4 && perfect.maxScore === 4);
  check("multi-select is order-insensitive", perfect.perQuestion[1].correct);
  check(
    "short answer normalizes case/whitespace + accepted answers",
    perfect.perQuestion[3].correct
  );
  check(
    "explanation returned only where authored",
    perfect.perQuestion[0].explanation === "B is right." &&
      perfect.perQuestion[1].explanation === undefined
  );
  check(
    "results follow key order",
    perfect.perQuestion.map((q) => q.questionId).join() === [mc, ms, tf, sa].map((q) => q.id).join()
  );

  const wrongs = gradeQuiz(quizKeys, [
    { kind: "multiple_choice", questionId: mc.id, choiceId: mc.choices[0].id },
    { kind: "multi_select", questionId: ms.id, choiceIds: [...ms.correctChoiceIds, ms.choices[1].id] },
    { kind: "true_false", questionId: tf.id, answer: false },
    { kind: "short_answer", questionId: sa.id, text: "demand curve" },
  ]);
  check("all-wrong scores 0", wrongs.score === 0 && wrongs.maxScore === 4);
  check("multi-select superset is wrong", !wrongs.perQuestion[1].correct);

  const partial = gradeQuiz(quizKeys, [
    { kind: "multiple_choice", questionId: mc.id, choiceId: mc.correctChoiceId },
    { kind: "multi_select", questionId: ms.id, choiceIds: [ms.correctChoiceIds[0]] },
  ]);
  check("subset multi-select wrong; unanswered wrong", partial.score === 1);
  check(
    "unanswered questions marked unanswered",
    !partial.perQuestion[2].answered && !partial.perQuestion[3].answered
  );

  const tampered = gradeQuiz(quizKeys, [
    { kind: "true_false", questionId: mc.id, answer: true }, // wrong KIND for an mc question
    { kind: "short_answer", questionId: "q-nonexistent", text: "x" },
    { kind: "multiple_choice", questionId: mc.id, choiceId: mc.correctChoiceId }, // dup: first wins
    { kind: "short_answer", questionId: sa.id, text: "   " },
  ]);
  check("kind mismatch = answered but wrong", tampered.perQuestion[0].answered && !tampered.perQuestion[0].correct);
  check("unknown question ids ignored", tampered.maxScore === 4);
  check("duplicate response: first wins", !tampered.perQuestion[0].correct);
  check("whitespace-only short answer = unanswered", !tampered.perQuestion[3].answered);
  check("normalizeShortAnswer collapses", normalizeShortAnswer("  A  \t B ") === "a b");

  const gradeLeaks = JSON.stringify(perfect);
  check(
    "grade payload never contains key fields",
    !/correctChoiceId|correctChoiceIds|correctAnswer|expectedAnswer|acceptedAnswers/.test(gradeLeaks)
  );

  /* ── 2. trackables + completion ── */
  console.log("\n2. Completion rule");
  const unitsA = lessonTrackables(snapLessonA);
  check(
    "lesson A tracks deck + quiz",
    unitsA.length === 2 && unitsA[0].kind === "slides" && unitsA[1].kind === "quiz"
  );
  check("lesson B has no trackables", lessonTrackables(snapLessonB).length === 0);
  const unitsC = lessonTrackables(snapLessonC);
  check(
    "lesson C tracks video + imported deck (homework never)",
    unitsC.length === 2 && unitsC[0].kind === "video" && unitsC[1].kind === "imported_deck"
  );

  const notReadyVideo = structuredClone(snapLessonC);
  const vb = notReadyVideo.blocks[0];
  if (vb.type === "video") vb.asset = { ...vb.asset, status: "processing" };
  const idb = notReadyVideo.blocks[1];
  if (idb.type === "imported_deck") idb.status = "processing";
  check(
    "unready video/deck are NOT trackable (never uncompletable)",
    lessonTrackables(notReadyVideo).length === 0
  );

  const emptyQuizLesson = structuredClone(snapLessonA);
  const qb = emptyQuizLesson.blocks[1];
  if (qb.type === "quiz") qb.questions = [];
  const db = emptyQuizLesson.blocks[0];
  if (db.type === "slide_deck") db.slides = [];
  check("empty deck/quiz are not trackable", lessonTrackables(emptyQuizLesson).length === 0);

  const half = computeLessonProgress(
    snapLessonA,
    { viewedSlides: { [deck.id]: [slide1.id] } },
    new Set()
  );
  check("1/2 slides + no attempt = 25%", half.pct === 25 && !half.completed && half.trackable);

  const slidesDone = computeLessonProgress(
    snapLessonA,
    { viewedSlides: { [deck.id]: [slide1.id, slide2.id, "slide-fake"] } },
    new Set()
  );
  check("invented slide ids don't inflate", slidesDone.pct === 50);

  const complete = computeLessonProgress(
    snapLessonA,
    { viewedSlides: { [deck.id]: [slide1.id, slide2.id] } },
    new Set([quiz.id])
  );
  check("all slides + quiz attempt completes", complete.completed && complete.pct === 100);

  const almostVideo = computeLessonProgress(
    snapLessonC,
    { videoPct: { [video.id]: VIDEO_COMPLETE_PCT - 0.5 }, viewedBlocks: [importedDeck.id] },
    new Set()
  );
  check("video at 89.5% not complete", !almostVideo.completed);
  check("incomplete pct caps at 99", almostVideo.pct <= 99);
  const videoDone = computeLessonProgress(
    snapLessonC,
    { videoPct: { [video.id]: VIDEO_COMPLETE_PCT }, viewedBlocks: [importedDeck.id] },
    new Set()
  );
  check("video at 90% + deck paged completes", videoDone.completed);

  const markB = computeLessonProgress(snapLessonB, { markedComplete: true }, new Set());
  check("untrackable lesson honors markedComplete", markB.completed && !markB.trackable);
  const markA = computeLessonProgress(
    snapLessonA,
    { markedComplete: true },
    new Set()
  );
  check("trackable lesson IGNORES markedComplete", !markA.completed);

  check(
    "snapshotLessonIds in course order",
    snapshotLessonIds(snapshot).join() === [lessonA.id, lessonB.id, lessonC.id].join()
  );
  check(
    "course complete only when every lesson is",
    !isCourseComplete(snapshot, new Set([lessonA.id])) &&
      isCourseComplete(snapshot, new Set([lessonA.id, lessonB.id, lessonC.id]))
  );
  check(
    "empty snapshot is never complete",
    !isCourseComplete({ ...snapshot, modules: [] } as PublicationSnapshot, new Set())
  );

  /* ── 3. progress-state merging ── */
  console.log("\n3. Progress-state merge");
  const merged = mergeProgressState(
    {},
    { action: "slides_viewed", lessonId: lessonA.id, blockId: deck.id, slideIds: [slide1.id, "slide-fake"] },
    snapshot
  );
  check(
    "slides merge intersects with the snapshot",
    (merged.viewedSlides?.[deck.id] ?? []).join() === slide1.id
  );
  const merged2 = mergeProgressState(
    merged,
    { action: "slides_viewed", lessonId: lessonA.id, blockId: deck.id, slideIds: [slide2.id] },
    snapshot
  );
  check("second batch accumulates", (merged2.viewedSlides?.[deck.id] ?? []).length === 2);

  const vhigh = mergeProgressState(
    { videoPct: { [video.id]: 70 } },
    { action: "video_progress", lessonId: lessonC.id, blockId: video.id, pct: 40 },
    snapshot
  );
  check("video pct is a high-water mark", vhigh.videoPct?.[video.id] === 70);

  const deckViewed = mergeProgressState(
    {},
    { action: "block_viewed", lessonId: lessonC.id, blockId: importedDeck.id },
    snapshot
  );
  check("block_viewed records the deck", deckViewed.viewedBlocks?.includes(importedDeck.id) === true);

  const badBlock = expectLearnError(() =>
    mergeProgressState(
      {},
      { action: "slides_viewed", lessonId: lessonA.id, blockId: quiz.id, slideIds: ["x"] },
      snapshot
    )
  );
  check("slides_viewed on a non-deck rejects", badBlock?.code === "invalid_request");
  const badLesson = expectLearnError(() =>
    mergeProgressState({}, { action: "lesson_opened", lessonId: newRowId() }, snapshot)
  );
  check("unknown lesson rejects", badLesson?.code === "not_found");
  const badMark = expectLearnError(() =>
    mergeProgressState({}, { action: "mark_complete", lessonId: lessonA.id }, snapshot)
  );
  check("mark_complete on a trackable lesson rejects", badMark?.code === "invalid_request");
  const okMark = mergeProgressState(
    {},
    { action: "mark_complete", lessonId: lessonB.id },
    snapshot
  );
  check("mark_complete on an untrackable lesson sets the flag", okMark.markedComplete === true);

  /* ── 4. course summary ── */
  console.log("\n4. Course summary");
  const summary = buildCourseProgressSummary(snapshot, [
    { lesson_id: lessonA.id, status: "completed", pct: 100, last_activity_at: "2026-07-01T10:00:00Z" },
    { lesson_id: lessonC.id, status: "in_progress", pct: 40, last_activity_at: "2026-07-02T09:00:00Z" },
  ]);
  check("counts completed lessons", summary.completedLessons === 1 && summary.totalLessons === 3);
  check("overall pct is the mean", summary.pct === Math.round((100 + 0 + 40) / 3));
  check("continue = most recently active unfinished lesson", summary.continueLessonId === lessonC.id);

  const fresh = buildCourseProgressSummary(snapshot, []);
  check("fresh learner continues at the first lesson", fresh.continueLessonId === lessonA.id);
  const done = buildCourseProgressSummary(
    snapshot,
    [lessonA, lessonB, lessonC].map((l) => ({
      lesson_id: l.id,
      status: "completed",
      pct: 100,
      last_activity_at: "2026-07-02T09:00:00Z",
    }))
  );
  check("all-done has no continue target", done.continueLessonId === null && done.pct === 100);

  /* ── 5. startedAt clamping ── */
  console.log("\n5. startedAt clamping");
  const now = new Date("2026-07-02T12:00:00Z");
  check("future clamps to now", clampStartedAt("2026-07-03T00:00:00Z", now) === now.toISOString());
  check(
    "older than 24h clamps to now-24h",
    clampStartedAt("2026-06-01T00:00:00Z", now) === "2026-07-01T12:00:00.000Z"
  );
  check("garbage falls back to now", clampStartedAt("not-a-date", now) === now.toISOString());
  check("absent falls back to now", clampStartedAt(undefined, now) === now.toISOString());
  check(
    "recent value passes through",
    clampStartedAt("2026-07-02T11:30:00Z", now) === new Date("2026-07-02T11:30:00Z").toISOString()
  );

  /* ── 6. contracts ── */
  console.log("\n6. Zod contracts");
  check(
    "quiz submission parses",
    QuizSubmissionRequestSchema.safeParse({
      publicationId: "p",
      blockId: "b",
      responses: allCorrect,
    }).success
  );
  check(
    "quiz submission rejects a malformed response",
    !QuizSubmissionRequestSchema.safeParse({
      publicationId: "p",
      blockId: "b",
      responses: [{ kind: "multiple_choice", questionId: "q" }],
    }).success
  );
  check(
    "homework requires text or files",
    !HomeworkSubmissionRequestSchema.safeParse({
      publicationId: "p",
      blockId: "b",
      text: "  ",
      filePaths: [],
    }).success &&
      HomeworkSubmissionRequestSchema.safeParse({
        publicationId: "p",
        blockId: "b",
        text: "done",
        filePaths: [],
      }).success &&
      HomeworkSubmissionRequestSchema.safeParse({
        publicationId: "p",
        blockId: "b",
        text: "",
        filePaths: ["u/homework/x"],
      }).success
  );
  check(
    "progress actions discriminate",
    ProgressActionSchema.safeParse({ action: "mark_complete", lessonId: "l" }).success &&
      !ProgressActionSchema.safeParse({ action: "video_progress", lessonId: "l", blockId: "b", pct: 101 }).success
  );
  check(
    "progress state tolerates empty + legacy jsonb",
    ProgressStateSchema.safeParse({}).success &&
      ProgressStateSchema.safeParse({ viewedSlides: { a: ["s"] }, markedComplete: true }).success
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
