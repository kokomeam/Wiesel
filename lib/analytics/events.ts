/**
 * Zod contract for the learning-event stream (Milestone 3; comms delivery
 * events added in Milestone 7). Single source of truth for every event that
 * lands in `learning_events` — types are INFERRED, never duplicated. Wire
 * shape is camelCase (matching every /api/learn payload); `mapEventToColumns`
 * translates to the snake_case DB row.
 *
 * Trust boundary: the client reports WHAT THE LEARNER DID (a slide was on
 * screen for N ms, a video crossed a quartile). Nothing here is a grade or a
 * completion claim — the AUTHORITATIVE events (quiz_submitted,
 * homework_submitted, lesson_completed) are SERVER-emitted from the existing
 * grading/submission/progress writers (lib/analytics/serverEmit.ts), keyed by
 * stable row uuids so a retry can never double-count. Client events are
 * deduped by the DB-unique clientEventId (`on conflict do nothing`), which is
 * what makes batch replay idempotent.
 *
 * COMMS DELIVERY EVENTS (Milestone 7): comms_email_delivered / _open /
 * _click / _bounce / _complaint are SERVER-emitted by the Resend webhook
 * route only (lib/comms/webhook.ts), keyed by a uuid derived from the Svix
 * message id. They carry a COURSE envelope (no publication/version/lesson —
 * an email is course-scoped and outlives republishes) and the learner_messages
 * id in metadata. They are NOT in the client batch contract
 * (`AnalyticsBatchSchema` composes only `ClientBatchEventSchema`), so a
 * browser can never forge delivery telemetry — and the ingest RPC would
 * independently reject them (no publication).
 *
 * PERF VITALS (PERF-1 E1): perf_vital is the one APP-scoped client event —
 * RUM web-vitals (LCP/INP/CLS/FCP/TTFB) with a NULL course envelope. The
 * ingest RPC skips the enrollment + publication∈course checks for exactly
 * this type (still pinning user_id to auth.uid()), and the NULL course_id
 * keeps the rows outside the author-select RLS — read surface is the
 * service-role-only perf_vitals_daily view (migration 20260718100100).
 *
 * TUTOR COST TELEMETRY (TUTOR-1 Wave 1.1): tutor_model_call records one AI-tutor
 * model call's token usage, computed USD cost, and latency. It is SERVER-emitted
 * ONLY (lib/tutor/telemetry.ts, admin client), keyed by a uuid derived from the
 * provider response id (retry-stable). It carries a COURSE envelope (course-scoped
 * cost; no publication/version/lesson) with an OPTIONAL learner. Like the comms
 * types it is deliberately ABSENT from the client batch contract, and the ingest
 * RPC independently rejects any tutor_% row. Per-call rows are author-INVISIBLE
 * (R-9); the only read surface is the service-role-only tutor_model_costs_daily
 * view (migration 20260803100000).
 *
 * TUTOR LEARNING EVIDENCE (TUTOR-1 Wave 2): five new types carry the tutor's
 * learning-evidence signal onto this SAME table (migration 20260803110000).
 * Four are SERVER-emitted (practice_answer / hint_request / self_report /
 * tutor_inference) — course+publication scoped with the lesson OPTIONAL (a
 * tutor conversation spans lessons); a browser can never forge learning
 * evidence, so they are ABSENT from the client batch and the ingest RPC rejects
 * them. ONE — content_engagement — is a CLIENT member (the perf_vital
 * precedent): full course envelope, its signal rides metadata (a browser cannot
 * know concept node ids). tutor_inference's direction/strength/turnRef ride
 * metadata as the frozen Wave-3 contract (TutorInferencePayloadSchema).
 */

import { z } from "zod";
import type { Database } from "@/lib/database.types";

/* ────────────────────────────── Contract ───────────────────────────────── */

/** Context every LEARNER event carries — where in the catalog it happened. */
const eventBase = {
  publicationId: z.uuid(),
  version: z.number().int().min(1),
  courseId: z.uuid(),
  lessonId: z.uuid(),
  /** Idempotency key: client events stamp crypto.randomUUID(); server events
   *  reuse a stable row uuid (attempt/submission/progress id). */
  clientEventId: z.uuid(),
  /** ISO timestamp from the emitter's clock (server_ts is the DB's own). */
  clientTs: z.string().min(1),
};

const quartile = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

const lessonStarted = z.object({ ...eventBase, eventType: z.literal("lesson_started") });
const slideViewed = z.object({
  ...eventBase,
  eventType: z.literal("slide_viewed"),
  blockId: z.uuid(),
  /** Slide ids are node ids (text — mirrors question_id_text). */
  slideId: z.string().min(1),
  /** Visible-time only — the dwell tracker excludes hidden-tab spans. */
  dwellMs: z.number().int().nonnegative(),
});
const videoProgress = z.object({
  ...eventBase,
  eventType: z.literal("video_progress"),
  blockId: z.uuid(),
  quartile,
});
const videoCompleted = z.object({
  ...eventBase,
  eventType: z.literal("video_completed"),
  blockId: z.uuid(),
});
const quizStarted = z.object({ ...eventBase, eventType: z.literal("quiz_started"), blockId: z.uuid() });
const quizSubmitted = z.object({
  ...eventBase,
  eventType: z.literal("quiz_submitted"),
  blockId: z.uuid(),
  attemptId: z.uuid(),
});
const homeworkSubmitted = z.object({
  ...eventBase,
  eventType: z.literal("homework_submitted"),
  blockId: z.uuid(),
});
const lessonCompleted = z.object({ ...eventBase, eventType: z.literal("lesson_completed") });
const sessionHeartbeat = z.object({ ...eventBase, eventType: z.literal("session_heartbeat") });

/** slide_feedback comment cap — mirrored by the DB CHECK
 *  (char_length(feedback_comment) <= 500, migration 20260707030000).
 *  Defined in eventConstants.ts (zod-free, client-bundle-safe) and
 *  re-exported here so server code keeps this import path. */
export { FEEDBACK_COMMENT_MAX_CHARS } from "./eventConstants";
import { FEEDBACK_COMMENT_MAX_CHARS } from "./eventConstants";

/** M10: in-slide reaction (+ optional comment). Append-only — a toggle emits
 *  a NEW event; "latest reaction wins per (user, slide)" is the rollup's
 *  contract, never a mutation of the log. */
const slideFeedback = z.object({
  ...eventBase,
  eventType: z.literal("slide_feedback"),
  blockId: z.uuid(),
  slideId: z.string().min(1),
  reaction: z.enum(["helpful", "confusing"]),
  comment: z.string().min(1).max(FEEDBACK_COMMENT_MAX_CHARS).nullable(),
});

/** Context a COMMS delivery event carries (Milestone 7) — course + the
 *  learner_messages row it belongs to. No publication/version/lesson. */
const commsEventBase = {
  courseId: z.uuid(),
  /** The learner_messages row this delivery event belongs to. */
  messageId: z.uuid(),
  /** Derived deterministically from the Svix message id (retry-stable). */
  clientEventId: z.uuid(),
  clientTs: z.string().min(1),
};

const commsDelivered = z.object({ ...commsEventBase, eventType: z.literal("comms_email_delivered") });
const commsOpen = z.object({ ...commsEventBase, eventType: z.literal("comms_email_open") });
const commsClick = z.object({
  ...commsEventBase,
  eventType: z.literal("comms_email_click"),
  url: z.string().max(500).nullable(),
});
const commsBounce = z.object({
  ...commsEventBase,
  eventType: z.literal("comms_email_bounce"),
  /** hard = permanent (suppresses the address); soft = transient. */
  bounceType: z.enum(["hard", "soft"]),
  bounceSubtype: z.string().max(100).nullable(),
});
const commsComplaint = z.object({ ...commsEventBase, eventType: z.literal("comms_email_complaint") });

/** TUTOR-1 Wave 1.1: the AI-tutor model-call job kinds — mirrored by the DB CHECK
 *  (job_type in (…)). The Zod enum derives from this const so the two can't drift.
 *  Wave 6.6 (20260806160000) widened the CHECK to add the two remaining Terra jobs
 *  — `lesson_rationale` (P5.3 lesson-health rationale) + `escalation_dossier`
 *  (P6.2 on-consent escalation synthesis) — so their runTurn cost rows can land. */
export const TUTOR_JOB_TYPES = [
  "graph_extraction",
  "reconciliation",
  "embedding",
  "tutor_turn",
  "lesson_rationale",
  "escalation_dossier",
] as const;
export type TutorJobType = (typeof TUTOR_JOB_TYPES)[number];

/** TUTOR-1 Wave 1.1: one AI-tutor model call's cost telemetry. SERVER-emitted
 *  ONLY (lib/tutor/telemetry.ts) — course-scoped with an OPTIONAL learner; the
 *  computed cost is null when the model is absent from the pricing table.
 *  `clientEventId` is REQUIRED — always the provider-response-id-derived uuid,
 *  so a re-emit for the same call no-ops. Deliberately NOT in the client batch
 *  contract (a browser can never forge tutor cost). */
const tutorModelCall = z.object({
  eventType: z.literal("tutor_model_call"),
  courseId: z.uuid(),
  /** Null for a run with no learner (extraction/reconciliation). */
  learnerUserId: z.uuid().nullable(),
  jobType: z.enum(TUTOR_JOB_TYPES),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** USD; null when the model has no pricing entry (computeCostUsd → null). */
  computedCostUsd: z.number().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative(),
  /** Derived deterministically from the provider response id (retry-stable). */
  clientEventId: z.uuid(),
  clientTs: z.string().min(1),
});
export const TutorModelCallEventSchema = tutorModelCall;
export type TutorModelCallEvent = z.infer<typeof tutorModelCall>;

/* ─────────────────── TUTOR-1 Wave 2: learning evidence ──────────────────────
 * Five new event types carrying the tutor's learning-EVIDENCE signal onto the
 * SAME learning_events table (never a parallel path). Four are SERVER-emitted
 * (a browser can never forge learning evidence): practice_answer, hint_request,
 * self_report, tutor_inference. They are course+publication scoped with the
 * LESSON OPTIONAL (a tutor conversation spans lessons). ONE — content_engagement
 * — is the client member (the perf_vital precedent): it joins the client batch
 * union, carries the FULL course envelope, and rides its signal in metadata (a
 * browser cannot know concept node ids).
 *
 * The derived `dwell_over_median` signal is NOT an event: it is computed in the
 * refold from the existing dwell events vs the cohort rollup, never emitted. */

/** Context every SERVER tutor-evidence event carries — course + publication,
 *  lesson OPTIONAL (a tutor conversation spans lessons). */
const tutorEvidenceBase = {
  courseId: z.uuid(),
  publicationId: z.uuid(),
  version: z.number().int().min(1),
  lessonId: z.uuid().nullable(),
  nodeId: z.uuid(),
  clientEventId: z.uuid(),
  clientTs: z.string().min(1),
};

/** A learner answered a tutor practice item (graded). */
const practiceAnswer = z.object({
  ...tutorEvidenceBase,
  eventType: z.literal("practice_answer"),
  attemptOrdinal: z.number().int().min(1),
  evidenceCorrect: z.boolean(),
  practiceItemRef: z.uuid(),
});
export const PracticeAnswerEventSchema = practiceAnswer;
export type PracticeAnswerEvent = z.infer<typeof practiceAnswer>;

/** A learner asked the tutor for a hint (rung 0–4). A hint MAY reference the
 *  item it was requested for (nullable). */
const hintRequest = z.object({
  ...tutorEvidenceBase,
  eventType: z.literal("hint_request"),
  hintRung: z.number().int().min(0).max(4),
  practiceItemRef: z.uuid().nullable(),
});
export const HintRequestEventSchema = hintRequest;
export type HintRequestEvent = z.infer<typeof hintRequest>;

/** A learner self-reported understanding of a concept. */
const selfReport = z.object({
  ...tutorEvidenceBase,
  eventType: z.literal("self_report"),
  evidenceCorrect: z.boolean(),
});
export const SelfReportEventSchema = selfReport;
export type SelfReportEvent = z.infer<typeof selfReport>;

/** THE frozen Wave-3 tutor-inference side-channel contract. The tutor's mastery
 *  inference rides METADATA (only node_id is columnar on the row); direction,
 *  strength, and the conversation turn ref travel here. Frozen — Wave 3 reads
 *  exactly this shape. */
export const TutorInferencePayloadSchema = z.object({
  nodeId: z.uuid(),
  direction: z.enum(["positive", "negative"]),
  strength: z.enum(["weak", "moderate"]),
  turnRef: z.string(),
});
export type TutorInferencePayload = z.infer<typeof TutorInferencePayloadSchema>;

/** The tutor inferred a mastery signal for a concept. Only the node is columnar;
 *  direction/strength/turnRef ride metadata (the frozen Wave-3 contract). */
const tutorInference = z.object({
  ...tutorEvidenceBase,
  eventType: z.literal("tutor_inference"),
  metadata: TutorInferencePayloadSchema,
});
export const TutorInferenceEventSchema = tutorInference;
export type TutorInferenceEvent = z.infer<typeof tutorInference>;

/** The four SERVER-only tutor-evidence event types (excluded from the client
 *  batch; the ingest RPC rejects the three non-tutor_% ones by name and
 *  tutor_inference by the tutor_% guard). */
export const TUTOR_EVIDENCE_SERVER_EVENT_TYPES = [
  "practice_answer",
  "hint_request",
  "self_report",
  "tutor_inference",
] as const;

/** The client engagement signal — the ONE client tutor-evidence member (the
 *  perf_vital precedent). Full course envelope; the signal rides metadata (a
 *  browser cannot know concept node ids). */
const contentEngagement = z.object({
  ...eventBase,
  eventType: z.literal("content_engagement"),
  signal: z.enum(["rewatch", "scrub_back", "completed"]),
});
export const ContentEngagementEventSchema = contentEngagement;
export type ContentEngagementEvent = z.infer<typeof contentEngagement>;

/** perf_vital route cap — mirrored by the DB CHECK
 *  (char_length(route) <= 200, migration 20260718100100). Constants live in
 *  eventConstants.ts (zod-free, client-bundle-safe); re-exported here. */
export { PERF_ROUTE_MAX_CHARS, PERF_VITAL_METRICS, PERF_VITAL_RATINGS } from "./eventConstants";
import { PERF_ROUTE_MAX_CHARS, PERF_VITAL_METRICS, PERF_VITAL_RATINGS } from "./eventConstants";

/** PERF-1 E1: RUM web-vitals — APP-scoped (no course/publication/lesson
 *  envelope; those columns land NULL, which is what keeps perf rows out of
 *  the author-select RLS and every course rollup). `value` is milliseconds
 *  for the timing metrics and the raw unitless float for CLS (the column is
 *  numeric — never rescale). `route` is a normalized PATTERN
 *  (lib/analytics/vitals.ts normalizeRoute), never a raw URL. */
const perfVital = z.object({
  eventType: z.literal("perf_vital"),
  clientEventId: z.uuid(),
  clientTs: z.string().min(1),
  metric: z.enum(PERF_VITAL_METRICS),
  value: z.number().nonnegative(),
  rating: z.enum(PERF_VITAL_RATINGS),
  route: z.string().min(1).max(PERF_ROUTE_MAX_CHARS),
  deviceClass: z.enum(["mobile", "desktop"]),
  /** web-vitals Metric.navigationType (navigate/reload/back-forward/…). */
  navigationType: z.string().max(50).nullable(),
});
export const PerfVitalEventSchema = perfVital;
export type PerfVitalEvent = z.infer<typeof perfVital>;

/** Everything a BROWSER may report through /api/analytics/ingest — the
 *  learner ten (M10 added slide_feedback) plus the app-scoped perf_vital
 *  (PERF-1 E1). The authoritative types among them are
 *  tolerated-but-untrusted (M3 trust model: no dashboard number depends
 *  solely on a client event). Comms types are deliberately absent —
 *  delivery telemetry is webhook-emitted only.
 *  [FWD: agent-runtime-perf] E4 agent-latency metrics will ride this same
 *  discriminator as further app-scoped members — extend the union here,
 *  never a parallel schema/pipeline. */
export const ClientBatchEventSchema = z.discriminatedUnion("eventType", [
  lessonStarted,
  slideViewed,
  videoProgress,
  videoCompleted,
  quizStarted,
  quizSubmitted,
  homeworkSubmitted,
  lessonCompleted,
  sessionHeartbeat,
  slideFeedback,
  perfVital,
  contentEngagement,
]);
export type ClientBatchEvent = z.infer<typeof ClientBatchEventSchema>;

/** The five webhook-emitted comms delivery events (Milestone 7). */
export const CommsDeliveryEventSchema = z.discriminatedUnion("eventType", [
  commsDelivered,
  commsOpen,
  commsClick,
  commsBounce,
  commsComplaint,
]);
export type CommsDeliveryEvent = z.infer<typeof CommsDeliveryEventSchema>;
export type CommsDeliveryEventType = CommsDeliveryEvent["eventType"];

export const COMMS_EVENT_TYPES = [
  "comms_email_delivered",
  "comms_email_open",
  "comms_email_click",
  "comms_email_bounce",
  "comms_email_complaint",
] as const satisfies readonly CommsDeliveryEventType[];

/** THE contract — every event type that lands in `learning_events`. */
export const AnalyticsEventSchema = z.discriminatedUnion("eventType", [
  lessonStarted,
  slideViewed,
  videoProgress,
  videoCompleted,
  quizStarted,
  quizSubmitted,
  homeworkSubmitted,
  lessonCompleted,
  sessionHeartbeat,
  slideFeedback,
  perfVital,
  commsDelivered,
  commsOpen,
  commsClick,
  commsBounce,
  commsComplaint,
  tutorModelCall,
  practiceAnswer,
  hintRequest,
  selfReport,
  tutorInference,
  contentEngagement,
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type AnalyticsEventType = AnalyticsEvent["eventType"];

export function isCommsEvent(event: AnalyticsEvent): event is CommsDeliveryEvent {
  return (COMMS_EVENT_TYPES as readonly string[]).includes(event.eventType);
}

export function isTutorModelCallEvent(event: AnalyticsEvent): event is TutorModelCallEvent {
  return event.eventType === "tutor_model_call";
}

/** One ingest batch. The cap matches the route's single multi-row insert.
 *  Composes the CLIENT subset only — a comms event fails this parse (400). */
export { MAX_BATCH_EVENTS } from "./eventConstants";
import { MAX_BATCH_EVENTS } from "./eventConstants";
export const AnalyticsBatchSchema = z.object({
  events: z.array(ClientBatchEventSchema).min(1).max(MAX_BATCH_EVENTS),
});
export type AnalyticsBatch = z.infer<typeof AnalyticsBatchSchema>;

/* ────────────────────────────── Builder ────────────────────────────────── */

export interface EventContext {
  publicationId: string;
  version: number;
  courseId: string;
  lessonId: string;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** The per-event payload a callsite provides — context + stamps come free.
 *  perf_vital is excluded: it carries no learner context (its builder is
 *  buildPerfVitalEvent in lib/analytics/vitals.ts). */
export type AnalyticsEventInput = DistributiveOmit<
  Exclude<ClientBatchEvent, { eventType: "perf_vital" }>,
  keyof EventContext | "clientEventId" | "clientTs"
>;

/**
 * Assemble + validate one learner event. Client callers omit `clientEventId`
 * (a fresh uuid is stamped); server emitters pass the stable row uuid that
 * makes the emit idempotent.
 */
export function buildEvent(
  ctx: EventContext,
  input: AnalyticsEventInput,
  opts?: { clientEventId?: string; clientTs?: string }
): ClientBatchEvent {
  return ClientBatchEventSchema.parse({
    ...ctx,
    ...input,
    clientEventId: opts?.clientEventId ?? crypto.randomUUID(),
    clientTs: opts?.clientTs ?? new Date().toISOString(),
  });
}

/** Assemble + validate one comms delivery event (webhook emitter only).
 *  `clientEventId` is REQUIRED — always the Svix-derived uuid. */
export function buildCommsDeliveryEvent(
  input: DistributiveOmit<CommsDeliveryEvent, "clientEventId" | "clientTs">,
  opts: { clientEventId: string; clientTs?: string }
): CommsDeliveryEvent {
  return CommsDeliveryEventSchema.parse({
    ...input,
    clientEventId: opts.clientEventId,
    clientTs: opts.clientTs ?? new Date().toISOString(),
  });
}

/** The four SERVER-only tutor-evidence events (Wave 2). */
export type TutorEvidenceServerEvent =
  | PracticeAnswerEvent
  | HintRequestEvent
  | SelfReportEvent
  | TutorInferenceEvent;
export const TutorEvidenceServerEventSchema = z.discriminatedUnion("eventType", [
  practiceAnswer,
  hintRequest,
  selfReport,
  tutorInference,
]);

/** Assemble + validate one SERVER tutor-evidence event (server emitters only).
 *  `clientEventId` is REQUIRED — always a stable, retry-safe uuid so the emit is
 *  idempotent. Excluded from the client batch (a browser can never forge
 *  learning evidence); the ingest RPC rejects these by name. */
export function buildTutorEvidenceEvent(
  input: DistributiveOmit<TutorEvidenceServerEvent, "clientEventId" | "clientTs">,
  opts: { clientEventId: string; clientTs?: string }
): TutorEvidenceServerEvent {
  return TutorEvidenceServerEventSchema.parse({
    ...input,
    clientEventId: opts.clientEventId,
    clientTs: opts.clientTs ?? new Date().toISOString(),
  });
}

/** Assemble + validate one tutor_model_call event (server emitter only —
 *  lib/tutor/telemetry.ts). `clientEventId` is REQUIRED — always the
 *  provider-response-id-derived uuid that makes the emit idempotent. */
export function buildTutorModelCallEvent(
  input: Omit<TutorModelCallEvent, "clientEventId" | "clientTs">,
  opts: { clientEventId: string; clientTs?: string }
): TutorModelCallEvent {
  return TutorModelCallEventSchema.parse({
    ...input,
    clientEventId: opts.clientEventId,
    clientTs: opts.clientTs ?? new Date().toISOString(),
  });
}

/* ─────────────────────────── Row mapping ───────────────────────────────── */

export type LearningEventRow = Database["public"]["Tables"]["learning_events"]["Insert"];

/** Translate a validated event to the learning_events insert row. user_id is
 *  ALWAYS the caller-verified auth uid (learner events) or the
 *  learner_messages row's user (comms events) — never a client/payload field. */
export function mapEventToColumns(event: AnalyticsEvent, userId: string): LearningEventRow {
  if (isCommsEvent(event)) {
    return {
      client_event_id: event.clientEventId,
      user_id: userId,
      event_type: event.eventType,
      publication_id: null,
      version: null,
      course_id: event.courseId,
      lesson_id: null,
      block_id: null,
      slide_id: null,
      dwell_ms: null,
      quartile: null,
      attempt_id: null,
      metadata: {
        messageId: event.messageId,
        ...(event.eventType === "comms_email_click" && event.url ? { url: event.url } : {}),
        ...(event.eventType === "comms_email_bounce"
          ? { bounceType: event.bounceType, ...(event.bounceSubtype ? { bounceSubtype: event.bounceSubtype } : {}) }
          : {}),
      },
      client_ts: event.clientTs,
    };
  }
  if (event.eventType === "perf_vital") {
    return {
      client_event_id: event.clientEventId,
      user_id: userId,
      event_type: event.eventType,
      publication_id: null,
      version: null,
      course_id: null,
      lesson_id: null,
      block_id: null,
      slide_id: null,
      dwell_ms: null,
      quartile: null,
      attempt_id: null,
      metric_name: event.metric,
      metric_value: event.value,
      metric_rating: event.rating,
      route: event.route,
      device_class: event.deviceClass,
      navigation_type: event.navigationType,
      metadata: {},
      client_ts: event.clientTs,
    };
  }
  if (event.eventType === "tutor_model_call") {
    return {
      client_event_id: event.clientEventId,
      // user_id is the acting principal (extraction runs pass the course author
      // id); learner_user_id is the separate, optional learner attribution.
      user_id: userId,
      event_type: event.eventType,
      publication_id: null,
      version: null,
      course_id: event.courseId,
      lesson_id: null,
      block_id: null,
      slide_id: null,
      dwell_ms: null,
      quartile: null,
      attempt_id: null,
      job_type: event.jobType,
      model: event.model,
      input_tokens: event.inputTokens,
      cached_input_tokens: event.cachedInputTokens,
      output_tokens: event.outputTokens,
      computed_cost_usd: event.computedCostUsd,
      latency_ms: event.latencyMs,
      learner_user_id: event.learnerUserId,
      metadata: {},
      client_ts: event.clientTs,
    };
  }
  if (
    event.eventType === "practice_answer" ||
    event.eventType === "hint_request" ||
    event.eventType === "self_report" ||
    event.eventType === "tutor_inference"
  ) {
    // SERVER tutor-evidence: course+publication scoped, lesson OPTIONAL. Each
    // carries exactly its own of the five evidence columns (DB CHECK enforces
    // isolation); tutor_inference's direction/strength/turnRef ride metadata.
    return {
      client_event_id: event.clientEventId,
      user_id: userId,
      event_type: event.eventType,
      publication_id: event.publicationId,
      version: event.version,
      course_id: event.courseId,
      lesson_id: event.lessonId,
      block_id: null,
      slide_id: null,
      dwell_ms: null,
      quartile: null,
      attempt_id: null,
      node_id: event.nodeId,
      attempt_ordinal: event.eventType === "practice_answer" ? event.attemptOrdinal : null,
      hint_rung: event.eventType === "hint_request" ? event.hintRung : null,
      evidence_correct:
        event.eventType === "practice_answer" || event.eventType === "self_report"
          ? event.evidenceCorrect
          : null,
      practice_item_ref:
        event.eventType === "practice_answer" || event.eventType === "hint_request"
          ? event.practiceItemRef
          : null,
      metadata: event.eventType === "tutor_inference" ? event.metadata : {},
      client_ts: event.clientTs,
    };
  }
  if (event.eventType === "content_engagement") {
    // CLIENT engagement signal: full course envelope, NO evidence columns (the
    // client can't know node ids); the signal rides metadata.
    return {
      client_event_id: event.clientEventId,
      user_id: userId,
      event_type: event.eventType,
      publication_id: event.publicationId,
      version: event.version,
      course_id: event.courseId,
      lesson_id: event.lessonId,
      block_id: null,
      slide_id: null,
      dwell_ms: null,
      quartile: null,
      attempt_id: null,
      metadata: { signal: event.signal },
      client_ts: event.clientTs,
    };
  }
  return {
    client_event_id: event.clientEventId,
    user_id: userId,
    event_type: event.eventType,
    publication_id: event.publicationId,
    version: event.version,
    course_id: event.courseId,
    lesson_id: event.lessonId,
    block_id: "blockId" in event ? event.blockId : null,
    slide_id:
      event.eventType === "slide_viewed" || event.eventType === "slide_feedback"
        ? event.slideId
        : null,
    dwell_ms: event.eventType === "slide_viewed" ? event.dwellMs : null,
    quartile: event.eventType === "video_progress" ? event.quartile : null,
    attempt_id: event.eventType === "quiz_submitted" ? event.attemptId : null,
    reaction: event.eventType === "slide_feedback" ? event.reaction : null,
    feedback_comment: event.eventType === "slide_feedback" ? event.comment : null,
    client_ts: event.clientTs,
  };
}
