# Marketing Assistant — engineering guide

The Marketing Assistant turns a finished course into a go-to-market engine:
generate a landing page from the syllabus, capture leads, run email lifecycles on
our own scheduler, measure everything through one event stream, and let an agent
operate it all behind a reversibility-graded approval gate.

The **Autonomous Email Campaign layer** (2026-07-02) builds the campaign-centric
product on those spines: goal-driven sequence **blueprints**, a mechanical **copy
quality rubric**, the **Campaign Brief + voice profile** grounding stack,
consent-first **lead lists with double opt-in**, **click attribution** on signed
links, **hard/soft bounce** taxonomy, **guardrail auto-pause + a per-creator send
ramp**, **send windows**, MPP-honest analytics, and the full campaign lifecycle
state machine (draft → … → completed) behind the same gate.

PRD: `docs/prd/Autonomous-Email-Marketing-Agent-Creator-Studio-Web.html` (and the
original `Marketing-Assistant-Creator-Studio-Web.html`). Per-phase detail in
`CHANGELOG.md`.

## The three spines

1. **One typed tool layer** — `lib/marketing/tools/*` (`MarketingTool` = `Tool<P>`
   + `reversibility`). The Generate Kit button, the hub cards, the campaign
   builder, and the agent all call **`executeMarketingTool(name, args, ctx)`** →
   the gate. No second write path. Zod params → strict JSON schema via
   `lib/ai/schema.ts`. 56 tools: 17 read / 28 reversible / 10 irreversible / 1
   interaction (`ask_creator`, the clarifying-question tool the gate resolves).
   The reversible tier includes the **audience membership tools**
   (`build_audience_list` / `add_leads_to_list` / `remove_leads_from_list`) —
   existing contacts → mailable lists in one step, sends nothing, exact
   membership revert (the `lead_list` snapshotter is composite: row + members).
2. **One event stream** — `analytics_event`. Renders the dashboard
   (`lib/marketing/analytics.ts`), feeds the agent's observe step
   (`get_analytics_summary`), drives the subscriber state machine
   (`lib/marketing/stateMachine.ts`, a pure reducer), computes the **engagement
   score** and **behavioral segments** at read time (`lib/marketing/segments.ts`),
   and powers **last-click enrollment attribution**
   (`lib/marketing/attribution.ts`). No metric is computed twice; no score is
   stored where it could drift.
3. **One governance gate** — `lib/marketing/gate.ts` + the `marketing_action`
   ledger. `read` executes; `reversible` executes + snapshots the target and
   lands as a **quiet, dismissible activity-log entry with a one-click Revert**
   for a configurable window (default 24h; atomic restore via
   `lib/marketing/entities.ts`; refused after expiry — never a blocking card,
   in any mode); `irreversible` is routed by the **autonomy engine**
   (`lib/marketing/autonomy.ts` — PURE, deterministic, policy-in-code):
   hard-denied tools (`launch_campaign`, `cancel_campaign`,
   `send_consent_confirmations`) always produce one approval card; `manual`
   always cards; `assisted` (default) cards but raises a **clarifying
   question** first when targeting is ambiguous and auto-logs owner-addressed
   test emails; `auto` executes ONLY on a clean match against the creator's
   explicit per-course policy (allowlist + recipient cap + hours +
   first-send-to-new-segment), with the full guardrail audit persisted as
   `autonomy_decision`. Approval is ONE card (inline preview · Approve &
   effect / Edit / Reject — `components/marketing/ApprovalCard.tsx`) with an
   atomic pending→approved claim (double-clicks see "already resolved").
   Same gate for the agent and the creator's own buttons. Resolving an
   **agent-requested** blocker (approve / deny / question answered)
   auto-resumes the agent once (`lib/marketing/agent/resume.ts`). Full detail:
   `docs/marketing-autonomy.md`.

## The campaign layer — what each module owns

| Module | Owns |
|---|---|
| `lib/marketing/blueprints.ts` | Per-goal sequence blueprints (6 goals; launch = 5 default, 4–7 range; stage → copy framework + day offset; `promote_discount` requires a REAL deadline — fake-scarcity rule) |
| `lib/marketing/quality.ts` | The copy quality rubric — mechanical, deterministic scoring (subject/preview/CTA discipline, 120–250 words, grade-8 readability, concrete-course-detail requirement, spam lint). **Advisory only — never blocks.** |
| `lib/marketing/mergeVars.ts` | The 6-variable merge catalog (`firstName`… `offerDeadline`), mandatory-fallback policy, send-time rendering, and the blocking missing-fallback compliance check |
| `lib/marketing/tokens.ts` | HMAC-signed link tokens — ONE mechanism for click redirects, unsubscribe, and consent-confirm links (`MARKETING_TOKEN_SECRET`) |
| `lib/marketing/attribution.ts` | Attributed/unattributed click recording + 7-day last-click enrollment attribution (`recordEnrollmentEvent` is the future checkout webhook's seam) |
| `lib/marketing/segments.ts` | Fixed behavioral segments (pure queries; open-based ones carry the MPP caveat), read-time engagement score (opens×1 + clicks×3, 30-day half-life), lead profile |
| `lib/marketing/guardrails.ts` | Auto-pause thresholds (hard-bounce >2%, complaint >0.1%, unsub >1% — evaluated at ≥50 sends only) + the per-creator daily ramp (200/500/2,000 by account age; held sends stay queued, never dropped) |
| `lib/marketing/consent.ts` | The 30-day pending-consent lapse sweep (runs at each scheduler tick) |
| `lib/marketing/language.ts` | Course-language detection (script-based) + brief override + localized footer strings (8 locales, English fallback) |
| `lib/marketing/campaignLifecycle.ts` | The launch checklist PREDICATE + approved-audience snapshot |
| `lib/marketing/email/llmGenerate.ts` | LLM-grounded sequence copy (course + brief + voice profile + accept/reject ledger signal → structured output; falls back to the deterministic blueprint templates when no model) |
| `lib/marketing/tools/campaignLifecycle.ts` | list/brief/approve-step/approve-campaign/launch/cancel/pause/resume/checklist/analyst tools |
| `lib/marketing/tools/compliance.ts` | `review_campaign_compliance` — blocking findings (consent, sender+mailing address, CTA resolution, merge-var fallbacks, fake urgency/guaranteed outcomes) + advisory (quality scores, tone, cadence) |
| `lib/marketing/tools/leads.ts` | Lead lists, consent-gated import (exact confirmation text required), segments/profile reads, `send_consent_confirmation` (irreversible, rate-limited once per contact) |
| `lib/marketing/tools/senderIdentity.ts` | Sender identity CRUD (mailing address REQUIRED — footer law), campaign attachment, sending schedule / send window |
| `lib/marketing/tools/voice.ts` | Creator-level voice profile (get/update) + the accepted/rejected-edit ledger signal |

**Campaign lifecycle:** `draft → generated → in_review → approved → active →
completed` (+ `paused` / `cancelled` / `failed`). Approve and launch are the two
human gates; editing an approved step drops it (and the campaign) back to review
— enforced inside `write_email_touch` itself, so no write path can bypass it.
`launch_campaign` snapshots the eligible audience onto
`config.approvedAudienceIds` — later opt-ins are NOT auto-added.

**Scheduler additions** (`lib/marketing/scheduler.ts`): sends render merge vars +
wrap CTAs in signed click links at send time (mock and Resend byte-identical);
paused sequences are never processed; due-but-outside-window sends roll to the
next window; per-creator ramp holds (never drops) over-cap sends; soft bounces
retry 3× with 30m/2h/8h backoff then escalate to hard; guardrails are evaluated
per campaign per tick and auto-pause with a `campaign_auto_paused` event.

## Layout

| Area | Files |
|---|---|
| Domain model + schemas | `lib/marketing/{types,schemas}.ts` |
| Gate + entity registry | `lib/marketing/{gate,entities}.ts` |
| Autonomy engine + settings IO | `lib/marketing/{autonomy,autonomyStore}.ts` (pure policy evaluation / settings + segment-send-history) |
| Clarifying questions | `lib/marketing/questions.ts` + `lib/marketing/tools/ask.ts` (`ask_creator`) |
| Persistence (row↔domain) | `lib/marketing/persistence.ts` |
| Tools | `lib/marketing/tools/{read,campaign,campaignLifecycle,compliance,leads,senderIdentity,voice,landing,analytics,email,ask,index}.ts` |
| Campaign layer | `lib/marketing/{blueprints,quality,mergeVars,tokens,attribution,segments,guardrails,consent,language,campaignLifecycle}.ts` |
| Generators (deterministic + LLM) | `lib/marketing/generators.ts`, `lib/marketing/email/{templates,llmGenerate}.ts` |
| Email render | `lib/marketing/email/render.ts` (localized compliant footer) |
| State machine + scheduler | `lib/marketing/{stateMachine,scheduler}.ts` |
| Services (swap seam) | `lib/marketing/services/{types,mock,resend,factory}.ts` |
| Agent | `lib/marketing/agent/{events,prompt,conversation,loop,resume}.ts` |
| Public ingest | `lib/marketing/ingest.ts`, `lib/supabase/admin.ts` |
| Routes | `app/api/marketing/{ingest,agent,scheduler/tick,unsubscribe,click,consent-confirm,webhooks/resend}/route.ts` |
| Public page | `app/p/[slug]/page.tsx`, `components/marketing-pages/*` |
| Creator UI | `app/(app)/marketing/{layout,page,actions,campaignActions,MarketingHub,analytics,agent,email/*,leads/*,audience/*}.tsx`, `components/marketing/agent/{AgentPanel,AgentDock}.tsx` (+ `lib/marketing/agentDockStore.ts`), `components/marketing/{ApprovalCard,QuestionCard,ActivityLogEntry,AutonomySettings,ListBuilder}.tsx` |
| Schema | `supabase/migrations/{20260618000000_marketing_assistant,20260622000000_marketing_account_tier,20260702000000_email_campaign_agent,20260703000000_marketing_autonomy}.sql` |

## Data model (17 tables, author-scoped via `private.is_course_author(course_id)` unless noted)

Original nine: `marketing_campaign` (now with the full lifecycle status,
`compliance_status/report`, `approved_at/by`, `sender_identity_id`,
`lead_list_id`; `config` jsonb carries `blueprintKey` / `brief` / `sendWindow` /
`approvedAudienceIds` / `autoPauseReason`) · `landing_page` (public-read when
`published`) · `email_sequence` · `email_touch` (+ `stage_name`, `purpose`,
`ai_rationale`, `personalization_variables`, per-step `approval_status`,
`compliance_warnings`, `quality_score`) · `subscriber` (+ `consent_status`
confirmed/pending/lapsed + `consent_requested_at`) · `sequence_enrollment` ·
`scheduled_send` (+ `bounce_type`, `soft_bounce_count`; unique
`(touch_id, subscriber_id)` = idempotency) · `analytics_event` (the single
stream; new types: `email_delivered`, `spam_complaint`, `consent_confirmed`,
`campaign_auto_paused`) · `marketing_action` (gate ledger; + `revert_expires_at`
— the reversible revert window — and `autonomy_decision` — the per-routing
guardrail audit).

Campaign layer adds: `lead_list` + `lead_list_member` (named consent-gated
audiences; totals/eligible always computed at read time) · `sender_identity`
(from/reply-to + REQUIRED `mailing_address`) · `follow_up_rule` (first-class
approved rules; click-first trigger defaults) · `voice_profile` (creator-scoped,
`author_id = auth.uid()` RLS, like `audience_contact`).

Autonomy layer adds: `marketing_autonomy_settings` (one row per course: mode
manual/assisted/auto, the auto policy jsonb — empty = inert — and
`revert_window_hours`; no row = assisted defaults) · `marketing_question`
(clarifying questions, model- or gate-raised; gate rows carry
`tool_name`/`tool_params`/`tool_call_id` for the retry) ·
`marketing_segment_send` (first/last send per course + segment key — powers the
first-send-to-new-segment guardrail).

**Account tier (Slice 4):** `audience_contact` (`(author_id,email)` unique) is the
creator's master mailing list — one person across all their courses; `subscriber`
+ `analytics_event` carry `contact_id` so events roll up to a person AND a course.
**Unsubscribe is creator-wide** (opt-out attaches to the sender, not the product):
`globalUnsubscribe` suppresses the contact across every course.

## Environment

| Var | Needed for | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | everything | existing |
| `OPENAI_API_KEY` | the agent + LLM-grounded sequence copy | absent → deterministic blueprint templates (everything still works) |
| `SUPABASE_SERVICE_ROLE_KEY` | public ingest + scheduler tick + click/unsub/consent routes | server-only; without it those routes 503 and the suite runs "author-only" |
| `RESEND_API_KEY` / `RESEND_FROM` | real email send | absent → mock provider (whole engine still runs) |
| `RESEND_WEBHOOK_SECRET` | the Resend delivery webhook (`whsec_…`) | absent → the webhook route 503s (never processes unverified events) |
| `MARKETING_TOKEN_SECRET` | signing click/unsubscribe/consent links | falls back to an insecure dev value with a console warning; REQUIRED before real sends |
| `CRON_SECRET` | securing the tick route | optional |
| `NEXT_PUBLIC_SITE_URL` | absolute link URLs in emails | required for real sends (links resolve against it) |

## Mock → real swap

Tools depend on the `EmailProvider` interface, never the SDK. `createEmailProvider()`
returns `ResendEmailProvider` when `RESEND_API_KEY` is set, the deterministic mock
otherwise. The mock returns simulated open/click engagement — and **address-
triggered bounces** (an address containing `hard-bounce` / `soft-bounce`
deterministically bounces, the pattern real ESP sandboxes use) — so the funnel,
the bounce taxonomy, and the agent's observe step all run before Resend exists.
In real mode, delivery/open/click/bounce/complaint events arrive via the
**Resend webhook** (`app/api/marketing/webhooks/resend`, Svix-signature-verified,
duplicate-safe) into the same stream. The scheduler is the same code in both
modes — only the trigger differs (manual POST in dev, cron in prod). The same
ModelClient seam gives sequence generation real LLM copy when `OPENAI_API_KEY`
is set and blueprint templates otherwise.

## Verify (all self-provision a throwaway `*@example.com` user vs. live Supabase)

| Script | Covers |
|---|---|
| `npm run verify:marketing` | the gate (37) — reversible stage+reject byte-for-byte, irreversible pend→approve/deny, RLS |
| `npm run verify:marketing:flow` | Phase 1 e2e (18) — generate→publish→public-read + lead ingest (ingest needs `SUPABASE_SERVICE_ROLE_KEY`) |
| `npm run verify:marketing:analytics` | Phase 2 (13) — funnel aggregation + observe tools + click-per-delivered + MPP caveat |
| `npm run verify:marketing:email` | Phase 3 (34) — state machine, activate→tick→advance, suppression, event triggers, broadcast |
| `npm run verify:marketing:agent` | Phase 4 (22) — observe→act→gate pause/approve via the mock model client; `agent_blocked` for approvals AND `ask_creator` questions (one pause shape) |
| `npm run verify:marketing:landing-edit` | Slice 3 (11) — design tokens + section variants + content edits stage & reject; agent edit path |
| `npm run verify:marketing:account` | Slice 4 (10) — one contact across courses, account aggregation, global unsubscribe cascade (needs the service key) |
| `npm run verify:marketing:sequences` | Slice 5 (10) — Email & sequences overview: per-touch sent/queued, recipients, email renders |
| `npm run verify:marketing:swap` | Phase 5 (7) — env-gated provider selection, zero contract change |
| `npm run verify:marketing:campaign` | **The campaign layer (112)** — blueprints, quality rubric, merge vars, signed tokens, localization, consent gate + double opt-in + lapse, fake-scarcity guard, compliance blocking vs advisory, edit-after-approval reset, launch checklist + audience snapshot, send windows incl. `sendWindowState`/`sendTimingSentence` + delivery-timing summaries on launch/enroll/activate, hard/soft bounce + escalation, click attribution + segments + engagement score + lead profile, pause/resume/completion, guardrail small-sample protection + ramp, voice profile revert, owner test-send auto-log |
| `npm run verify:marketing:autonomy` | **The autonomy invariants (93)** — every non-negotiable pinned: unknown-tool fail-closed + registry drift guard, hard-deny × every mode × every policy, deny-never-executes, each auto-mode guardrail failing ALONE blocks (pure permutations + live ladder), reversible never pends in any mode, revert window (stamp/refuse/dismiss), governance language + the END-OF-RUN wrap-up contract, owner/foreign test-email routing, gate + model questions through one pause shape, answer idempotency, resume-in-same-conversation, approve double-click race, segment history from both approval paths |
| `npm run verify:marketing:lists` | **Audience list building (31)** — filter semantics (consent × stage, suppressed always excluded), consent-confirmed-at-birth lists, zero-match fail-loud, idempotent adds, unknown-id filtering, BYTE-FOR-BYTE membership revert (composite lead_list snapshot), the import-revert regression fix, legacy row-only snapshot back-compat, staged-under-auto, the agent driving build_audience_list, and the "__other__" free-text answer messages |

Full suite (2026-07-04): **398** checks green.

**Seeing the emails:** `/marketing/email` → the campaign list + builder (step
cards, compliance, launch checklist, embedded assistant); `/marketing/leads` →
lists, consent-gated import, per-lead profiles; `/marketing/sequences/[id]`
renders each email exactly as it sends (same `renderEmailHtml` as Resend).

## Subscriber lifecycle & scheduling — in plain language

A **subscriber** moves through stages, and the stage is *derived from events*, never
set by hand (`lib/marketing/stateMachine.ts`):

1. **lead** — someone submitted the landing-page form (or was imported). Event:
   `form_submit`. Imports also carry a **consent status**: form signups are
   `confirmed` at capture (the on-page consent line IS the confirmation); manual
   imports are `pending` until the contact clicks a one-time opt-in email
   (double opt-in), and `lapse` after 30 days if they never do. Only `confirmed`
   contacts are ever eligible for a send.
2. **subscribed** — they've been sent at least one email. Event: `email_sent`.
3. **engaged** — they opened or clicked. Events: `email_open` / `email_click`.
4. **enrolled** — they bought/joined the course. Event: `enrollment` (carries
   7-day last-click attribution back to the campaign + touch).
5. **unsubscribed / bounced** — terminal; no further sends (suppressed).
   Unsubscribe is **creator-wide**; a hard bounce (or 3 soft bounces) suppresses.

How sends happen (our scheduler, not the provider's):

- **Launching a campaign** (approval-gated) snapshots the eligible audience,
  activates the sequence, **enrolls** them, and writes the first due row into
  the **outbox** (`scheduled_send`), at `enrolled_at + touch.delay`.
- The **scheduler tick** (`runSchedulerTick`) claims due rows *inside the send
  window and under the creator's ramp cap*, renders merge variables + signed
  links, sends via the provider, writes `email_sent` (+ mock engagement or real
  webhook events), advances the subscriber's stage, and schedules the **next**
  touch — or completes the enrollment (and the campaign, when the last one
  finishes). A unique `(touch_id, subscriber_id)` makes ticks idempotent.
- An **event-triggered** followup enrolls a subscriber when a matching behavioral
  event lands (e.g. `page_view`), then schedules its touches the same way.
- **Unsubscribe** flips the subscriber terminal (creator-wide) and cancels their
  pending sends. Guardrail trips **auto-pause** the campaign for human review.

**See & test it (no real email):** open **/marketing/audience** — each subscriber's
stage, their sequence position, and the next scheduled send. Use the **test
controls** to seed a lead and **advance the scheduler ±days** (passes a future
`nowMs` so every due send fires), then refresh to watch the stage move.

## Known follow-ups

- Per-recipient **send-time optimization** on the `sendWindow` seam (Klaviyo
  Smart-Send-Time pattern) — out of MVP by design.
- Plain-English → segment mapping (Klaviyo Segments-AI style); MVP ships the
  fixed segment set.
- A per-course **preference center** (unsubscribe is deliberately creator-wide
  today).
- Real **A/B testing** (variants are selection-only by design), advanced
  segmentation, per-creator sending domains / OAuth.
- Pageview **dedup** + anonymous→subscriber linking hardening (Phase 2 baseline).
- Wire `recordEnrollmentEvent` to real checkout when Stripe lands (the
  attribution seam is ready).
