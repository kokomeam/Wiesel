-- WiseSel — Marketing Assistant suite (Phase 3 of the roadmap).
--
-- Nine author-scoped tables behind ONE typed tool layer, ONE event stream, ONE
-- governance gate. Every child carries a denormalized `course_id` so RLS
-- authorizes in one hop via private.is_course_author(course_id) — the exact
-- pattern modules/lessons/blocks/conversations already use.
--
-- Two deliberate departures from the course tables (see PRD §A):
--   1) landing_page is PUBLIC-READ when status='published' (the /p/[slug] route).
--   2) subscriber + analytics_event are written by anonymous visitors through a
--      SERVER service-role ingest route (which bypasses RLS); there is no anon
--      INSERT policy — default-deny covers it, and the author keeps full CRUD.
--
-- jsonb payloads: campaign.config · landing_page.sections/theme · sequence.trigger
--   · touch.body · subscriber.consent/attributes · analytics_event.props
--   · marketing_action.params/before_snapshot/target_ref.

create extension if not exists moddatetime schema extensions;

/* ───────────────────────── marketing_campaign ──────────────────────────
 * Top-level container. One per course for MVP (schema allows many). */
create table public.marketing_campaign (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses(id) on delete cascade,
  name       text not null,
  goal       text,
  status     text not null default 'draft' check (status in ('draft','active','paused','archived')),
  config     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index marketing_campaign_course_id_idx on public.marketing_campaign(course_id);
create index marketing_campaign_status_idx on public.marketing_campaign(course_id, status);
create trigger marketing_campaign_set_updated_at before update on public.marketing_campaign
  for each row execute procedure extensions.moddatetime(updated_at);

/* ─────────────────────────── landing_page ──────────────────────────────
 * Slot-filled sales page. `sections` jsonb is an ordered array of typed
 * sections (the AI fills slots; the renderer owns layout). PUBLIC-READ when
 * published — served at /p/[slug]. */
create table public.landing_page (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.marketing_campaign(id) on delete cascade,
  course_id    uuid not null references public.courses(id) on delete cascade,
  slug         text not null unique,
  title        text not null,
  status       text not null default 'draft' check (status in ('draft','published','unpublished')),
  sections     jsonb not null default '[]'::jsonb,
  theme        jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index landing_page_campaign_id_idx on public.landing_page(campaign_id);
create index landing_page_course_id_idx on public.landing_page(course_id);
create index landing_page_status_idx on public.landing_page(status);
create trigger landing_page_set_updated_at before update on public.landing_page
  for each row execute procedure extensions.moddatetime(updated_at);

/* ────────────────────────── email_sequence ─────────────────────────────
 * A named sequence. `kind` selects orchestration: a time-based launch
 * sequence (touches by offset) or an event-triggered followup (`trigger`
 * jsonb names the starting behavioral event). */
create table public.email_sequence (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.marketing_campaign(id) on delete cascade,
  course_id   uuid not null references public.courses(id) on delete cascade,
  name        text not null,
  kind        text not null check (kind in ('time_launch','event_triggered')),
  trigger     jsonb not null default '{}'::jsonb,
  status      text not null default 'draft' check (status in ('draft','active','paused')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index email_sequence_campaign_id_idx on public.email_sequence(campaign_id);
create index email_sequence_course_id_idx on public.email_sequence(course_id);
create index email_sequence_status_idx on public.email_sequence(course_id, status);
create trigger email_sequence_set_updated_at before update on public.email_sequence
  for each row execute procedure extensions.moddatetime(updated_at);

/* ──────────────────────────── email_touch ──────────────────────────────
 * One email in a sequence. Time touches carry `delay_seconds` (offset from
 * enrollment); event touches carry `trigger_event`. `body` jsonb is the
 * slot-filled, React-Email-ready content. */
create table public.email_touch (
  id            uuid primary key default gen_random_uuid(),
  sequence_id   uuid not null references public.email_sequence(id) on delete cascade,
  course_id     uuid not null references public.courses(id) on delete cascade,
  position      integer not null default 0,
  delay_seconds integer,
  trigger_event text,
  subject       text not null,
  preview_text  text,
  body          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index email_touch_sequence_id_idx on public.email_touch(sequence_id);
create index email_touch_course_id_idx on public.email_touch(course_id);
create trigger email_touch_set_updated_at before update on public.email_touch
  for each row execute procedure extensions.moddatetime(updated_at);

/* ──────────────────────────── subscriber ───────────────────────────────
 * Per-creator lead/list row + the lifecycle STATE MACHINE (`status`). Status
 * is a reducer over analytics_event; the column is the materialized current
 * state. Public form submits insert these via the service-role ingest route
 * (RLS default-deny blocks anon; the author keeps full CRUD). */
create table public.subscriber (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references public.marketing_campaign(id) on delete cascade,
  course_id       uuid not null references public.courses(id) on delete cascade,
  email           text not null,
  name            text,
  status          text not null default 'lead'
    check (status in ('lead','subscribed','engaged','enrolled','unsubscribed','bounced')),
  source          text,
  consent         jsonb not null default '{}'::jsonb,
  attributes      jsonb not null default '{}'::jsonb,
  anonymous_id    text,
  unsubscribed_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (campaign_id, email)
);
create index subscriber_campaign_id_idx on public.subscriber(campaign_id);
create index subscriber_course_id_idx on public.subscriber(course_id);
create index subscriber_status_idx on public.subscriber(campaign_id, status);
create index subscriber_anonymous_id_idx on public.subscriber(anonymous_id);
create trigger subscriber_set_updated_at before update on public.subscriber
  for each row execute procedure extensions.moddatetime(updated_at);

/* ───────────────────────── sequence_enrollment ─────────────────────────
 * The state-machine INSTANCE: one subscriber × one sequence. The scheduler
 * advances `current_position`; unique (sequence,subscriber) prevents double
 * enrollment. */
create table public.sequence_enrollment (
  id               uuid primary key default gen_random_uuid(),
  sequence_id      uuid not null references public.email_sequence(id) on delete cascade,
  subscriber_id    uuid not null references public.subscriber(id) on delete cascade,
  course_id        uuid not null references public.courses(id) on delete cascade,
  status           text not null default 'active' check (status in ('active','completed','cancelled')),
  current_position integer not null default 0,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (sequence_id, subscriber_id)
);
create index sequence_enrollment_sequence_id_idx on public.sequence_enrollment(sequence_id);
create index sequence_enrollment_subscriber_id_idx on public.sequence_enrollment(subscriber_id);
create index sequence_enrollment_course_id_idx on public.sequence_enrollment(course_id);
create trigger sequence_enrollment_set_updated_at before update on public.sequence_enrollment
  for each row execute procedure extensions.moddatetime(updated_at);

/* ──────────────────────────── scheduled_send ───────────────────────────
 * The OUTBOX the scheduler polls. A unique (touch_id, subscriber_id) makes
 * ticks IDEMPOTENT — a subscriber is never sent the same sequence touch twice
 * (NULL touch_id = a one-off broadcast, which is gated individually instead).
 * `action_id` links the gate row that authorized the send. */
create table public.scheduled_send (
  id                  uuid primary key default gen_random_uuid(),
  course_id           uuid not null references public.courses(id) on delete cascade,
  sequence_id         uuid references public.email_sequence(id) on delete cascade,
  touch_id            uuid references public.email_touch(id) on delete cascade,
  subscriber_id       uuid not null references public.subscriber(id) on delete cascade,
  scheduled_for       timestamptz not null default now(),
  status              text not null default 'pending'
    check (status in ('pending','awaiting_approval','approved','sent','skipped','failed','cancelled')),
  action_id           uuid,
  provider_message_id text,
  attempts            integer not null default 0,
  error               text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (touch_id, subscriber_id)
);
create index scheduled_send_due_idx on public.scheduled_send(status, scheduled_for);
create index scheduled_send_course_id_idx on public.scheduled_send(course_id);
create index scheduled_send_subscriber_id_idx on public.scheduled_send(subscriber_id);
create index scheduled_send_sequence_id_idx on public.scheduled_send(sequence_id);
create trigger scheduled_send_set_updated_at before update on public.scheduled_send
  for each row execute procedure extensions.moddatetime(updated_at);

/* ──────────────────────────── analytics_event ──────────────────────────
 * THE single event stream. Renders the dashboard AND feeds the agent's
 * observe step AND drives the subscriber reducer. Append-only (created_at
 * only). `anonymous_id` links pre-lead pageviews to a subscriber on convert.
 * Public events insert via the service-role ingest route. */
create table public.analytics_event (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  campaign_id     uuid references public.marketing_campaign(id) on delete set null,
  landing_page_id uuid references public.landing_page(id) on delete set null,
  subscriber_id   uuid references public.subscriber(id) on delete set null,
  anonymous_id    text,
  type            text not null check (type in (
    'page_view','form_submit','free_lesson_capture',
    'email_sent','email_open','email_click','email_bounce','email_unsubscribe',
    'enrollment')),
  source          text,
  props           jsonb not null default '{}'::jsonb,
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index analytics_event_course_time_idx on public.analytics_event(course_id, occurred_at);
create index analytics_event_course_type_idx on public.analytics_event(course_id, type);
create index analytics_event_subscriber_id_idx on public.analytics_event(subscriber_id);
create index analytics_event_landing_page_id_idx on public.analytics_event(landing_page_id);
create index analytics_event_anonymous_id_idx on public.analytics_event(anonymous_id);

/* ──────────────────────────── marketing_action ─────────────────────────
 * The GOVERNANCE GATE ledger + audit + Accept/Reject staging, unified. Every
 * mutating tool call records a row here:
 *   reversible   → executed immediately, before_snapshot stored, REJECT-able.
 *   irreversible → status 'pending' until a human approves; then executed.
 * `target_ref` = { entity, id }; `before_snapshot` = the entity row(s) before
 * a reversible change (null for a create → revert deletes). */
create table public.marketing_action (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.courses(id) on delete cascade,
  campaign_id     uuid references public.marketing_campaign(id) on delete set null,
  tool_name       text not null,
  action_kind     text not null,
  reversibility   text not null check (reversibility in ('reversible','irreversible')),
  status          text not null default 'pending'
    check (status in ('auto_approved','pending','approved','rejected','executed','reverted')),
  params          jsonb not null default '{}'::jsonb,
  before_snapshot jsonb,
  target_ref      jsonb,
  summary         text,
  requested_by    text not null default 'user' check (requested_by in ('agent','user')),
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index marketing_action_course_id_idx on public.marketing_action(course_id);
create index marketing_action_status_idx on public.marketing_action(course_id, status);
create index marketing_action_campaign_id_idx on public.marketing_action(campaign_id);
create trigger marketing_action_set_updated_at before update on public.marketing_action
  for each row execute procedure extensions.moddatetime(updated_at);

/* ──────────────────────────────── RLS ──────────────────────────────────
 * Author-only via private.is_course_author(course_id), split per action.
 * EXCEPTION: landing_page SELECT is also public when published. */
alter table public.marketing_campaign   enable row level security;
alter table public.landing_page         enable row level security;
alter table public.email_sequence       enable row level security;
alter table public.email_touch          enable row level security;
alter table public.subscriber           enable row level security;
alter table public.sequence_enrollment  enable row level security;
alter table public.scheduled_send       enable row level security;
alter table public.analytics_event      enable row level security;
alter table public.marketing_action     enable row level security;

-- marketing_campaign
create policy "marketing_campaign_select" on public.marketing_campaign for select using (private.is_course_author(course_id));
create policy "marketing_campaign_insert" on public.marketing_campaign for insert with check (private.is_course_author(course_id));
create policy "marketing_campaign_update" on public.marketing_campaign for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "marketing_campaign_delete" on public.marketing_campaign for delete using (private.is_course_author(course_id));

-- landing_page (author full CRUD; published rows are world-readable)
create policy "landing_page_select" on public.landing_page for select using (private.is_course_author(course_id) or status = 'published');
create policy "landing_page_insert" on public.landing_page for insert with check (private.is_course_author(course_id));
create policy "landing_page_update" on public.landing_page for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "landing_page_delete" on public.landing_page for delete using (private.is_course_author(course_id));

-- email_sequence
create policy "email_sequence_select" on public.email_sequence for select using (private.is_course_author(course_id));
create policy "email_sequence_insert" on public.email_sequence for insert with check (private.is_course_author(course_id));
create policy "email_sequence_update" on public.email_sequence for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "email_sequence_delete" on public.email_sequence for delete using (private.is_course_author(course_id));

-- email_touch
create policy "email_touch_select" on public.email_touch for select using (private.is_course_author(course_id));
create policy "email_touch_insert" on public.email_touch for insert with check (private.is_course_author(course_id));
create policy "email_touch_update" on public.email_touch for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "email_touch_delete" on public.email_touch for delete using (private.is_course_author(course_id));

-- subscriber (author CRUD; public inserts arrive via service-role ingest)
create policy "subscriber_select" on public.subscriber for select using (private.is_course_author(course_id));
create policy "subscriber_insert" on public.subscriber for insert with check (private.is_course_author(course_id));
create policy "subscriber_update" on public.subscriber for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "subscriber_delete" on public.subscriber for delete using (private.is_course_author(course_id));

-- sequence_enrollment
create policy "sequence_enrollment_select" on public.sequence_enrollment for select using (private.is_course_author(course_id));
create policy "sequence_enrollment_insert" on public.sequence_enrollment for insert with check (private.is_course_author(course_id));
create policy "sequence_enrollment_update" on public.sequence_enrollment for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "sequence_enrollment_delete" on public.sequence_enrollment for delete using (private.is_course_author(course_id));

-- scheduled_send
create policy "scheduled_send_select" on public.scheduled_send for select using (private.is_course_author(course_id));
create policy "scheduled_send_insert" on public.scheduled_send for insert with check (private.is_course_author(course_id));
create policy "scheduled_send_update" on public.scheduled_send for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "scheduled_send_delete" on public.scheduled_send for delete using (private.is_course_author(course_id));

-- analytics_event (author read/manage; public inserts arrive via service-role ingest)
create policy "analytics_event_select" on public.analytics_event for select using (private.is_course_author(course_id));
create policy "analytics_event_insert" on public.analytics_event for insert with check (private.is_course_author(course_id));
create policy "analytics_event_delete" on public.analytics_event for delete using (private.is_course_author(course_id));

-- marketing_action
create policy "marketing_action_select" on public.marketing_action for select using (private.is_course_author(course_id));
create policy "marketing_action_insert" on public.marketing_action for insert with check (private.is_course_author(course_id));
create policy "marketing_action_update" on public.marketing_action for update using (private.is_course_author(course_id)) with check (private.is_course_author(course_id));
create policy "marketing_action_delete" on public.marketing_action for delete using (private.is_course_author(course_id));
