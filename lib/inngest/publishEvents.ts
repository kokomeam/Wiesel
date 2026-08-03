/**
 * Publish-governance event surface — the SINGLE source for event names and
 * payload shapes shared by the senders (approve/cancel/void/reschedule), the
 * durable functions, and the wiring tests.
 *
 *   social/publish.requested — fired when an approval is consumed (and again
 *     after a reschedule): the durable fire function sleepUntil(scheduledFor)
 *     then advances the manifest. Fire accuracy is sleepUntil-precise — no
 *     cron quantization (M-C amendment 1; P95 well under 120s).
 *   social/publish.released  — fired on cancel, void, and reschedule; the
 *     fire function's cancelOn matches it by manifestId, killing the sleep.
 *
 * Senders are BEST-EFFORT (never throw into the approve/cancel paths): the
 * sweep cron reconciles anything a lost event leaves behind.
 */

import { inngest } from "./client";

export const PUBLISH_REQUESTED_EVENT = "social/publish.requested" as const;
export const PUBLISH_RELEASED_EVENT = "social/publish.released" as const;

/** cancelOn expression — the released event must name the same manifest. */
export const PUBLISH_CANCEL_MATCH = "event.data.manifestId == async.data.manifestId" as const;

export interface PublishRequestedData {
  manifestId: string;
  creatorId: string;
  /** ISO fire time; null/past = advance immediately. */
  scheduledFor: string | null;
}

export async function sendPublishRequested(data: PublishRequestedData): Promise<void> {
  try {
    await inngest.send({ name: PUBLISH_REQUESTED_EVENT, data });
  } catch (err) {
    console.log(
      JSON.stringify({ tag: "publish_event_send_failed", event: PUBLISH_REQUESTED_EVENT, manifestId: data.manifestId, error: err instanceof Error ? err.message.slice(0, 200) : String(err) })
    );
  }
}

export async function sendPublishReleased(manifestId: string): Promise<void> {
  try {
    await inngest.send({ name: PUBLISH_RELEASED_EVENT, data: { manifestId } });
  } catch (err) {
    console.log(
      JSON.stringify({ tag: "publish_event_send_failed", event: PUBLISH_RELEASED_EVENT, manifestId, error: err instanceof Error ? err.message.slice(0, 200) : String(err) })
    );
  }
}
