-- WiseSel — PERF-1 Phase C1: the /learn/[slug]/[lessonId] bundle RPC.
--
-- One SECURITY DEFINER round trip replaces the lesson page's wave of nine
-- (progress ×2, quiz attempts, homework history, review_prompt_state,
-- my_slide_feedback, per-media admin reads — diagnosis §A2). The immutable
-- snapshot itself is NOT returned: the page reads it from the publication
-- cache (lib/learn/publicationCache.ts) keyed by publication id, so a warm
-- lesson view = slug-meta resolve + this RPC = 2 data round trips.
--
-- Authorization lives INSIDE the function (never trust client-supplied user
-- ids): v_uid is pinned to (select auth.uid()); the caller must be enrolled
-- (active/completed) in the publication's course OR be its author. Anyone
-- else gets {"access":"denied"} and the page bounces to the landing exactly
-- as the old getLearnerAccess path did. video_assets rows are returned only
-- past that gate AND course-scoped (the definer bypasses RLS — this mirrors
-- the existing admin-client-after-gate pattern in lib/learn/media.ts). The
-- heavy `transcript` column is deliberately EXCLUDED (dead weight — the
-- player only needs transcript_vtt, which it parses into caption cues).
--
-- Payload contract (Zod mirror: lib/learn/lessonState.ts — edit together):
--   access                 {enrolled, enrollment_status, is_author}
--   progress               [{lesson_id, status, pct, last_activity_at}] —
--                          the caller's OWN rows for the whole course
--   lesson_progress_state  progress_state jsonb for p_lesson_id (students
--                          only; null for authors/missing rows)
--   quiz_attempt_block_ids [block_id…] distinct, caller's attempts in course
--   quiz_attempt_counts    {block_id: n} — same rows, counted (the lesson UI
--                          shows "N previous attempts"; ids alone lose that)
--   homework_submissions   latest 20, newest first
--   review_prompt          review_prompt_state(course) — students only
--   slide_feedback         my_slide_feedback(course) — students only
--   video_assets           the learner-player field set for p_video_asset_ids

create function public.learn_lesson_state(
  p_publication_id  uuid,
  p_lesson_id       uuid,
  p_video_asset_ids uuid[] default '{}'
) returns jsonb
language plpgsql security definer stable
set search_path = public as $$
declare
  v_uid        uuid := (select auth.uid());
  v_course_id  uuid;
  v_author_id  uuid;
  v_enr_status text;
  v_enrolled   boolean;
  v_is_author  boolean;
  v_is_student boolean;
begin
  if v_uid is null then
    return null;
  end if;

  select p.course_id into v_course_id
  from public.course_publications p
  where p.id = p_publication_id;
  if v_course_id is null then
    return null;
  end if;

  select c.author_id into v_author_id
  from public.courses c
  where c.id = v_course_id;
  v_is_author := (v_author_id = v_uid);

  select e.status into v_enr_status
  from public.enrollments e
  where e.course_id = v_course_id and e.user_id = v_uid;
  v_enrolled := coalesce(v_enr_status in ('active', 'completed'), false);

  if not v_enrolled and not v_is_author then
    return jsonb_build_object('access', 'denied');
  end if;

  -- Author preview wins over an enrollment (mirrors getLearnerAccess).
  v_is_student := v_enrolled and not v_is_author;

  return jsonb_build_object(
    'access', jsonb_build_object(
      'enrolled', v_enrolled,
      'enrollment_status', v_enr_status,
      'is_author', v_is_author),
    'progress', coalesce((
      select jsonb_agg(jsonb_build_object(
        'lesson_id', lp.lesson_id,
        'status', lp.status,
        'pct', lp.pct,
        'last_activity_at', lp.last_activity_at))
      from public.learn_progress lp
      where lp.user_id = v_uid and lp.course_id = v_course_id
    ), '[]'::jsonb),
    'lesson_progress_state', case when v_is_student then (
      select lp.progress_state
      from public.learn_progress lp
      where lp.user_id = v_uid
        and lp.course_id = v_course_id
        and lp.lesson_id = p_lesson_id
    ) end,
    'quiz_attempt_block_ids', coalesce((
      select jsonb_agg(distinct qa.block_id)
      from public.quiz_attempts qa
      where qa.user_id = v_uid and qa.course_id = v_course_id
    ), '[]'::jsonb),
    'quiz_attempt_counts', coalesce((
      select jsonb_object_agg(t.block_id, t.n)
      from (
        select qa.block_id, count(*)::integer as n
        from public.quiz_attempts qa
        where qa.user_id = v_uid and qa.course_id = v_course_id
        group by qa.block_id
      ) t
    ), '{}'::jsonb),
    'homework_submissions', coalesce((
      select jsonb_agg(h.obj order by h.created_at desc)
      from (
        select hs.created_at, jsonb_build_object(
          'id', hs.id,
          'block_id', hs.block_id,
          'status', hs.status,
          'created_at', hs.created_at,
          'file_paths', to_jsonb(hs.file_paths)) as obj
        from public.homework_submissions hs
        where hs.user_id = v_uid and hs.course_id = v_course_id
        order by hs.created_at desc
        limit 20
      ) h
    ), '[]'::jsonb),
    'review_prompt', case when v_is_student
      then public.review_prompt_state(v_course_id) end,
    'slide_feedback', case when v_is_student
      then public.my_slide_feedback(v_course_id) end,
    'video_assets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', va.id,
        'mux_playback_id', va.mux_playback_id,
        'thumbnail_time', va.thumbnail_time,
        'duration_seconds', va.duration_seconds,
        'mp4_url', va.mp4_url,
        'mp4_status', va.mp4_status,
        'transcript_vtt', va.transcript_vtt))
      from public.video_assets va
      where va.id = any(coalesce(p_video_asset_ids, '{}'::uuid[]))
        and va.course_id = v_course_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.learn_lesson_state(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.learn_lesson_state(uuid, uuid, uuid[]) to authenticated;
