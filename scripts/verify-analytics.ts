/**
 * Analytics pipeline PURE verification — no DB, no key, no browser.
 * Run: `npx tsx scripts/verify-analytics.ts`  (npm run verify:analytics)
 *
 * Covers: the Zod event contract (round-trip + rejects + column mapping), the
 * visibility-aware dwell tracker, the stats mirrors (percentile_cont semantics
 * + a hand-computed point-biserial golden the int suite reuses to prove
 * SQL ↔ TS agreement), the flag thresholds (INCLUDING a drift guard that
 * regexes the migration SQL for the documented literals), and the batching
 * queue (single keepalive POST, chunking, retry/backoff, 4xx drop, and the
 * flush-on-unload path — driven via the injected handler, headless).
 */

import { readFileSync } from "node:fs";
import {
  AnalyticsBatchSchema,
  buildEvent,
  mapEventToColumns,
  MAX_BATCH_EVENTS,
  type AnalyticsEvent,
} from "@/lib/analytics/events";
import { createAnalyticsQueue } from "@/lib/analytics/client";
import { SlideDwellTracker } from "@/lib/analytics/dwell";
import {
  describeLearnerFlag,
  DISTRACTOR_RATIO,
  dwellOutlier,
  DWELL_MIN_N,
  FAILURE_MIN_ATTEMPTS,
  FAILURE_SCORE_PCT,
  INACTIVE_DAYS,
  LOW_DISCRIMINATION,
  LOW_PCT_CORRECT,
  LOW_PCT_MIN_N,
  questionFlags,
} from "@/lib/analytics/flags";
import { median, p90, percentileCont, pointBiserial } from "@/lib/analytics/stats";

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

const CTX = {
  publicationId: "11111111-1111-4111-8111-111111111111",
  version: 1,
  courseId: "22222222-2222-4222-8222-222222222222",
  lessonId: "33333333-3333-4333-8333-333333333333",
};
const BLOCK = "44444444-4444-4444-8444-444444444444";
const ATTEMPT = "55555555-5555-4555-8555-555555555555";

function main() {
  /* ── 1. Contract ── */
  console.log("\n— Zod contract —");
  const everyType: AnalyticsEvent[] = [
    buildEvent(CTX, { eventType: "lesson_started" }),
    buildEvent(CTX, { eventType: "slide_viewed", blockId: BLOCK, slideId: "s-1", dwellMs: 1200 }),
    buildEvent(CTX, { eventType: "video_progress", blockId: BLOCK, quartile: 2 }),
    buildEvent(CTX, { eventType: "video_completed", blockId: BLOCK }),
    buildEvent(CTX, { eventType: "quiz_started", blockId: BLOCK }),
    buildEvent(CTX, { eventType: "quiz_submitted", blockId: BLOCK, attemptId: ATTEMPT }),
    buildEvent(CTX, { eventType: "homework_submitted", blockId: BLOCK }),
    buildEvent(CTX, { eventType: "lesson_completed" }),
    buildEvent(CTX, { eventType: "session_heartbeat" }),
  ];
  check("all 9 event types build + parse", everyType.length === 9);
  check(
    "clientEventId is stamped as a uuid",
    everyType.every((e) => /^[0-9a-f-]{36}$/.test(e.clientEventId))
  );
  check(
    "clientTs is stamped as ISO",
    everyType.every((e) => !Number.isNaN(Date.parse(e.clientTs)))
  );
  check(
    "server-emit override wins",
    buildEvent(CTX, { eventType: "lesson_completed" }, { clientEventId: ATTEMPT })
      .clientEventId === ATTEMPT
  );

  const rejects: Array<[string, () => void]> = [
    ["slide_viewed without dwellMs", () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildEvent(CTX, { eventType: "slide_viewed", blockId: BLOCK, slideId: "s-1" } as any)],
    ["video_progress quartile 5", () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildEvent(CTX, { eventType: "video_progress", blockId: BLOCK, quartile: 5 } as any)],
    ["quiz_submitted without attemptId", () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildEvent(CTX, { eventType: "quiz_submitted", blockId: BLOCK } as any)],
    ["negative dwell", () =>
      buildEvent(CTX, { eventType: "slide_viewed", blockId: BLOCK, slideId: "s", dwellMs: -1 })],
    ["non-uuid blockId", () =>
      buildEvent(CTX, { eventType: "quiz_started", blockId: "not-a-uuid" })],
  ];
  for (const [name, fn] of rejects) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    check(`rejects ${name}`, threw);
  }

  check("empty batch rejected", !AnalyticsBatchSchema.safeParse({ events: [] }).success);
  check(
    `batch over ${MAX_BATCH_EVENTS} rejected`,
    !AnalyticsBatchSchema.safeParse({
      events: Array.from({ length: MAX_BATCH_EVENTS + 1 }, () =>
        buildEvent(CTX, { eventType: "session_heartbeat" })
      ),
    }).success
  );

  const userId = "66666666-6666-4666-8666-666666666666";
  const slideRow = mapEventToColumns(everyType[1], userId);
  const quizRow = mapEventToColumns(everyType[5], userId);
  const heartbeatRow = mapEventToColumns(everyType[8], userId);
  check(
    "column mapping: slide_viewed",
    slideRow.slide_id === "s-1" &&
      slideRow.dwell_ms === 1200 &&
      slideRow.block_id === BLOCK &&
      slideRow.user_id === userId &&
      slideRow.quartile === null &&
      slideRow.attempt_id === null
  );
  check(
    "column mapping: quiz_submitted carries attempt_id",
    quizRow.attempt_id === ATTEMPT && quizRow.dwell_ms === null
  );
  check(
    "column mapping: heartbeat has no block fields",
    heartbeatRow.block_id === null && heartbeatRow.slide_id === null
  );
  check(
    "column mapping: context rides on every row",
    quizRow.publication_id === CTX.publicationId &&
      quizRow.version === 1 &&
      quizRow.course_id === CTX.courseId &&
      quizRow.lesson_id === CTX.lessonId
  );

  /* ── 2. Dwell tracker (visibility-aware) ── */
  console.log("\n— Dwell tracker —");
  let now = 0;
  let visible = true;
  const tracker = new SlideDwellTracker({ now: () => now, isVisible: () => visible });

  tracker.start("s-1");
  now += 5_000;
  const r1 = tracker.end();
  check("accrues while visible", r1?.slideId === "s-1" && r1.dwellMs === 5_000);

  tracker.start("s-2");
  now += 2_000;
  visible = false;
  tracker.handleVisibilityChange(); // hide → close span
  now += 60_000; // a minute hidden — must NOT count
  visible = true;
  tracker.handleVisibilityChange(); // show → new span
  now += 3_000;
  const r2 = tracker.end();
  check("hidden time excluded", r2?.dwellMs === 5_000, `got ${r2?.dwellMs}`);

  visible = false;
  tracker.start("s-3"); // started while hidden
  now += 10_000;
  visible = true;
  tracker.handleVisibilityChange();
  now += 1_500;
  const r3 = tracker.end();
  check("start-while-hidden accrues only after show", r3?.dwellMs === 1_500);

  check("end with nothing active returns null", tracker.end() === null);
  tracker.start("s-4");
  check("activeSlideId reflects the live slide", tracker.activeSlideId === "s-4");
  tracker.start("s-5"); // discard s-4 (callers end() first — LearnSlideDeck does)
  now += 700;
  const r5 = tracker.end();
  check("restart replaces the active slide", r5?.slideId === "s-5" && r5.dwellMs === 700);

  /* ── 3. Stats mirrors ── */
  console.log("\n— Stats (percentile_cont + point-biserial) —");
  check("percentileCont p50 interpolates", percentileCont([1, 2, 3, 4], 0.5) === 2.5);
  check("median odd n", median([3, 1, 2]) === 2);
  // Compare rounded — the rollup stores ::integer, and 0.9·(n−1) carries
  // float epsilon in JS (2.7000…02) that SQL's numeric arithmetic doesn't.
  check(
    "p90 matches percentile_cont (rounded, as stored)",
    Math.round(p90([1000, 2000, 3000, 10000]) ?? 0) === 7900,
    `got ${p90([1000, 2000, 3000, 10000])}`
  );
  check("percentile of empty is null", percentileCont([], 0.5) === null);

  // Hand-computed golden (the int suite re-derives the same fixture in SQL):
  // totals [3,2,2,1,0], correct [T,T,F,F,F] → p=.4, sd_pop=√1.04,
  // m1=2.5, m0=1 → r = (1.5/1.0198…)·√.24 = 0.7206 (4 dp).
  const golden = pointBiserial([
    { correct: true, total: 3 },
    { correct: true, total: 2 },
    { correct: false, total: 2 },
    { correct: false, total: 1 },
    { correct: false, total: 0 },
  ]);
  check("point-biserial golden = 0.7206", golden === 0.7206, `got ${golden}`);
  check(
    "perfect discriminator = 1.0",
    pointBiserial([
      { correct: true, total: 2 },
      { correct: false, total: 0 },
      { correct: false, total: 0 },
    ]) === 1
  );
  check("n<2 → null", pointBiserial([{ correct: true, total: 1 }]) === null);
  check(
    "sd=0 → null",
    pointBiserial([
      { correct: true, total: 1 },
      { correct: false, total: 1 },
    ]) === null
  );
  check(
    "all-correct → null",
    pointBiserial([
      { correct: true, total: 2 },
      { correct: true, total: 1 },
    ]) === null
  );

  /* ── 4. Flags + SQL drift guard ── */
  console.log("\n— Flags —");
  check(
    "stuck constants match the documented SQL (7d / 2 / 0.60)",
    INACTIVE_DAYS === 7 && FAILURE_MIN_ATTEMPTS === 2 && FAILURE_SCORE_PCT === 0.6
  );
  const migration = readFileSync(
    new URL("../supabase/migrations/20260702050000_analytics_events.sql", import.meta.url),
    "utf8"
  );
  check(
    "migration SQL still encodes the same thresholds",
    migration.includes(`interval '${INACTIVE_DAYS} days'`) &&
      migration.includes(`count(*) >= ${FAILURE_MIN_ATTEMPTS}`) &&
      migration.includes(`< ${FAILURE_SCORE_PCT.toFixed(2)}`)
  );

  const base = {
    n: 30,
    pctCorrect: 80,
    answerDistribution: { A: 24, B: 4, C: 2 },
    keyValue: "A",
    discrimination: 0.4,
  };
  check("healthy question → no flags", questionFlags(base).length === 0);
  check(
    "low % correct flags at n≥20",
    questionFlags({ ...base, pctCorrect: LOW_PCT_CORRECT - 1 }).some((f) => f.type === "low_correct")
  );
  check(
    "low % correct does NOT flag under min n",
    questionFlags({ ...base, pctCorrect: 10, n: LOW_PCT_MIN_N - 1 }).length === 0
  );
  check(
    `distractor ≥ ${DISTRACTOR_RATIO}× key flags`,
    questionFlags({
      ...base,
      answerDistribution: { A: 5, B: 10 },
    }).some((f) => f.type === "strong_distractor")
  );
  check(
    "no distractor flag without a key bucket (short answer)",
    !questionFlags({
      ...base,
      keyValue: null,
      answerDistribution: { x: 1, y: 99 },
    }).some((f) => f.type === "strong_distractor")
  );
  check(
    "low discrimination flags",
    questionFlags({ ...base, discrimination: LOW_DISCRIMINATION - 0.01 }).some(
      (f) => f.type === "low_discrimination"
    )
  );
  check(
    "null discrimination doesn't flag",
    !questionFlags({ ...base, discrimination: null }).some(
      (f) => f.type === "low_discrimination"
    )
  );

  check("dwell skim (ratio + abs floor)", dwellOutlier(1_000, 10_000, 10) === "skimmed");
  check("dwell stall", dwellOutlier(60_000, 20_000, 10) === "stall");
  check("normal dwell → null", dwellOutlier(9_000, 10_000, 10) === null);
  check("under min n → null", dwellOutlier(1_000, 10_000, DWELL_MIN_N - 1) === null);
  check(
    "fast-but-even deck doesn't skim-flag (ratio not tripped)",
    dwellOutlier(2_000, 3_500, 10) === null
  );
  check(
    "long-but-proportional doesn't stall-flag",
    dwellOutlier(50_000, 30_000, 10) === null
  );

  check(
    "describe inactive flag",
    describeLearnerFlag("inactive_7d_incomplete", {
      lastActivityAt: new Date(Date.now() - 12 * 86_400_000).toISOString(),
      completedLessons: 3,
      totalLessons: 8,
    }).includes("3/8")
  );
  check(
    "describe repeated failure flag",
    describeLearnerFlag("repeated_quiz_failure", {
      quizzes: [{ blockId: BLOCK, failedAttempts: 3, lastScorePct: 45 }],
    }).includes("3 failing attempts")
  );

  /* ── 5. Batching queue ── */
  console.log("\n— Batching queue —");
  void (async () => {
    // Deterministic timers + fetch.
    type Call = { url: string; init: RequestInit };
    const calls: Call[] = [];
    let failNext = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("network down");
      }
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }) as typeof fetch;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const queue = createAnalyticsQueue({
      fetchImpl,
      setTimeoutImpl: (fn, ms) => {
        timers.push({ fn, ms });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutImpl: () => {},
      randomImpl: () => 0,
    });

    queue.enqueue(buildEvent(CTX, { eventType: "session_heartbeat" }));
    queue.enqueue(buildEvent(CTX, { eventType: "lesson_started" }));
    await queue.flush("interval");
    const body0 = JSON.parse(String(calls[0]?.init.body)) as { events: unknown[] };
    check("flush drains the queue in one POST", calls.length === 1 && queue.pendingCount() === 0);
    check("batch body carries the events", body0.events.length === 2);
    check(
      "keepalive:true on every POST (the unload survival mechanism)",
      calls[0]?.init.keepalive === true
    );

    // Chunking: 120 events → two POSTs (100 + 20).
    for (let i = 0; i < 120; i++) {
      queue.enqueue(buildEvent(CTX, { eventType: "session_heartbeat" }));
    }
    await queue.flush("interval");
    const sizes = calls
      .slice(1)
      .map((c) => (JSON.parse(String(c.init.body)) as { events: unknown[] }).events.length);
    check(`chunks at ${MAX_BATCH_EVENTS}`, sizes.length === 2 && sizes[0] === 100 && sizes[1] === 20);

    // Failure → re-queue + scheduled retry with backoff; retry succeeds.
    failNext = 1;
    queue.enqueue(buildEvent(CTX, { eventType: "lesson_started" }));
    await queue.flush("interval");
    check("failed batch is re-queued", queue.pendingCount() === 1);
    check("a retry is scheduled with base backoff", timers.length === 1 && timers[0].ms >= 1_000);
    const before = calls.length;
    timers[0].fn(); // fire the retry timer (flush runs async)
    await new Promise((r) => setImmediate(r));
    check(
      "retry drains after recovery",
      calls.length === before + 1 && queue.pendingCount() === 0
    );

    // 4xx (poisoned batch / auth loss) → dropped, no infinite retry.
    const badFetch = (async () =>
      new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const dropQueue = createAnalyticsQueue({
      fetchImpl: badFetch,
      setTimeoutImpl: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutImpl: () => {},
    });
    dropQueue.enqueue(buildEvent(CTX, { eventType: "session_heartbeat" }));
    await dropQueue.flush("interval");
    check("4xx batch is dropped, not retried forever", dropQueue.pendingCount() === 0);

    // Flush-on-unload: exactly what the provider's pagehide handler runs.
    const unloadCalls: Call[] = [];
    const unloadQueue = createAnalyticsQueue({
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        unloadCalls.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      setTimeoutImpl: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutImpl: () => {},
    });
    unloadQueue.enqueue(
      buildEvent(CTX, { eventType: "slide_viewed", blockId: BLOCK, slideId: "s", dwellMs: 42 })
    );
    const onPageHide = () => void unloadQueue.flush("unload"); // the provider's handler
    onPageHide();
    await new Promise((r) => setImmediate(r));
    check(
      "flush-on-unload: pagehide handler drains via one keepalive POST",
      unloadCalls.length === 1 &&
        unloadCalls[0].init.keepalive === true &&
        unloadQueue.pendingCount() === 0
    );

    // Queue cap: oldest dropped beyond maxQueued.
    const capQueue = createAnalyticsQueue({
      fetchImpl,
      setTimeoutImpl: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimeoutImpl: () => {},
      maxQueued: 10,
    });
    for (let i = 0; i < 25; i++) {
      capQueue.enqueue(buildEvent(CTX, { eventType: "session_heartbeat" }));
    }
    check("offline queue is capped", capQueue.pendingCount() === 10);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  })();
}

main();
