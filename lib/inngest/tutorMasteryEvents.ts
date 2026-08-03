/**
 * Tutor MASTERY event surface (TUTOR-1 Wave 2) — the SINGLE source for the
 * refold event name + payload shape shared by the sender, the durable function,
 * and the wiring tests. Mirrors tutorGraphEvents.ts exactly: the name is
 * `{domain}/{noun}.{verb}`, the sender is BEST-EFFORT (it logs + never throws
 * into the caller's path — a lost event is reconciled by the nightly sweep).
 *
 *   tutor/mastery.refold.requested — fired when a learner's (user, course)
 *     mastery should be recomputed from scratch (evidence changed). The durable
 *     `tutor-mastery-refold` function refolds + writes the pair (concurrency 1
 *     per user:course). Defined + HANDLED now; the EMITTERS are Wave 3's evidence
 *     ingest routes (a practice answer / hint / self-report / tutor inference /
 *     content-engagement write fires this for the affected learner) — wiring them
 *     is Wave 3, but the surface is complete now so those routes can reference one
 *     constant, exactly like the graph extraction event predated its emitter.
 */

import { inngest } from "./client";

export const TUTOR_MASTERY_REFOLD_REQUESTED_EVENT = "tutor/mastery.refold.requested" as const;

/** The payload the refold event carries: the (user, course) pair to recompute. */
export interface TutorMasteryRefoldRequestedData {
  userId: string;
  courseId: string;
}

/** Best-effort fire of the refold event — mirrors sendTutorExtractionRequested:
 *  swallow + LOG any send failure (tag `tutor_mastery_event`) so the caller's
 *  path never throws. The nightly sweep reconciles a lost event (any pair with
 *  evidence newer than its mastery computed_at is refolded there). */
export async function sendTutorMasteryRefoldRequested(
  data: TutorMasteryRefoldRequestedData
): Promise<void> {
  try {
    await inngest.send({ name: TUTOR_MASTERY_REFOLD_REQUESTED_EVENT, data });
  } catch (err) {
    console.log(
      JSON.stringify({
        tag: "tutor_mastery_event",
        event: TUTOR_MASTERY_REFOLD_REQUESTED_EVENT,
        userId: data.userId,
        courseId: data.courseId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
  }
}
