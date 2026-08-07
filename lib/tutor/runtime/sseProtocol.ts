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
// A3 Wave 4 — the diagram field on a renderStructure card is a VALIDATED
// lib/course/diagram spec (storage-schema shape). This is SERVER-only (zod is
// fine here); the zod-free client mirror (tutorClientTypes.ts) hand-types it and
// imports ONLY {types,geometry,validate} + the renderers, NEVER this Zod half
// (the PERF-1 zod-free learn-bundle rule).
import { DiagramSpecStorageSchema } from "@/lib/course/diagram/schemas";

/* ─────────────────────────── turn payload sub-shapes ────────────────────────── */

/** Structural mirror of `grounding.ts` `ProseSpan` (a plain interface there). A
 *  cleaned, marker-free prose span classified grounded vs supplemental. */
export const WireProseSpanSchema = z.object({
  kind: z.enum(["grounded", "supplemental"]),
  text: z.string(),
});

/** A3 Wave 3 — the AT-MOST-ONE quiet invitation a question turn may offer (a
 *  downgraded Class-A proposal). Null on Paths 1/2, under cooldown, or when the
 *  turn proposed nothing. The client renders it as a pressable chip; pressing it
 *  sends the acceptance claim on the next POST body. */
export const WireInvitationSchema = z.object({
  toolName: z.string(),
  nodeId: z.string(),
  label: z.string(),
});
export type WireInvitation = z.infer<typeof WireInvitationSchema>;

/* ─────────────────────── A3 Wave 4 — structure + assessment cards ────────── */

/** Class P — a renderStructure card. MAY appear on a question turn (A3-12); never
 *  stripped. `diagram` is the validated storage-shape spec, or null on the
 *  drop-and-flag path (the tool logged tutor_structure_dropped). */
export const RenderStructureCardSchema = z.object({
  kind: z.enum(["tree", "graph", "timeline", "axes"]),
  title: z.string().nullable(),
  caption: z.string().nullable(),
  diagram: DiagramSpecStorageSchema.nullable(),
});
export type RenderStructureCard = z.infer<typeof RenderStructureCardSchema>;

/** Class A — a checkUnderstanding card. Formative: the answer key + every wrong
 *  option's misconceptionId ship (the client grades locally, the practiceItems
 *  precedent). NEVER on a question turn (stripped like practiceItems). */
export const CheckUnderstandingCardSchema = z.object({
  cardId: z.string(),
  toolName: z.literal("checkUnderstanding"),
  conceptSlug: z.string(),
  initiation: z.enum(["practice_request", "invitation_accepted"]),
  stem: z.string(),
  options: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        correct: z.boolean(),
        misconceptionId: z.string().nullable(),
        feedback: z.string(),
      })
    )
    .min(3)
    .max(4),
  collectConfidence: z.boolean(),
});

/** Class A — a sequenceTask card. `correctOrder` ships (formative, client-scored
 *  by `partialCreditRule`). */
export const SequenceTaskCardSchema = z.object({
  cardId: z.string(),
  toolName: z.literal("sequenceTask"),
  conceptSlug: z.string(),
  initiation: z.enum(["practice_request", "invitation_accepted"]),
  prompt: z.string(),
  items: z.array(z.object({ id: z.string(), text: z.string() })).min(3),
  correctOrder: z.array(z.string()),
  partialCreditRule: z.enum(["exact", "adjacent-pairs"]),
});

/** A3 Wave 5 — Class A — a fadedExample card. Each step ships its `answer` (shown
 *  steps render it inline; blanked steps ship it for local grading). `fadeLevel`
 *  is derived by the runtime from mastery (A3-16) and fixed at authoring. */
export const FadedExampleCardSchema = z.object({
  cardId: z.string(),
  toolName: z.literal("fadedExample"),
  conceptSlug: z.string(),
  initiation: z.enum(["practice_request", "invitation_accepted"]),
  fadeLevel: z.number().int().min(0).max(3),
  title: z.string().nullable(),
  problem: z.string(),
  steps: z
    .array(z.object({ text: z.string(), blanked: z.boolean(), answer: z.string() }))
    .min(2),
});

/** A3 Wave 5 — Class A — a predictThenReveal card. The answer key + near-miss
 *  matchers + the reveal ship (formative, client-graded). */
export const PredictThenRevealCardSchema = z.object({
  cardId: z.string(),
  toolName: z.literal("predictThenReveal"),
  conceptSlug: z.string(),
  initiation: z.enum(["practice_request", "invitation_accepted"]),
  title: z.string().nullable(),
  setup: z.string(),
  prompt: z.string(),
  acceptedAnswers: z.array(z.string()).min(1),
  nearMisses: z.array(
    z.object({ pattern: z.string(), misconceptionId: z.string(), feedback: z.string() })
  ),
  revealExplanation: z.string(),
});

/** A3 Wave 5 — Class A — an explainBack card. The rubric ships so the client
 *  renders the criterion list; grading is SERVER-side (the explain_back_grade
 *  route action) — NO answer key on the card. */
export const ExplainBackCardSchema = z.object({
  cardId: z.string(),
  toolName: z.literal("explainBack"),
  conceptSlug: z.string(),
  initiation: z.enum(["practice_request", "invitation_accepted"]),
  title: z.string().nullable(),
  prompt: z.string(),
  rubric: z.array(z.object({ criterion: z.string(), required: z.boolean() })).min(2),
});

/** The assessment-card union — discriminated on `toolName`. */
export const AssessmentCardSchema = z.discriminatedUnion("toolName", [
  CheckUnderstandingCardSchema,
  SequenceTaskCardSchema,
  FadedExampleCardSchema,
  PredictThenRevealCardSchema,
  ExplainBackCardSchema,
]);
export type AssessmentCard = z.infer<typeof AssessmentCardSchema>;

/** The `turn` payload — the settled output of ONE tutor turn. Mirrors the
 *  route's inline payload (route.ts:46-60). `rung` is nullable (the route types
 *  it `number | null`); `practiceItems`/`flags` are always arrays (the route
 *  coalesces `?? []`); `escalationProposal`/`escalationCandidateId`/`invitation`
 *  are nullable. */
export const TutorTurnPayloadSchema = z.object({
  prose: z.string(),
  spans: z.array(WireProseSpanSchema),
  citations: z.array(TurnCitationSchema),
  rung: z.number().int().nullable(),
  practiceItems: z.array(TurnPracticeItemSchema),
  escalationProposal: TurnEscalationProposalSchema.nullable(),
  escalationCandidateId: z.string().nullable(),
  flags: z.array(z.string()),
  invitation: WireInvitationSchema.nullable(),
  // A3 Wave 4 — appended AFTER invitation (streaming/prose-extractor order
  // unaffected; these ride the settled `turn` frame only). Nullable arrays
  // defaulting [] so an older client-shaped payload without them still parses.
  structures: z.array(RenderStructureCardSchema).nullable().default([]),
  assessments: z.array(AssessmentCardSchema).nullable().default([]),
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
 * THE tutor SSE wire protocol — a discriminated union on `type` with exactly
 * eleven variants. Four legacy variants (queued/turn/error/done) mirror the
 * current route; six are the A2 streaming lifecycle (turn_started → model_started
 * → first_token → text_delta* → turn_completed | turn_aborted); one
 * (approval_required) settles a turn an irreversible-tier tool halted (Wave 2 —
 * dormant today, no tutor tool is irreversible, but wired + tested). Everything
 * but `turn`/`queued`/`error`/`done` is a TRANSPORT frame (see header note (a)).
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

  /* ── A2 approval halt (dormant — no tutor tool is irreversible today) ── */
  z.object({
    type: z.literal("approval_required"),
    /** The irreversible-tier tool that halted the loop — the structured field the
     *  client keys the approval UI off (never named in `message`). */
    toolName: z.string(),
    /** The learner-visible message. §7 copy: generic, sentence case, no terminal
     *  punctuation, and NO tool name in the text (toolName rides the field above). */
    message: z.string(),
  }),
]);
export type TutorWireEvent = z.infer<typeof TutorWireEventSchema>;

/* ─────────────────────────────── SSE framing ────────────────────────────────── */

/** Frame one wire event for the SSE stream — identical framing to route.ts:64-66
 *  (`data: ${JSON.stringify(event)}\n\n`). */
export function encodeWireEvent(event: TutorWireEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
