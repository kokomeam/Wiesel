-- AI Content Agent — conversation persistence + reviewable change-sets.
--
-- Four author-scoped tables. Every child carries a denormalized `course_id` so
-- RLS authorizes in one hop via private.is_course_author(course_id) — the exact
-- pattern modules/lessons/blocks already use. These are creator-only working
-- artifacts: learners never read agent threads or pending edits, so SELECT is
-- gated by is_course_author too (NOT can_read_course).
--
-- ⚠ Proposed for human review. Apply only after sign-off; regenerate
--   lib/database.types.ts afterwards.

/* ─────────────────────────── conversations ─────────────────────────────
 * One chat thread, scoped to a course and (optionally) the lesson the agent
 * was docked beside. */
create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses(id) on delete cascade,
  lesson_id  uuid references public.lessons(id) on delete set null,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_course_id_idx on public.conversations(course_id);
create index conversations_lesson_id_idx on public.conversations(lesson_id);
create trigger conversations_set_updated_at before update on public.conversations
  for each row execute procedure extensions.moddatetime(updated_at);

/* ───────────────────────────── messages ────────────────────────────────
 * Append-only turn log. `content` jsonb holds the full turn payload:
 *   user      → { "text": ... }
 *   assistant → { "text": ..., "toolCalls": [{ "callId", "name", "arguments" }] }
 *   tool      → { "callId", "name", "output" }
 * The DB is authoritative: history is replayed from here every turn (we never
 * depend on provider-side session state). */
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  course_id       uuid not null references public.courses(id) on delete cascade,
  role            text not null check (role in ('user','assistant','tool')),
  content         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index messages_conversation_id_idx on public.messages(conversation_id);
create index messages_course_id_idx on public.messages(course_id);

/* ──────────────────────────── change_sets ──────────────────────────────
 * One per agent turn that mutated content. Lifecycle: pending → accepted /
 * rejected. The editor highlights blocks belonging to a pending change-set. */
create table public.change_sets (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  lesson_id       uuid references public.lessons(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id      uuid references public.messages(id) on delete set null,
  status          text not null default 'pending' check (status in ('pending','accepted','rejected')),
  summary         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz
);
create index change_sets_course_id_idx on public.change_sets(course_id);
create index change_sets_status_idx on public.change_sets(course_id, status);
create index change_sets_conversation_id_idx on public.change_sets(conversation_id);
create index change_sets_lesson_id_idx on public.change_sets(lesson_id);
create index change_sets_message_id_idx on public.change_sets(message_id);
create trigger change_sets_set_updated_at before update on public.change_sets
  for each row execute procedure extensions.moddatetime(updated_at);

/* ───────────────────────── change_set_items ────────────────────────────
 * Per-block before/after snapshots for one change-set. `block_id` is a plain
 * uuid (NOT a FK) — a 'delete' op's block no longer exists in `blocks`, and a
 * rejected 'create' is removed. Accept clears the pending flag; reject restores
 * `before` (or removes a created block) through the same patch pipeline. */
create table public.change_set_items (
  id            uuid primary key default gen_random_uuid(),
  change_set_id uuid not null references public.change_sets(id) on delete cascade,
  course_id     uuid not null references public.courses(id) on delete cascade,
  block_id      uuid not null,
  -- The block's lesson (plain uuid, not a FK — a 'create' that is later
  -- rejected, or a lesson deleted out from under it, must not break). Needed to
  -- re-add a block when a 'delete' is rejected.
  lesson_id     uuid,
  op            text not null check (op in ('create','update','delete')),
  before        jsonb,
  after         jsonb,
  created_at    timestamptz not null default now()
);
create index change_set_items_change_set_id_idx on public.change_set_items(change_set_id);
create index change_set_items_course_id_idx on public.change_set_items(course_id);
create index change_set_items_block_id_idx on public.change_set_items(block_id);

/* ──────────────────────────────── RLS ──────────────────────────────────
 * Author-only on all four tables (no public/learner access). Split per action
 * so SELECT is governed by a single permissive policy (advisor guidance). */
alter table public.conversations    enable row level security;
alter table public.messages         enable row level security;
alter table public.change_sets      enable row level security;
alter table public.change_set_items enable row level security;

-- conversations
create policy "conversations_select" on public.conversations for select using (private.is_course_author(course_id));
create policy "conversations_insert" on public.conversations for insert with check (private.is_course_author(course_id));
create policy "conversations_update" on public.conversations for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "conversations_delete" on public.conversations for delete using (private.is_course_author(course_id));

-- messages
create policy "messages_select" on public.messages for select using (private.is_course_author(course_id));
create policy "messages_insert" on public.messages for insert with check (private.is_course_author(course_id));
create policy "messages_delete" on public.messages for delete using (private.is_course_author(course_id));

-- change_sets
create policy "change_sets_select" on public.change_sets for select using (private.is_course_author(course_id));
create policy "change_sets_insert" on public.change_sets for insert with check (private.is_course_author(course_id));
create policy "change_sets_update" on public.change_sets for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "change_sets_delete" on public.change_sets for delete using (private.is_course_author(course_id));

-- change_set_items
create policy "change_set_items_select" on public.change_set_items for select using (private.is_course_author(course_id));
create policy "change_set_items_insert" on public.change_set_items for insert with check (private.is_course_author(course_id));
create policy "change_set_items_update" on public.change_set_items for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "change_set_items_delete" on public.change_set_items for delete using (private.is_course_author(course_id));
