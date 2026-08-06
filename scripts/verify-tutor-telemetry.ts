/**
 * TUTOR-1 Wave 1.1B tutor cost-telemetry PURE verification — no DB, no key.
 * Run: `npx tsx scripts/verify-tutor-telemetry.ts`  (npm run verify:tutor:telemetry)
 *
 * Covers: tutorEventId determinism + purpose-prefix isolation from
 * uuidFromSvixId; the tutor_model_call column mapping golden (course envelope,
 * every tutor column, publication/version/lesson NULL); the CLIENT batch schema
 * REJECTING a tutor event (and still accepting a learner golden); the emitter's
 * cost wiring (computeCostUsd golden + null for an unknown model) via a stubbed
 * admin capturing the upsert payload; the never-throws posture (rejecting stub);
 * and a drift guard regexing migration 20260803100000 for the event list,
 * ingest reject, RLS exclusion, view revoke, and the two-sided NOT NULL fields.
 */

import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  AnalyticsBatchSchema,
  AnalyticsEventSchema,
  buildEvent,
  buildTutorModelCallEvent,
  ClientBatchEventSchema,
  mapEventToColumns,
  TUTOR_JOB_TYPES,
  TutorModelCallEventSchema,
  type TutorModelCallEvent,
} from "@/lib/analytics/events";
import { computeCostUsd } from "@/lib/ai/modelConfig";
import { emitTutorModelCall, tutorEventId } from "@/lib/tutor/telemetry";
import { uuidFromSvixId } from "@/lib/comms/webhook";

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

const COURSE = "11111111-1111-4111-8111-111111111111";
const LEARNER = "22222222-2222-4222-8222-222222222222";
const AUTHOR = "33333333-3333-4333-8333-333333333333";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tutorEvent(overrides: Partial<TutorModelCallEvent> = {}): TutorModelCallEvent {
  return buildTutorModelCallEvent(
    {
      eventType: "tutor_model_call",
      courseId: COURSE,
      learnerUserId: LEARNER,
      jobType: "tutor_turn",
      model: "gpt-5.6-luna",
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
      computedCostUsd: 0.001205,
      latencyMs: 842,
      ...overrides,
    },
    { clientEventId: tutorEventId("resp_abc"), clientTs: "2026-08-03T00:00:00.000Z" }
  );
}

/** A minimal admin stub capturing the upsert payload; the outcome is injectable. */
function stubAdmin(behavior: "ok" | "reject"): {
  admin: SupabaseClient<Database>;
  captured: () => Record<string, unknown> | null;
} {
  let payload: Record<string, unknown> | null = null;
  const admin = {
    from() {
      return {
        upsert(rows: Record<string, unknown>[]) {
          payload = rows[0] ?? null;
          if (behavior === "reject") {
            return Promise.reject(new Error("stub upsert rejected"));
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as SupabaseClient<Database>;
  return { admin, captured: () => payload };
}

async function main() {
  /* ── 1. tutorEventId determinism + isolation ── */
  console.log("\n— tutorEventId —");
  check("same input → same uuid", tutorEventId("resp_x") === tutorEventId("resp_x"));
  check("different input → different uuid", tutorEventId("resp_x") !== tutorEventId("resp_y"));
  check("valid uuid format", UUID_RE.test(tutorEventId("resp_x")));
  check(
    "purpose-prefix isolates from uuidFromSvixId of the same raw string",
    tutorEventId("shared-raw") !== uuidFromSvixId("shared-raw")
  );

  /* ── 2. Column mapping golden ── */
  console.log("\n— mapEventToColumns (tutor_model_call) —");
  const event = tutorEvent();
  const row = mapEventToColumns(event, AUTHOR) as Record<string, unknown>;
  check("event_type maps", row.event_type === "tutor_model_call");
  check("user_id is the emitting principal (acting id)", row.user_id === AUTHOR);
  check("learner_user_id is the separate attribution", row.learner_user_id === LEARNER);
  check("course_id maps (course-scoped)", row.course_id === COURSE);
  check(
    "position envelope is NULL",
    row.publication_id === null && row.version === null && row.lesson_id === null
  );
  check(
    "learner-engagement extras are NULL",
    row.block_id === null && row.slide_id === null && row.dwell_ms === null &&
      row.quartile === null && row.attempt_id === null
  );
  check("perf metric columns are absent/NULL (mutual exclusion)", row.metric_name == null);
  check(
    "tutor columns map",
    row.job_type === "tutor_turn" && row.model === "gpt-5.6-luna" &&
      row.input_tokens === 1000 && row.cached_input_tokens === 200 &&
      row.output_tokens === 500 && row.computed_cost_usd === 0.001205 &&
      row.latency_ms === 842
  );
  check(
    "idempotency key + clientTs ride through",
    row.client_event_id === event.clientEventId && row.client_ts === event.clientTs
  );
  const nullLearnerRow = mapEventToColumns(
    tutorEvent({ learnerUserId: null }),
    AUTHOR
  ) as Record<string, unknown>;
  check("learner-optional: null learner maps to null column", nullLearnerRow.learner_user_id === null);
  const nullCostRow = mapEventToColumns(
    tutorEvent({ model: "gpt-unknown", computedCostUsd: null }),
    AUTHOR
  ) as Record<string, unknown>;
  check("null cost (unpriced model) maps through", nullCostRow.computed_cost_usd === null);

  /* ── 3. Server-only: excluded from the CLIENT batch, present in the contract ── */
  console.log("\n— server-only exclusion —");
  check(
    "TUTOR_JOB_TYPES enum drives the schema",
    TutorModelCallEventSchema.safeParse(event).success &&
      !TutorModelCallEventSchema.safeParse({ ...event, jobType: "bogus" }).success
  );
  check(
    "TUTOR_JOB_TYPES has the six kinds (4 original + Wave 6.6's two Terra jobs)",
    TUTOR_JOB_TYPES.length === 6 &&
      TUTOR_JOB_TYPES.includes("graph_extraction") &&
      TUTOR_JOB_TYPES.includes("reconciliation") &&
      TUTOR_JOB_TYPES.includes("embedding") &&
      TUTOR_JOB_TYPES.includes("tutor_turn") &&
      TUTOR_JOB_TYPES.includes("lesson_rationale") &&
      TUTOR_JOB_TYPES.includes("escalation_dossier")
  );
  check(
    "CLIENT batch schema REJECTS a tutor_model_call event",
    !ClientBatchEventSchema.safeParse(event).success
  );
  const lessonGolden = buildEvent(
    { publicationId: COURSE, version: 1, courseId: COURSE, lessonId: LEARNER },
    { eventType: "lesson_started" }
  );
  check(
    "…and still ACCEPTS a lesson_started golden",
    ClientBatchEventSchema.safeParse(lessonGolden).success
  );
  check(
    "a batch carrying a tutor event fails AnalyticsBatchSchema",
    !AnalyticsBatchSchema.safeParse({ events: [event] }).success
  );
  check(
    "tutor_model_call IS in the full AnalyticsEventSchema contract",
    AnalyticsEventSchema.safeParse(event).success
  );

  /* ── 4. Emitter cost wiring ── */
  console.log("\n— emitTutorModelCall cost wiring —");
  // gpt-5.6-luna: (uncached 800 × 0.25 + cached 200 × 0.025 + out 500 × 2) / 1e6.
  const usage = { inputTokens: 1000, cachedTokens: 200, outputTokens: 500 };
  const costGolden = (800 * 0.25 + 200 * 0.025 + 500 * 2) / 1_000_000;
  check("hand-computed cost golden = 0.001205", costGolden === 0.001205);
  check("computeCostUsd matches the golden", computeCostUsd(usage, "gpt-5.6-luna") === costGolden);

  const okStub = stubAdmin("ok");
  await emitTutorModelCall(okStub.admin, {
    courseId: COURSE,
    learnerUserId: LEARNER,
    jobType: "tutor_turn",
    model: "gpt-5.6-luna",
    usage,
    latencyMs: 842,
    providerResponseId: "resp_abc",
    emittedBy: AUTHOR,
  });
  const captured = okStub.captured() as Record<string, unknown> | null;
  check("upsert was captured", captured !== null);
  check("emitter computed cost via computeCostUsd", captured?.computed_cost_usd === costGolden);
  check("emitter stamps the provider-derived idempotency key", captured?.client_event_id === tutorEventId("resp_abc"));
  check("emitter pins user_id to emittedBy", captured?.user_id === AUTHOR);

  const unknownStub = stubAdmin("ok");
  await emitTutorModelCall(unknownStub.admin, {
    courseId: COURSE,
    jobType: "embedding",
    model: "gpt-does-not-exist",
    usage,
    latencyMs: 10,
    providerResponseId: "resp_unknown",
    emittedBy: AUTHOR,
  });
  const unknownCap = unknownStub.captured() as Record<string, unknown> | null;
  check("unknown model → null computed cost persisted", unknownCap?.computed_cost_usd === null);
  check("learner-optional emit maps null learner", unknownCap?.learner_user_id === null);

  /* ── 5. Never throws ── */
  console.log("\n— never throws —");
  let threw = false;
  try {
    await emitTutorModelCall(stubAdmin("reject").admin, {
      courseId: COURSE,
      jobType: "graph_extraction",
      model: "gpt-5.6-luna",
      usage,
      latencyMs: 5,
      providerResponseId: "resp_reject",
      emittedBy: AUTHOR,
    });
  } catch {
    threw = true;
  }
  check("a rejecting admin upsert resolves without throwing", !threw);

  /* ── 6. Migration drift guard (20260803100000) ── */
  console.log("\n— migration drift guard (20260803100000) —");
  const sql = readFileSync(
    new URL("../supabase/migrations/20260803100000_tutor_model_call_events.sql", import.meta.url),
    "utf8"
  );
  check("event_type CHECK includes tutor_model_call", /'tutor_model_call'/.test(sql));
  check("ingest RPC rejects server-only tutor_% rows", /e\.event_type like 'tutor_%'/.test(sql) && /server-only event type/.test(sql));
  check(
    "author-select policy re-creation excludes tutor_%",
    /create policy "learning_events_select"[\s\S]*?event_type not like 'tutor_%'/.test(sql)
  );
  check(
    "view is SECURITY INVOKER + revoked from client roles",
    /security_invoker = true/.test(sql) &&
      /revoke all on public\.tutor_model_costs_daily from public, anon, authenticated/.test(sql)
  );
  check(
    "two-sided check names all five NOT NULL tutor fields",
    /learning_events_tutor_call_check/.test(sql) &&
      /job_type is not null/.test(sql) &&
      /model is not null/.test(sql) &&
      /input_tokens is not null/.test(sql) &&
      /output_tokens is not null/.test(sql) &&
      /latency_ms is not null/.test(sql)
  );
  check(
    "the ORIGINAL migration still encodes the four base job types",
    sql.includes("job_type in ('graph_extraction','reconciliation','embedding','tutor_turn')")
  );

  /* ── 7. Wave 6.6 migration drift guard (20260806160000) — the widened CHECK ── */
  console.log("\n— migration drift guard (20260806160000 — widened job_type CHECK) —");
  const widenSql = readFileSync(
    new URL("../supabase/migrations/20260806160000_tutor_cost_jobtypes.sql", import.meta.url),
    "utf8"
  );
  check(
    "the widened migration drops + re-adds learning_events_job_type_check",
    /drop constraint learning_events_job_type_check/.test(widenSql) &&
      /add constraint learning_events_job_type_check/.test(widenSql)
  );
  check(
    "the widened job_type CHECK matches TUTOR_JOB_TYPES verbatim (all six kinds)",
    // The list is line-wrapped in the migration; normalize whitespace before matching.
    widenSql
      .replace(/\s+/g, " ")
      .includes(`job_type in (${TUTOR_JOB_TYPES.map((j) => `'${j}'`).join(",")})`)
  );
  check(
    "the two new Terra job kinds are present in the widened CHECK",
    /'lesson_rationale'/.test(widenSql) && /'escalation_dossier'/.test(widenSql)
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
