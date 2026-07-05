-- WiseSel — Marketing Agent autonomy redesign (gate routing + approval UX).
--
-- Four ADDITIVE changes; every existing marketing_action row remains valid:
--
--   1. marketing_action gains a revert window (`revert_expires_at`) — a staged
--      reversible change is one-click revertable for a fixed window, then the
--      revert closes (fail-closed; enforced at read + write time, no cron) —
--      and an `autonomy_decision` jsonb audit column recording, for every
--      irreversible routing, which mode ran and how each guardrail evaluated.
--   2. marketing_autonomy_settings — one row per course: the autonomy mode
--      (manual | assisted | auto) governing ONLY the irreversible tier, the
--      auto-mode policy (jsonb, empty = inert: NOTHING auto-approves until the
--      creator explicitly opts tools in), and the reversible revert window.
--      NO ROW means the default: assisted, empty policy, 24h window.
--   3. marketing_question — clarifying questions: the SECOND "blocked, waiting
--      on a human" shape beside pending approvals. Raised either by the model
--      (the ask_creator tool) or by the gate itself when an irreversible tool
--      is missing required targeting (source = 'gate' rows carry the tool name
--      + original params so the agent can retry with resolved targeting).
--   4. marketing_segment_send — first/last send per (course, segment): powers
--      the "always manual-review the first send to a new segment" guardrail.
--      Written when a segment-send actually executes (auto OR human-approved).
--
-- The reversibility grades and the gate's role as the single choke point are
-- unchanged — tools that reach real people stay `irreversible`; the modes only
-- decide HOW the human's approval is obtained (per-action card vs. a policy
-- the creator authored in advance). Hard-denied tools (cancel_campaign,
-- send_consent_confirmations, launch_campaign) always require a card.
--
-- Conventions as everywhere: uuid PKs, moddatetime triggers, inline CHECKs,
-- denormalized course_id, RLS via private.is_course_author. No public reads.

create extension if not exists moddatetime schema extensions;

/* ───────────────── marketing_action — window + audit columns ───────────────── */

alter table public.marketing_action
  add column revert_expires_at timestamptz,
  add column autonomy_decision jsonb;

-- Existing staged rows get a window measured from creation. Most are already
-- past it → Revert simply won't be offered (fail-closed); Dismiss still clears
-- them from the activity log.
update public.marketing_action
  set revert_expires_at = created_at + interval '24 hours'
  where status = 'auto_approved' and revert_expires_at is null;

create index marketing_action_revert_idx
  on public.marketing_action(course_id, status, revert_expires_at);

/* ─────────────── marketing_autonomy_settings — one row per course ───────────── */

create table public.marketing_autonomy_settings (
  id                  uuid primary key default gen_random_uuid(),
  course_id           uuid not null unique references public.courses(id) on delete cascade,
  mode                text not null default 'assisted'
                        check (mode in ('manual','assisted','auto')),
  -- AutonomyPolicy (lib/marketing/autonomy.ts): { autoApproveTools: string[],
  -- maxRecipients: number|null, maxBudgetCents: number|null,
  -- allowedHours: {startHour,endHour}|null, firstSendToNewSegmentManual: bool }.
  -- '{}' parses to the EMPTY policy — auto mode is inert until edited.
  policy              jsonb not null default '{}'::jsonb,
  revert_window_hours integer not null default 24
                        check (revert_window_hours between 1 and 720),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger marketing_autonomy_settings_set_updated_at
  before update on public.marketing_autonomy_settings
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.marketing_autonomy_settings enable row level security;
create policy "marketing_autonomy_settings_select" on public.marketing_autonomy_settings
  for select using (private.is_course_author(course_id));
create policy "marketing_autonomy_settings_insert" on public.marketing_autonomy_settings
  for insert with check (private.is_course_author(course_id));
create policy "marketing_autonomy_settings_update" on public.marketing_autonomy_settings
  for update using (private.is_course_author(course_id))
  with check (private.is_course_author(course_id));
create policy "marketing_autonomy_settings_delete" on public.marketing_autonomy_settings
  for delete using (private.is_course_author(course_id));

/* ─────────────────── marketing_question — clarifying questions ──────────────── */

create table public.marketing_question (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  campaign_id     uuid references public.marketing_campaign(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  -- 'model' = the agent called ask_creator; 'gate' = the gate auto-raised it
  -- for an irreversible tool with ambiguous targeting.
  source          text not null check (source in ('model','gate')),
  tool_name       text,
  tool_call_id    text,
  tool_params     jsonb,
  question        text not null,
  -- [{label, value, description}] — 2..5 options, enforced in code (ask.ts Zod).
  options         jsonb not null default '[]'::jsonb,
  status          text not null default 'pending'
                    check (status in ('pending','answered','dismissed')),
  -- {value, label, freeText?} once answered.
  answer          jsonb,
  requested_by    text not null default 'agent' check (requested_by in ('agent','user')),
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index marketing_question_course_status_idx
  on public.marketing_question(course_id, status);
create trigger marketing_question_set_updated_at
  before update on public.marketing_question
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.marketing_question enable row level security;
create policy "marketing_question_select" on public.marketing_question
  for select using (private.is_course_author(course_id));
create policy "marketing_question_insert" on public.marketing_question
  for insert with check (private.is_course_author(course_id));
create policy "marketing_question_update" on public.marketing_question
  for update using (private.is_course_author(course_id))
  with check (private.is_course_author(course_id));
create policy "marketing_question_delete" on public.marketing_question
  for delete using (private.is_course_author(course_id));

/* ─────────────── marketing_segment_send — first-send-per-segment ────────────── */

create table public.marketing_segment_send (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references public.courses(id) on delete cascade,
  campaign_id   uuid references public.marketing_campaign(id) on delete set null,
  segment_key   text not null,
  first_sent_at timestamptz not null default now(),
  last_sent_at  timestamptz not null default now(),
  send_count    integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (course_id, segment_key)
);
create trigger marketing_segment_send_set_updated_at
  before update on public.marketing_segment_send
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.marketing_segment_send enable row level security;
create policy "marketing_segment_send_select" on public.marketing_segment_send
  for select using (private.is_course_author(course_id));
create policy "marketing_segment_send_insert" on public.marketing_segment_send
  for insert with check (private.is_course_author(course_id));
create policy "marketing_segment_send_update" on public.marketing_segment_send
  for update using (private.is_course_author(course_id))
  with check (private.is_course_author(course_id));
create policy "marketing_segment_send_delete" on public.marketing_segment_send
  for delete using (private.is_course_author(course_id));
