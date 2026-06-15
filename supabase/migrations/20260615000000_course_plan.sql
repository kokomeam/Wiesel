-- Plan step: AI-grounding planning context the studio collects before generating content.
-- Additive, single jsonb column; RLS is inherited from the courses row policies
-- (author full CRUD; public reads only published+public). No new policies, and no
-- course_id (this lives on the courses row itself).
--
-- Applied 2026-06-15 via Supabase MCP (migration name: add_course_plan); mirrored here
-- for the repo record. Security advisors: 0 lints after apply.

alter table public.courses
  add column if not exists plan jsonb not null default '{}'::jsonb;

comment on column public.courses.plan is
  'AI-grounding planning context collected on the studio Plan step: '
  '{ category, outcomes[], prerequisites[], teachingStyle }. '
  'Title, subtitle(description), audience and level live in their own columns.';
