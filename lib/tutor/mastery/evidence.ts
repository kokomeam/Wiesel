/**
 * Evidence normalization (TUTOR-1 Wave 2). PURE mapping from raw source rows into
 * a single `MasteryEvidence[]` stream the refold folds through BKT. ZERO MODEL
 * CALLS, no I/O — the loader (loader.ts) fetches the rows; this file turns each
 * into weighted, node-targeted, directional evidence via weights.ts.
 *
 * Sources (each a pure mapper here):
 *   1. quiz_attempt_detail — per-question correctness. A question maps to the
 *      node(s) anchored to its block in the ACTIVE graph (question-level node
 *      mapping arrives with Wave-3 practice items; until then a detail row weighs
 *      every node the block teaches). Weight = the ordinal weight of the attempt.
 *   2. historical detail-less quiz_attempts — block-level score only (pre-
 *      deployment data, the cold-start story). Direction = score ≥ pass; weight =
 *      HISTORICAL_DETAILLESS_FACTOR × ordinal weight, applied to every anchored node.
 *   3. the evidence event types (practice_answer, hint_request, self_report,
 *      tutor_inference, content_engagement + A3's tutor_evidence_recorded).
 *   4. DERIVED dwell — a slide_viewed dwell over the cohort median (from
 *      rollup_slide_dwell) is a weak negative on the node(s) anchored to that slide.
 *
 * Attempt ordinal for the two quiz sources is DERIVED HERE by a stable sort over
 * (created_at, id) per (user, publication, block) — never read from a stored
 * counter (R-22 idempotency: the ordinal must be reproducible from the raw rows).
 */

import type { MasteryConfig } from "./config";
import {
  ordinalWeight,
  hintWeight,
  contentEngagementWeight,
  tutorInferenceWeight,
  toolEvidenceWeight,
  SELF_REPORT_WEIGHT,
  HISTORICAL_DETAILLESS_FACTOR,
  HISTORICAL_PASS_FRACTION,
  DWELL_OVER_MEDIAN_WEIGHT,
  type TutorInferenceStrength,
  type ToolEvidenceOutcomeKind,
} from "./weights";

/* ────────────────────────────── the evidence shape ──────────────────────── */

/** One normalized observation the refold folds through BKT. `direction` +1
 *  positive / −1 negative; `weight` the BKT blend weight; `at` the ISO timestamp
 *  used to order the fold + to compute decay from the last positive; `sourceId`
 *  the stable tiebreak the caller sorts by (evidence with the same `at` orders by
 *  sourceId, deterministically); `kind` a debug/telemetry tag. */
export interface MasteryEvidence {
  nodeId: string;
  direction: 1 | -1;
  weight: number;
  at: string;
  sourceId: string;
  kind: MasteryEvidenceKind;
}

export type MasteryEvidenceKind =
  | "quiz_detail"
  | "quiz_historical"
  | "practice_answer"
  | "hint_request"
  | "self_report"
  | "tutor_inference"
  | "content_engagement"
  | "tutor_evidence_recorded"
  | "dwell_over_median";

/* ────────────────────────────── raw source rows ─────────────────────────── */

/** A quiz_attempt_detail row reduced to the fields the mapper reads. */
export interface QuizDetailRow {
  attemptId: string;
  userId: string;
  courseId: string;
  publicationId: string;
  blockId: string;
  questionId: string;
  correct: boolean;
  createdAt: string;
}

/** A historical (detail-less) quiz_attempts row: block-level score only. */
export interface HistoricalAttemptRow {
  attemptId: string;
  userId: string;
  publicationId: string;
  blockId: string;
  /** score fraction 0..1 (maxScore-normalized by the loader). */
  scoreFraction: number;
  createdAt: string;
}

/** An evidence-type event row (the five Wave-2 members + A3's
 *  tutor_evidence_recorded), reduced to what the mappers read. The loader has
 *  already pulled node_id + the typed columns/metadata off learning_events. */
export interface MasteryEventRow {
  eventId: string;
  eventType:
    | "practice_answer"
    | "hint_request"
    | "self_report"
    | "tutor_inference"
    | "content_engagement"
    | "tutor_evidence_recorded";
  nodeId: string | null;
  createdAt: string;
  /** practice_answer: correctness (evidence_correct) + attempt_ordinal. */
  evidenceCorrect?: boolean | null;
  attemptOrdinal?: number | null;
  /** hint_request: rung 0..4. */
  hintRung?: number | null;
  /** tutor_inference: metadata {direction, strength}. */
  inferenceDirection?: "positive" | "negative" | null;
  inferenceStrength?: TutorInferenceStrength | null;
  /** content_engagement: metadata.signal. */
  contentSignal?: "rewatch" | "scrub_back" | "completed" | null;
  /** tutor_evidence_recorded (A3): the tool-completion outcome column.
   *  confidence/misconception deliberately absent — they do NOT modulate the
   *  v1 weight (see weights.ts toolEvidenceWeight). */
  toolOutcome?: ToolEvidenceOutcomeKind | null;
}

/** A slide_viewed dwell observation the loader has paired with its slide's cohort
 *  median (from rollup_slide_dwell) and the node(s) anchored to the slide. */
export interface DwellRow {
  eventId: string;
  nodeIds: string[];
  dwellMs: number;
  cohortMedianMs: number | null;
  createdAt: string;
}

/* ──────────────────────────── ordinal derivation ────────────────────────── */

/**
 * PURE. Derive a per-row 1-based attempt ordinal keyed by (userId, publicationId,
 * blockId): sort the rows in each group by (createdAt, attemptId) and number them.
 * Returns a Map attemptId → ordinal. Deterministic — the ordinal is reproducible
 * from the raw rows, never a stored counter.
 */
export function deriveAttemptOrdinals(
  rows: { attemptId: string; userId: string; publicationId: string; blockId: string; createdAt: string }[]
): Map<string, number> {
  const groups = new Map<string, { attemptId: string; createdAt: string }[]>();
  for (const r of rows) {
    const key = `${r.userId}::${r.publicationId}::${r.blockId}`;
    const list = groups.get(key) ?? [];
    list.push({ attemptId: r.attemptId, createdAt: r.createdAt });
    groups.set(key, list);
  }
  const ordinals = new Map<string, number>();
  for (const list of groups.values()) {
    list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0));
    list.forEach((row, i) => ordinals.set(row.attemptId, i + 1));
  }
  return ordinals;
}

/* ─────────────────────────────── mappers ────────────────────────────────── */

/**
 * PURE. Map quiz_attempt_detail rows to evidence. `blockNodeIds` maps a block id
 * to the node ids anchored to it in the ACTIVE graph; a detail row on a block with
 * no anchored node yields nothing. Ordinal is derived across the SAME rows (each
 * question in an attempt shares the attempt's ordinal). Weight = ordinal weight.
 */
export function mapQuizDetail(
  rows: QuizDetailRow[],
  blockNodeIds: Map<string, string[]>
): MasteryEvidence[] {
  const ordinals = deriveAttemptOrdinals(rows);
  const out: MasteryEvidence[] = [];
  for (const r of rows) {
    const nodeIds = blockNodeIds.get(r.blockId) ?? [];
    if (nodeIds.length === 0) continue;
    const w = ordinalWeight(ordinals.get(r.attemptId) ?? 1);
    for (const nodeId of nodeIds) {
      out.push({
        nodeId,
        direction: r.correct ? 1 : -1,
        weight: w,
        at: r.createdAt,
        sourceId: `quiz_detail:${r.attemptId}:${r.questionId}:${nodeId}`,
        kind: "quiz_detail",
      });
    }
  }
  return out;
}

/**
 * PURE. Map historical detail-less attempts to evidence. Direction = score ≥
 * HISTORICAL_PASS_FRACTION; weight = HISTORICAL_DETAILLESS_FACTOR × ordinal
 * weight; applied to every node anchored to the block.
 */
export function mapHistoricalAttempts(
  rows: HistoricalAttemptRow[],
  blockNodeIds: Map<string, string[]>
): MasteryEvidence[] {
  const ordinals = deriveAttemptOrdinals(
    rows.map((r) => ({ attemptId: r.attemptId, userId: r.userId, publicationId: r.publicationId, blockId: r.blockId, createdAt: r.createdAt }))
  );
  const out: MasteryEvidence[] = [];
  for (const r of rows) {
    const nodeIds = blockNodeIds.get(r.blockId) ?? [];
    if (nodeIds.length === 0) continue;
    const w = HISTORICAL_DETAILLESS_FACTOR * ordinalWeight(ordinals.get(r.attemptId) ?? 1);
    const direction: 1 | -1 = r.scoreFraction >= HISTORICAL_PASS_FRACTION ? 1 : -1;
    for (const nodeId of nodeIds) {
      out.push({
        nodeId,
        direction,
        weight: w,
        at: r.createdAt,
        sourceId: `quiz_historical:${r.attemptId}:${nodeId}`,
        kind: "quiz_historical",
      });
    }
  }
  return out;
}

/**
 * PURE. Map the evidence event types (five Wave-2 members + A3's
 * tutor_evidence_recorded) to evidence. A row with no node_id (or an event that
 * carries no usable signal) yields nothing.
 */
export function mapEvents(rows: MasteryEventRow[]): MasteryEvidence[] {
  const out: MasteryEvidence[] = [];
  for (const r of rows) {
    if (!r.nodeId) continue;
    switch (r.eventType) {
      case "practice_answer": {
        if (r.evidenceCorrect === null || r.evidenceCorrect === undefined) break;
        const w = ordinalWeight(r.attemptOrdinal ?? 1);
        out.push({
          nodeId: r.nodeId,
          direction: r.evidenceCorrect ? 1 : -1,
          weight: w,
          at: r.createdAt,
          sourceId: `practice_answer:${r.eventId}`,
          kind: "practice_answer",
        });
        break;
      }
      case "hint_request": {
        if (r.hintRung === null || r.hintRung === undefined) break;
        const { direction, weight } = hintWeight(r.hintRung);
        out.push({ nodeId: r.nodeId, direction, weight, at: r.createdAt, sourceId: `hint_request:${r.eventId}`, kind: "hint_request" });
        break;
      }
      case "self_report": {
        if (r.evidenceCorrect === null || r.evidenceCorrect === undefined) break;
        out.push({
          nodeId: r.nodeId,
          direction: r.evidenceCorrect ? 1 : -1,
          weight: SELF_REPORT_WEIGHT,
          at: r.createdAt,
          sourceId: `self_report:${r.eventId}`,
          kind: "self_report",
        });
        break;
      }
      case "tutor_inference": {
        if (!r.inferenceDirection || !r.inferenceStrength) break;
        out.push({
          nodeId: r.nodeId,
          direction: r.inferenceDirection === "positive" ? 1 : -1,
          weight: tutorInferenceWeight(r.inferenceStrength),
          at: r.createdAt,
          sourceId: `tutor_inference:${r.eventId}`,
          kind: "tutor_inference",
        });
        break;
      }
      case "content_engagement": {
        if (!r.contentSignal) break;
        const { direction, weight } = contentEngagementWeight(r.contentSignal);
        out.push({ nodeId: r.nodeId, direction, weight, at: r.createdAt, sourceId: `content_engagement:${r.eventId}`, kind: "content_engagement" });
        break;
      }
      case "tutor_evidence_recorded": {
        // A3 tool completion — conservative v1: outcome alone sets the fold
        // (practice-answer magnitudes; confidence/misconception never modulate).
        if (!r.toolOutcome) break;
        const { direction, weight } = toolEvidenceWeight(r.toolOutcome);
        out.push({
          nodeId: r.nodeId,
          direction,
          weight,
          at: r.createdAt,
          sourceId: `tutor_evidence_recorded:${r.eventId}`,
          kind: "tutor_evidence_recorded",
        });
        break;
      }
    }
  }
  return out;
}

/**
 * PURE. Map DERIVED dwell signals: a slide whose dwell exceeds
 * `cfg.dwellOverMedianMult × cohortMedian` yields a light NEGATIVE on each node
 * anchored to the slide. A slide with no cohort median (n too small) or dwell at
 * or under the multiple yields nothing.
 */
export function mapDwell(rows: DwellRow[], cfg: MasteryConfig): MasteryEvidence[] {
  const out: MasteryEvidence[] = [];
  for (const r of rows) {
    if (r.cohortMedianMs === null || r.cohortMedianMs <= 0) continue;
    if (r.dwellMs <= cfg.dwellOverMedianMult * r.cohortMedianMs) continue;
    for (const nodeId of r.nodeIds) {
      out.push({
        nodeId,
        direction: -1,
        weight: DWELL_OVER_MEDIAN_WEIGHT,
        at: r.createdAt,
        sourceId: `dwell_over_median:${r.eventId}:${nodeId}`,
        kind: "dwell_over_median",
      });
    }
  }
  return out;
}

/**
 * PURE. Assemble the full evidence stream from every source and SORT it
 * deterministically by (at, sourceId) — the order the refold trusts (refold.ts
 * folds in this exact order). Byte-identical for identical inputs.
 */
export function assembleEvidence(parts: MasteryEvidence[][]): MasteryEvidence[] {
  const all = parts.flat();
  all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  return all;
}
