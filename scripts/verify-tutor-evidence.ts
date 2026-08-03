/**
 * TUTOR-1 Wave 2 learning-evidence contract PURE verification — no DB, no key.
 * Run: `npx tsx scripts/verify-tutor-evidence.ts`
 *
 * Covers:
 *   • Zod goldens for every new event type (practice_answer / hint_request /
 *     self_report / tutor_inference / content_engagement) + illegal-shape
 *     rejections mirroring the DB column-isolation matrix (migration 110000 §3).
 *   • ClientBatchEventSchema accepts content_engagement and REJECTS the four
 *     server-only members; AnalyticsBatchSchema fails a batch carrying one.
 *   • mapEventToColumns goldens: the five evidence columns land per member; the
 *     envelope nulls match each member's scope (server: pub/version, lesson
 *     optional; client: full envelope).
 *   • TutorInferencePayloadSchema frozen goldens ({nodeId, direction, strength,
 *     turnRef}) + illegal rejections.
 *   • response_summary leak-guard: build the summaries the way quizService does
 *     (buildResponseSummary over a graded fixture) and assert no answer-key key
 *     (expectedAnswer / correctChoice* / acceptedAnswers / explanation) appears
 *     at ANY depth.
 *   • Migration drift guards (regex): the 22-type CHECK list == the TS union
 *     both directions; the four-server-member envelope arm (pub+version
 *     required, lesson optional); the ingest RPC's widened server-only reject
 *     (the three by name + the tutor_% arm); `>= 5` verbatim inside
 *     concept_mastery_aggregate (110200); strict-regime policy assertions on
 *     quiz_attempt_detail / mastery_review_queue / mastery_course_aggregate
 *     (RLS enabled, ZERO create policies) and learner_mastery (exactly ONE
 *     select policy `user_id = (select auth.uid())`).
 */

import { readFileSync } from "node:fs";
import {
  AnalyticsBatchSchema,
  AnalyticsEventSchema,
  ClientBatchEventSchema,
  ContentEngagementEventSchema,
  HintRequestEventSchema,
  mapEventToColumns,
  PracticeAnswerEventSchema,
  SelfReportEventSchema,
  TutorInferenceEventSchema,
  TutorInferencePayloadSchema,
  type AnalyticsEventType,
} from "@/lib/analytics/events";
import { buildResponseSummary } from "@/lib/learn/grading";
import type { QuizQuestionResponse } from "@/lib/learn/schemas";

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
const PUB = "22222222-2222-4222-8222-222222222222";
const LESSON = "33333333-3333-4333-8333-333333333333";
const NODE = "44444444-4444-4444-8444-444444444444";
const ITEM = "55555555-5555-4555-8555-555555555555";
const USER = "66666666-6666-4666-8666-666666666666";
const CEID = "77777777-7777-4777-8777-777777777777";
const TS = "2026-08-03T00:00:00.000Z";

/** The base every SERVER tutor-evidence event carries (lesson OPTIONAL). */
const serverBase = {
  courseId: COURSE,
  publicationId: PUB,
  version: 3,
  lessonId: LESSON,
  nodeId: NODE,
  clientEventId: CEID,
  clientTs: TS,
};

function readMigration(name: string): string {
  return readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
}

function main() {
  /* ── 1. Zod goldens + illegal-shape rejections (mirror the DB matrix) ── */
  console.log("\n— practice_answer —");
  const practiceGolden = {
    ...serverBase,
    eventType: "practice_answer" as const,
    attemptOrdinal: 2,
    evidenceCorrect: true,
    practiceItemRef: ITEM,
  };
  check("golden parses", PracticeAnswerEventSchema.safeParse(practiceGolden).success);
  check(
    "hint_rung is not a practice_answer field (stripped by the schema; DB CHECK enforces isolation)",
    !("hintRung" in (PracticeAnswerEventSchema.parse({ ...practiceGolden, hintRung: 1 } as never) as object))
  );
  check(
    "rejects a missing practiceItemRef",
    !PracticeAnswerEventSchema.safeParse({ ...practiceGolden, practiceItemRef: undefined }).success
  );
  check(
    "rejects attemptOrdinal < 1",
    !PracticeAnswerEventSchema.safeParse({ ...practiceGolden, attemptOrdinal: 0 }).success
  );

  console.log("\n— hint_request —");
  const hintGolden = {
    ...serverBase,
    eventType: "hint_request" as const,
    hintRung: 4,
    practiceItemRef: ITEM,
  };
  check("golden parses (rung 4)", HintRequestEventSchema.safeParse(hintGolden).success);
  check(
    "practiceItemRef is nullable",
    HintRequestEventSchema.safeParse({ ...hintGolden, practiceItemRef: null }).success
  );
  check(
    "rejects rung 5 (0–4 only)",
    !HintRequestEventSchema.safeParse({ ...hintGolden, hintRung: 5 }).success
  );
  check(
    "rejects rung -1",
    !HintRequestEventSchema.safeParse({ ...hintGolden, hintRung: -1 }).success
  );
  check(
    "evidenceCorrect is not a hint_request field (stripped; DB CHECK enforces isolation)",
    !("evidenceCorrect" in (HintRequestEventSchema.parse({ ...hintGolden, evidenceCorrect: true } as never) as object))
  );

  console.log("\n— self_report —");
  const selfGolden = { ...serverBase, eventType: "self_report" as const, evidenceCorrect: false };
  check("golden parses", SelfReportEventSchema.safeParse(selfGolden).success);
  check(
    "practiceItemRef is not a self_report field (stripped; DB CHECK enforces isolation)",
    !("practiceItemRef" in (SelfReportEventSchema.parse({ ...selfGolden, practiceItemRef: ITEM } as never) as object))
  );
  check(
    "rejects a missing evidenceCorrect",
    !SelfReportEventSchema.safeParse({ ...selfGolden, evidenceCorrect: undefined }).success
  );

  console.log("\n— tutor_inference —");
  const inferGolden = {
    ...serverBase,
    eventType: "tutor_inference" as const,
    metadata: { nodeId: NODE, direction: "positive" as const, strength: "moderate" as const, turnRef: "turn_9" },
  };
  check("golden parses", TutorInferenceEventSchema.safeParse(inferGolden).success);
  check(
    "rejects a missing metadata payload",
    !TutorInferenceEventSchema.safeParse({ ...inferGolden, metadata: undefined }).success
  );
  check(
    "columnar evidence is not a tutor_inference field (stripped; only node is columnar, DB CHECK enforces it)",
    !("evidenceCorrect" in (TutorInferenceEventSchema.parse({ ...inferGolden, evidenceCorrect: true } as never) as object))
  );

  console.log("\n— content_engagement (the one client member) —");
  const engageGolden = {
    publicationId: PUB,
    version: 3,
    courseId: COURSE,
    lessonId: LESSON,
    clientEventId: CEID,
    clientTs: TS,
    eventType: "content_engagement" as const,
    signal: "rewatch" as const,
  };
  check("golden parses", ContentEngagementEventSchema.safeParse(engageGolden).success);
  check(
    "requires a full envelope (lesson NOT NULL for the client member)",
    !ContentEngagementEventSchema.safeParse({ ...engageGolden, lessonId: undefined }).success
  );
  check(
    "rejects a bad signal",
    !ContentEngagementEventSchema.safeParse({ ...engageGolden, signal: "bogus" }).success
  );
  check(
    "accepts scrub_back + completed",
    ContentEngagementEventSchema.safeParse({ ...engageGolden, signal: "scrub_back" }).success &&
      ContentEngagementEventSchema.safeParse({ ...engageGolden, signal: "completed" }).success
  );

  /* ── 2. Client-batch isolation: content_engagement in, the four server out ── */
  console.log("\n— ClientBatchEventSchema isolation —");
  check(
    "ACCEPTS content_engagement",
    ClientBatchEventSchema.safeParse(engageGolden).success
  );
  check(
    "REJECTS practice_answer",
    !ClientBatchEventSchema.safeParse(practiceGolden).success
  );
  check("REJECTS hint_request", !ClientBatchEventSchema.safeParse(hintGolden).success);
  check("REJECTS self_report", !ClientBatchEventSchema.safeParse(selfGolden).success);
  check("REJECTS tutor_inference", !ClientBatchEventSchema.safeParse(inferGolden).success);
  check(
    "a batch carrying a server evidence event fails AnalyticsBatchSchema",
    !AnalyticsBatchSchema.safeParse({ events: [practiceGolden] }).success
  );
  check(
    "a batch of only content_engagement passes AnalyticsBatchSchema",
    AnalyticsBatchSchema.safeParse({ events: [engageGolden] }).success
  );
  check(
    "all five are in the full AnalyticsEventSchema contract",
    AnalyticsEventSchema.safeParse(practiceGolden).success &&
      AnalyticsEventSchema.safeParse(hintGolden).success &&
      AnalyticsEventSchema.safeParse(selfGolden).success &&
      AnalyticsEventSchema.safeParse(inferGolden).success &&
      AnalyticsEventSchema.safeParse(engageGolden).success
  );

  /* ── 3. mapEventToColumns goldens (five columns + envelope nulls) ── */
  console.log("\n— mapEventToColumns (evidence columns + envelope) —");
  const pRow = mapEventToColumns(practiceGolden, USER) as Record<string, unknown>;
  check(
    "practice_answer: node + item + ordinal + correct; hint_rung NULL",
    pRow.node_id === NODE &&
      pRow.practice_item_ref === ITEM &&
      pRow.attempt_ordinal === 2 &&
      pRow.evidence_correct === true &&
      pRow.hint_rung === null
  );
  check(
    "practice_answer: server envelope (pub+version set, lesson set here)",
    pRow.publication_id === PUB && pRow.version === 3 && pRow.lesson_id === LESSON &&
      pRow.user_id === USER && pRow.course_id === COURSE
  );

  const hRow = mapEventToColumns(hintGolden, USER) as Record<string, unknown>;
  check(
    "hint_request: node + rung + item; ordinal & evidence_correct NULL",
    hRow.node_id === NODE && hRow.hint_rung === 4 && hRow.practice_item_ref === ITEM &&
      hRow.attempt_ordinal === null && hRow.evidence_correct === null
  );

  const sRow = mapEventToColumns(selfGolden, USER) as Record<string, unknown>;
  check(
    "self_report: node + evidence_correct; item/rung/ordinal NULL",
    sRow.node_id === NODE && sRow.evidence_correct === false &&
      sRow.practice_item_ref === null && sRow.hint_rung === null && sRow.attempt_ordinal === null
  );

  const iRow = mapEventToColumns(inferGolden, USER) as Record<string, unknown>;
  check(
    "tutor_inference: only node columnar; the rest ride metadata",
    iRow.node_id === NODE && iRow.evidence_correct === null && iRow.hint_rung === null &&
      iRow.attempt_ordinal === null && iRow.practice_item_ref === null
  );
  check(
    "tutor_inference: metadata carries the frozen Wave-3 payload",
    JSON.stringify(iRow.metadata) ===
      JSON.stringify({ nodeId: NODE, direction: "positive", strength: "moderate", turnRef: "turn_9" })
  );

  const eRow = mapEventToColumns(engageGolden, USER) as Record<string, unknown>;
  check(
    "content_engagement: NO evidence columns (client can't know nodes)",
    eRow.node_id == null && eRow.attempt_ordinal == null && eRow.hint_rung == null &&
      eRow.evidence_correct == null && eRow.practice_item_ref == null
  );
  check(
    "content_engagement: full envelope + signal rides metadata",
    eRow.publication_id === PUB && eRow.version === 3 && eRow.lesson_id === LESSON &&
      JSON.stringify(eRow.metadata) === JSON.stringify({ signal: "rewatch" })
  );

  // lesson-OPTIONAL server envelope: a null lesson still maps for the server four.
  const nullLessonRow = mapEventToColumns(
    { ...practiceGolden, lessonId: null },
    USER
  ) as Record<string, unknown>;
  check(
    "server evidence: lesson OPTIONAL (null lesson maps to null column)",
    nullLessonRow.lesson_id === null && nullLessonRow.publication_id === PUB
  );

  /* ── 4. TutorInferencePayloadSchema frozen goldens ── */
  console.log("\n— TutorInferencePayloadSchema (frozen Wave-3 shape) —");
  const payload = { nodeId: NODE, direction: "negative" as const, strength: "weak" as const, turnRef: "t1" };
  check("frozen golden parses", TutorInferencePayloadSchema.safeParse(payload).success);
  check(
    "accepts every legal enum combo",
    (["positive", "negative"] as const).every((d) =>
      (["weak", "moderate"] as const).every(
        (s) => TutorInferencePayloadSchema.safeParse({ nodeId: NODE, direction: d, strength: s, turnRef: "x" }).success
      )
    )
  );
  check(
    "rejects a bad direction",
    !TutorInferencePayloadSchema.safeParse({ ...payload, direction: "up" }).success
  );
  check(
    "rejects a 'strong' strength (only weak|moderate)",
    !TutorInferencePayloadSchema.safeParse({ ...payload, strength: "strong" }).success
  );
  check(
    "rejects a missing turnRef",
    !TutorInferencePayloadSchema.safeParse({ nodeId: NODE, direction: "positive", strength: "weak" }).success
  );
  check(
    "rejects a non-uuid nodeId",
    !TutorInferencePayloadSchema.safeParse({ ...payload, nodeId: "not-a-uuid" }).success
  );

  /* ── 5. response_summary leak-guard (built the way quizService builds it) ── */
  console.log("\n— response_summary leak-guard —");
  // A graded fixture of one of every response kind. buildResponseSummary is
  // EXACTLY what quizService.ts maps into p_detail[].response_summary.
  const responses: QuizQuestionResponse[] = [
    { kind: "multiple_choice", questionId: "q1", choiceId: "c2" },
    { kind: "multi_select", questionId: "q2", choiceIds: ["c1", "c3"] },
    { kind: "true_false", questionId: "q3", answer: true },
    { kind: "short_answer", questionId: "q4", text: "  Photosynthesis  " },
  ];
  const summaries = responses.map(buildResponseSummary);
  const FORBIDDEN = /expectedAnswer|correctChoice|acceptedAnswers|explanation/i;
  const serialized = JSON.stringify(summaries);
  check(
    "no answer-key key appears at any depth of the summaries",
    !FORBIDDEN.test(serialized),
    serialized
  );
  check(
    "mc summary is selected id only",
    JSON.stringify(summaries[0]) === JSON.stringify({ selected: "c2" })
  );
  check(
    "ms summary is the selected id set only",
    JSON.stringify(summaries[1]) === JSON.stringify({ selected: ["c1", "c3"] })
  );
  check(
    "tf summary is the selected boolean only",
    JSON.stringify(summaries[2]) === JSON.stringify({ selected: true })
  );
  check(
    "sa summary is the trimmed submitted text only",
    JSON.stringify(summaries[3]) === JSON.stringify({ text: "Photosynthesis" })
  );
  check(
    "every summary key is one of {selected,text}",
    summaries.every((s) => Object.keys(s).every((k) => k === "selected" || k === "text"))
  );

  /* ── 6. Migration drift guard — 20260803110000 (events) ── */
  console.log("\n— migration drift (20260803110000 events) —");
  const evSql = readMigration("20260803110000_tutor_evidence_events.sql");

  // The 22-type CHECK list == the TS union, BOTH directions.
  const checkMatch = evSql.match(/event_type in \(([\s\S]*?)\)\);/);
  const sqlTypes = new Set(
    checkMatch ? [...checkMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : []
  );
  const tsTypes = new Set(AnalyticsEventSchema.options.map((o) => o.shape.eventType.value as string));
  check("the event_type CHECK list has 22 types", sqlTypes.size === 22);
  check("the TS AnalyticsEvent union has 22 types", tsTypes.size === 22);
  check(
    "every TS event type is in the SQL CHECK list (TS ⊆ SQL)",
    [...tsTypes].every((t) => sqlTypes.has(t)),
    [...tsTypes].filter((t) => !sqlTypes.has(t)).join(",")
  );
  check(
    "every SQL event type is in the TS union (SQL ⊆ TS)",
    [...sqlTypes].every((t) => tsTypes.has(t as AnalyticsEventType)),
    [...sqlTypes].filter((t) => !tsTypes.has(t as AnalyticsEventType)).join(",")
  );

  // The four-server-member envelope arm: pub+version required, lesson optional.
  check(
    "envelope arm: the four server evidence types require pub+version (lesson optional)",
    /event_type in \('practice_answer','hint_request','self_report','tutor_inference'\)[\s\S]*?publication_id is not null and version is not null\)/.test(
      evSql
    )
  );
  // content_engagement is NOT in that arm — it keeps the full envelope.
  check(
    "content_engagement is absent from the tutor-evidence envelope arm (keeps the full envelope)",
    !/'practice_answer','hint_request','self_report','tutor_inference','content_engagement'\)[\s\S]*?and publication_id is not null and version is not null\)/.test(
      evSql
    )
  );

  // The ingest RPC's widened server-only reject.
  check(
    "ingest RPC rejects the three by name + keeps the tutor_% arm",
    /e\.event_type like 'tutor_%'/.test(evSql) &&
      /e\.event_type in \('practice_answer','hint_request','self_report'\)/.test(evSql) &&
      /server-only event type/.test(evSql)
  );

  // Column-isolation CHECK exists and is bidirectional (each type its own, else none).
  check(
    "column-isolation CHECK present with the five columns and an else-none arm",
    /learning_events_evidence_check/.test(evSql) &&
      /node_id is null and attempt_ordinal is null and hint_rung is null/.test(evSql) &&
      /evidence_correct is null and practice_item_ref is null/.test(evSql)
  );
  check(
    "the five new columns are added (node_id/attempt_ordinal/hint_rung/evidence_correct/practice_item_ref)",
    /add column node_id uuid/.test(evSql) &&
      /add column attempt_ordinal integer/.test(evSql) &&
      /add column hint_rung smallint/.test(evSql) &&
      /add column evidence_correct boolean/.test(evSql) &&
      /add column practice_item_ref uuid/.test(evSql)
  );

  /* ── 7. Migration drift — 20260803110100 (quiz_attempt_detail) ── */
  console.log("\n— migration drift (20260803110100 quiz_attempt_detail) —");
  const qdSql = readMigration("20260803110100_quiz_attempt_detail.sql");
  check(
    "quiz_attempt_detail: RLS enabled",
    /alter table public\.quiz_attempt_detail enable row level security/.test(qdSql)
  );
  check(
    "quiz_attempt_detail: ZERO create-policy statements (strict regime)",
    [...qdSql.matchAll(/create policy\b[^;]*?\bon\s+public\.(\w+)/gi)].filter(
      (m) => m[1] === "quiz_attempt_detail"
    ).length === 0
  );
  check(
    "record_quiz_attempt is service-role only (revoked from request roles)",
    /revoke all on function public\.record_quiz_attempt\(jsonb, jsonb, jsonb\)\s*\n?\s*from public, anon, authenticated/.test(
      qdSql
    ) && /grant execute on function public\.record_quiz_attempt\(jsonb, jsonb, jsonb\) to service_role/.test(qdSql)
  );
  check(
    "my_quiz_detail scopes to the caller (user_id = auth.uid())",
    /d\.user_id = \(select auth\.uid\(\)\)/.test(qdSql)
  );
  check(
    "detail insert is idempotent (on conflict … do nothing over the unique triple)",
    /on conflict \(attempt_id, block_id, question_id\) do nothing/.test(qdSql)
  );

  /* ── 8. Migration drift — 20260803110200 (mastery) ── */
  console.log("\n— migration drift (20260803110200 mastery) —");
  const mSql = readMigration("20260803110200_learner_mastery.sql");
  check("concept_mastery_aggregate encodes the cohort floor `>= 5` verbatim", />= 5/.test(mSql));

  // Extract the target of every `create policy … on public.<table>` statement so
  // the per-table policy COUNT is unambiguous (no [\s\S]* bridge across tables).
  const policyTargets = [...mSql.matchAll(/create policy\b[^;]*?\bon\s+public\.(\w+)/gi)].map(
    (m) => m[1]
  );
  const policyCount = (table: string) => policyTargets.filter((t) => t === table).length;

  check(
    "learner_mastery: RLS enabled",
    /alter table public\.learner_mastery enable row level security/.test(mSql)
  );
  check("learner_mastery: exactly ONE policy", policyCount("learner_mastery") === 1);
  check(
    "learner_mastery: the one policy is a SELECT of own rows (user_id = auth.uid())",
    /create policy "learner_mastery_select_own" on public\.learner_mastery for select\s*\n?\s*using \(user_id = \(select auth\.uid\(\)\)\)/.test(
      mSql
    )
  );
  check(
    "mastery_review_queue: RLS enabled, ZERO create policies",
    /alter table public\.mastery_review_queue enable row level security/.test(mSql) &&
      policyCount("mastery_review_queue") === 0
  );
  check(
    "mastery_course_aggregate: RLS enabled, ZERO create policies",
    /alter table public\.mastery_course_aggregate enable row level security/.test(mSql) &&
      policyCount("mastery_course_aggregate") === 0
  );
  check(
    "my_review_queue scopes to the caller (user_id = auth.uid())",
    /q\.user_id = \(select auth\.uid\(\)\)/.test(mSql)
  );
  check(
    "concept_mastery_aggregate is author-gated (raises for a non-author)",
    /not the course author/.test(mSql) && /c\.author_id = \(select auth\.uid\(\)\)/.test(mSql)
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
