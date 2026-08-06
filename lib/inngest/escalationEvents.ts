/**
 * Tutor ESCALATION event surface (TUTOR-1 Wave 6, P6.1) — the SINGLE source for
 * the on-consent event name + payload shape. This is the FROZEN contract P6.2
 * consumes: its on-consent Inngest function triggers on this event name and reads
 * exactly this payload to synthesize the dossier + assign the cluster.
 *
 * Mirrors tutorMasteryEvents.ts / tutorGraphEvents.ts exactly: the name is
 * `{domain}/{noun}.{verb}`, and the sender is BEST-EFFORT (it logs + never throws
 * into the caller's path). The escalate_consent route action fires this the moment
 * a learner consents; a lost event is reconciled by P6.2's nightly sweep (a
 * `consented` candidate with no dossier yet is synthesized there) — correctness
 * never depends on the event round-trip (dev has no INNGEST_EVENT_KEY).
 *
 * ── WHY THE PAYLOAD IS ID-ONLY ───────────────────────────────────────────────
 * The event carries ONLY the candidate id + course id. NO learner identity, NO
 * question text on the wire — the P6.2 synthesis job re-reads the (now consented)
 * candidate row with the service role and anonymizes the question before it ever
 * reaches a model. Keeping identity off the event mirrors the tutor cost-telemetry
 * discipline (identity stays server-side).
 */

import { inngest } from "./client";

export const TUTOR_ESCALATION_CONSENTED_EVENT = "tutor/escalation.consented" as const;

/** The payload the consent event carries: the candidate + course to synthesize.
 *  Deliberately id-only — the P6.2 job re-reads the row server-side (no identity
 *  or question text on the wire). */
export interface TutorEscalationConsentedData {
  candidateId: string;
  courseId: string;
}

/** Best-effort fire of the consent event — mirrors sendTutorMasteryRefoldRequested:
 *  swallow + LOG any send failure (tag `tutor_escalation_event`) so the caller's
 *  path (the escalate_consent route action) never throws. The nightly reconcile in
 *  P6.2 synthesizes any consented candidate whose dossier is missing, so a lost
 *  event is self-healing. */
export async function sendTutorEscalationConsented(
  data: TutorEscalationConsentedData
): Promise<void> {
  try {
    await inngest.send({ name: TUTOR_ESCALATION_CONSENTED_EVENT, data });
  } catch (err) {
    console.log(
      JSON.stringify({
        tag: "tutor_escalation_event",
        event: TUTOR_ESCALATION_CONSENTED_EVENT,
        candidateId: data.candidateId,
        courseId: data.courseId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
  }
}
