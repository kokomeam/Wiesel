/**
 * The FROZEN tutor-turn output contract (TUTOR-1 Wave 3, package C1).
 *
 * This is the strict-JSON shape the live tutor model returns for ONE turn. It is
 * the sole boundary between the model and the runtime: the loop parses the model's
 * structured output against `TurnOutputSchema`, then `grounding.ts` validates the
 * citations/spans and `scaffolding.ts` clamps the rung before anything reaches the
 * learner. Nothing downstream trusts a field this schema didn't admit.
 *
 * ── THE SPAN MARKERS (load-bearing, documented once here) ────────────────────
 * `proseWithSpanMarkers` is the tutor's reply text with INLINE span markers the
 * model MUST emit around any claim it wants classified:
 *
 *   ⟦g⟧ … ⟦/g⟧   — a GROUNDED span: backed by the course material. Every grounded
 *                   span requires ≥1 surviving citation, or grounding flags it
 *                   `ungrounded`.
 *   ⟦s⟧ … ⟦/s⟧   — a SUPPLEMENTAL span: general knowledge beyond the course. Under
 *                   a STRICT course canon the span's content is removed; under an
 *                   OPEN canon it is kept. Either way the markers are stripped to
 *                   plain text in the cleaned output.
 *
 * The markers are EXACT four-codepoint sequences (`⟦g⟧`, `⟦/g⟧`, `⟦s⟧`, `⟦/s⟧`)
 * using U+27E6/U+27E7 mathematical white square brackets — chosen because they
 * never occur in ordinary prose, so a naive learner message can't inject a span.
 * `grounding.ts` owns the parse; this module only names the constants so both the
 * prompt layer and the validator reference ONE definition.
 */

import { z } from "zod";

/* ─────────────────────────────── span markers ──────────────────────────────── */

/** Opening marker of a GROUNDED span. */
export const GROUNDED_OPEN = "⟦g⟧";
/** Closing marker of a GROUNDED span. */
export const GROUNDED_CLOSE = "⟦/g⟧";
/** Opening marker of a SUPPLEMENTAL span. */
export const SUPPLEMENTAL_OPEN = "⟦s⟧";
/** Closing marker of a SUPPLEMENTAL span. */
export const SUPPLEMENTAL_CLOSE = "⟦/s⟧";

/* ─────────────────────────────── sub-schemas ───────────────────────────────── */

/**
 * A citation: which lesson/block (and optionally slide) in the publication
 * snapshot backs a grounded claim. `blockId` is a row uuid; `slideId` is the
 * jsonb short id (nullable/optional — a block-level citation omits it). The
 * grounding validator resolves these against the snapshot index and drops/downgrades
 * ones that don't resolve.
 */
export const TurnCitationSchema = z.object({
  lessonId: z.string(),
  blockId: z.string(),
  slideId: z.string().nullable().optional(),
});
export type TurnCitation = z.infer<typeof TurnCitationSchema>;

/**
 * A practice item the tutor proposes via the generate_practice tool. `kind`
 * distinguishes multiple-choice from short-answer; `choices` is present (and
 * non-null) only for `mc`. `itemBankRef` is reserved for a future item bank and
 * is ALWAYS null in Wave 3 (the tutor never references a persisted bank yet).
 */
export const TurnPracticeItemSchema = z.object({
  nodeId: z.string(),
  practiceItemRef: z.string(),
  kind: z.enum(["mc", "short"]),
  prompt: z.string(),
  choices: z.array(z.string()).nullable().optional(),
  itemBankRef: z.null(),
});
export type TurnPracticeItem = z.infer<typeof TurnPracticeItemSchema>;

/**
 * The tutor's proposal to escalate to a human instructor. `nodeIds` names the
 * concept(s) the learner is stuck on; `proposedAnswer` is what the tutor WOULD
 * say, surfaced to the instructor (never auto-sent to the learner).
 */
export const TurnEscalationProposalSchema = z.object({
  learnerQuestion: z.string(),
  nodeIds: z.array(z.string()),
  proposedAnswer: z.string(),
});
export type TurnEscalationProposal = z.infer<typeof TurnEscalationProposalSchema>;

/* ─────────────────────────────── turn output ───────────────────────────────── */

/**
 * The turn-local evidence item: the SHAPE of the frozen Wave-3
 * `TutorInferencePayloadSchema`, but `nodeId` is a plain string at PARSE time —
 * a model-mangled node id must be a droppable cleanup (the loop filters items
 * against the course's real concept-node ids, flag `evidence_dropped`), never a
 * whole-turn `schema_parse_failed`. Found live: a turn that emitted evidence
 * with a non-uuid node reference lost the ENTIRE turn. The frozen event schema
 * still gates EMISSION (service.ts → buildTutorEvidenceEvent) — only resolving
 * uuids ever reach the analytics stream.
 */
export const TurnEvidenceItemSchema = z.object({
  nodeId: z.string(),
  direction: z.enum(["positive", "negative"]),
  strength: z.enum(["weak", "moderate"]),
  turnRef: z.string(),
});

/**
 * THE turn output. `rung` is the 0..4 scaffolding rung (0 = pure question, 4 =
 * full answer — see the rung table in promptLayers.ts). `citations` (≤8) back the
 * grounded spans; `evidence` (≤4) are tutor-inference mastery signals emitted this
 * turn (shape-frozen, id-loosened — see `TurnEvidenceItemSchema`). `practiceItems`
 * (≤3) and `escalationProposal` are optional — present only when the tutor
 * generated practice or proposed a hand-off.
 */
export const TurnOutputSchema = z.object({
  proseWithSpanMarkers: z.string(),
  citations: z.array(TurnCitationSchema).max(8),
  rung: z.number().int().min(0).max(4),
  evidence: z.array(TurnEvidenceItemSchema).max(4),
  // ⚠ toStrictJsonSchema makes optionals NULLABLE on the wire — the live model
  //   correctly emits null here, so the Zod side must accept it too (found live:
  //   every turn failed schema_parse on exactly this field).
  practiceItems: z.array(TurnPracticeItemSchema).max(3).nullable().optional(),
  escalationProposal: TurnEscalationProposalSchema.nullable().optional(),
});
export type TurnOutput = z.infer<typeof TurnOutputSchema>;
