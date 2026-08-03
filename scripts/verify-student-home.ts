/**
 * Student-home PURE verification — no DB, no key, no browser.
 * Run: `npx tsx scripts/verify-student-home.ts`
 *
 * Covers lib/learn/studentHome.ts: computeStreak (anchoring, gaps, dupes,
 * unsorted input, month boundaries, malformed dates), latestAttemptsPerBlock
 * (newest-per-block folding + tie-breaks), reviewQueue (threshold boundary,
 * worst-first sort, zero-max guard), quizAccuracyPct (rounding, zero-max
 * guard, null), and summarizeLearning.
 */

import {
  computeStreak,
  latestAttemptsPerBlock,
  quizAccuracyPct,
  reviewQueue,
  summarizeLearning,
  type QuizAttemptRowLike,
} from "@/lib/learn/studentHome";

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

function attempt(over: Partial<QuizAttemptRowLike>): QuizAttemptRowLike {
  return {
    block_id: "b1",
    course_id: "c1",
    score: 1,
    max_score: 2,
    attempt_number: 1,
    submitted_at: "2026-07-08T10:00:00Z",
    ...over,
  };
}

function main() {
  const TODAY = "2026-07-08";

  /* ── computeStreak ── */
  console.log("\n— computeStreak —");
  check("empty input → 0", computeStreak([], TODAY) === 0);
  check("single day today → 1", computeStreak(["2026-07-08"], TODAY) === 1);
  check(
    "today + yesterday → 2",
    computeStreak(["2026-07-08", "2026-07-07"], TODAY) === 2
  );
  check(
    "yesterday-anchored (today missing) still counts",
    computeStreak(["2026-07-07", "2026-07-06"], TODAY) === 2
  );
  check(
    "gap breaks the run (today + day-before-yesterday) → 1",
    computeStreak(["2026-07-08", "2026-07-06"], TODAY) === 1
  );
  check(
    "duplicates collapse",
    computeStreak(["2026-07-08", "2026-07-08", "2026-07-07"], TODAY) === 2
  );
  check(
    "unsorted input tolerated",
    computeStreak(
      ["2026-07-06", "2026-07-08", "2026-07-04", "2026-07-07", "2026-07-05"],
      TODAY
    ) === 5
  );
  check(
    "neither today nor yesterday → 0 (stale history)",
    computeStreak(["2026-07-05", "2026-07-04", "2026-07-03"], TODAY) === 0
  );
  const longRun = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 6, 8) - i * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
  check("long 30-day run → 30", computeStreak(longRun, TODAY) === 30);
  check(
    "month boundary crossed (Jul 1 ← Jun 30)",
    computeStreak(["2026-07-01", "2026-06-30"], "2026-07-01") === 2
  );
  check(
    "malformed dates ignored",
    computeStreak(["garbage", "2026-07-08", "2026-7-7"], TODAY) === 1
  );
  check("malformed today → 0", computeStreak(["2026-07-08"], "not-a-date") === 0);

  /* ── latestAttemptsPerBlock ── */
  console.log("\n— latestAttemptsPerBlock —");
  const folded = latestAttemptsPerBlock([
    attempt({ block_id: "b1", submitted_at: "2026-07-01T10:00:00Z", score: 1 }),
    attempt({ block_id: "b1", submitted_at: "2026-07-03T10:00:00Z", score: 2 }),
    attempt({ block_id: "b1", submitted_at: "2026-07-02T10:00:00Z", score: 0 }),
    attempt({ block_id: "b2", submitted_at: "2026-07-01T09:00:00Z", score: 1 }),
  ]);
  check("one entry per block", folded.length === 2);
  check(
    "newest attempt wins (unsorted input)",
    folded.find((r) => r.block_id === "b1")?.score === 2
  );
  check(
    "other block kept",
    folded.find((r) => r.block_id === "b2")?.score === 1
  );
  const tied = latestAttemptsPerBlock([
    attempt({ attempt_number: 1, score: 0 }),
    attempt({ attempt_number: 2, score: 2 }),
  ]);
  check(
    "submitted_at tie → higher attempt_number wins",
    tied.length === 1 && tied[0].score === 2
  );
  check("empty input → []", latestAttemptsPerBlock([]).length === 0);

  /* ── reviewQueue ── */
  console.log("\n— reviewQueue —");
  const queue = reviewQueue([
    attempt({ block_id: "pass", score: 9, max_score: 10 }), // 90% — above
    attempt({ block_id: "boundary", score: 7, max_score: 10 }), // exactly 70% — excluded
    attempt({ block_id: "mid", score: 5, max_score: 10 }), // 50%
    attempt({ block_id: "worst", score: 1, max_score: 10 }), // 10%
    attempt({ block_id: "ungradable", score: 0, max_score: 0 }), // guard
  ]);
  check("only below-threshold attempts kept", queue.length === 2);
  check(
    "exactly-at-threshold excluded",
    !queue.some((r) => r.block_id === "boundary")
  );
  check("zero max_score excluded", !queue.some((r) => r.block_id === "ungradable"));
  check(
    "sorted worst-first",
    queue[0]?.block_id === "worst" && queue[1]?.block_id === "mid"
  );
  check(
    "scoreRatio attached",
    Math.abs((queue[0]?.scoreRatio ?? 1) - 0.1) < 1e-9
  );
  const custom = reviewQueue([attempt({ score: 8, max_score: 10 })], 0.9);
  check("custom threshold honored (80% < 0.9)", custom.length === 1);
  check("empty input → []", reviewQueue([]).length === 0);

  /* ── quizAccuracyPct ── */
  console.log("\n— quizAccuracyPct —");
  check("no attempts → null", quizAccuracyPct([]) === null);
  check(
    "single perfect score → 100",
    quizAccuracyPct([attempt({ score: 10, max_score: 10 })]) === 100
  );
  check(
    "mean rounds correctly (50% + 66.7% → 58)",
    quizAccuracyPct([
      attempt({ block_id: "a", score: 1, max_score: 2 }),
      attempt({ block_id: "b", score: 2, max_score: 3 }),
    ]) === 58
  );
  check(
    "only zero-max rows → null (no division by zero)",
    quizAccuracyPct([attempt({ score: 0, max_score: 0 })]) === null
  );
  check(
    "zero-max rows excluded from the mean",
    quizAccuracyPct([
      attempt({ block_id: "a", score: 0, max_score: 0 }),
      attempt({ block_id: "b", score: 1, max_score: 2 }),
    ]) === 50
  );
  check("zero score → 0", quizAccuracyPct([attempt({ score: 0, max_score: 5 })]) === 0);

  /* ── summarizeLearning ── */
  console.log("\n— summarizeLearning —");
  const summary = summarizeLearning([
    { enrollment_status: "active", total_lessons: 10, completed_lessons: 4 },
    { enrollment_status: "completed", total_lessons: 5, completed_lessons: 5 },
    { enrollment_status: "active", total_lessons: 8, completed_lessons: 0 },
  ]);
  check("inProgress counted", summary.inProgress === 2);
  check("completed counted", summary.completed === 1);
  check("lessonsCompleted summed", summary.lessonsCompleted === 9);
  check("lessonsTotal summed", summary.lessonsTotal === 23);
  const empty = summarizeLearning([]);
  check(
    "empty input → zeros",
    empty.inProgress === 0 &&
      empty.completed === 0 &&
      empty.lessonsCompleted === 0 &&
      empty.lessonsTotal === 0
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
