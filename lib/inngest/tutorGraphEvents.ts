/**
 * Tutor concept-graph event surface (TUTOR-1 Wave 1.3) — the SINGLE source for
 * the extraction/reconciliation event names + payload shapes shared by the
 * senders, the durable functions, and the wiring tests. Mirrors publishEvents.ts:
 * event names are `{domain}/{noun}.{verb}`, senders are BEST-EFFORT (they log +
 * never throw into the caller's path — a lost event is reconciled elsewhere).
 *
 *   tutor/graph.extraction.requested    — fired when a course's concept graph
 *     should be (re-)extracted from its live publication. The durable
 *     `tutorGraphExtract` function runs runGraphExtraction (concurrency 1 per
 *     course); a re-run is idempotent (stageExtractionResult short-circuits on
 *     an existing pending set).
 *   tutor/graph.reconciliation.requested — RESERVED: the name is defined now so
 *     senders/tests can reference one constant; its durable function arrives in
 *     Wave 1.4.
 */

import { inngest } from "./client";

export const TUTOR_EXTRACTION_REQUESTED_EVENT = "tutor/graph.extraction.requested" as const;
export const TUTOR_RECONCILIATION_REQUESTED_EVENT = "tutor/graph.reconciliation.requested" as const;

/** The payload both graph events carry: the course + the live publication to
 *  (re-)extract, plus the agent_runs row id the core threads through. */
export interface TutorExtractionRequestedData {
  courseId: string;
  publicationId: string;
  runId: string;
}

/** Reserved for Wave 1.4 — same shape as extraction (a reconciliation run
 *  re-extracts then merges against the stored graph). */
export type TutorReconciliationRequestedData = TutorExtractionRequestedData;

/** Best-effort fire of the extraction event — mirrors sendPublishRequested
 *  exactly: swallow + LOG any send failure (tag `tutor_graph_event`) so the
 *  caller's path never throws. The sweep/backstop reconciles a lost event. */
export async function sendTutorExtractionRequested(
  data: TutorExtractionRequestedData
): Promise<void> {
  try {
    await inngest.send({ name: TUTOR_EXTRACTION_REQUESTED_EVENT, data });
  } catch (err) {
    console.log(
      JSON.stringify({
        tag: "tutor_graph_event",
        event: TUTOR_EXTRACTION_REQUESTED_EVENT,
        courseId: data.courseId,
        publicationId: data.publicationId,
        runId: data.runId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
  }
}

/** Best-effort fire of the reconciliation event (W1.4 — the publish hook sends
 *  it when the course already has an active graph). Same discipline as above. */
export async function sendTutorReconciliationRequested(
  data: TutorReconciliationRequestedData
): Promise<void> {
  try {
    await inngest.send({ name: TUTOR_RECONCILIATION_REQUESTED_EVENT, data });
  } catch (err) {
    console.log(
      JSON.stringify({
        tag: "tutor_graph_event",
        event: TUTOR_RECONCILIATION_REQUESTED_EVENT,
        courseId: data.courseId,
        publicationId: data.publicationId,
        runId: data.runId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
  }
}
