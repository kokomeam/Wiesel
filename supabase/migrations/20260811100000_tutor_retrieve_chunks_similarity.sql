-- TUTOR-1 Amendment A4, Wave 5 (τ calibration finding) — expose the top chunk's
-- raw cosine SIMILARITY from the hybrid-retrieve RPC.
--
-- The Wave-3 `insufficient_local_context` gate compared the RRF FUSED score to τ.
-- Calibration against cs61b (real embeddings, 32 labeled queries) showed the
-- fused-top score clusters at ~1/61 for BOTH relevant and irrelevant queries (the
-- vector arm always returns a rank-1 nearest; the lexical arm rarely stacks on the
-- SAME chunk), so no τ on the RRF scale separates them (≥87% false-expansion). The
-- top chunk's cosine SIMILARITY separates cleanly, so the RPC now returns it and
-- the scope policy gates τ on `similarity` (recalibrated on that scale).
--
-- ROLLBACK: re-create the pre-Wave-5 function (20260810140000's body, without the
-- similarity column).

drop function if exists public.tutor_retrieve_chunks(uuid, text, text, uuid[], int, int, int);

create function public.tutor_retrieve_chunks(
  p_publication_id  uuid,
  p_query_embedding text,
  p_query_text      text,
  p_lesson_ids      uuid[],
  p_vector_limit    int default 6,
  p_lexical_limit   int default 6,
  p_result_limit    int default 8
)
returns table (
  id uuid, lesson_id uuid, block_id uuid, slide_id text, chunk_ordinal int,
  text text, display_anchor jsonb, source_tier text,
  vector_rank int, lexical_rank int, score double precision, similarity double precision
)
language sql stable security definer set search_path = public as $$
  with q as (select (p_query_embedding)::vector as v),
  vec as (
    select c.id, row_number() over (order by c.embedding <=> (select v from q)) as rnk
    from public.tutor_chunks c
    where c.publication_id = p_publication_id
      and c.lesson_id = any(p_lesson_ids)
    order by c.embedding <=> (select v from q)
    limit p_vector_limit
  ),
  lex as (
    select c.id,
           row_number() over (order by ts_rank(c.tsv, websearch_to_tsquery('english', p_query_text)) desc) as rnk
    from public.tutor_chunks c
    where c.publication_id = p_publication_id
      and c.lesson_id = any(p_lesson_ids)
      and c.tsv @@ websearch_to_tsquery('english', p_query_text)
    order by ts_rank(c.tsv, websearch_to_tsquery('english', p_query_text)) desc
    limit p_lexical_limit
  ),
  fused as (
    select coalesce(vec.id, lex.id) as id,
           vec.rnk as vrank,
           lex.rnk as lrank,
           coalesce(1.0 / (60 + vec.rnk), 0) + coalesce(1.0 / (60 + lex.rnk), 0) as score
    from vec
    full outer join lex on vec.id = lex.id
  )
  select c.id, c.lesson_id, c.block_id, c.slide_id, c.chunk_ordinal,
         c.text, c.display_anchor, c.source_tier,
         f.vrank, f.lrank, f.score,
         1 - (c.embedding <=> (select v from q)) as similarity
  from fused f
  join public.tutor_chunks c on c.id = f.id
  order by f.score desc, c.chunk_ordinal asc
  limit p_result_limit;
$$;
revoke all on function public.tutor_retrieve_chunks(uuid, text, text, uuid[], int, int, int) from public, anon, authenticated;
grant execute on function public.tutor_retrieve_chunks(uuid, text, text, uuid[], int, int, int) to service_role;

comment on function public.tutor_retrieve_chunks(uuid, text, text, uuid[], int, int, int) is
  'A4 Wave 2/5 hybrid retrieval: vector (pgvector cosine, hnsw) + lexical (tsvector) arms fused by reciprocal rank fusion; eligible-lesson filter INSIDE the query; returns each chunk''s raw cosine SIMILARITY (the tau signal). Service-role only.';
