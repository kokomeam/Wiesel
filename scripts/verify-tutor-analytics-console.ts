/**
 * Creator Tutor Console ANALYTICS — PURE suite (no key, no DB, no browser).
 * TUTOR-1 Wave 5 (P5.3). Covers:
 *
 *   - computeLessonHealthComposite goldens: the deterministic weighted sum; a
 *     fixture B that differs from A ONLY in first-attempt error rate ranks HIGHER
 *     (AC-A1.5 — first-attempt error demonstrably moves the ranking); the sum of
 *     weights is 1.0; missing/negative inputs coalesce to 0.
 *   - The composite WEIGHTS drift guard: the TS LESSON_HEALTH_WEIGHTS mirror the
 *     named SQL constants (v_w_*) verbatim in migration 20260805120000 (the
 *     verify-analytics.ts precedent — a divergence trips CI).
 *   - most-missed ranking + suppression pure logic: a below-floor question is
 *     dropped; survivors sort by first-attempt error desc; the bad-lesson evidence
 *     attribution shape (worst question per lesson) is well-formed (T5.5).
 *   - The two new RPCs' author-gate + cohort-floor + revoke/grant drift guards
 *     over the migration text (the D-4 privacy proof mirrors here).
 *
 * Run: `npx tsx scripts/verify-tutor-analytics-console.ts`
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  LESSON_HEALTH_WEIGHTS,
  computeLessonHealthComposite,
  type LessonHealthInputs,
} from "@/lib/analytics/lessonHealth";
import {
  buildLessonRationalePrompt,
  LessonRationaleOutputSchema,
  type LessonHealthEvidence,
} from "@/lib/analytics/lessonRationale";

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

const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ─────────────────────────── composite goldens ─────────────────────────── */

console.log("\n# computeLessonHealthComposite goldens");

const zeroInputs: LessonHealthInputs = {
  masteryShortfall: 0,
  firstAttemptErrorRate: 0,
  confusionDensity: 0,
  dropoutAfterRate: 0,
  rewatchScrubDensity: 0,
};

check("all-zero inputs → composite 0", computeLessonHealthComposite(zeroInputs) === 0);

// A single input at 1.0 yields exactly that input's weight.
check(
  "mastery shortfall 1.0 → composite === masteryShortfall weight",
  approx(
    computeLessonHealthComposite({ ...zeroInputs, masteryShortfall: 1 }),
    LESSON_HEALTH_WEIGHTS.masteryShortfall
  )
);
check(
  "first-attempt error 1.0 → composite === firstAttemptErrorRate weight",
  approx(
    computeLessonHealthComposite({ ...zeroInputs, firstAttemptErrorRate: 1 }),
    LESSON_HEALTH_WEIGHTS.firstAttemptErrorRate
  )
);

// A hand-computed mixed golden.
const mixed: LessonHealthInputs = {
  masteryShortfall: 0.5,
  firstAttemptErrorRate: 0.4,
  confusionDensity: 0.2,
  dropoutAfterRate: 0.1,
  rewatchScrubDensity: 0.6,
};
const mixedExpected =
  0.3 * 0.5 + 0.25 * 0.4 + 0.2 * 0.2 + 0.15 * 0.1 + 0.1 * 0.6; // 0.15+0.1+0.04+0.015+0.06 = 0.365
check(
  "mixed inputs match the hand-computed weighted sum (0.365)",
  approx(computeLessonHealthComposite(mixed), Math.round(mixedExpected * 1e6) / 1e6),
  String(computeLessonHealthComposite(mixed))
);

check(
  "negative / non-finite inputs coalesce to 0",
  computeLessonHealthComposite({
    masteryShortfall: -1,
    firstAttemptErrorRate: Number.NaN,
    confusionDensity: 0,
    dropoutAfterRate: 0,
    rewatchScrubDensity: 0,
  }) === 0
);

// AC-A1.5: A and B identical EXCEPT first-attempt error rate → B (higher error)
// ranks strictly higher. This is the exact "first-attempt error moves ranking" AC.
const fixtureA: LessonHealthInputs = {
  masteryShortfall: 0.3,
  firstAttemptErrorRate: 0.2,
  confusionDensity: 0.1,
  dropoutAfterRate: 0.1,
  rewatchScrubDensity: 0.1,
};
const fixtureB: LessonHealthInputs = { ...fixtureA, firstAttemptErrorRate: 0.8 };
const scoreA = computeLessonHealthComposite(fixtureA);
const scoreB = computeLessonHealthComposite(fixtureB);
check(
  "AC-A1.5: fixtures differ ONLY in first-attempt error → B ranks higher than A",
  scoreB > scoreA,
  `A=${scoreA} B=${scoreB}`
);
check(
  "AC-A1.5: the ranking delta equals the weight × the error delta (isolated)",
  approx(scoreB - scoreA, LESSON_HEALTH_WEIGHTS.firstAttemptErrorRate * (0.8 - 0.2)),
  `delta=${scoreB - scoreA}`
);

check(
  "the five weights sum to 1.0",
  approx(
    Object.values(LESSON_HEALTH_WEIGHTS).reduce((a, b) => a + b, 0),
    1
  )
);

/* ─────────────── most-missed ranking + suppression (pure logic) ─────────── */

console.log("\n# most-missed ranking + suppression");

// A synthetic RPC-shaped result: the RPC OMITS sub-floor questions and ranks by
// first-attempt error desc. We assert the invariants the UI depends on.
interface MMFixture {
  questionId: string;
  distinctLearnerCount: number;
  firstAttemptErrorRate: number;
}
const rawQuestions: MMFixture[] = [
  { questionId: "q-a", distinctLearnerCount: 12, firstAttemptErrorRate: 0.7 },
  { questionId: "q-b", distinctLearnerCount: 4, firstAttemptErrorRate: 0.95 }, // sub-floor → omitted
  { questionId: "q-c", distinctLearnerCount: 8, firstAttemptErrorRate: 0.9 },
  { questionId: "q-d", distinctLearnerCount: 5, firstAttemptErrorRate: 0.3 },
];
// Mirror the RPC contract: floor at 5, then rank by first-attempt error desc.
const surviving = rawQuestions
  .filter((q) => q.distinctLearnerCount >= 5)
  .sort((a, b) => b.firstAttemptErrorRate - a.firstAttemptErrorRate);

check("a below-floor (n<5) question is SUPPRESSED (omitted)", !surviving.some((q) => q.questionId === "q-b"));
check("all survivors have >= 5 distinct learners", surviving.every((q) => q.distinctLearnerCount >= 5));
check(
  "survivors rank by first-attempt error desc (q-c 0.9 > q-a 0.7 > q-d 0.3)",
  surviving.map((q) => q.questionId).join(",") === "q-c,q-a,q-d",
  surviving.map((q) => q.questionId).join(",")
);

/* ─────────────── bad-lesson evidence attribution shape (T5.5) ───────────── */

console.log("\n# bad-lesson evidence attribution (T5.5)");

const evidence: LessonHealthEvidence = {
  publicationId: "pub-1",
  lessonId: "lesson-1",
  compositeScore: 0.61,
  inputs: {
    masteryShortfall: 0.7,
    firstAttemptErrorRate: 0.8,
    confusionDensity: 0.2,
    dropoutAfterRate: 0.1,
    rewatchScrubDensity: 0.0,
  },
  worstQuestion: { questionId: "q-hardest", pctCorrect: 22, n: 41 },
};
const prompt = buildLessonRationalePrompt(evidence);
check("the rationale prompt names the implicated question id", prompt.includes("q-hardest"));
check("the rationale prompt cites the composite score", prompt.includes("0.61"));
check(
  "the rationale prompt foregrounds the strongest signal (first-attempt error 80%)",
  prompt.indexOf("first-attempt quiz error rate: 80%") >= 0
);
check(
  "the rationale output schema caps prose at 400 chars",
  !LessonRationaleOutputSchema.safeParse({ rationale: "x".repeat(401) }).success &&
    LessonRationaleOutputSchema.safeParse({ rationale: "A tight case." }).success
);
// The "no dominant question" branch renders too.
const spread: LessonHealthEvidence = { ...evidence, worstQuestion: null };
check(
  "a lesson with no dominant question still produces a well-formed prompt",
  buildLessonRationalePrompt(spread).includes("No single most-missed question")
);

/* ─────────── RPC payload Zod shape (mirror the loaders' contract) ───────── */

console.log("\n# RPC payload contract");

const MostMissedRowSchema = z.object({
  blockId: z.string(),
  questionId: z.string(),
  lessonId: z.string().nullable(),
  distinctLearnerCount: z.coerce.number(),
  firstAttemptErrorRate: z.coerce.number(),
  secondAttemptErrorRate: z.coerce.number().nullable(),
  perOption: z.array(z.object({ option: z.string().nullable(), count: z.coerce.number() })),
  conceptNodeIds: z.array(z.string()),
  deepLink: z.object({ lessonId: z.string().nullable(), blockId: z.string() }),
});
check(
  "a most-missed row (with distractors + concept ids + deep link) parses",
  MostMissedRowSchema.safeParse({
    blockId: "b-1",
    questionId: "q-a",
    lessonId: "l-1",
    objectiveId: "obj-1",
    distinctLearnerCount: "12",
    firstAttemptErrorRate: "0.7",
    secondAttemptErrorRate: null,
    perOption: [{ option: "c-2", count: "9" }],
    conceptNodeIds: ["n-1", "n-2"],
    deepLink: { lessonId: "l-1", blockId: "b-1" },
  }).success
);

/* ───────────────── migration drift guards (20260805120000) ──────────────── */

console.log("\n# migration drift guards (20260805120000_tutor_lesson_health.sql)");

const MIGRATION = readFileSync(
  new URL("../supabase/migrations/20260805120000_tutor_lesson_health.sql", import.meta.url),
  "utf8"
);

// ── the composite WEIGHTS drift guard: SQL named constants === TS mirror ──
const SQL_WEIGHT_LINES: Array<[string, number]> = [
  ["v_w_mastery_shortfall", LESSON_HEALTH_WEIGHTS.masteryShortfall],
  ["v_w_first_attempt_error_rate", LESSON_HEALTH_WEIGHTS.firstAttemptErrorRate],
  ["v_w_confusion_density", LESSON_HEALTH_WEIGHTS.confusionDensity],
  ["v_w_dropout_after_rate", LESSON_HEALTH_WEIGHTS.dropoutAfterRate],
  ["v_w_rewatch_scrub_density", LESSON_HEALTH_WEIGHTS.rewatchScrubDensity],
];
for (const [name, tsValue] of SQL_WEIGHT_LINES) {
  const re = new RegExp(`${name}\\s+constant numeric\\s*:=\\s*([0-9.]+)`);
  const m = MIGRATION.match(re);
  const sqlValue = m ? Number(m[1]) : Number.NaN;
  check(
    `SQL weight ${name} (${m?.[1] ?? "MISSING"}) === TS mirror ${tsValue}`,
    m !== null && approx(sqlValue, tsValue),
    `sql=${m?.[1]} ts=${tsValue}`
  );
}

check(
  "most_missed_questions is SECURITY DEFINER, author-gated (not the course author raise)",
  /create function public\.most_missed_questions\(p_course_id uuid\)/.test(MIGRATION) &&
    /security definer/i.test(MIGRATION) &&
    /raise exception 'not the course author'/.test(MIGRATION)
);
check(
  "most_missed_questions applies the >= 5 cohort floor verbatim (D-4)",
  /distinct_learner_count >= 5/.test(MIGRATION)
);
check(
  "the attempt ordinal is DERIVED by (created_at, id), never stored",
  /order by d\.created_at, d\.id/.test(MIGRATION) && /row_number\(\) over/.test(MIGRATION)
);
check(
  "recompute_lesson_health mastery input is cohort-floored >= 5 inside the definer",
  /ma\.learner_count >= 5/.test(MIGRATION)
);
check(
  "lesson_health is author-gated + ranked by composite_score desc",
  /create function public\.lesson_health\(p_course_id uuid\)/.test(MIGRATION) &&
    /order by h\.composite_score desc/.test(MIGRATION)
);
check(
  "both read RPCs revoke from public, anon + grant to authenticated",
  /revoke all on function public\.most_missed_questions\(uuid\) from public, anon/.test(MIGRATION) &&
    /grant execute on function public\.most_missed_questions\(uuid\) to authenticated/.test(MIGRATION) &&
    /revoke all on function public\.lesson_health\(uuid\) from public, anon/.test(MIGRATION) &&
    /grant execute on function public\.lesson_health\(uuid\) to authenticated/.test(MIGRATION)
);
check(
  "the composite is DETERMINISTIC (recompute is SQL; rationale left null for Terra)",
  /create function private\.recompute_lesson_health\(cid uuid\)/.test(MIGRATION) &&
    /rationale\s+text/.test(MIGRATION)
);
check(
  "the recompute wrapper is service-role only (revoked from authenticated)",
  /revoke all on function public\.recompute_lesson_health_admin\(uuid\) from public, anon, authenticated/.test(
    MIGRATION
  ) && /grant execute on function public\.recompute_lesson_health_admin\(uuid\) to service_role/.test(MIGRATION)
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
