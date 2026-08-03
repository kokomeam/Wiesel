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
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type AnalyticsEventType = AnalyticsEvent["eventType"];

export function isCommsEvent(event: AnalyticsEvent): event is CommsDeliveryEvent {
  return (COMMS_EVENT_TYPES as readonly string[]).includes(event.eventType);
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
