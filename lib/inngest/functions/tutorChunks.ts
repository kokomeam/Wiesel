/**
 * TUTOR-1 Amendment A4, Wave 2 — the durable retrieval-embed function.
 *
 *   tutorChunksEmbed — on tutor/chunks.embed.requested: assemble the admin client
 *     + a CREATOR-pooled real OpenAI client (never the LEARNER pool — Wave-0 audit
 *     §2) and run embedAndStoreChunks for the new publication inside ONE durable
 *     step. IDEMPOTENT: embedAndStoreChunks short-circuits when the publication
 *     already has chunks (an Inngest retry / duplicate event re-embeds nothing).
 *     concurrency { key: courseId, limit: 1 } serializes a course's runs.
 *
 * FAIL-BENIGN: a missing admin/OPENAI env settles the step with a checkpoint
 * (never throws — retrying a permanent misconfiguration wastes executions), the
 * tutorGraphExtract precedent.
 */

import { inngest } from "../client";
import {
  TUTOR_CHUNKS_EMBED_REQUESTED_EVENT,
  type TutorChunksEmbedRequestedData,
} from "../tutorChunkEvents";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { createOpenAIModelClient } from "@/lib/ai/providers/openai";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
import { PublicationSnapshotSchema } from "@/lib/course/publish/schemas";
import { embedAndStoreChunks } from "@/lib/tutor/retrieval/embedStore";

type EmbedStepResult =
  | { ok: true; chunks: number; embedded: number; skipped: boolean }
  | { ok: false; checkpoint: string };

export const tutorChunksEmbed = inngest.createFunction(
  {
    id: "tutor-chunks-embed",
    concurrency: { key: "event.data.courseId", limit: 1 },
    triggers: [{ event: TUTOR_CHUNKS_EMBED_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const { courseId, publicationId } = event.data as TutorChunksEmbedRequestedData;

    return step.run("embed-chunks", async (): Promise<EmbedStepResult> => {
      if (!isAdminConfigured() || !process.env.OPENAI_API_KEY) {
        const result: EmbedStepResult = { ok: false, checkpoint: "model not configured" };
        console.log(JSON.stringify({ tag: "tutor_chunks_embed", ...result, courseId, publicationId }));
        return result;
      }

      const admin = createAdminClient();
      const { data: pub, error } = await admin
        .from("course_publications")
        .select("course_id, version, content_hash, snapshot")
        .eq("id", publicationId)
        .maybeSingle();
      if (error || !pub) {
        const result: EmbedStepResult = { ok: false, checkpoint: "publication not found" };
        console.log(JSON.stringify({ tag: "tutor_chunks_embed", ...result, courseId, publicationId, error: error?.message }));
        return result;
      }

      const snapshot = PublicationSnapshotSchema.parse(pub.snapshot);
      // CREATOR pool (never the learner pool — §2). A publish-time bulk embed is
      // background creator work; it serializes with graph extraction, not tutor turns.
      const embedClient = withPooledModel(createOpenAIModelClient(), { pool: poolFor("creator") });

      const res = await embedAndStoreChunks(admin, embedClient, {
        courseId,
        publicationId,
        version: pub.version,
        contentHash: pub.content_hash,
        snapshot,
      });
      console.log(JSON.stringify({ tag: "tutor_chunks_embed", ok: true, courseId, publicationId, ...res }));
      return { ok: true, ...res };
    });
  }
);
