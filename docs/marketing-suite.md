# Marketing Assistant — engineering guide

The Marketing Assistant turns a finished course into a go-to-market engine:
generate a landing page from the syllabus, capture leads, run email lifecycles on
our own scheduler, measure everything through one event stream, and let an agent
operate it all behind a reversibility-graded approval gate.

PRD: `docs/prd/Marketing-Assistant-Creator-Studio-Web.html`. Per-phase detail in
`CHANGELOG.md`.

## The three spines

1. **One typed tool layer** — `lib/marketing/tools/*` (`MarketingTool` = `Tool<P>`
   + `reversibility`). The Generate Kit button, the hub cards, and the agent all
   call **`executeMarketingTool(name, args, ctx)`** → the gate. No second write
   path. Zod params → strict JSON schema via `lib/ai/schema.ts`.
2. **One event stream** — `analytics_event`. Renders the dashboard
   (`lib/marketing/analytics.ts`), feeds the agent's observe step
   (`get_analytics_summary`), and drives the subscriber state machine
   (`lib/marketing/stateMachine.ts`, a pure reducer). No metric is computed twice.
3. **One governance gate** — `lib/marketing/gate.ts` + the `marketing_action`
   ledger. `read` executes; `reversible` executes + snapshots the target + stages
   it Reject-able (atomic restore via `lib/marketing/entities.ts`); `irreversible`
   does NOT execute — it records `pending` and waits for `approveMarketingAction`
   (runs the real effect) or reject (deny). Same gate for the agent and the
   creator's own buttons.

## Layout

| Area | Files |
|---|---|
| Domain model + schemas | `lib/marketing/{types,schemas}.ts` |
| Gate + entity registry | `lib/marketing/{gate,entities}.ts` |
| Persistence (row↔domain) | `lib/marketing/persistence.ts` |
| Tools | `lib/marketing/tools/{read,campaign,landing,analytics,email,index}.ts` |
| Generators (mock-first content) | `lib/marketing/generators.ts`, `lib/marketing/email/templates.ts` |
| Email render | `lib/marketing/email/render.ts` |
| State machine + scheduler | `lib/marketing/{stateMachine,scheduler}.ts` |
| Services (swap seam) | `lib/marketing/services/{types,mock,resend,factory}.ts` |
| Agent | `lib/marketing/agent/{events,prompt,conversation,loop}.ts` |
| Public ingest | `lib/marketing/ingest.ts`, `lib/supabase/admin.ts` |
| Routes | `app/api/marketing/{ingest,agent,scheduler/tick,unsubscribe}/route.ts` |
| Public page | `app/p/[slug]/page.tsx`, `components/marketing-pages/*` |
| Creator UI | `app/(app)/marketing/{page,actions,MarketingHub,analytics,agent}.tsx`, `components/marketing/agent/AgentPanel.tsx` |
| Schema | `supabase/migrations/20260618000000_marketing_assistant.sql` (9 tables) |

## Data model (9 tables, all author-scoped via `private.is_course_author(course_id)`)

`marketing_campaign` · `landing_page` (public-read when `published`) ·
`email_sequence` · `email_touch` · `subscriber` (lifecycle state) ·
`sequence_enrollment` · `scheduled_send` (outbox; unique `(touch_id, subscriber_id)`
= idempotency) · `analytics_event` (the single stream) · `marketing_action`
(gate ledger). Public lead/analytics writes go through the service-role ingest
route, not anon RLS.

**Account tier (Slice 4):** `audience_contact` (`(author_id,email)` unique) is the
creator's master mailing list — one person across all their courses; `subscriber`
+ `analytics_event` carry `contact_id` so events roll up to a person AND a course.
Per-course funnel state stays on `subscriber`; distinct-audience + account funnel
come from `getAccountSummary`. `/marketing/overview` = account view; `/marketing`
(+ `?course=`) = per-course hub with a picker. Global unsubscribe suppresses a
person across every course (`globalUnsubscribe`).

## Environment

| Var | Needed for | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | everything | existing |
| `OPENAI_API_KEY` | the agent (real) | existing; mock client used in tests |
| `SUPABASE_SERVICE_ROLE_KEY` | public ingest + scheduler tick | server-only; without it the ingest/tick routes 503 and run in "author-only" mode |
| `RESEND_API_KEY` / `RESEND_FROM` | real email send (Phase 5) | absent → mock provider (whole engine still runs) |
| `CRON_SECRET` | securing the tick route | optional |
| `NEXT_PUBLIC_SITE_URL` | absolute unsubscribe links | optional |

## Mock → real swap

Tools depend on the `EmailProvider` interface, never the SDK. `createEmailProvider()`
returns `ResendEmailProvider` when `RESEND_API_KEY` is set, the deterministic mock
otherwise. The mock returns simulated open/click engagement so the funnel + the
agent's observe step have data before Resend exists. The scheduler is the same
code in both modes — only the trigger differs (manual POST in dev, Vercel Cron /
external cron in prod).

## Verify (all self-provision a throwaway `*@example.com` user vs. live Supabase)

| Script | Covers |
|---|---|
| `npm run verify:marketing` | the gate (37) — reversible stage+reject byte-for-byte, irreversible pend→approve/deny, RLS |
| `npm run verify:marketing:flow` | Phase 1 e2e (13) — generate→publish→public-read + lead ingest (ingest needs `SUPABASE_SERVICE_ROLE_KEY`) |
| `npm run verify:marketing:analytics` | Phase 2 (12) — funnel aggregation + observe tools |
| `npm run verify:marketing:email` | Phase 3 (31) — state machine, activate→tick→advance, suppression, event triggers, broadcast |
| `npm run verify:marketing:agent` | Phase 4 (18) — observe→act→gate pause/approve, via the mock model client |
| `npm run verify:marketing:landing-edit` | Slice 3 (11) — design tokens + section variants + content edits stage & reject; agent edit path |
| `npm run verify:marketing:account` | Slice 4 (10) — one contact across courses, account aggregation, global unsubscribe cascade (needs the service key) |
| `npm run verify:marketing:sequences` | Slice 5 (10) — Email & sequences overview: per-touch sent/queued, recipients, email renders |
| `npm run verify:marketing:swap` | Phase 5 (7) — env-gated provider selection, zero contract change |

Full suite (2026-06-22): **157** checks green.

**Seeing the emails:** `/marketing/sequences` lists every sequence + schedule + per-touch sent/queued; `/marketing/sequences/[id]` renders each email exactly as it sends (same `renderEmailHtml` as Resend) + the recipients (who's on which email).

## Subscriber lifecycle & scheduling — in plain language

A **subscriber** moves through stages, and the stage is *derived from events*, never
set by hand (`lib/marketing/stateMachine.ts`):

1. **lead** — someone submitted the landing-page form (or you seeded one). Event:
   `form_submit`.
2. **subscribed** — they've been sent at least one email. Event: `email_sent`.
3. **engaged** — they opened or clicked. Events: `email_open` / `email_click`.
4. **enrolled** — they bought/joined the course. Event: `enrollment`.
5. **unsubscribed / bounced** — terminal; no further sends (suppressed).

How sends happen (our scheduler, not the provider's):

- You **activate** a sequence (approval-gated). For a timed launch that **enrolls**
  current subscribers and writes the first due row into the **outbox**
  (`scheduled_send`), at `enrolled_at + touch.delay`.
- The **scheduler tick** (`runSchedulerTick`) claims due rows, sends via the
  provider (mock today), writes `email_sent` (+ deterministic mock `open`/`click`),
  advances the subscriber's stage, and schedules the **next** touch — or completes
  the enrollment. A unique `(touch_id, subscriber_id)` makes ticks idempotent.
- An **event-triggered** followup enrolls a subscriber when a matching behavioral
  event lands (e.g. `page_view`), then schedules its touches the same way.
- **Unsubscribe** flips the subscriber terminal and cancels their pending sends.

**See & test it (no real email):** open **/marketing/audience** — each subscriber's
stage, their sequence position, and the next scheduled send. Use the **test
controls** to seed a lead and **advance the scheduler ±days** (passes a future
`nowMs` so every due send fires), then refresh to watch the stage move.

## Known follow-ups

- Resend **webhooks** → feed real `email_open`/`email_click`/`email_bounce` into the
  same `analytics_event` stream (the mock simulates these today).
- Agent **auto-resume** after an approval (today: approve runs the action; the
  creator sends another message to continue the agent).
- Signed unsubscribe tokens (today: subscriber id).
- Pageview **dedup** + anonymous→subscriber linking hardening (Phase 2 baseline).
- Per-creator sending domains / OAuth (out of v1 scope).
