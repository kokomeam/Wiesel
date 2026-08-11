-- TUTOR-1 — Amendment A4, Wave 2: the RETRIEVAL INDEX (pgvector chunk store +
-- hybrid retrieval).
--
-- Course content is chunked at PUBLISH (one chunk per slide / per non-deck block)
-- and embedded ONCE against the immutable publication (snapshot) id — never
-- recomputed for the same publication. Retrieval is HYBRID: vector similarity
-- (pgvector cosine, hnsw) fused with lexical match (tsvector, gin) via reciprocal
-- rank fusion, so exact technical terminology ("2-3 tree", "LLRB", "amortized")
-- that pure vector search misses is still found. The eligible-lesson filter runs
-- INSIDE the SQL (A4-11), never as a post-filter.
--
-- The vector seam already existed for the concept graph (ModelClient.embed +
-- text-embedding-3-small + cosine math); this wave adds the STORED index.
--
-- ROLLBACK:
--   drop function if exists public.tutor_retrieve_chunks(uuid, text, text, uuid[], int, int, int);
--   drop function if exists public.tutor_store_chunks(uuid, jsonb);
--   drop table if exists public.tutor_chunks;
--   -- (leave the `vector` extension installed; other work may adopt it)

create extension if not exists vector;

-- ─────────────────────────────── the chunk store ───────────────────────────
create table public.tutor_chunks (
  id             uuid primary key default gen_random_uuid(),
  course_id      uuid not null references public.courses(id) on delete cascade,
  -- The immutable snapshot id. FK → course_publications so a deleted publication
  -- (course cascade) takes its chunks with it. Republishing identical content is
  -- an M1 no-op (same row), so keying on publication_id gives free re-embed
  -- avoidance; content_hash is carried for cross-publication dedup insight.
  publication_id uuid not null references public.course_publications(id) on delete cascade,
  version        integer not null,
  content_hash   text not null,
  -- Snapshot node ids (block/lesson are uuids; slide_id is a jsonb SHORT id → text).
  -- NO FK — a draft node may be deleted while a published chunk lives (the tutor
  -- no-FK-to-draft convention).
  lesson_id      uuid not null,
  block_id       uuid not null,
  slide_id       text,
  chunk_ordinal  integer not null,                 -- stable order within the publication
  text           text not null,
  embedding      vector(1536) not null,            -- text-embedding-3-small dims (TUTOR_EMBEDDING_DIMS)
  -- Generated FTS vector for the lexical arm (no need to pass it on insert).
  tsv            tsvector generated always as (to_tsvector('english', text)) stored,
  -- [FWD] the model-knowledge tier seam. A4 stores ONLY 'canon' (the CHECK makes
  -- 'adjacent' unreachable); a future amendment widens the CHECK to enable it.
  source_tier    text not null default 'canon' check (source_tier = 'canon'),
  -- The resolvable deep-link tuple {lessonId, blockId, slideId?} (fixes D-8).
  display_anchor jsonb not null,
  created_at     timestamptz not null default now(),
  unique (publication_id, chunk_ordinal)
);

comment on table public.tutor_chunks is
  'A4 Wave 2 retrieval index: one embedded chunk per slide / non-deck block of a published snapshot. publication_id-keyed (embed once per immutable snapshot). Hybrid retrieval = pgvector cosine (hnsw) + tsvector lexical (gin), fused. Written ONLY by tutor_store_chunks (service-role definer); read via tutor_retrieve_chunks or author RLS.';

-- The eligible-lesson filter's covering index (publication + lesson).
create index tutor_chunks_pub_lesson_idx on public.tutor_chunks (publication_id, lesson_id);
-- Vector ANN (cosine). hnsw = recall/latency at this corpus size.
create index tutor_chunks_embedding_hnsw on public.tutor_chunks using hnsw (embedding vector_cosine_ops);
-- Lexical FTS.
create index tutor_chunks_tsv_gin on public.tutor_chunks using gin (tsv);

-- ─────────────────────────────────── RLS ───────────────────────────────────
alter table public.tutor_chunks enable row level security;
-- Read: an enrolled learner or the course author (chunks are answer-stripped
-- published content they can already see). NO client insert/update/delete — the
-- SECURITY DEFINER writer + the service-role client are the only writers.
create policy "tutor_chunks_select" on public.tutor_chunks for select
  using (private.is_enrolled(course_id) or private.is_course_author(course_id));

-- ─────────────────────────── the WRITE path (definer) ──────────────────────
-- Replace-all for a publication (idempotent): delete the publication's chunks,
-- then insert the provided set. The embed layer guards with a pre-count so the
-- happy path never re-embeds; this replace makes a forced re-run safe too. Each
-- chunk's `embedding` arrives as a JSON STRING ('[...]') cast to vector; tsv is
-- generated; source_tier defaults 'canon'. Service-role only.
create function public.tutor_store_chunks(p_publication_id uuid, p_chunks jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  delete from public.tutor_chunks where publication_id = p_publication_id;
  insert into public.tutor_chunks
    (course_id, publication_id, version, content_hash, lesson_id, block_id,
     slide_id, chunk_ordinal, text, embedding, display_anchor)
  select
    (e->>'course_id')::uuid,
    p_publication_id,
    (e->>'version')::int,
    e->>'content_hash',
    (e->>'lesson_id')::uuid,
    (e->>'block_id')::uuid,
    nullif(e->>'slide_id', ''),
    (e->>'chunk_ordinal')::int,
    e->>'text',
    (e->>'embedding')::vector,
    e->'display_anchor'
  from jsonb_array_elements(p_chunks) e;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.tutor_store_chunks(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.tutor_store_chunks(uuid, jsonb) to service_role;

-- ─────────────────────────── the READ path (definer) ───────────────────────
-- HYBRID retrieval via reciprocal rank fusion (k=60). The vector arm ranks by
-- cosine distance; the lexical arm by ts_rank over websearch_to_tsquery. BOTH
-- arms filter `lesson_id = any(p_lesson_ids)` INSIDE the query (A4-11) — a chunk
-- from an ineligible lesson is never scored. A lexical-only hit (in `lex` but not
-- `vec`) still earns a fused score, so exact terminology pure-vector misses is
-- surfaced (A4-10). The query embedding arrives as a JSON STRING cast to vector.
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
  vector_rank int, lexical_rank int, score double precision
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
         f.vrank, f.lrank, f.score
  from fused f
  join public.tutor_chunks c on c.id = f.id
  order by f.score desc, c.chunk_ordinal asc
  limit p_result_limit;
$$;
revoke all on function public.tutor_retrieve_chunks(uuid, text, text, uuid[], int, int, int) from public, anon, authenticated;
grant execute on function public.tutor_retrieve_chunks(uuid, text, text, uuid[], int, int, int) to service_role;

comment on function public.tutor_retrieve_chunks(uuid, text, text, uuid[], int, int, int) is
  'A4 Wave 2 hybrid retrieval: vector (pgvector cosine, hnsw) + lexical (tsvector) arms fused by reciprocal rank fusion; eligible-lesson filter INSIDE the query. Service-role only (the tutor runtime already gated learner access).';
