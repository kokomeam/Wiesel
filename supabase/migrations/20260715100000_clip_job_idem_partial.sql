-- A failed or cancelled render job must not consume its idempotency key
-- forever: the tool's key is gen:{candidate}:{preset}, so after one failure
-- the replay path returned the dead row and "queue again" was impossible.
-- Uniqueness now spans only live/completed jobs — a retry after failure
-- inserts a fresh job; a duplicate submit while one is in flight (or done)
-- still replays.
drop index if exists public.clip_render_job_idem_idx;
create unique index clip_render_job_idem_idx
  on public.clip_render_job(creator_id, idempotency_key)
  where idempotency_key is not null and status not in ('failed', 'cancelled');
