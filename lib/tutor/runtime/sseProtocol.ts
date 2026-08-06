/**
 * TUTOR-1 Amendment A2 Wave 1 — the SERVER-side Zod contract for the tutor SSE
 * wire protocol. Wave 2 moves `app/api/learn/tutor/route.ts` onto this schema;
 * Wave 1 only DEFINES it (the route is not edited yet).
 *
 * ── THREE CONTRACT NOTES (all deliberate) ────────────────────────────────────
 *  (a) TRANSPORT FRAMES ≠ FACTS. The lifecycle variants (turn_started,
 *      model_started, first_token, turn_completed, turn_aborted) and text_delta
 *      are TRANSPORT frames — they describe the streaming CONNECTION, not what
 *      the learner did. They are NEVER persisted to `learning_events` (directive
 *      §2: "deltas are transport frames, not facts"). The persisted analytics
 *      contract is `lib/analytics/events.ts` and gains NOTHING from this file —
 *      `verify-tutor-stream-infra.ts` asserts exactly that (A2-5). Only the
 *      `turn` payload carries settled turn output; even it is not itself an
 *      analytics event (evidence is emitted server-side in service.ts).
 *  (b) THE CLIENT MIRROR IS ZOD-FREE. `lib/learn/tutorClientTypes.ts` (NOT this
 *      file) hand-mirrors these shapes as plain TS types — the PERF-1 bundle
 *      rule keeps zod out of the learner client bundle. This module is the
 *      SERVER source of truth; the two are kept in sync by review, never by an
 *      import (the client cannot import a zod schema without shipping zod).
 *  (c) NAMING IS snake_case FLAT. The variant tags are `turn_started`,
 *      `text_delta`, etc. — flat snake_case matching the EXISTING wire union
 *      (route.ts `TutorSSEEvent`: queued | turn | error | done). This is a
 *      deliberate deviation from the directive's dot-form (`tutor.turn.started`),
 *      disclosed in the Wave 1 checkpoint: one wire convention beats two.
 *
 * The `turn` payload mirrors the route's inline shape (route.ts:46-60) exactly —
 * `spans`/`citations`/`practiceItems`/`escalationProposal` reuse the FROZEN
 * sub-schemas from `outputContract.ts` (imported without circularity: that
 * module only imports zod). `spans` mirrors `grounding.ts` `ProseSpan`
 * structurally (it is a plain interface there, no schema to import).
 */

import { z } from "zod";

import {
  TurnCitationSchema,
  TurnPracticeItemSchema,
  TurnEscalationProposalSchema,
} from "./outputContract";

/* ─────────────────────────── turn payload sub-shapes ────────────────────────── */

/** Structural mirror of `grounding.ts` `ProseSpan` (a plain interface there). A
 *  cleaned, marker-free prose span classified grounded vs supplemental. */
export const WireProseSpanSchema = z.object({
  kind: z.enum(["grounded", "supplemental"]),
  text: z.string(),
});

/** The `turn` payload — the settled output of ONE tutor turn. Mirrors the
 *  route's inline payload (route.ts:46-60). `rung` is nullable (the route types
 *  it `number | null`); `practiceItems`/`flags` are always arrays (the route
 *  coalesces `?? []`); `escalationProposal`/`escalationCandidateId` are nullable. */
export const TutorTurnPayloadSchema = z.object({
  prose: z.string(),
  spans: z.array(WireProseSpanSchema),
  citations: z.array(TurnCitationSchema),
  rung: z.number().int().nullable(),
  practiceItems: z.array(TurnPracticeItemSchema),
  escalationProposal: TurnEscalationProposalSchema.nullable(),
  escalationCandidateId: z.string().nullable(),
  flags: z.array(z.string()),
});
export type TutorTurnPayload = z.infer<typeof TutorTurnPayloadSchema>;

/* ─────────────────────────────── the wire union ─────────────────────────────── */

/** The provider usage counters carried by `turn_completed`. Each is nullable —
 *  a provider may not report a given counter. */
export const TutorWireUsageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cachedTokens: z.number().nullable(),
});

/**
 * THE tutor SSE wire protocol — a discriminated union on `type` with exactly ten
 * variants. Four legacy variants (queued/turn/error/done) mirror the current
 * route; six are the A2 streaming lifecycle (turn_started → model_started →
 * first_token → text_delta* → turn_completed | turn_aborted). Everything but
 * `turn`/`queued`/`error`/`done` is a TRANSPORT frame (see header note (a)).
 */
export const TutorWireEventSchema = z.discriminatedUnion("type", [
  /* ── legacy variants (mirror route.ts TutorSSEEvent) ── */
  z.object({ type: z.literal("queued"), position: z.number().int().nonnegative() }),
  z.object({ type: z.literal("turn"), payload: TutorTurnPayloadSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("done") }),

  /* ── A2 streaming lifecycle (transport frames, never persisted) ── */
  z.object({
    type: z.literal("turn_started"),
    /** The resume-buffer stream id (uuid-ish; treated as an opaque string). */
    streamId: z.string(),
    /** ISO timestamp the turn opened. */
    ts: z.string(),
  }),
  z.object({
    type: z.literal("model_started"),
    /** The provider response id (response.created) — drives the 'thinking' phase.
     *  Null until the provider assigns one. */
    responseId: z.string().nullable(),
  }),
  z.object({
    type: z.literal("first_token"),
    /** Time-to-first-token in ms (≥0). */
    ttftMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("text_delta"),
    /** One transport delta of prose — NEVER persisted (Wave 2 emits these). */
    delta: z.string(),
  }),
  z.object({
    type: z.literal("turn_completed"),
    finishReason: z.string(),
    durationMs: z.number(),
    usage: TutorWireUsageSchema,
  }),
  z.object({
    type: z.literal("turn_aborted"),
    reason: z.string(),
    tokensEmitted: z.number(),
  }),
]);
export type TutorWireEvent = z.infer<typeof TutorWireEventSchema>;

/* ─────────────────────────────── SSE framing ────────────────────────────────── */

/** Frame one wire event for the SSE stream — identical framing to route.ts:64-66
 *  (`data: ${JSON.stringify(event)}\n\n`). */
export function encodeWireEvent(event: TutorWireEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
