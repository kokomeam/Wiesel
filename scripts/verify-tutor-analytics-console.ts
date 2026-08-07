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
 *   - A3-23 (Amendment A3, Wave 2): the misconception display helpers —
 *     humanizeMisconceptionSlug matrix, the <20-cohort raw-counts /
 *     ≥20-adds-percentage rule (misconceptionCountDisplay), deterministic
 *     per-concept grouping + the empty-state gate, and structural guards that
 *     the Analytics tab renders through them.
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
import {
  MISCONCEPTION_PCT_MIN_COHORT,
  humanizeMisconceptionSlug,
  misconceptionCountDisplay,
  groupMisconceptionsByNode,
  type MisconceptionRollupRow,
} from "@/lib/analytics/misconceptions";

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

/* ══════════════ A3-23 — misconception display helpers (Amendment A3) ══════════
 * The Analytics tab's "Misconceptions" section (tool-evidence rollup). The RPC
 * owns both privacy floors; these pure helpers own ONLY display: humanized slug
 * labels + the <20-cohort raw-counts rule + deterministic per-concept grouping. */

console.log("\n# A3-23 — humanizeMisconceptionSlug matrix");

check(
  '"insertion-order-preserved" → "Insertion order preserved"',
  humanizeMisconceptionSlug("insertion-order-preserved") === "Insertion order preserved"
);
check('"off-by-one" → "Off by one"', humanizeMisconceptionSlug("off-by-one") === "Off by one");
check('single word "aliasing" → "Aliasing"', humanizeMisconceptionSlug("aliasing") === "Aliasing");
check(
  "underscores humanize too (defensive)",
  humanizeMisconceptionSlug("snake_case_slug") === "Snake case slug"
);
check(
  "mixed case is normalized to sentence case",
  humanizeMisconceptionSlug("Already-WEIRD-Case") === "Already weird case"
);
check(
  "repeated separators collapse to one space",
  humanizeMisconceptionSlug("a--b__c") === "A b c"
);
check("empty slug → empty string (no crash)", humanizeMisconceptionSlug("") === "");
check(
  "separator-only slug → empty string",
  humanizeMisconceptionSlug("---") === ""
);

console.log("\n# A3-23 — misconceptionCountDisplay (<20 raw counts only; ≥20 adds a percentage)");

check("the percentage threshold constant is 20", MISCONCEPTION_PCT_MIN_COHORT === 20);
check(
  'cohort 19 (<20): RAW COUNTS ONLY — "4 learners"',
  misconceptionCountDisplay(4, 19) === "4 learners"
);
check(
  'cohort 20 (boundary, ≥20): percentage appears — "4 learners (20%)"',
  misconceptionCountDisplay(4, 20) === "4 learners (20%)"
);
check(
  'cohort 5 (the RPC disclosure floor itself): still raw only — "5 learners"',
  misconceptionCountDisplay(5, 5) === "5 learners"
);
check('singular below threshold — "1 learner"', misconceptionCountDisplay(1, 19) === "1 learner");
check(
  'singular at threshold — "1 learner (5%)"',
  misconceptionCountDisplay(1, 20) === "1 learner (5%)"
);
check(
  "percentage rounds to the nearest integer (7/21 → 33%)",
  misconceptionCountDisplay(7, 21) === "7 learners (33%)"
);
check(
  "large cohort — 5/100 → 5%",
  misconceptionCountDisplay(5, 100) === "5 learners (5%)"
);
check(
  "non-positive cohort degrades to raw counts (never divides by zero)",
  misconceptionCountDisplay(3, 0) === "3 learners" && misconceptionCountDisplay(3, -1) === "3 learners"
);
check(
  "fractional inputs are rounded defensively",
  misconceptionCountDisplay(4.4, 19.9) === "4 learners"
);

console.log("\n# A3-23 — groupMisconceptionsByNode (deterministic grouping + empty-state gate)");

const mkRow = (
  nodeId: string,
  nodeTitle: string,
  slug: string,
  learnerCount: number,
  evidenceCount: number
): MisconceptionRollupRow => ({
  nodeId,
  nodeTitle,
  misconceptionSlug: slug,
  learnerCount,
  evidenceCount,
  cohortSize: 25,
});

check("[] in → [] out (the section's empty-state gate)", groupMisconceptionsByNode([]).length === 0);

const grouped = groupMisconceptionsByNode([
  mkRow("n-hash", "Hash tables", "insertion-order-preserved", 6, 9),
  mkRow("n-bigo", "Asymptotic analysis", "constants-dominate", 12, 20),
  mkRow("n-hash", "Hash tables", "collisions-are-errors", 8, 11),
  mkRow("n-bigo", "Asymptotic analysis", "best-case-is-typical", 12, 14),
]);
check("two concept groups from four rows", grouped.length === 2);
check(
  "groups rank by strongest signal (max learner count) desc",
  grouped[0]?.nodeId === "n-bigo" && grouped[1]?.nodeId === "n-hash"
);
check(
  "items within a group sort by learner count desc, then slug asc on ties",
  grouped[0]?.items.map((i) => i.slug).join(",") === "best-case-is-typical,constants-dominate" &&
    grouped[1]?.items.map((i) => i.slug).join(",") === "collisions-are-errors,insertion-order-preserved"
);
check(
  "grouping preserves counts verbatim (no recomputation)",
  grouped[1]?.items[0]?.learnerCount === 8 && grouped[1]?.items[0]?.evidenceCount === 11
);

// ── structural guards: the tab really renders through these helpers ──────────
const TAB = readFileSync(
  new URL("../components/studio/tutor/AnalyticsTutorTab.tsx", import.meta.url),
  "utf8"
);
check(
  "AnalyticsTutorTab renders counts through misconceptionCountDisplay (the <20 rule is not inlined)",
  /misconceptionCountDisplay\(/.test(TAB) && !/cohortSize\s*[<>]=?\s*20/.test(TAB)
);
check(
  "AnalyticsTutorTab ships the calm empty state for the misconception section",
  /No misconception signal yet/.test(TAB) &&
    /at least 5 learners have evidence/.test(TAB)
);
check(
  "AnalyticsTutorTab keeps the raw slug visible (mono chip) beside the humanized label",
  /humanizeMisconceptionSlug\(/.test(TAB) && /font-mono/.test(TAB)
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
