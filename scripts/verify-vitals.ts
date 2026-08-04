/**
 * PERF-1 E1 RUM PURE verification — no DB, no key, no browser.
 * Run: `npx tsx scripts/verify-vitals.ts`  (npm run verify:vitals)
 *
 * Covers: the perf_vital contract member (accepts + rejects), its column
 * mapping (NULL course envelope + the six metric columns), route
 * normalization against the known app-tree shapes (incl. uuid scrub +
 * length cap), the sampling gate with an injected rng, the builder stamps,
 * and a drift guard regexing migration 20260718100100 for the TS-mirrored
 * literals (route cap, metric list, RPC scope-skip, view revoke).
 */

import { readFileSync } from "node:fs";
import {
  AnalyticsBatchSchema,
  ClientBatchEventSchema,
  mapEventToColumns,
  PERF_ROUTE_MAX_CHARS,
  PERF_VITAL_METRICS,
  PerfVitalEventSchema,
} from "@/lib/analytics/events";
import {
  buildPerfVitalEvent,
  deviceClassFromMedia,
  normalizeRoute,
  parseSampleRate,
  shouldSample,
  type PerfVitalInput,
} from "@/lib/analytics/vitals";

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

const BASE: PerfVitalInput = {
  metric: "LCP",
  value: 2444.5,
  rating: "needs-improvement",
  route: "/learn/[slug]/[lessonId]",
  deviceClass: "mobile",
  navigationType: "navigate",
};

function rejects(input: Record<string, unknown>): boolean {
  return !PerfVitalEventSchema.safeParse({
    eventType: "perf_vital",
    clientEventId: crypto.randomUUID(),
    clientTs: new Date().toISOString(),
    ...BASE,
    ...input,
  }).success;
}

function main() {
  /* ── 1. Contract ── */
  console.log("\n— perf_vital contract —");
  const everyMetric = PERF_VITAL_METRICS.map((metric) =>
    buildPerfVitalEvent({ ...BASE, metric, value: metric === "CLS" ? 0.083 : BASE.value })
  );
  check(
    "every declared metric builds + parses",
    everyMetric.length === PERF_VITAL_METRICS.length
  );
  check(
    "CLS keeps its raw unitless float",
    everyMetric.find((e) => e.metric === "CLS")?.value === 0.083
  );
  check(
    "TUTOR_TTFT (TUTOR-1) builds + parses as a perf_vital metric",
    everyMetric.some((e) => e.metric === "TUTOR_TTFT") &&
      ClientBatchEventSchema.safeParse(
        buildPerfVitalEvent({ ...BASE, metric: "TUTOR_TTFT", value: 842 })
      ).success
  );
  check(
    "perf_vital is in the CLIENT batch schema (unlike comms types)",
    ClientBatchEventSchema.safeParse(everyMetric[0]).success
  );
  check(
    "a mixed batch (perf_vital alongside itself) passes AnalyticsBatchSchema",
    AnalyticsBatchSchema.safeParse({ events: everyMetric }).success
  );
  check("zero value accepted (bfcache TTFB)", !rejects({ value: 0 }));
  check("null navigationType accepted", !rejects({ navigationType: null }));

  check("rejects a bad metric (FID)", rejects({ metric: "FID" }));
  check("rejects a missing route", rejects({ route: undefined }));
  check("rejects an empty route", rejects({ route: "" }));
  check(
    "rejects a route over the cap",
    rejects({ route: `/${"x".repeat(PERF_ROUTE_MAX_CHARS)}` })
  );
  check("rejects a negative value", rejects({ value: -1 }));
  check("rejects a bad rating", rejects({ rating: "meh" }));
  check("rejects a bad deviceClass", rejects({ deviceClass: "tablet" }));
  check(
    "rejects a learner envelope smuggled in… actually strips it (zod object)",
    (() => {
      const parsed = PerfVitalEventSchema.safeParse({
        eventType: "perf_vital",
        clientEventId: crypto.randomUUID(),
        clientTs: new Date().toISOString(),
        ...BASE,
        courseId: "22222222-2222-4222-8222-222222222222",
      });
      return parsed.success && !("courseId" in parsed.data);
    })()
  );

  /* ── 2. Column mapping ── */
  console.log("\n— mapEventToColumns —");
  const event = everyMetric[0];
  const row = mapEventToColumns(event, "99999999-9999-4999-8999-999999999999");
  check("event_type maps", row.event_type === "perf_vital");
  check("user_id is the caller-verified uid", row.user_id === "99999999-9999-4999-8999-999999999999");
  check(
    "course envelope is NULL (app-scoped)",
    row.course_id === null && row.publication_id === null && row.version === null && row.lesson_id === null
  );
  check(
    "learner extras are NULL",
    row.block_id === null && row.slide_id === null && row.dwell_ms === null &&
      row.quartile === null && row.attempt_id === null
  );
  check(
    "metric columns map",
    row.metric_name === "LCP" && row.metric_value === 2444.5 &&
      row.metric_rating === "needs-improvement" && row.route === BASE.route &&
      row.device_class === "mobile" && row.navigation_type === "navigate"
  );
  check(
    "idempotency key + clientTs ride through",
    row.client_event_id === event.clientEventId && row.client_ts === event.clientTs
  );

  /* ── 3. Route normalization ── */
  console.log("\n— normalizeRoute —");
  const uuid = "0f3a1b2c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  const table: Array<[string, string]> = [
    ["/dashboard", "/dashboard"],
    ["/", "/"],
    ["/learn/algebra-basics", "/learn/[slug]"],
    [`/learn/algebra-basics/${uuid}`, "/learn/[slug]/[lessonId]"],
    ["/p/intro-to-supply", "/p/[slug]"],
    [`/studio/${uuid}`, "/studio/[courseId]"],
    [`/studio/${uuid}/analytics`, "/studio/[courseId]/analytics"],
    [
      `/studio/${uuid}/analytics/learners/${uuid}`,
      "/studio/[courseId]/analytics/learners/[learnerId]",
    ],
    ["/marketing/email/new", "/marketing/email/new"],
    [`/marketing/email/${uuid}`, "/marketing/email/[id]"],
    [`/marketing/leads/${uuid}`, "/marketing/leads/[id]"],
    [`/marketing/sequences/${uuid}`, "/marketing/sequences/[id]"],
    ["/studio", "/studio"],
    ["/dashboard/", "/dashboard"],
    ["/dashboard?tab=reviews", "/dashboard"],
    ["/learn/algebra-basics#outline", "/learn/[slug]"],
    [`/some/future/${uuid}/detail`, "/some/future/[id]/detail"],
  ];
  for (const [input, expected] of table) {
    const got = normalizeRoute(input);
    check(`${input} → ${expected}`, got === expected, `got ${got}`);
  }
  const long = `/${"a".repeat(400)}`;
  check(
    "unknown over-long path caps at the DB CHECK",
    normalizeRoute(long).length === PERF_ROUTE_MAX_CHARS
  );
  check(
    "…and the capped pattern still parses",
    PerfVitalEventSchema.safeParse({
      eventType: "perf_vital",
      clientEventId: crypto.randomUUID(),
      clientTs: new Date().toISOString(),
      ...BASE,
      route: normalizeRoute(long),
    }).success
  );

  /* ── 4. Sampling ── */
  console.log("\n— sampling gate —");
  check("rate 1 always samples", shouldSample(1, () => 0.999));
  check("rate 0 never samples", !shouldSample(0, () => 0));
  check("rng below the rate samples", shouldSample(0.5, () => 0.4));
  check("rng at/above the rate does not", !shouldSample(0.5, () => 0.5));
  check(
    "deterministic with an injected rng",
    shouldSample(0.25, () => 0.2) && !shouldSample(0.25, () => 0.3)
  );
  check("parseSampleRate default is 1", parseSampleRate(undefined) === 1);
  check("…empty string → 1", parseSampleRate("") === 1);
  check("…garbage → 1", parseSampleRate("all-of-them") === 1);
  check("…clamps low", parseSampleRate("-2") === 0);
  check("…clamps high", parseSampleRate("7") === 1);
  check("…parses a fraction", parseSampleRate("0.25") === 0.25);

  /* ── 5. Builder + device class ── */
  console.log("\n— builder —");
  const built = buildPerfVitalEvent(BASE);
  check("clientEventId is stamped as a uuid", /^[0-9a-f-]{36}$/.test(built.clientEventId));
  check("clientTs is stamped as ISO", !Number.isNaN(Date.parse(built.clientTs)));
  const pinned = buildPerfVitalEvent(BASE, {
    clientEventId: "88888888-8888-4888-8888-888888888888",
    clientTs: "2026-07-18T00:00:00.000Z",
  });
  check(
    "explicit stamps win",
    pinned.clientEventId === "88888888-8888-4888-8888-888888888888" &&
      pinned.clientTs === "2026-07-18T00:00:00.000Z"
  );
  check(
    "device class maps media match → mobile",
    deviceClassFromMedia(true) === "mobile" && deviceClassFromMedia(false) === "desktop"
  );

  /* ── 6. Migration drift guard ── */
  console.log("\n— migration drift guard (20260718100100) —");
  const sql = readFileSync(
    new URL("../supabase/migrations/20260718100100_perf_vitals.sql", import.meta.url),
    "utf8"
  );
  check("event_type CHECK includes perf_vital", /'perf_vital'/.test(sql));
  check(
    "route cap matches PERF_ROUTE_MAX_CHARS",
    sql.includes(`char_length(route) <= ${PERF_ROUTE_MAX_CHARS}`)
  );

  // The FULL metric list is now enumerated in the TUTOR_TTFT follow-up
  // migration (20260804110000 re-creates learning_events_metric_name_check with
  // the extended list). PERF_VITAL_METRICS grew — the original perf_vitals
  // migration only ever knew the web-vitals five, so the current const is
  // asserted against the migration that OWNS the live constraint today. The
  // 5-member subset is still verified in the original file (it never dropped
  // a metric — only added).
  console.log("\n— migration drift guard (20260804110000 · TUTOR_TTFT) —");
  const tutorSql = readFileSync(
    new URL("../supabase/migrations/20260804110000_tutor_ttft_vital.sql", import.meta.url),
    "utf8"
  );
  check(
    "TUTOR_TTFT follow-up re-creates the metric_name CHECK",
    /drop constraint learning_events_metric_name_check/.test(tutorSql) &&
      /add constraint learning_events_metric_name_check/.test(tutorSql)
  );
  check(
    "the re-created metric list matches PERF_VITAL_METRICS (incl. TUTOR_TTFT)",
    tutorSql.includes(`metric_name in (${PERF_VITAL_METRICS.map((m) => `'${m}'`).join(",")})`)
  );
  check("TUTOR_TTFT is in PERF_VITAL_METRICS", PERF_VITAL_METRICS.includes("TUTOR_TTFT"));
  check(
    "the original five survive in the perf_vitals migration",
    ["LCP", "INP", "CLS", "FCP", "TTFB"].every((m) => sql.includes(`'${m}'`))
  );
  check(
    "alerts-never-gates rule is restated in the TUTOR_TTFT header",
    /never\s+.*blocks|ALERTS-NOT-GATES|monitoring signal, not a quality gate/i.test(tutorSql)
  );
  check(
    "RPC skips BOTH scope checks for perf_vital",
    (sql.match(/e\.event_type <> 'perf_vital'/g) ?? []).length === 2
  );
  check(
    "view is SECURITY INVOKER + revoked from client roles",
    /security_invoker = true/.test(sql) &&
      /revoke all on public\.perf_vitals_daily from public, anon, authenticated/.test(sql)
  );
  check(
    "alerts-never-gates rule is stated in the view header",
    /never\s+quality gates|MONITORING ALERTS, never/i.test(sql)
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
