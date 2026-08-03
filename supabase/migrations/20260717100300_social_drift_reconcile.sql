-- PERF-1 C3 (4/4) — reconcile live-DB schema drift on social_post
-- (docs/perf/PERF-1_diagnosis.md §A2 delta + checkpoint item 5).
--
-- The live database has social_post.regenerated_from_post_id (uuid, self-FK →
-- social_post.id ON DELETE SET NULL) that exists in NO migration — it was
-- added out-of-band during the Social Post Generator wave. This file makes the
-- migration set authoritative again:
--   • column:     ADD COLUMN IF NOT EXISTS (no-op live, additive on replay)
--   • constraint: added only when NO foreign key already covers the column —
--     matched by column, not by name, so it no-ops live regardless of what
--     the out-of-band constraint was called
--   • index:      the FK cover the advisors flagged (self-referential
--     SET NULL: each parent delete otherwise seq-scans social_post)

alter table public.social_post
  add column if not exists regenerated_from_post_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.social_post'::regclass
      and con.contype = 'f'
      and att.attname = 'regenerated_from_post_id'
  ) then
    alter table public.social_post
      add constraint social_post_regenerated_from_post_id_fkey
      foreign key (regenerated_from_post_id)
      references public.social_post(id) on delete set null;
  end if;
end $$;

create index if not exists social_post_regenerated_from_post_id_idx
  on public.social_post(regenerated_from_post_id);
