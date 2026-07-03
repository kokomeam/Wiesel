/**
 * Publishing checks — PURE, no key / no DB / no network.
 * Run: `npx tsx scripts/verify-publish.ts`  (npm run verify:publish)
 *
 * Covers the publish pipeline's data contracts:
 *  1. Slugs — slugify, validity, collision suffixing.
 *  2. Stable stringify + sha256 + content hash (key-order invariance;
 *     answer-key changes move the hash).
 *  3. Snapshot build — every block type; node IDs preserved; quiz answers +
 *     explanations stripped into keys; deep-clone isolation; the STRICT
 *     published-quiz schema rejects an unstripped question; deep leak scan.
 *  4. Pre-flight — every error class blocks, warnings aggregate (incl. slide
 *     lint + pending images + not-ready assets), a healthy course passes.
 *  5. Diff summary — first publish, no-op, add/change/remove/move.
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
import { summarizePublishDiff, diffIsEmpty } from "@/lib/course/publish/diff";
import {
  computeContentHash,
  sha256Hex,
  stableStringify,
} from "@/lib/course/publish/hash";
import { runPublishPreflight } from "@/lib/course/publish/preflight";
import {
  PublicationAnswerKeysSchema,
  PublicationSnapshotSchema,
  PublishedQuizQuestionSchema,
  PublishRpcResultSchema,
} from "@/lib/course/publish/schemas";
import {
  buildPublicationSnapshot,
  findAnswerKeyLeaks,
} from "@/lib/course/publish/snapshot";
import {
  isValidSlug,
  publicCoursePath,
  slugifyTitle,
  suffixedSlug,
} from "@/lib/course/publish/slug";
import type {
  CourseDocument,
  HomeworkBlock,
  QuizBlock,
  SlideDeckBlock,
  VideoLessonBlock,
} from "@/lib/course/types";

let pass = 0,
  fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n} ${d}`);
  }
};

/* ───────────────────────── fixture: a full course ─────────────────────── */

function makeQuiz(): QuizBlock {
  const quiz = createBlock("quiz", 1) as QuizBlock;
  const mc = createQuestion("multiple_choice");
  if (mc.kind !== "multiple_choice") throw new Error("unreachable");
  mc.prompt = "What does a supply curve do?";
  mc.correctChoiceId = mc.choices[1].id;
  mc.explanation = "It slopes upward — price incentivizes production.";
  const ms = createQuestion("multi_select");
  if (ms.kind !== "multi_select") throw new Error("unreachable");
  ms.prompt = "Pick every prime.";
  ms.correctChoiceIds = [ms.choices[0].id, ms.choices[2].id];
  const tf = createQuestion("true_false");
  if (tf.kind !== "true_false") throw new Error("unreachable");
  tf.prompt = "The mitochondria is the powerhouse of the cell.";
  tf.correctAnswer = true;
  tf.explanation = "Classic.";
  const sa = createQuestion("short_answer");
  if (sa.kind !== "short_answer") throw new Error("unreachable");
  sa.prompt = "Name the data structure behind BFS.";
  sa.expectedAnswer = "queue";
  sa.acceptedAnswers = ["a queue", "fifo queue"];
  quiz.questions = [mc, ms, tf, sa];
  return quiz;
}

function makeDoc(): CourseDocument {
  const m1 = createModule("Foundations", 0);
  const m2 = createModule("Applications", 1);
  const l1 = createLesson("Supply and demand", 0);
  const l2 = createLesson("Market shocks", 1);
  const l3 = createLesson("Case studies", 0);

  const deck = createBlock("slide_deck", 0) as SlideDeckBlock;
  const quiz = makeQuiz();
  const homework = createBlock("homework", 2) as HomeworkBlock;
  homework.instructions = "Sketch a market in equilibrium.";
  const lecture = createBlock("lecture_text", 3);
  const example = createBlock("example", 4);
  const exercise = createBlock("exercise", 5);
  const resource = createBlock("resource", 6);
  const video = createBlock("video", 7) as VideoLessonBlock;

  l1.blocks = [deck, quiz, homework, lecture];
  l2.blocks = [example, exercise, resource, video];
  m1.lessons = [l1, l2];
  m2.lessons = [l3];

  return {
    id: newRowId(),
    title: "Microeconomics, properly taught",
    description: "Supply, demand, and why your coffee costs that much.",
    audience: "AP Econ students",
    level: "intermediate",
    plan: { outcomes: ["Read a market"], prerequisites: [], teachingStyle: "practical" },
    modules: [m1, m2],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
      ownerId: newRowId(),
      aiReadableVersion: "1.0",
    },
  };
}

async function main() {
  /* ── 1. slugs ── */
  console.log("\n1. Slugs");
  check("slugify basic", slugifyTitle("Intro to USACO!") === "intro-to-usaco");
  check("slugify diacritics", slugifyTitle("Économie française") === "economie-francaise");
  check("slugify squeezes separators", slugifyTitle("A  --  B") === "a-b");
  check("slugify empty falls back", slugifyTitle("!!!") === "course");
  check("slugify caps length", slugifyTitle("x".repeat(200)).length <= 60);
  check("valid slug accepted", isValidSlug("intro-to-usaco-2"));
  check("uppercase rejected", !isValidSlug("Intro"));
  check("double hyphen rejected", !isValidSlug("a--b"));
  check("edge hyphen rejected", !isValidSlug("-a") && !isValidSlug("a-"));
  check("empty rejected", !isValidSlug(""));
  check("suffix free base", suffixedSlug("econ", new Set()) === "econ");
  check(
    "suffix collision walks",
    suffixedSlug("econ", new Set(["econ", "econ-2"])) === "econ-3"
  );
  check("public path", publicCoursePath("econ") === "/learn/econ");

  /* ── 2. hashing ── */
  console.log("\n2. Hashing");
  check(
    "stableStringify sorts keys",
    stableStringify({ b: 1, a: { d: 2, c: 3 } }) === '{"a":{"c":3,"d":2},"b":1}'
  );
  check(
    "stableStringify drops undefined",
    stableStringify({ a: undefined, b: 1 }) === '{"b":1}'
  );
  check(
    "arrays keep order",
    stableStringify({ a: [3, 1, 2] }) === '{"a":[3,1,2]}'
  );
  check(
    "sha256 known vector",
    (await sha256Hex("abc")) ===
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  const h1 = await computeContentHash({ x: 1, y: 2 }, [{ k: "a" }]);
  const h2 = await computeContentHash({ y: 2, x: 1 }, [{ k: "a" }]);
  const h3 = await computeContentHash({ x: 1, y: 2 }, [{ k: "CHANGED" }]);
  check("hash is key-order invariant", h1 === h2);
  check("answer-key change moves the hash", h1 !== h3);

  /* ── 3. snapshot build ── */
  console.log("\n3. Snapshot build");
  const doc = makeDoc();
  const { snapshot, answerKeys } = buildPublicationSnapshot(doc);

  const parsed = PublicationSnapshotSchema.safeParse(snapshot);
  check("snapshot parses (strict quiz)", parsed.success, JSON.stringify(parsed.error?.issues?.[0]));
  check("answer keys parse", PublicationAnswerKeysSchema.safeParse(answerKeys).success);

  check("course id preserved", snapshot.course.id === doc.id);
  check(
    "module/lesson ids preserved",
    snapshot.modules[0].id === doc.modules[0].id &&
      snapshot.modules[0].lessons[1].id === doc.modules[0].lessons[1].id
  );
  const draftBlockIds = doc.modules.flatMap((m) =>
    m.lessons.flatMap((l) => l.blocks.map((b) => b.id))
  );
  const snapBlockIds = snapshot.modules.flatMap((m) =>
    m.lessons.flatMap((l) => l.blocks.map((b) => b.id))
  );
  check("all block ids preserved", stableStringify(draftBlockIds) === stableStringify(snapBlockIds));
  check(
    "every block type survives",
    new Set(snapshot.modules.flatMap((m) => m.lessons.flatMap((l) => l.blocks.map((b) => b.type))))
      .size === 8
  );

  check("no answer-key leaks in snapshot", findAnswerKeyLeaks(snapshot).length === 0);
  check(
    "leak scanner catches a plant",
    findAnswerKeyLeaks({ nested: [{ correctChoiceId: "x" }] }).length === 1
  );
  check(
    "leak scanner scopes explanation to quiz nodes",
    findAnswerKeyLeaks({ type: "example", explanation: "fine" }).length === 0 &&
      findAnswerKeyLeaks({ kind: "true_false", explanation: "leak" }).length === 1
  );

  const draftQuiz = doc.modules[0].lessons[0].blocks[1] as QuizBlock;
  const snapQuiz = snapshot.modules[0].lessons[0].blocks[1];
  check("quiz block kept in place", snapQuiz.type === "quiz" && snapQuiz.id === draftQuiz.id);
  if (snapQuiz.type === "quiz") {
    check(
      "question ids + prompts preserved",
      snapQuiz.questions.every(
        (q, i) => q.id === draftQuiz.questions[i].id && q.prompt === draftQuiz.questions[i].prompt
      )
    );
  }
  const keyBlock = answerKeys.find((k) => k.blockId === draftQuiz.id);
  check("keys extracted for the quiz block", !!keyBlock && keyBlock.keys.questions.length === 4);
  const mcKey = keyBlock?.keys.questions.find((q) => q.kind === "multiple_choice");
  const saKey = keyBlock?.keys.questions.find((q) => q.kind === "short_answer");
  check(
    "mc key carries answer + explanation",
    mcKey?.kind === "multiple_choice" &&
      mcKey.correctChoiceId.length > 0 &&
      mcKey.explanation === "It slopes upward — price incentivizes production."
  );
  check(
    "short-answer key carries accepted answers",
    saKey?.kind === "short_answer" &&
      saKey.expectedAnswer === "queue" &&
      saKey.acceptedAnswers?.length === 2
  );

  const draftDeck = doc.modules[0].lessons[0].blocks[0];
  const snapDeck = snapshot.modules[0].lessons[0].blocks[0];
  check(
    "slide deck byte-identical to draft",
    stableStringify(draftDeck) === stableStringify(snapDeck)
  );

  // Deep-clone isolation: mutating the draft never reaches the snapshot.
  const before = stableStringify(snapshot);
  doc.title = "MUTATED";
  (doc.modules[0].lessons[0].blocks[0] as SlideDeckBlock).slides.push(createSlide("title"));
  draftQuiz.questions.pop();
  check("snapshot isolated from draft mutations", stableStringify(snapshot) === before);
  doc.title = "Microeconomics, properly taught";

  check(
    "STRICT schema rejects an unstripped question",
    !PublishedQuizQuestionSchema.safeParse({
      id: "q1",
      prompt: "p",
      kind: "true_false",
      correctAnswer: true,
    }).success
  );
  check(
    "RPC result shape parses",
    PublishRpcResultSchema.safeParse({
      id: newRowId(),
      courseId: newRowId(),
      version: 1,
      slug: "econ",
      visibility: "public",
      status: "live",
      contentHash: "abc",
      publishedAt: "2026-07-02T00:00:00.000Z",
    }).success
  );

  /* ── 4. pre-flight ── */
  console.log("\n4. Pre-flight");
  const goodDoc = makeDoc();
  const good = runPublishPreflight(goodDoc);
  check("healthy course passes", good.ok, JSON.stringify(good.errors));
  check(
    "counts are right",
    good.counts.modules === 2 && good.counts.lessons === 3 && good.counts.blocks === 8
  );
  check(
    "empty lesson warns",
    good.warnings.some((w) => w.code === "EMPTY_LESSON")
  );
  check(
    "video-not-ready warns",
    good.warnings.some((w) => w.code === "VIDEO_NOT_READY")
  );

  const untitled = makeDoc();
  untitled.title = "   ";
  untitled.modules.forEach((m) => m.lessons.forEach((l) => (l.blocks = [])));
  const bad = runPublishPreflight(untitled);
  check("untitled blocks", bad.errors.some((e) => e.code === "COURSE_UNTITLED"));
  check("no-content blocks", bad.errors.some((e) => e.code === "NO_CONTENT"));
  check("not ok", !bad.ok);

  const brokenQuiz = makeDoc();
  const bq = brokenQuiz.modules[0].lessons[0].blocks[1] as QuizBlock;
  const q0 = bq.questions[0];
  if (q0.kind === "multiple_choice") q0.correctChoiceId = "nonexistent";
  const q1 = bq.questions[1];
  if (q1.kind === "multi_select") q1.correctChoiceIds = [];
  const q3 = bq.questions[3];
  if (q3.kind === "short_answer") q3.expectedAnswer = "   ";
  const badQuiz = runPublishPreflight(brokenQuiz);
  check(
    "ungradable questions are errors",
    badQuiz.errors.filter((e) => e.code === "QUIZ_QUESTION_INVALID").length === 3
  );
  check(
    "error locates the question",
    badQuiz.errors.every((e) => e.code !== "QUIZ_QUESTION_INVALID" || !!e.where?.questionId)
  );

  const pendingImg = makeDoc();
  const pDeck = pendingImg.modules[0].lessons[0].blocks[0] as SlideDeckBlock;
  pDeck.slides.push({
    ...createSlide("title"),
    template: {
      layoutId: "image_supporting",
      content: {
        imageUrl: "",
        alt: "A pending figure",
        title: { text: "Pending" },
        pendingGen: { status: "pending", visualWeight: "supporting", prompt: "x", alt: "y" },
      },
    },
  });
  const pReport = runPublishPreflight(pendingImg);
  check("pending image warns", pReport.warnings.some((w) => w.code === "IMAGE_PENDING"));
  check("pending image doesn't block", pReport.ok);

  const crowded = makeDoc();
  const cDeck = crowded.modules[0].lessons[0].blocks[0] as SlideDeckBlock;
  const slide = createSlide("title_bullets");
  const bullets = slide.elements.find((el) => el.type === "bullet_list");
  if (bullets && bullets.type === "bullet_list") {
    bullets.items = ["a", "b", "c", "d", "e", "f", "g"];
  }
  cDeck.slides.push(slide);
  const cReport = runPublishPreflight(crowded);
  check(
    "slide lint surfaces as warnings",
    cReport.warnings.some((w) => w.code.startsWith("SLIDE_"))
  );

  /* ── 5. diff summary ── */
  console.log("\n5. Diff summary");
  const base = buildPublicationSnapshot(makeDoc()).snapshot;
  const first = summarizePublishDiff(null, base);
  check(
    "first publish counts everything",
    first.firstPublish && first.lessons.added === 3 && first.blocks.added === 8
  );
  check("identical snapshots diff empty", diffIsEmpty(summarizePublishDiff(base, base)));

  const evolvedDoc = makeDoc();
  const evolved0 = buildPublicationSnapshot(evolvedDoc).snapshot;
  const same = summarizePublishDiff(evolved0, buildPublicationSnapshot(evolvedDoc).snapshot);
  check("rebuild of same doc diffs empty", diffIsEmpty(same));

  const l4 = createLesson("New lesson", 2);
  l4.blocks = [createBlock("lecture_text", 0)];
  evolvedDoc.modules[1].lessons.push(l4);
  (evolvedDoc.modules[0].lessons[0].blocks[3] as { title?: string }).title = "Renamed lecture";
  evolvedDoc.modules[0].lessons[1].blocks.splice(0, 1); // remove the example block
  const evolved = summarizePublishDiff(evolved0, buildPublicationSnapshot(evolvedDoc).snapshot);
  check("added lesson counted", evolved.lessons.added === 1);
  check("added block counted", evolved.blocks.added === 1);
  check("changed block counted", evolved.blocks.changed === 1);
  check("removed block counted", evolved.blocks.removed === 1);
  check("not first publish", !evolved.firstPublish);

  const moved = makeDoc();
  const movedBase = buildPublicationSnapshot(moved).snapshot;
  const lesson = moved.modules[0].lessons.pop()!;
  moved.modules[1].lessons.push(lesson);
  const movedDiff = summarizePublishDiff(movedBase, buildPublicationSnapshot(moved).snapshot);
  check("cross-module move counts as changed lesson", movedDiff.lessons.changed === 1);
  check("move doesn't touch blocks", movedDiff.blocks.changed === 0 && movedDiff.blocks.added === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
