/**
 * Generation VALIDATION / REPAIR / LINT checks — pure, no key/DB.
 * Run: `npx tsx scripts/verify-validation.ts`
 *
 * Locks in the correctness layer that replaces the heavy critique pass:
 *  1. Placeholder + empty slide detection (the leftover "Section title" starter).
 *  2. validateLessonGeneration finds every hard failure class against the plan
 *     (missing specs, placeholder, duplicate spec, required quiz/homework, short
 *     deck) and passes a fully-covered deck.
 *  3. The deterministic repair patches remove placeholders (and junk/empty decks)
 *     without a model, and a built-out deck then validates clean.
 *  4. The PLAN depth floor re-asks a thin NON-micro lesson and exempts a micro one.
 *  5. The lint warnings + the light-review trigger threshold behave.
 */

import {
  createBlock,
  createSlide,
  createStructuredSlide,
} from "@/lib/course/factories";
import { applyCoursePatch } from "@/lib/course/patches";
import { defaultCourseTheme } from "@/lib/course/persistence";
import type { CourseDocument, QuizBlock, SlideDeckBlock } from "@/lib/course/types";
import { coerceOutline, lessonDepthShortfall, type LessonOutline } from "@/lib/ai/outline";
import { isEmptySlide, isPlaceholderSlide } from "@/lib/ai/slideDiagnostics";
import {
  hasModelRepairableFailure,
  placeholderRepairPatches,
  pruneEmptyDeckPatches,
  validateLessonGeneration,
} from "@/lib/ai/validation";
import { lintLessonGeneration } from "@/lib/ai/lintGeneration";
import { shouldRunLightReview } from "@/lib/ai/lightReview";

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

const NOW = "2026-06-18T00:00:00.000Z";

function freshDoc(): { doc: CourseDocument; lessonId: string } {
  const lessonId = "lesson-1";
  const doc: CourseDocument = {
    id: "course-1",
    title: "Algorithms 101",
    description: "Core patterns.",
    audience: "beginners",
    level: "beginner",
    plan: { outcomes: ["Apply greedy"], prerequisites: [], teachingStyle: "concrete" },
    modules: [
      {
        id: "mod-1",
        type: "module",
        title: "Foundations",
        order: 0,
        lessons: [{ id: lessonId, type: "lesson", title: "Greedy", order: 0, blocks: [] }],
      },
    ],
    theme: defaultCourseTheme(),
    metadata: { createdAt: NOW, updatedAt: NOW, aiReadableVersion: "1.0" },
  };
  return { doc, lessonId };
}

/** Build an N-slide lesson outline (spec ids s1..sN), optional quiz/homework/micro. */
function makeOutline(n: number, opts: { quiz?: boolean; hw?: boolean; micro?: boolean; code?: boolean } = {}): LessonOutline {
  const slides = Array.from({ length: n }, (_, i) => ({
    segmentId: "seg",
    title: `Slide ${i + 1}`,
    teachingGoal: "understand it",
    role: opts.code && i === 0 ? "code_walkthrough" : "concept_intro",
    kind: "core",
    layout: opts.code && i === 0 ? "code_walkthrough_steps" : "prose",
    depth: "definition",
    keyPoints: ["a real point"],
    notes: "exact detail",
    visualIntent: null,
    requiredElements: null,
    speakerNotesGoal: "explain it",
  }));
  const { outline, errors } = coerceOutline({
    objective: "learn the thing",
    targetStudent: "beginners",
    estimatedMinutes: 12,
    microLesson: opts.micro ?? false,
    segments: [{ id: "seg", name: "S", purpose: "concept_intro", targetSlideCount: n }],
    slides,
    quizPlan: opts.quiz ? { questionCount: 3, targetSkills: [{ skill: "x", difficulty: "easy" }] } : null,
    homeworkPlan: opts.hw ? { exerciseCount: 1, targetSkills: ["x"], difficulty: "easy" } : null,
  });
  if (!outline) throw new Error(`makeOutline failed: ${errors.join("; ")}`);
  return outline;
}

/** A slide_deck block whose slides carry the given spec ids (null = unstamped),
 *  optionally prefixed by a default placeholder starter slide. */
function deckWith(specIds: (string | null)[], opts: { placeholder?: boolean } = {}): SlideDeckBlock {
  const block = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  const slides = [];
  if (opts.placeholder) slides.push(createSlide("title")); // the studio default starter
  for (const id of specIds) {
    const s = createStructuredSlide("prose");
    if (id) s.ai.specId = id;
    s.speakerNotes = "what to say";
    slides.push(s);
  }
  block.slides = slides;
  return block;
}

function withDeck(deck: SlideDeckBlock, extra: { quiz?: boolean } = {}): { doc: CourseDocument; lessonId: string } {
  const { doc, lessonId } = freshDoc();
  doc.modules[0].lessons[0].blocks.push(deck);
  if (extra.quiz) {
    const quiz = createBlock("quiz") as QuizBlock;
    quiz.questions = [];
    doc.modules[0].lessons[0].blocks.push(quiz);
  }
  return { doc, lessonId };
}

function main() {
  // ── 1. Placeholder + empty detection ───────────────────────────────────────
  console.log("\n# placeholder / empty detection");
  const placeholder = createSlide("title");
  check("the studio default starter slide is detected as a placeholder", isPlaceholderSlide(placeholder));
  const structured = createStructuredSlide("prose");
  check("a structured (authored) slide is NOT a placeholder", !isPlaceholderSlide(structured));
  const filledFlat = createSlide("title");
  filledFlat.elements = filledFlat.elements.map((e) =>
    e.type === "heading" ? { ...e, text: "Binary search, explained" } : e
  );
  check("a filled-in flat slide (real title) is NOT a placeholder", !isPlaceholderSlide(filledFlat));
  const stampedFlat = createSlide("title");
  stampedFlat.ai.specId = "s1";
  check("a flat slide tagged with a spec id is NOT a placeholder", !isPlaceholderSlide(stampedFlat));
  check("a structured slide with content is NOT empty", !isEmptySlide(structured));

  // ── 2. validateLessonGeneration — hard failure classes ──────────────────────
  console.log("\n# validateLessonGeneration");
  const outline3 = makeOutline(3);

  const covered = withDeck(deckWith(["s1", "s2", "s3"]));
  const okReport = validateLessonGeneration(covered.doc, covered.lessonId, outline3, {});
  check("a fully-covered 3-slide deck validates ok", okReport.ok, JSON.stringify(okReport.issues));
  check("ok report lists no missing specs", okReport.missingSpecIds.length === 0);

  const missing = withDeck(deckWith(["s1", "s2"]));
  const missReport = validateLessonGeneration(missing.doc, missing.lessonId, outline3, {});
  check("a deck missing a planned slide fails (MISSING_SLIDE_SPECS)", !missReport.ok && missReport.issues.some((i) => i.code === "MISSING_SLIDE_SPECS"));
  check("the missing spec is identified (s3)", missReport.missingSpecIds.join(",") === "s3", missReport.missingSpecIds.join(","));
  check("missing-spec failure is model-repairable", hasModelRepairableFailure(missReport));

  const withPlaceholder = withDeck(deckWith(["s1", "s2", "s3"], { placeholder: true }));
  const phReport = validateLessonGeneration(withPlaceholder.doc, withPlaceholder.lessonId, outline3, {});
  check("a leftover placeholder fails validation (PLACEHOLDER_SLIDE)", !phReport.ok && phReport.issues.some((i) => i.code === "PLACEHOLDER_SLIDE"));
  check("the placeholder slide id is reported", phReport.placeholderSlideIds.length === 1);

  const dup = withDeck(deckWith(["s1", "s2", "s2"]));
  const dupReport = validateLessonGeneration(dup.doc, dup.lessonId, outline3, {});
  check("a duplicated primary spec fails (DUPLICATE_SPEC + missing s3)", !dupReport.ok && dupReport.duplicateSpecIds.join(",") === "s2");

  const outlineQuiz = makeOutline(3, { quiz: true });
  const noQuiz = withDeck(deckWith(["s1", "s2", "s3"]));
  const quizReport = validateLessonGeneration(noQuiz.doc, noQuiz.lessonId, outlineQuiz, {});
  check("a required-but-missing quiz fails (REQUIRED_BLOCK_MISSING)", !quizReport.ok && quizReport.requiredBlocksMissing.includes("quiz"));
  const withQuiz = withDeck(deckWith(["s1", "s2", "s3"]), { quiz: true });
  check("the same plan passes once a quiz block exists", validateLessonGeneration(withQuiz.doc, withQuiz.lessonId, outlineQuiz, {}).ok);

  const budget = validateLessonGeneration(missing.doc, missing.lessonId, outline3, { checkpointed: true });
  check("budgetExhausted set when the run was checkpointed AND specs are missing", budget.budgetExhausted);
  check("budgetExhausted NOT set when the run finished normally", !missReport.budgetExhausted);

  // ── 3. Deterministic repair ─────────────────────────────────────────────────
  console.log("\n# deterministic repair patches");
  const rHost = withDeck(deckWith(["s1", "s2", "s3"], { placeholder: true }));
  let rdoc = rHost.doc;
  const rlid = rHost.lessonId;
  let rReport = validateLessonGeneration(rdoc, rlid, outline3, {});
  const repairPatches = placeholderRepairPatches(rdoc, rlid, rReport);
  check("placeholder repair emits a DELETE_SLIDE (real content remains)", repairPatches.length === 1 && repairPatches[0].action === "DELETE_SLIDE");
  for (const p of repairPatches) {
    const r = applyCoursePatch(rdoc, p, NOW);
    if (r.ok) rdoc = r.doc;
  }
  rReport = validateLessonGeneration(rdoc, rlid, outline3, {});
  check("after deterministic repair the placeholder is gone (deck now valid)", rReport.ok, JSON.stringify(rReport.issues));

  // A deck that is ONLY placeholder/empty junk is dropped whole (DELETE_BLOCK).
  const junkOnly = withDeck(deckWith([], { placeholder: true }));
  const junkReport = validateLessonGeneration(junkOnly.doc, junkOnly.lessonId, outline3, {});
  const junkPatches = placeholderRepairPatches(junkOnly.doc, junkOnly.lessonId, junkReport);
  check("an all-placeholder deck is dropped whole (DELETE_BLOCK)", junkPatches.length === 1 && junkPatches[0].action === "DELETE_BLOCK");

  // An empty (0-slide) pre-created deck is LEFT during repair, pruned only at the end.
  const emptyDeck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  const emptyHost = withDeck(emptyDeck);
  const emptyReport = validateLessonGeneration(emptyHost.doc, emptyHost.lessonId, outline3, {});
  check("an empty pre-created deck is NOT touched by placeholder repair", placeholderRepairPatches(emptyHost.doc, emptyHost.lessonId, emptyReport).length === 0);
  check("an empty deck IS removed by the final prune", pruneEmptyDeckPatches(emptyHost.doc, emptyHost.lessonId).length === 1);

  // ── 4. PLAN depth floor ─────────────────────────────────────────────────────
  console.log("\n# PLAN depth floor (lessonDepthShortfall)");
  check("a 3-slide NORMAL lesson is too thin → re-ask reason", lessonDepthShortfall(makeOutline(3)) !== null);
  check("a 3-slide MICRO lesson is exempt → null", lessonDepthShortfall(makeOutline(3, { micro: true })) === null);
  check("a 6-slide normal lesson meets the floor → null", lessonDepthShortfall(makeOutline(6)) === null);
  check("a 6-slide TECHNICAL lesson is below the 7 floor → re-ask", lessonDepthShortfall(makeOutline(6, { code: true })) !== null);
  check("a 7-slide technical lesson meets the floor → null", lessonDepthShortfall(makeOutline(7, { code: true })) === null);

  // ── 5. Lint + light-review trigger ──────────────────────────────────────────
  console.log("\n# lint warnings + light-review trigger");
  // Thin, note-less slides → THIN_SLIDE + NO_SPEAKER_NOTES warnings.
  const thinDeck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  const thin = createStructuredSlide("prose");
  thin.template = { layoutId: "prose", content: { title: { text: "Tip" }, body: { text: "Short." } } };
  thin.ai.specId = "s1";
  // no speaker notes
  thinDeck.slides = [thin];
  const thinHost = withDeck(thinDeck);
  const warnings = lintLessonGeneration(thinHost.doc, thinHost.lessonId, makeOutline(1));
  check("lint flags a thin slide", warnings.some((w) => w.code === "THIN_SLIDE"));
  check("lint flags a missing speaker note", warnings.some((w) => w.code === "NO_SPEAKER_NOTES"));

  // Quiz shorter than planned.
  const shortQuizHost = withDeck(deckWith(["s1", "s2", "s3"]), { quiz: true });
  const sq = shortQuizHost.doc.modules[0].lessons[0].blocks.find((b): b is QuizBlock => b.type === "quiz");
  sq!.questions = [{ id: "q1", kind: "true_false", prompt: "?", explanation: "e", correctAnswer: true }];
  const quizWarnings = lintLessonGeneration(shortQuizHost.doc, shortQuizHost.lessonId, makeOutline(3, { quiz: true }));
  check("lint flags a quiz shorter than planned (1 of 3)", quizWarnings.some((w) => w.code === "QUIZ_TOO_SHORT"));

  // Light-review trigger (default: off, onLintThreshold true, threshold 4).
  const w = (n: number) => Array.from({ length: n }, (_, i) => ({ code: "X", message: `m${i}` }));
  check("light review does NOT fire below the lint threshold (3 < 4)", !shouldRunLightReview(w(3)));
  check("light review fires at/above the lint threshold (4 ≥ 4)", shouldRunLightReview(w(4)));

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
