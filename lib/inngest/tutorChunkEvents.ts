/**
 * TUTOR-1 Amendment A4, Wave 2 — the retrieval-embed event surface.
 *
 * `tutor/chunks.embed.requested` — fired by the publish hook after a REAL publish
 * so the durable `tutorChunksEmbed` function chunks + embeds the new (immutable)
 * publication into `tutor_chunks`. Best-effort send (log + never throw into the
 * publisher's path); a lost event is re-enqueued on the next publish. Mirrors
 * `tutorGraphEvents.ts`.
 */

import { inngest } from "./client";

export const TUTOR_CHUNKS_EMBED_REQUESTED_EVENT = "tutor/chunks.embed.requested" as const;

export interface TutorChunksEmbedRequestedData {
  courseId: string;
  publicationId: string;
}

/** Best-effort fire — swallow + LOG any send failure (tag `tutor_chunks_event`)
 *  so the publish path never throws. */
export async function sendTutorChunksEmbedRequested(
  data: TutorChunksEmbedRequestedData
): Promise<void> {
  try {
    await inngest.send({ name: TUTOR_CHUNKS_EMBED_REQUESTED_EVENT, data });
  } catch (err) {
    console.log(
      JSON.stringify({
        tag: "tutor_chunks_event",
        event: TUTOR_CHUNKS_EMBED_REQUESTED_EVENT,
        courseId: data.courseId,
        publicationId: data.publicationId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
  }
}
