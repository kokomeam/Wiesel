-- TUTOR-1 Amendment A2, Wave 1 — in-flight turn state on tutor_threads.
--
-- A2's resumable streaming needs two nullable text handles on the thread row
-- (the per-(learner, course) conversation row — the directive's `tutor_sessions`
-- does not exist in this schema; deviation noted in the Wave 0 audit §2):
--
--   active_stream_id    — the resume-buffer key for the turn currently in
--                         flight (`wisesel:tutor:{id}` in the stream buffer).
--                         NULL = no turn in flight. [FWD] seam field, no FK.
--   active_response_id  — the provider response id captured the moment
--                         `response.created` arrives (BEFORE the first output
--                         token) — the approved R-4 satisfier for A2-3. The
--                         COMPLETED-turn chain id stays on tutor_turns.
--                         response_id (append-only, immutable); this is only
--                         the in-flight observability/resume handle. NULL when
--                         idle.
--
-- Two columns, not one: the stream id must exist from request start (it keys
-- the buffer before the provider responds); the response id only exists after
-- response.created. Merging them would leave pre-created frames unkeyed
-- (disclosed deviation from the directive's "exactly one column").
--
-- No index: the row is always addressed via the existing unique
-- (user_id, course_id) key — no new query pattern needs one (audit §2).
--
-- ROLLBACK:
--   alter table public.tutor_threads drop column active_response_id;
--   alter table public.tutor_threads drop column active_stream_id;

alter table public.tutor_threads
  add column active_stream_id text,
  add column active_response_id text;

comment on column public.tutor_threads.active_stream_id is
  'A2: resume-buffer key of the in-flight turn (null = idle). [FWD] seam, no FK.';
comment on column public.tutor_threads.active_response_id is
  'A2: provider response id captured at response.created, before first token (null = idle). Completed-turn chain id lives on tutor_turns.response_id.';
