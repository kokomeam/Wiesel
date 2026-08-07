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
 *   • Migration drift guards (regex): the LATEST event_type CHECK (A3's
 *     20260807100000, 23 types) == the TS union both directions (the Wave-2
 *     22-type list stays as a historical pin); the four-server-member envelope
 *     arm (pub+version required, lesson optional); the ingest RPC's widened
 *     server-only reject (the three by name + the tutor_% arm); `>= 5` verbatim
 *     inside concept_mastery_aggregate (110200); strict-regime policy
 *     assertions on quiz_attempt_detail / mastery_review_queue /
 *     mastery_course_aggregate (RLS enabled, ZERO create policies) and
 *     learner_mastery (exactly ONE select policy `user_id = (select auth.uid())`).
 *
 *   A3 WAVE 2 (the tool-evidence spine — sections 9–16):
 *   • tutor_evidence_recorded schema goldens + every enum rejection +
 *     reviewedItemId non-null REJECTED ([FWD] — z.null() in A3) + client-batch
 *     exclusion; mapEventToColumns golden (every field → its column, old
 *     evidence columns null, snake_case name — ruling R-4).
 *   • Deterministic id: toolev:{completionKey} same-in → same-out.
 *   • normalizeMisconceptionSlug matrix (spaces/unicode/underscores/repeats/
 *     cap/empty→null) + resolveConceptNode (merge chains → survivor,
 *     cycle-safe, retired/absent drop — ruling R-1).
 *   • Tool-evidence weights mirror practice_answer magnitudes (+1.0 / +0.5 /
 *     −1.0) + the mapEvents fold.
 *   • A3-22 structural: evidenceRecord.ts imports nothing from toolTiers/
 *     approval; recordToolEvidence is the single append-only writer (R-3).
 *   • 20260807100000 drift guards: envelope arm, both column-isolation CHECKs,
 *     latency_ms NOT re-added, ingest RPC untouched, registry strict-write
 *     regime, rollup RPC floors (`>= 5` both ways) + grants.
 *     (The hardcoded 23-member union list lives in verify-tutor-stream-infra.ts
 *     — this suite locks SQL ↔ TS instead, deliberately not duplicating it.)
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
  TutorEvidenceRecordedSchema,
  TutorInferenceEventSchema,
  TutorInferencePayloadSchema,
  TUTOR_EVIDENCE_SERVER_EVENT_TYPES,
  type AnalyticsEventType,
} from "@/lib/analytics/events";
import { buildResponseSummary } from "@/lib/learn/grading";
import type { QuizQuestionResponse } from "@/lib/learn/schemas";
import {
  normalizeMisconceptionSlug,
  resolveConceptNode,
  type ConceptNodeLineageRef,
} from "@/lib/tutor/runtime/evidenceRecord";
import { tutorEvidenceId } from "@/lib/tutor/runtime/service";
import {
  ORDINAL_WEIGHTS,
  toolEvidenceWeight,
  TOOL_EVIDENCE_PARTIAL_FACTOR,
} from "@/lib/tutor/mastery/weights";
import { mapEvents, type MasteryEventRow } from "@/lib/tutor/mastery/evidence";

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
  console.log("\n— migration drift (20260803110000 events + the A3 lock) —");
  const evSql = readMigration("20260803110000_tutor_evidence_events.sql");

  // HISTORICAL: the Wave-2 migration froze 22 types at its point in time (the
  // file never changes). The AUTHORITATIVE current CHECK moved to the A3 Wave-2
  // migration (20260807100000) — the bidirectional TS ↔ SQL lock reads THAT.
  // (The hardcoded 23-member union list itself lives in
  // verify-tutor-stream-infra.ts — deliberately not duplicated here.)
  const wave2CheckMatch = evSql.match(/event_type in \(([\s\S]*?)\)\);/);
  const wave2SqlTypes = new Set(
    wave2CheckMatch ? [...wave2CheckMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : []
  );
  check("the Wave-2 event_type CHECK froze 22 types (historical)", wave2SqlTypes.size === 22);

  const a3Sql = readMigration("20260807100000_tutor_evidence_recorded.sql");
  const a3CheckMatch = a3Sql.match(
    /add constraint learning_events_event_type_check check \(event_type in \(([\s\S]*?)\)\);/
  );
  const sqlTypes = new Set(
    a3CheckMatch ? [...a3CheckMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : []
  );
  const tsTypes = new Set(AnalyticsEventSchema.options.map((o) => o.shape.eventType.value as string));
  check("the LATEST event_type CHECK list has 23 types", sqlTypes.size === 23);
  check("the TS AnalyticsEvent union has 23 types", tsTypes.size === 23);
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

  /* ════════════ A3 Wave 2 — the tool-evidence spine (tutor_evidence_recorded) ═ */

  /* ── 9. A3 schema goldens + rejections ── */
  console.log("\n— A3: tutor_evidence_recorded schema —");
  const toolGolden = {
    ...serverBase,
    eventType: "tutor_evidence_recorded" as const,
    toolName: "checkUnderstanding",
    outcome: "partial" as const,
    misconceptionSlug: "insertion-order-preserved",
    confidence: "unsure" as const,
    fadeLevel: 2,
    initiation: "invitation_accepted" as const,
    itemSource: "generated" as const,
    reviewedItemId: null,
    latencyMs: 5400,
  };
  check("golden parses", TutorEvidenceRecordedSchema.safeParse(toolGolden).success);
  check(
    "all nullables accepted as null (misconception/confidence/fadeLevel/latency/lesson)",
    TutorEvidenceRecordedSchema.safeParse({
      ...toolGolden,
      misconceptionSlug: null,
      confidence: null,
      fadeLevel: null,
      latencyMs: null,
      lessonId: null,
    }).success
  );
  check(
    "every legal outcome parses",
    (["demonstrated", "partial", "not_demonstrated"] as const).every(
      (o) => TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, outcome: o }).success
    )
  );
  check(
    "every legal initiation parses",
    (["question", "practice_request", "invitation_accepted"] as const).every(
      (i) => TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, initiation: i }).success
    )
  );
  check(
    "rejects a bad outcome ('mastered')",
    !TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, outcome: "mastered" }).success
  );
  check(
    "rejects a bad confidence ('confident')",
    !TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, confidence: "confident" }).success
  );
  check(
    "rejects a bad initiation ('nudge')",
    !TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, initiation: "nudge" }).success
  );
  check(
    "rejects a bad itemSource ('imported')",
    !TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, itemSource: "imported" }).success
  );
  check(
    "rejects fadeLevel 4 and -1 (0–3 only)",
    !TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, fadeLevel: 4 }).success &&
      !TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, fadeLevel: -1 }).success
  );
  check(
    "rejects a negative latencyMs",
    !TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, latencyMs: -1 }).success
  );
  check(
    "REJECTS a non-null reviewedItemId ([FWD] — always null in A3)",
    !TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, reviewedItemId: ITEM }).success
  );
  check(
    "rejects a >80-char misconceptionSlug (mirrors the DB CHECK)",
    !TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, misconceptionSlug: "a".repeat(81) })
      .success
  );
  check(
    "rejects an empty toolName",
    !TutorEvidenceRecordedSchema.safeParse({ ...toolGolden, toolName: "" }).success
  );
  check(
    "ClientBatchEventSchema REJECTS it (server-only; a batch carrying one fails)",
    !ClientBatchEventSchema.safeParse(toolGolden).success &&
      !AnalyticsBatchSchema.safeParse({ events: [toolGolden] }).success
  );
  check(
    "AnalyticsEventSchema (the 23-member contract) ACCEPTS it",
    AnalyticsEventSchema.safeParse(toolGolden).success
  );
  check(
    "TUTOR_EVIDENCE_SERVER_EVENT_TYPES gained it (5 members)",
    TUTOR_EVIDENCE_SERVER_EVENT_TYPES.length === 5 &&
      (TUTOR_EVIDENCE_SERVER_EVENT_TYPES as readonly string[]).includes("tutor_evidence_recorded")
  );

  /* ── 10. A3 mapEventToColumns golden ── */
  console.log("\n— A3: mapEventToColumns (tool-evidence columns + envelope) —");
  const tRow = mapEventToColumns(toolGolden, USER) as Record<string, unknown>;
  check(
    "snake_case event name lands verbatim (ruling R-4)",
    tRow.event_type === "tutor_evidence_recorded"
  );
  check(
    "every new field lands in its column",
    tRow.tool_name === "checkUnderstanding" &&
      tRow.outcome === "partial" &&
      tRow.misconception_slug === "insertion-order-preserved" &&
      tRow.confidence === "unsure" &&
      tRow.fade_level === 2 &&
      tRow.initiation === "invitation_accepted" &&
      tRow.item_source === "generated" &&
      tRow.reviewed_item_id === null &&
      tRow.latency_ms === 5400
  );
  check("node_id lands (the resolved concept node uuid — ruling R-1)", tRow.node_id === NODE);
  check(
    "the OLD evidence columns stay NULL (DB column-isolation mirrored)",
    tRow.attempt_ordinal === null &&
      tRow.hint_rung === null &&
      tRow.evidence_correct === null &&
      tRow.practice_item_ref === null
  );
  check(
    "tutor-evidence envelope (pub+version set; lesson rides through)",
    tRow.publication_id === PUB && tRow.version === 3 && tRow.lesson_id === LESSON &&
      tRow.user_id === USER && tRow.course_id === COURSE
  );
  check(
    "lesson OPTIONAL (null lesson maps to null column)",
    (mapEventToColumns({ ...toolGolden, lessonId: null }, USER) as Record<string, unknown>)
      .lesson_id === null
  );
  check(
    "metadata stays empty (everything is columnar on this type)",
    JSON.stringify(tRow.metadata) === "{}"
  );

  /* ── 11. A3 id determinism (toolev:{completionKey}) ── */
  console.log("\n— A3: deterministic event id —");
  const idA = tutorEvidenceId("toolev:comp-1");
  const idB = tutorEvidenceId("toolev:comp-1");
  const idC = tutorEvidenceId("toolev:comp-2");
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  check("same completionKey → same client_event_id", idA === idB);
  check("different completionKey → different id", idA !== idC);
  check("id is a v5-shaped uuid", UUID_SHAPE.test(idA));
  check(
    "the toolev purpose prefix never collides with the practice prefix",
    idA !== tutorEvidenceId("practice:comp-1")
  );

  /* ── 12. A3 normalizeMisconceptionSlug matrix ── */
  console.log("\n— A3: normalizeMisconceptionSlug —");
  check(
    "spaces + case: ' Insertion Order Preserved ' → 'insertion-order-preserved'",
    normalizeMisconceptionSlug(" Insertion Order Preserved ") === "insertion-order-preserved"
  );
  check(
    "underscores collapse: 'hash_map__basics' → 'hash-map-basics'",
    normalizeMisconceptionSlug("hash_map__basics") === "hash-map-basics"
  );
  check(
    "unicode + punctuation strip: 'Résumé—writing!' → 'rsumwriting'",
    normalizeMisconceptionSlug("Résumé—writing!") === "rsumwriting"
  );
  check("hyphen runs collapse: 'a---b' → 'a-b'", normalizeMisconceptionSlug("a---b") === "a-b");
  check("edge hyphens trim: '--x--' → 'x'", normalizeMisconceptionSlug("--x--") === "x");
  const capped = normalizeMisconceptionSlug("a".repeat(100));
  check("caps at 80", capped !== null && capped.length === 80);
  const cappedEdge = normalizeMisconceptionSlug("a".repeat(79) + "-bb");
  check(
    "the cap never leaves a trailing hyphen",
    cappedEdge !== null && !cappedEdge.endsWith("-") && cappedEdge.length <= 80
  );
  check("empty → null (invalid)", normalizeMisconceptionSlug("") === null);
  check("whitespace-only → null", normalizeMisconceptionSlug("   ") === null);
  check("nothing-survives ('!!!') → null", normalizeMisconceptionSlug("!!!") === null);
  check(
    "idempotent (normalize ∘ normalize = normalize)",
    normalizeMisconceptionSlug("Insertion Order Preserved") ===
      normalizeMisconceptionSlug(normalizeMisconceptionSlug("Insertion Order Preserved")!)
  );

  /* ── 13. A3 resolveConceptNode (merge chains, cycle-safe) ── */
  console.log("\n— A3: resolveConceptNode —");
  const lineage: ConceptNodeLineageRef[] = [
    { id: "A", status: "active", mergedIntoNodeId: null },
    { id: "B", status: "merged_into", mergedIntoNodeId: "A" },
    { id: "C", status: "merged_into", mergedIntoNodeId: "B" },
    { id: "R", status: "retired", mergedIntoNodeId: null },
    { id: "M", status: "merged_into", mergedIntoNodeId: "R" },
    { id: "X", status: "merged_into", mergedIntoNodeId: "Y" },
    { id: "Y", status: "merged_into", mergedIntoNodeId: "X" },
  ];
  check("an active id resolves to itself", resolveConceptNode(lineage, "A")?.id === "A");
  check(
    "a merge CHAIN walks to the survivor (C → B → A)",
    resolveConceptNode(lineage, "C")?.id === "A"
  );
  check("a retired id drops (null)", resolveConceptNode(lineage, "R") === null);
  check("an absent id drops (null)", resolveConceptNode(lineage, "nope") === null);
  check("a merge CYCLE drops instead of looping (X ↔ Y)", resolveConceptNode(lineage, "X") === null);
  check(
    "merged-into-a-retired-node drops (M → R retired)",
    resolveConceptNode(lineage, "M") === null
  );
  const longChain: ConceptNodeLineageRef[] = [{ id: "n0", status: "active", mergedIntoNodeId: null }];
  for (let i = 1; i <= 200; i += 1) {
    longChain.push({ id: `n${i}`, status: "merged_into", mergedIntoNodeId: `n${i - 1}` });
  }
  check(
    "a 200-hop chain resolves (bounded walk, no stack growth)",
    resolveConceptNode(longChain, "n200")?.id === "n0"
  );

  /* ── 14. A3 mastery weights + mapEvents fold ── */
  console.log("\n— A3: tool-evidence weights + mapEvents —");
  check(
    "demonstrated → +1.0 (the practice-correct weight)",
    toolEvidenceWeight("demonstrated").direction === 1 &&
      toolEvidenceWeight("demonstrated").weight === ORDINAL_WEIGHTS[0]
  );
  check(
    "partial → +0.5 (HALF the correct weight)",
    toolEvidenceWeight("partial").direction === 1 &&
      toolEvidenceWeight("partial").weight === ORDINAL_WEIGHTS[0] * TOOL_EVIDENCE_PARTIAL_FACTOR
  );
  check(
    "not_demonstrated → −1.0 (the practice-wrong weight)",
    toolEvidenceWeight("not_demonstrated").direction === -1 &&
      toolEvidenceWeight("not_demonstrated").weight === ORDINAL_WEIGHTS[0]
  );
  const foldRow: MasteryEventRow = {
    eventId: "e1",
    eventType: "tutor_evidence_recorded",
    nodeId: "N1",
    createdAt: TS,
    toolOutcome: "not_demonstrated",
  };
  const folded = mapEvents([foldRow]);
  check(
    "mapEvents folds a tool-evidence row (direction −1, weight 1, tagged kind)",
    folded.length === 1 &&
      folded[0].direction === -1 &&
      folded[0].weight === 1 &&
      folded[0].kind === "tutor_evidence_recorded" &&
      folded[0].sourceId === "tutor_evidence_recorded:e1" &&
      folded[0].nodeId === "N1"
  );
  check(
    "a partial folds positive at 0.5",
    mapEvents([{ ...foldRow, toolOutcome: "partial" }])[0]?.weight === 0.5 &&
      mapEvents([{ ...foldRow, toolOutcome: "partial" }])[0]?.direction === 1
  );
  check(
    "a row with no outcome yields nothing (never a throw)",
    mapEvents([{ ...foldRow, toolOutcome: null }]).length === 0
  );
  check(
    "a row with no nodeId yields nothing",
    mapEvents([{ ...foldRow, nodeId: null }]).length === 0
  );

  /* ── 15. A3-22 structural — evidenceRecord.ts source asserts ── */
  console.log("\n— A3-22: evidenceRecord.ts structural —");
  const recSrc = readFileSync(
    new URL("../lib/tutor/runtime/evidenceRecord.ts", import.meta.url),
    "utf8"
  );
  check(
    "NO import from the tool-tier / approval surface (A3-22)",
    !/from\s+["'][^"']*(toolTiers|approval)[^"']*["']/i.test(recSrc)
  );
  check(
    "recordToolEvidence is the exported writer",
    /export async function recordToolEvidence\(/.test(recSrc)
  );
  check(
    "the write rides the upsertEvent discipline (onConflict client_event_id + ignoreDuplicates)",
    /onConflict: "client_event_id"/.test(recSrc) && /ignoreDuplicates: true/.test(recSrc)
  );
  check(
    "EXACTLY ONE learning_events write site in the module (append-only, R-3)",
    (recSrc.match(/\.from\("learning_events"\)/g) ?? []).length === 1
  );
  check(
    "the deterministic id is toolev:{completionKey}",
    recSrc.includes("tutorEvidenceId(`toolev:${input.completionKey}`)")
  );
  check(
    "no versioned UPDATE on learning_events (append-only — updates belong to the registry only)",
    !/from\("learning_events"\)[\s\S]{0,200}?\.update\(/.test(recSrc)
  );

  /* ── 16. A3 migration drift — 20260807100000 ── */
  console.log("\n— migration drift (20260807100000 tool evidence) —");
  check(
    "envelope arm gained tutor_evidence_recorded (pub+version required, lesson optional)",
    /event_type in \('practice_answer','hint_request','self_report','tutor_inference',\s*'tutor_evidence_recorded'\)[\s\S]*?publication_id is not null and version is not null\)/.test(
      a3Sql
    )
  );
  check(
    "old-column isolation gained the arm: node_id NOT NULL, old four columns NULL",
    /when 'tutor_evidence_recorded' then\s*\n\s*node_id is not null and attempt_ordinal is null and hint_rung is null\s*\n\s*and evidence_correct is null and practice_item_ref is null/.test(
      a3Sql
    )
  );
  check(
    "NEW-column isolation CHECK present, both directions",
    /learning_events_tool_evidence_check/.test(a3Sql) &&
      /then tool_name is not null and outcome is not null\s*\n\s*and initiation is not null and item_source is not null/.test(
        a3Sql
      ) &&
      /else tool_name is null and outcome is null\s*\n\s*and misconception_slug is null and confidence is null\s*\n\s*and fade_level is null and initiation is null\s*\n\s*and item_source is null and reviewed_item_id is null/.test(
        a3Sql
      )
  );
  check(
    "the new columns are added with their CHECKs (outcome/confidence/fade_level/initiation/item_source)",
    /add column tool_name text/.test(a3Sql) &&
      /outcome in \('demonstrated','partial','not_demonstrated'\)/.test(a3Sql) &&
      /confidence in \('sure','unsure'\)/.test(a3Sql) &&
      /fade_level between 0 and 3/.test(a3Sql) &&
      /initiation in \('question','practice_request','invitation_accepted'\)/.test(a3Sql) &&
      /item_source in \('generated','reviewed'\)/.test(a3Sql) &&
      /add column reviewed_item_id uuid/.test(a3Sql) &&
      /char_length\(misconception_slug\) between 1 and 80/.test(a3Sql)
  );
  check(
    "latency_ms is NOT re-added (it already exists from 20260803100000)",
    !/add column latency_ms/.test(a3Sql)
  );
  check(
    "tutor_call_check re-created with a tutor_evidence_recorded arm; the else still pins latency_ms null",
    /when 'tutor_evidence_recorded' then\s*\n\s*job_type is null and model is null/.test(a3Sql) &&
      /else\s*\n\s*job_type is null and model is null\s*\n\s*and input_tokens is null and cached_input_tokens is null\s*\n\s*and output_tokens is null and computed_cost_usd is null\s*\n\s*and latency_ms is null and learner_user_id is null/.test(
        a3Sql
      )
  );
  check(
    "the refold's partial index gained the new type",
    /learning_events_evidence_idx[\s\S]*?'content_engagement','tutor_evidence_recorded'\)/.test(
      a3Sql
    )
  );
  check(
    "the ingest RPC is documented UNCHANGED (the tutor_% guard already rejects it)",
    /INGEST RPC NEEDS NO CHANGE/i.test(a3Sql) &&
      !/create or replace function public\.ingest_learning_events/.test(a3Sql)
  );

  // The registry (tutor_misconceptions): strict write regime.
  const a3PolicyTargets = [...a3Sql.matchAll(/create policy\b[^;]*?\bon\s+public\.(\w+)/gi)].map(
    (m) => m[1]
  );
  check(
    "tutor_misconceptions: RLS enabled",
    /alter table public\.tutor_misconceptions enable row level security/.test(a3Sql)
  );
  check(
    "tutor_misconceptions: EXACTLY ONE policy, and it is the author SELECT",
    a3PolicyTargets.filter((t) => t === "tutor_misconceptions").length === 1 &&
      /create policy "tutor_misconceptions_select" on public\.tutor_misconceptions for select/.test(
        a3Sql
      )
  );
  check(
    "tutor_misconceptions: unique (course_id, node_id, slug) + slug length CHECK 1–80",
    /unique \(course_id, node_id, slug\)/.test(a3Sql) &&
      /char_length\(slug\) between 1 and 80/.test(a3Sql)
  );
  check(
    "tutor_misconceptions: moddatetime trigger + version column",
    /tutor_misconceptions_set_updated_at before update/.test(a3Sql) &&
      /version    integer not null default 1/.test(a3Sql)
  );

  // The rollup RPC: definer + author gate + BOTH floors + grants.
  check(
    "tutor_misconception_rollup is SECURITY DEFINER + author-gated (raises for a non-author)",
    /create function public\.tutor_misconception_rollup\(p_course_id uuid\)/.test(a3Sql) &&
      /security definer/.test(a3Sql) &&
      /not the course author/.test(a3Sql)
  );
  check(
    "the >= 5 floor appears verbatim BOTH ways (cohort return-nothing + per-row omit)",
    (a3Sql.match(/>= 5|< 5/g) ?? []).length >= 2 &&
      /v_cohort < 5/.test(a3Sql) &&
      /having \(count\(distinct e\.user_id\) filter \(where e\.outcome <> 'demonstrated'\)\) >= 5/.test(
        a3Sql
      )
  );
  check(
    "the <20 raw-counts rule is documented as DISPLAY-side (the RPC always returns raw counts + cohort_size)",
    /DISPLAY rule/.test(a3Sql)
  );
  check(
    "rollup grants: PUBLIC/anon revoked; authenticated + service_role granted",
    /revoke all on function public\.tutor_misconception_rollup\(uuid\) from public, anon/.test(
      a3Sql
    ) &&
      /grant execute on function public\.tutor_misconception_rollup\(uuid\) to authenticated, service_role/.test(
        a3Sql
      )
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
