/**
 * Creator-dashboard PURE verification — no DB, no key, no browser.
 * Run: `npx tsx scripts/verify-creator-home.ts`
 *
 * Covers lib/analytics/creatorHome.ts: the cross-course health merge
 * (including courses with zero rows anywhere), portfolio totals (completion
 * null on zero enrollments, review-count-weighted rating, the em-dash cases),
 * the spotlight pick (no live pubs → null; tie-break by title), the funnel
 * biggest-dropoff picker, the DEFENSIVE finding-jsonb parse (garbage in →
 * skipped, never thrown), and the defensive snapshot lesson-title walk.
 */

import {
  buildCourseHealth,
  funnelSummary,
  lessonTitlesFromSnapshot,
  parseAttentionFindings,
  pickSpotlightCourse,
  portfolioTotals,
  type CourseRow,
  type DraftMessageRow,
  type EnrollmentRow,
  type FunnelRollupRow,
  type LivePublicationRow,
  type OpenFindingRow,
  type ReviewRollupRow,
} from "@/lib/analytics/creatorHome";

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

/* ── Fixtures ── */

const COURSE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // live, busy
const COURSE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // draft, empty everywhere
const COURSE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // live, quieter
const PUB_A = "11111111-1111-4111-8111-111111111111";
const PUB_C = "33333333-3333-4333-8333-333333333333";

const courses: CourseRow[] = [
  { id: COURSE_A, title: "Algebra Foundations", status: "published", updated_at: "2026-07-07T10:00:00Z" },
  { id: COURSE_B, title: "", status: "draft", updated_at: "2026-07-06T10:00:00Z" },
  { id: COURSE_C, title: "Zebra Studies", status: "published", updated_at: "2026-07-05T10:00:00Z" },
];

const pubs: LivePublicationRow[] = [
  { id: PUB_A, course_id: COURSE_A, version: 3, visibility: "public" },
  { id: PUB_C, course_id: COURSE_C, version: 1, visibility: "unlisted" },
];

const enrollments: EnrollmentRow[] = [
  { course_id: COURSE_A, status: "active" },
  { course_id: COURSE_A, status: "completed" },
  { course_id: COURSE_A, status: "dropped" },
  { course_id: COURSE_C, status: "active" },
];

const reviews: ReviewRollupRow[] = [
  { course_id: COURSE_A, avg_rating: 4.0, review_count: 3 },
  { course_id: COURSE_C, avg_rating: 5.0, review_count: 1 },
];

const goodFinding = (title: string, severity: string, summary = "evidence line") => ({
  id: "f",
  kind: "content_issue",
  severity,
  title,
  evidence: { metrics: { n: 41 }, summary },
  targets: { lessonId: null, blockId: null, questionId: null, userId: null },
  recommendation: "fix it",
});

const findings: OpenFindingRow[] = [
  {
    id: "f1",
    course_id: COURSE_A,
    finding: goodFinding("Q3 is ambiguous", "high"),
    created_at: "2026-07-06T00:00:00Z",
  },
  {
    id: "f2",
    course_id: COURSE_A,
    finding: goodFinding("Lesson 2 skims", "medium"),
    created_at: "2026-07-07T00:00:00Z",
  },
];

const drafts: DraftMessageRow[] = [
  { id: "m1", course_id: COURSE_A },
  { id: "m2", course_id: COURSE_A },
];

function main() {
  /* ── 1. buildCourseHealth ── */
  console.log("\n— buildCourseHealth —");
  const health = buildCourseHealth(courses, pubs, enrollments, reviews, findings, drafts);

  check("one entry per course, input order preserved", health.length === 3 && health[0].id === COURSE_A && health[1].id === COURSE_B && health[2].id === COURSE_C);
  const [a, b, c] = health;
  check("live pub sets isLive + version + publicationId", a.isLive && a.version === 3 && a.publicationId === PUB_A);
  check("draft course is not live (null version/publicationId)", !b.isLive && b.version === null && b.publicationId === null);
  check("learners counted per course", a.learners === 3 && c.learners === 1);
  check("completed counts only status='completed'", a.completedLearners === 1 && c.completedLearners === 0);
  check("review rollup merged", a.avgRating === 4.0 && a.reviewCount === 3);
  check("open findings counted per course", a.openFindings === 2 && c.openFindings === 0);
  check("draft messages counted per course", a.draftMessages === 2 && b.draftMessages === 0);
  check(
    "zero-rows-anywhere course gets a complete all-zero entry",
    b.learners === 0 && b.completedLearners === 0 && b.avgRating === null && b.reviewCount === 0 && b.openFindings === 0 && b.draftMessages === 0
  );
  check("empty title falls back to 'Untitled course'", b.title === "Untitled course");
  check("updatedAt passthrough", a.updatedAt === "2026-07-07T10:00:00Z");

  const zeroCountReview = buildCourseHealth(
    [courses[0]],
    [],
    [],
    [{ course_id: COURSE_A, avg_rating: 0, review_count: 0 }],
    [],
    []
  );
  check("review row with review_count 0 never yields a 0-star rating", zeroCountReview[0].avgRating === null && zeroCountReview[0].reviewCount === 0);

  /* ── 2. portfolioTotals ── */
  console.log("\n— portfolioTotals —");
  const totals = portfolioTotals(health);
  check("courses + liveCourses counted", totals.courses === 3 && totals.liveCourses === 2);
  check("learners summed", totals.learners === 4 && totals.completedLearners === 1);
  check("completion rate = completed/total, rounded", totals.completionRatePct === 25);
  check(
    "avg rating is review_count-weighted (4.0×3 + 5.0×1 = 4.25 → 4.3)",
    totals.avgRating === 4.3 && totals.reviewCount === 4
  );
  check("findings summed + coursesWithFindings", totals.openFindings === 2 && totals.coursesWithFindings === 1);
  check("draft messages summed", totals.draftMessages === 2);

  const empty = portfolioTotals(buildCourseHealth([courses[1]], [], [], [], [], []));
  check("zero enrollments → completion rate null (em-dash case)", empty.completionRatePct === null);
  check("zero reviews → avg rating null (em-dash case)", empty.avgRating === null && empty.reviewCount === 0);

  /* ── 3. pickSpotlightCourse ── */
  console.log("\n— pickSpotlightCourse —");
  check("picks the live course with the most learners", pickSpotlightCourse(health)?.id === COURSE_A);
  check("no live publications → null", pickSpotlightCourse(buildCourseHealth(courses, [], enrollments, [], [], [])) === null);
  const draftHeavy = buildCourseHealth(
    courses,
    [{ id: PUB_C, course_id: COURSE_C, version: 1, visibility: "public" }],
    [
      { course_id: COURSE_B, status: "active" },
      { course_id: COURSE_B, status: "active" },
      { course_id: COURSE_C, status: "active" },
    ],
    [],
    [],
    []
  );
  check("a bigger DRAFT course never outranks a live one", pickSpotlightCourse(draftHeavy)?.id === COURSE_C);
  const tie = buildCourseHealth(
    [courses[2], courses[0]], // Zebra first in input
    pubs,
    [],
    [],
    [],
    []
  );
  check("learner tie breaks alphabetically by title", pickSpotlightCourse(tie)?.id === COURSE_A);

  /* ── 4. funnelSummary ── */
  console.log("\n— funnelSummary —");
  const funnelRows: FunnelRollupRow[] = [
    { lesson_id: "l1", started_count: 40, completed_count: 30, dropoff_pct: null },
    { lesson_id: "l2", started_count: 30, completed_count: 25, dropoff_pct: 25 },
    { lesson_id: "l3", started_count: 12, completed_count: 10, dropoff_pct: 60 },
    { lesson_id: "l4", started_count: 12, completed_count: 9, dropoff_pct: 0 },
  ];
  const funnel = funnelSummary(funnelRows);
  check(
    "rows pass through in order with mapped fields",
    funnel.lessons.length === 4 &&
      funnel.lessons[0].lessonId === "l1" &&
      funnel.lessons[0].started === 40 &&
      funnel.lessons[0].completed === 30 &&
      funnel.lessons[0].dropoffPct === null
  );
  check("biggest dropoff picks the max positive", funnel.biggestDropoff?.lessonId === "l3" && funnel.biggestDropoff?.dropoffPct === 60);
  check("maxStarted is the bar-scale denominator", funnel.maxStarted === 40);
  const flat = funnelSummary([
    { lesson_id: "l1", started_count: 10, completed_count: 10, dropoff_pct: null },
    { lesson_id: "l2", started_count: 10, completed_count: 10, dropoff_pct: 0 },
  ]);
  check("no positive dropoff → biggestDropoff null", flat.biggestDropoff === null);
  const noRows = funnelSummary([]);
  check("empty funnel → empty lessons, null dropoff, maxStarted 0", noRows.lessons.length === 0 && noRows.biggestDropoff === null && noRows.maxStarted === 0);

  /* ── 5. parseAttentionFindings (defensive jsonb) ── */
  console.log("\n— parseAttentionFindings —");
  const parsed = parseAttentionFindings(findings);
  check(
    "valid findings parse title/severity/summary",
    parsed.length === 2 && parsed[0].title === "Q3 is ambiguous" && parsed[0].severity === "high" && parsed[0].summary === "evidence line"
  );
  check("severity ranks high before medium (despite newer medium)", parsed[0].id === "f1" && parsed[1].id === "f2");

  const garbageRows: OpenFindingRow[] = [
    { id: "g1", course_id: COURSE_A, finding: null, created_at: "2026-07-01T00:00:00Z" },
    { id: "g2", course_id: COURSE_A, finding: "not an object", created_at: "2026-07-01T00:00:00Z" },
    { id: "g3", course_id: COURSE_A, finding: { severity: "high" }, created_at: "2026-07-01T00:00:00Z" }, // no title
    { id: "g4", course_id: COURSE_A, finding: { title: 42 }, created_at: "2026-07-01T00:00:00Z" }, // wrong type
    { id: "ok", course_id: COURSE_A, finding: goodFinding("Survivor", "low"), created_at: "2026-07-01T00:00:00Z" },
  ];
  let threw = false;
  let survived: ReturnType<typeof parseAttentionFindings> = [];
  try {
    survived = parseAttentionFindings(garbageRows);
  } catch {
    threw = true;
  }
  check("garbage jsonb never throws", !threw);
  check("garbage rows are skipped, valid row survives", survived.length === 1 && survived[0].id === "ok" && survived[0].title === "Survivor");
  check(
    "unknown severity defaults to medium (rendered amber, not dropped)",
    parseAttentionFindings([
      { id: "s1", course_id: COURSE_A, finding: { title: "Odd severity", severity: "catastrophic" }, created_at: "2026-07-01T00:00:00Z" },
    ])[0]?.severity === "medium"
  );
  check(
    "missing evidence → empty summary, still rendered",
    parseAttentionFindings([
      { id: "s2", course_id: COURSE_A, finding: { title: "Bare", severity: "low" }, created_at: "2026-07-01T00:00:00Z" },
    ])[0]?.summary === ""
  );
  const many: OpenFindingRow[] = Array.from({ length: 8 }, (_, i) => ({
    id: `m${i}`,
    course_id: COURSE_A,
    finding: goodFinding(`Finding ${i}`, "medium"),
    created_at: `2026-07-0${(i % 7) + 1}T00:00:00Z`,
  }));
  const capped = parseAttentionFindings(many, 5);
  check("cap applies after ranking", capped.length === 5);
  check(
    "within a severity, newest first",
    capped[0].createdAt >= capped[1].createdAt && capped[1].createdAt >= capped[2].createdAt
  );

  /* ── 6. lessonTitlesFromSnapshot (defensive walk) ── */
  console.log("\n— lessonTitlesFromSnapshot —");
  const snapshot = {
    modules: [
      { lessons: [{ id: "l1", title: "Intro" }, { id: "l2", title: "Slopes" }] },
      { lessons: [{ id: "l3", title: "Review" }] },
    ],
  };
  const titles = lessonTitlesFromSnapshot(snapshot);
  check("walks modules → lessons into an id→title map", titles.size === 3 && titles.get("l2") === "Slopes");
  check("null snapshot → empty map", lessonTitlesFromSnapshot(null).size === 0);
  check("string snapshot → empty map", lessonTitlesFromSnapshot("junk").size === 0);
  check("modules not an array → empty map", lessonTitlesFromSnapshot({ modules: 7 }).size === 0);
  check(
    "malformed lesson entries are skipped, valid ones kept",
    lessonTitlesFromSnapshot({
      modules: [{ lessons: [null, { id: "x" }, { id: "ok", title: "Kept" }, "junk"] }, null],
    }).get("ok") === "Kept"
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
