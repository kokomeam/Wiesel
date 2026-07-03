-- Course Structure agent — make module/lesson STRUCTURAL ops reviewable + reject-able.
--
-- Today `change_set_items` records only BLOCK before/after snapshots (op on a
-- `block_id`). Structural changes the agent makes (create / rename / move / delete a
-- lesson or module) persist but never appear in the review surface and can't be
-- rejected. The Course Structure agent records those ops as change-set items too, so
-- a structural turn is reviewable + atomically reject-able alongside any content it
-- generates — ONE change-set per logical action.
--
-- Design: EXTEND `change_set_items` rather than add a sibling table, so the single
-- realtime feed, the RLS policy set, `getPendingBlocks`, and the all-or-nothing
-- `rejectChangeSet` keep working over one stream. New columns default to the current
-- block shape, so every existing reader/row is byte-compatible.
--
-- ⚠ Proposed for human review. Apply when ready; regenerate lib/database.types.ts
--   afterwards. Idempotent-guarded so a re-run is a no-op.

-- 1. node_type discriminates a block item from a structural (lesson/module) item.
--    node_id is the lesson/module id for structural items (a plain uuid, NOT a FK —
--    a rejected 'create' deletes the node, and a node deleted out from under an item
--    must not break the row; same rationale as block_id below).
alter table public.change_set_items
  add column if not exists node_type text not null default 'block'
    check (node_type in ('block','lesson','module')),
  add column if not exists node_id uuid;

-- 2. block_id was NOT NULL; a structural item has no block. Make it nullable.
alter table public.change_set_items alter column block_id drop not null;

-- 3. Identity invariant: a 'block' item carries block_id; a structural item carries
--    node_id. (Guarded — re-running CREATEs would error on a duplicate constraint.)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'change_set_items_identity_chk'
  ) then
    alter table public.change_set_items
      add constraint change_set_items_identity_chk check (
        (node_type = 'block' and block_id is not null) or
        (node_type in ('lesson','module') and node_id is not null)
      );
  end if;
end
$$;

create index if not exists change_set_items_node_idx
  on public.change_set_items(node_type, node_id);

-- RLS unchanged: the four change_set_items_* policies gate on course_id, which every
-- structural item still carries. Realtime unchanged: change_set_items is already in
-- the supabase_realtime publication (20260622010000); structural INSERTs flow to the
-- studio's subscription automatically. `op` reuses the existing create|update|delete
-- check (rename / move map to 'update'); before/after jsonb hold the node snapshot.
