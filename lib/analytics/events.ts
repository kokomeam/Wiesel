/**
 * Zod contract for the learning-event stream (Milestone 3). Single source of
 * truth for every event that lands in `learning_events` — types are INFERRED,
 * never duplicated. Wire shape is camelCase (matching every /api/learn
 * payload); `mapEventToColumns` translates to the snake_case DB row.
 *
 * Trust boundary: the client reports WHAT THE LEARNER DID (a slide was on
 * screen for N ms, a video crossed a quartile). Nothing here is a grade or a
 * completion claim — the AUTHORITATIVE events (quiz_submitted,
 * homework_submitted, lesson_completed) are SERVER-emitted from the existing
 * grading/submission/progress writers (lib/analytics/serverEmit.ts), keyed by
 * stable row uuids so a retry can never double-count. Client events are
 * deduped by the DB-unique clientEventId (`on conflict do nothing`), which is
 * what makes batch replay idempotent.
 */

import { z } from "zod";
import type { Database } from "@/lib/database.types";

/* ────────────────────────────── Contract ───────────────────────────────── */

/** Context every event carries — where in the catalog it happened. */
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

export const AnalyticsEventSchema = z.discriminatedUnion("eventType", [
  z.object({ ...eventBase, eventType: z.literal("lesson_started") }),
  z.object({
    ...eventBase,
    eventType: z.literal("slide_viewed"),
    blockId: z.uuid(),
    /** Slide ids are node ids (text — mirrors question_id_text). */
    slideId: z.string().min(1),
    /** Visible-time only — the dwell tracker excludes hidden-tab spans. */
    dwellMs: z.number().int().nonnegative(),
  }),
  z.object({
    ...eventBase,
    eventType: z.literal("video_progress"),
    blockId: z.uuid(),
    quartile,
  }),
  z.object({ ...eventBase, eventType: z.literal("video_completed"), blockId: z.uuid() }),
  z.object({ ...eventBase, eventType: z.literal("quiz_started"), blockId: z.uuid() }),
  z.object({
    ...eventBase,
    eventType: z.literal("quiz_submitted"),
    blockId: z.uuid(),
    attemptId: z.uuid(),
  }),
  z.object({ ...eventBase, eventType: z.literal("homework_submitted"), blockId: z.uuid() }),
  z.object({ ...eventBase, eventType: z.literal("lesson_completed") }),
  z.object({ ...eventBase, eventType: z.literal("session_heartbeat") }),
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type AnalyticsEventType = AnalyticsEvent["eventType"];

/** One ingest batch. The cap matches the route's single multi-row insert. */
export const MAX_BATCH_EVENTS = 100;
export const AnalyticsBatchSchema = z.object({
  events: z.array(AnalyticsEventSchema).min(1).max(MAX_BATCH_EVENTS),
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

/** The per-event payload a callsite provides — context + stamps come free. */
export type AnalyticsEventInput = DistributiveOmit<
  AnalyticsEvent,
  keyof EventContext | "clientEventId" | "clientTs"
>;

/**
 * Assemble + validate one event. Client callers omit `clientEventId` (a fresh
 * uuid is stamped); server emitters pass the stable row uuid that makes the
 * emit idempotent.
 */
export function buildEvent(
  ctx: EventContext,
  input: AnalyticsEventInput,
  opts?: { clientEventId?: string; clientTs?: string }
): AnalyticsEvent {
  return AnalyticsEventSchema.parse({
    ...ctx,
    ...input,
    clientEventId: opts?.clientEventId ?? crypto.randomUUID(),
    clientTs: opts?.clientTs ?? new Date().toISOString(),
  });
}

/* ─────────────────────────── Row mapping ───────────────────────────────── */

export type LearningEventRow = Database["public"]["Tables"]["learning_events"]["Insert"];

/** Translate a validated event to the learning_events insert row. user_id is
 *  ALWAYS the caller-verified auth uid — never a client-supplied field. */
export function mapEventToColumns(event: AnalyticsEvent, userId: string): LearningEventRow {
  return {
    client_event_id: event.clientEventId,
    user_id: userId,
    event_type: event.eventType,
    publication_id: event.publicationId,
    version: event.version,
    course_id: event.courseId,
    lesson_id: event.lessonId,
    block_id: "blockId" in event ? event.blockId : null,
    slide_id: event.eventType === "slide_viewed" ? event.slideId : null,
    dwell_ms: event.eventType === "slide_viewed" ? event.dwellMs : null,
    quartile: event.eventType === "video_progress" ? event.quartile : null,
    attempt_id: event.eventType === "quiz_submitted" ? event.attemptId : null,
    client_ts: event.clientTs,
  };
}
