/**
 * TUTOR-1 Amendment A4, Wave 2 — the publish → retrieval-embed seam.
 *
 * Called by `publishCourse` after a REAL publish (the identical-hash republish
 * path early-returns BEFORE reaching here, so a no-op republish never enqueues —
 * and even if it did, embedAndStoreChunks is idempotent per publication). Fires
 * `tutor/chunks.embed.requested` so the durable worker chunks + embeds the new
 * immutable publication. BEST-EFFORT + lazy-imported (the Inngest SDK stays out
 * of publish-only import graphs); a send failure logs and never breaks publish.
 */

export async function enqueueChunkEmbedForPublish(
  args: { courseId: string; publicationId: string }
): Promise<"requested" | "skipped_error"> {
  try {
    const events = await import("@/lib/inngest/tutorChunkEvents");
    await events.sendTutorChunksEmbedRequested({
      courseId: args.courseId,
      publicationId: args.publicationId,
    });
    return "requested";
  } catch (err) {
    console.error(
      JSON.stringify({
        tag: "tutor_chunks_publish_hook",
        outcome: "error",
        courseId: args.courseId,
        message: err instanceof Error ? err.message : String(err),
      })
    );
    return "skipped_error";
  }
}
