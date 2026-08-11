/**
 * TUTOR-1 Amendment A4, Wave 2 — the hybrid retrieval WRAPPER.
 *
 * Embeds the query (via an INJECTED, un-pooled embed client — Wave-0 audit §2:
 * keep interactive query embeds OFF the learner pool) and calls the
 * `tutor_retrieve_chunks` definer RPC, which fuses a pgvector-cosine arm with a
 * tsvector-lexical arm and filters eligible lessons INSIDE the query (A4-11).
 * Returns fused, ranked chunks with their resolvable display anchors.
 *
 * NOT wired into the tutor loop yet — that is Wave 4 (scope policy decides the
 * eligible lessons + weaves chunks into the prompt).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { ModelClient } from "@/lib/ai/modelClient";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import { padToDims, toVectorLiteral, RETRIEVAL_DEFAULTS } from "./config";
import type { RetrievalChunkAnchor } from "./chunker";

type DB = SupabaseClient<Database>;

export interface RetrievedChunk {
  id: string;
  lessonId: string;
  blockId: string;
  slideId: string | null;
  chunkOrdinal: number;
  text: string;
  anchor: RetrievalChunkAnchor;
  sourceTier: string;
  /** Rank in the vector arm (null when the chunk was a lexical-only hit). */
  vectorRank: number | null;
  /** Rank in the lexical arm (null when the chunk was a vector-only hit). */
  lexicalRank: number | null;
  /** Reciprocal-rank-fusion score (higher = better; the RANKING signal). */
  score: number;
  /** Raw cosine similarity to the query (0..1; the RELEVANCE signal τ gates on). */
  similarity: number;
}

export interface RetrieveChunksArgs {
  publicationId: string;
  queryText: string;
  /** The lessons the learner is eligible to retrieve from (Wave 3 computes these).
   *  Empty ⇒ nothing is retrievable (no eligible lesson). */
  eligibleLessonIds: string[];
  vectorLimit?: number;
  lexicalLimit?: number;
  resultLimit?: number;
}

/**
 * Hybrid-retrieve chunks for a query within the eligible lessons of a publication.
 * `admin` is the service-role client (the RPC is service-role only); `embedClient`
 * embeds the query. Returns fused/ranked chunks (empty when no eligible lessons).
 */
export async function retrieveChunks(
  admin: DB,
  embedClient: ModelClient,
  args: RetrieveChunksArgs
): Promise<RetrievedChunk[]> {
  if (args.eligibleLessonIds.length === 0) return [];
  if (!embedClient.embed) throw new Error("retrieveChunks: the model client has no embed()");

  const emb = await embedClient.embed({
    model: TUTOR_MODELS.embedding.model,
    inputs: [args.queryText],
    timeoutMs: TUTOR_MODELS.embedding.timeoutMs,
  });
  const queryEmbedding = toVectorLiteral(padToDims(emb.vectors[0] ?? []));

  const { data, error } = await admin.rpc("tutor_retrieve_chunks", {
    p_publication_id: args.publicationId,
    p_query_embedding: queryEmbedding,
    p_query_text: args.queryText,
    p_lesson_ids: args.eligibleLessonIds,
    p_vector_limit: args.vectorLimit ?? RETRIEVAL_DEFAULTS.vectorLimit,
    p_lexical_limit: args.lexicalLimit ?? RETRIEVAL_DEFAULTS.lexicalLimit,
    p_result_limit: args.resultLimit ?? RETRIEVAL_DEFAULTS.resultLimit,
  });
  if (error) throw new Error(`tutor_retrieve_chunks: ${error.message}`);

  return (data ?? []).map((r) => ({
    id: r.id,
    lessonId: r.lesson_id,
    blockId: r.block_id,
    slideId: r.slide_id ?? null,
    chunkOrdinal: r.chunk_ordinal,
    text: r.text,
    anchor: { lessonId: r.lesson_id, blockId: r.block_id, slideId: r.slide_id ?? null },
    sourceTier: r.source_tier,
    vectorRank: r.vector_rank ?? null,
    lexicalRank: r.lexical_rank ?? null,
    score: r.score,
    similarity: r.similarity ?? 0,
  }));
}
