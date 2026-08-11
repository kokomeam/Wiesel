/**
 * TUTOR-1 Amendment A4, Wave 2 — retrieval config + pure vector helpers.
 *
 * `TUTOR_EMBEDDING_DIMS` is the ONE dimension source: it MUST equal the
 * `vector(N)` column dimension in migration `20260810140000` (1536 = the
 * `TUTOR_MODELS.embedding` model's output width). A provider returning a
 * different width is normalized to this dimension by `padToDims` — production
 * 1536-vectors pass through; the 32-dim test mock is zero-padded (zero-padding
 * preserves cosine EXACTLY, so ranking is unaffected). Do not env-override this
 * without changing the column.
 */

/** The stored embedding dimension — MUST match `tutor_chunks.embedding vector(N)`. */
export const TUTOR_EMBEDDING_DIMS = 1536;

/** Default retrieval fan-out (per arm) + fused result cap. */
export const RETRIEVAL_DEFAULTS = {
  /** Nearest-neighbour candidates from the vector arm. */
  vectorLimit: 6,
  /** Top matches from the lexical (tsvector) arm. */
  lexicalLimit: 6,
  /** Fused results returned to the caller. */
  resultLimit: 8,
} as const;

/** Max chunk text length embedded/stored (a slide/block is small; this is a
 *  defensive cap so a pathological block can't blow the embed request). */
export const RETRIEVAL_CHUNK_MAX_CHARS = 4000;

/** Batch size for the embeddings API (one request embeds this many chunks). */
export const RETRIEVAL_EMBED_BATCH = 96;

/**
 * Normalize an embedding to the stored dimension: truncate if longer, ZERO-pad
 * if shorter. Zero-padding is cosine-preserving (the padded dims contribute
 * nothing to the dot product or either norm), so a shorter mock vector ranks
 * identically to its unpadded self. Pure.
 */
export function padToDims(vec: number[], dims = TUTOR_EMBEDDING_DIMS): number[] {
  if (vec.length === dims) return vec;
  if (vec.length > dims) return vec.slice(0, dims);
  const out = vec.slice();
  while (out.length < dims) out.push(0);
  return out;
}

/** Render a numeric vector as the pgvector text literal `[a,b,c]` (the store RPC
 *  and the retrieve RPC both cast a JSON string of this shape to `vector`). */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
