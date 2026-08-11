/**
 * TUTOR-1 Amendment A4, Wave 2 — chunk + embed + store, at publish.
 *
 * `embedAndStoreChunks` chunks a published snapshot, embeds each chunk (batched),
 * and stores them via the `tutor_store_chunks` service-role definer RPC. IDEMPOTENT
 * by publication id: an immutable snapshot is embedded ONCE — a repeat call (an
 * Inngest retry, or a republish of the same publication) makes ZERO embed calls
 * (A4-9). The embed client is INJECTED (the Inngest publish worker passes a real
 * OpenAI client; tests pass the deterministic mock).
 *
 * The embed client should be issued UN-POOLED or on the CREATOR pool — never the
 * learner pool (Wave-0 audit §2: interactive query embeds must not contend with
 * tutor turns; a publish-time bulk embed is creator/background work).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { ModelClient } from "@/lib/ai/modelClient";
import type { PublicationSnapshot } from "@/lib/course/publish/schemas";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import { deriveRetrievalChunks } from "./chunker";
import { padToDims, toVectorLiteral, RETRIEVAL_EMBED_BATCH } from "./config";

type DB = SupabaseClient<Database>;
type Json = Database["public"]["Functions"]["tutor_store_chunks"]["Args"]["p_chunks"];

export interface EmbedStoreResult {
  /** Chunks derived from the snapshot (0 when already embedded or no prose). */
  chunks: number;
  /** Chunks actually embedded + stored this call (0 when skipped). */
  embedded: number;
  /** True when idempotency short-circuited (chunks already exist). */
  skipped: boolean;
}

/** Does the publication already have stored chunks? (the idempotency guard) */
export async function chunksExistForPublication(admin: DB, publicationId: string): Promise<boolean> {
  const { count, error } = await admin
    .from("tutor_chunks")
    .select("id", { count: "exact", head: true })
    .eq("publication_id", publicationId);
  if (error) throw new Error(`chunksExistForPublication: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function embedAndStoreChunks(
  admin: DB,
  embedClient: ModelClient,
  args: {
    courseId: string;
    publicationId: string;
    version: number;
    contentHash: string;
    snapshot: PublicationSnapshot;
    /** Force a re-embed even if chunks exist (a content/style migration). Default false. */
    force?: boolean;
  }
): Promise<EmbedStoreResult> {
  // A4-9 · idempotency: an immutable publication is embedded ONCE. Skip → 0 embeds.
  if (!args.force && (await chunksExistForPublication(admin, args.publicationId))) {
    return { chunks: 0, embedded: 0, skipped: true };
  }
  if (!embedClient.embed) throw new Error("embedAndStoreChunks: the model client has no embed()");

  const chunks = deriveRetrievalChunks(args.snapshot);
  if (chunks.length === 0) return { chunks: 0, embedded: 0, skipped: false };

  // Embed in order-aligned batches.
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += RETRIEVAL_EMBED_BATCH) {
    const batch = chunks.slice(i, i + RETRIEVAL_EMBED_BATCH);
    const res = await embedClient.embed({
      model: TUTOR_MODELS.embedding.model,
      inputs: batch.map((c) => c.text),
      timeoutMs: TUTOR_MODELS.embedding.timeoutMs,
    });
    if (res.vectors.length !== batch.length) {
      throw new Error(`embed batch size mismatch: ${res.vectors.length} != ${batch.length}`);
    }
    vectors.push(...res.vectors);
  }

  const payload = chunks.map((c, i) => ({
    course_id: c.courseId,
    version: args.version,
    content_hash: args.contentHash,
    lesson_id: c.lessonId,
    block_id: c.blockId,
    slide_id: c.slideId ?? "", // "" → NULL in the store RPC (nullif)
    chunk_ordinal: c.chunkOrdinal,
    text: c.text,
    embedding: toVectorLiteral(padToDims(vectors[i])),
    display_anchor: c.anchor,
  }));

  const { error } = await admin.rpc("tutor_store_chunks", {
    p_publication_id: args.publicationId,
    p_chunks: payload as unknown as Json,
  });
  if (error) throw new Error(`tutor_store_chunks: ${error.message}`);

  return { chunks: chunks.length, embedded: chunks.length, skipped: false };
}
