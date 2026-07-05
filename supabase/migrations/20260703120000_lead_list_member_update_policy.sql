-- lead_list_member was the ONE table missing its UPDATE policy (it shipped
-- with select/insert/delete only). Membership rows are effectively immutable,
-- but the composite lead_list snapshot RESTORE upserts them — and Postgres
-- routes an INSERT … ON CONFLICT DO UPDATE through the UPDATE policies, so a
-- revert of a membership edit failed RLS on any already-present row. Same
-- join-gated predicate as the table's other three policies.

create policy "lead_list_member_update" on public.lead_list_member for update
  using (exists (select 1 from public.lead_list l where l.id = list_id and private.is_course_author(l.course_id)))
  with check (exists (select 1 from public.lead_list l where l.id = list_id and private.is_course_author(l.course_id)));
