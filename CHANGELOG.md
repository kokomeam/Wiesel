# Changelog — Course Studio editor upgrade

All notable editor changes, newest first. Each batch is individually
verifiable; verification = `npm run build` + `npm run lint` + a temporary
Playwright script driving the real UI through its `data-ai-*` attributes.
Part C = the approved AUDIT.md items (all except #1 persistence — Supabase
is next — #5 multi-selection styling, and #8 canvas a11y).

## Marketing — delivery-timing honesty (send-window visibility + agent wrap-ups), 2026-07-04

From live usage: a creator launched a campaign at 23:41 local, the agent said
"4 subscriber(s) will begin receiving the sequence", and nothing arrived — the
sends were correctly HELD by the default send window (9–11 UTC weekdays,
Amendment 12) but NOTHING said so, and the agent ended its run without any
summary of what had happened or what would happen next.

- **Pure window helpers** (`lib/marketing/scheduler.ts`): `sendWindowState`
  (open now? when does it next open — 15-min stepping, weekend-aware, 14-day
  horizon), `describeSendWindow` ("09:00–11:00 UTC, weekdays"),
  `formatWindowOpening`, and `sendTimingSentence` — the ONE sentence that keeps
  everyone honest ("Queued emails are HELD until the send window opens (…);
  next opening Fri, Jul 4, 09:00 (UTC)."). `withinSendWindow` exported; the
  private DEFAULT_WINDOW now aliases the types' `DEFAULT_SEND_WINDOW`.
- **Every summary that enqueues sends states the timing**: `launch_campaign`
  (preview AND executed — so the approval card warns BEFORE the creator
  approves; executed `data` carries `nextWindowOpensAt`), `activate_sequence`,
  `enroll_segment_in_sequence`.
- **Builder Delivery card** (`CampaignBuilder.tsx` + server-computed
  `sendWindowInfo` in `page.tsx`): a due-but-held state now renders an amber
  callout — "N queued emails are due but held until your send window opens
  (09:00–11:00 UTC, weekdays). Next opening: {local time} your time." The old
  copy hardcoded "default 9–11am weekdays" with no timezone (misleading for a
  non-UTC creator) and never said sends were being held. Window state is
  computed with the injected clock — react-hooks/purity forbids `Date.now()`
  in render even in server components.
- **Agent END-OF-RUN wrap-up contract** (`agent/prompt.ts`): never stop
  silently after tool calls — close every run with (1) what you did, (2)
  what's true now, (3) what happens next and WHEN ("Enqueued is NOT sent"),
  (4) what awaits the creator. The approve-resume message
  (`agent/resume.ts`) now explicitly demands that wrap-up with timing.
- **Tests**: campaign suite 101 → 112 (pure window-state/timing-sentence
  matrix incl. weekend skip + degenerate window; launch preview/executed
  summaries + `nextWindowOpensAt` asserted at the fixed clock); autonomy
  92 → 93 (prompt wrap-up directive). Full marketing set: **398 checks
  green**; build + lint clean.

## Fix — OpenAI transport proxy (agent "Request timed out."), 2026-07-03

Every real-model agent call (marketing agent AND studio content agent) died at
`{"tag":"openai_error","message":"Request timed out."}` after ~85–89s. Root
cause (verified with `curl` + the smoke test): on this machine
`api.openai.com` is reachable ONLY through the local Clash proxy, and the
OpenAI SDK's bundled undici fetch IGNORES `HTTPS_PROXY` — it connected
directly and hung until the transport deadline. This repo copy never received
the proxy shim the sibling App repo already had; ported it:

- `lib/ai/providers/openai.ts`: `resolveProxyUrl()` (`OPENAI_PROXY_URL` wins,
  else `HTTPS_PROXY`/`HTTP_PROXY`) + `makeProxyTransport()` — undici's own
  `fetch` + a `ProxyAgent` dispatcher with socket-level timeouts, passed
  TOGETHER and scoped to the OpenAI client only (global dispatcher untouched;
  Supabase and all other fetch stay direct). No proxy env ⇒ direct connection
  exactly as before (production unaffected). undici loaded via non-literal
  `createRequire` (devDependency; the bundler never resolves it). An
  `openai_client_config` log line states the ACTUAL transport per client.
- `scripts/smoke-openai.ts` + `npm run smoke:openai`: Phase A reproduces the
  direct-connection failure, Phase C proves the provider's scoped proxy works
  while the global dispatcher stays direct. Verified: A1 direct fetch failed
  (dead), C1 wrapper call answered in 2.8s through Clash.

## Marketing — audience list building + agent dock + freeform answers, 2026-07-03

Follow-up QoL pass from live usage: the agent (and the UI) couldn't put
EXISTING contacts on a list, the chat was buried in a card grid, and question
cards had no type-your-own-answer path.

- **Audience tools** (all reversible, all send nothing): `build_audience_list`
  (create + fill from existing contacts in one step — consent × funnel-stage
  filter, suppressed always excluded, confirmed-only lists are
  consent-confirmed at birth), `add_leads_to_list` (filter or explicit ids,
  already-members skipped), `remove_leads_from_list`. The `lead_list`
  snapshotter is now COMPOSITE (row + membership) — reverting any membership
  edit restores it byte-for-byte, fixing the silent `import_leads` revert gap;
  legacy bare-row snapshots still restore. Found + fixed along the way:
  `lead_list_member` had no UPDATE policy, so restore's upsert failed RLS
  (migration `20260703120000`). `removeLeadFromListAction` now routes through
  the gate (was the one direct-delete bypass). The agent's system prompt now
  teaches the capability explicitly.
- **ListBuilder UI** (`components/marketing/ListBuilder.tsx`): a prominent
  "turn your contacts into a mailing list" panel on BOTH `/marketing/leads`
  and `/marketing/audience` — live-counted consent × stage slicing, new-list
  or add-to-existing, revert hint on success.
- **Agent dock**: `app/(app)/marketing/layout.tsx` mounts a floating "Ask the
  agent" pill on every marketing page (hidden where a chat already owns the
  surface) opening a right slide-over with the same AgentPanel; the transcript
  survives close (panel stays mounted). The hub gets a front-and-center
  ask-bar + suggestion chips that seed the dock and auto-send
  (`agentDockStore`, `AgentPanel seed/onSeedConsumed`).
- **Freeform question answers**: every QuestionCard offers "Something else…"
  (`value: "__other__"`); the resume message hands the creator's words to the
  agent verbatim — allowed to redirect the plan, never coerced into an option.
- **Verified:** new `verify:marketing:lists` **31/31**; all 12 suites green —
  **386 checks total**; build + lint + tsc clean; 15-check Playwright pass
  (dock open/close/seed, list builder end-to-end → quiet revertable hub log,
  audience-page parity).

## Marketing agent — gate/autonomy redesign, 2026-07-03

The approval system rebuilt around one principle: LOUD only where a human is
load-bearing. Full design doc: `docs/marketing-autonomy.md`.

- **Reversible tier fixed (the core bug):** all 25 reversible tools used to
  stage blocking Accept/Reject cards with the same weight as the 10 real gate
  cards. Now they execute + land as a quiet, dismissible **activity log** with
  a one-click **Revert** for a configurable window (default 24h,
  `marketing_action.revert_expires_at`; refused after expiry, fail-closed;
  Dismiss = accept). Unconditional — not gated behind any mode.
- **Three autonomy modes** (per-course `marketing_autonomy_settings`,
  governing ONLY the irreversible tier): `manual` / `assisted` (default; no
  row needed) / `auto`. Auto evaluates an explicit creator policy through the
  PURE engine `lib/marketing/autonomy.ts` (allowlist + recipient cap + budget
  cap + allowed hours + first-send-to-new-segment via the new
  `marketing_segment_send` history); every unset field fails closed, the empty
  policy is inert, one failing guardrail routes to a card, and the full audit
  persists as `autonomy_decision`. **Hard-deny first** — `launch_campaign`,
  `cancel_campaign`, `send_consent_confirmations` never auto-approve.
  Assisted auto-logs owner-addressed test emails (foreign addresses stay
  carded) and resolves ambiguous targeting via a question before the card.
- **Clarifying questions** (`marketing_question`): model-raised (`ask_creator`,
  a narrow 2–5-option interaction tool the gate resolves) or gate-raised
  (`clarifyTargeting` hooks on send_broadcast / enroll_segment_in_sequence —
  null status over a mixed audience; `"all"` = explicit everyone so answers
  never re-trigger). Both pause the loop through ONE `agent_blocked {kind}`
  branch; `resumeAgentAfterAnswer` is the third resume path (same
  conversation, one turn; gate-raised answers tell the agent to retry the
  tool with the param resolved; user-path answers re-run the tool directly).
- **One-card approval** (`ApprovalCard`, shared by chat/hub/builder/leads):
  full inline preview (new `effectLabel` + `bodyPreview` on irreversible
  previews; pages re-run previews server-side so counts stay current),
  exactly Approve-&-effect / Edit (in-place param edit + re-preview) /
  Reject (+ optional note to the agent). Request buttons return the pending
  payload → the card renders where the creator clicked; the old two-location
  request→approve round-trip is gone. `approveMarketingAction` claims
  `pending→'approved'` atomically — double-clicks see "already resolved",
  failed executes release back to pending (retryable).
- **UI:** `components/marketing/{ApprovalCard,QuestionCard,ActivityLogEntry,
  AutonomySettings}.tsx`; MarketingHub gets Needs-approval cards, "The agent
  asked", the quiet Recent-changes log, and the autonomy settings section.
- **Verified:** new `verify:marketing:autonomy` **92/92** (pure invariant
  permutations first, then live: unknown-tool fail-closed + registry drift
  guard, hard-deny sweep, deny-never-executes, per-guardrail ladder,
  reversible-never-pends, revert window, governance language, pause/resume
  parity, approve race, segment history). Updated `:agent` 18→22,
  `:campaign` 99→101, `:email`/`:marketing`/`:landing-edit` adjusted for the
  revert-window clock injection. **Full marketing suite: 355 checks green**;
  `build` + `lint` + `tsc` clean; Supabase advisors show no new findings.

## Marketing studio — Email & sequences hub (Slice 5), 2026-06-22

You can now SEE what will be emailed, when, and to whom — before it sends.

- **Hub card → `/marketing/sequences`:** every sequence with its status, schedule
  (each touch's delay / trigger), subjects, and per-touch **sent / queued** counts.
- **`/marketing/sequences/[id]`:** each email **rendered exactly as it will send**
  (`renderEmailHtml` — the same renderer the real Resend path uses), with its
  preview text + send counts, plus a **recipients** table (who's enrolled and
  which email they're up to). "Edit with AI" links to the agent.
- **Persistence:** `loadSequencesOverview` (per-touch sent/queued from the outbox
  + enrolled counts) and `loadSequenceRecipients` (enrollees + current position).
- **Verified:** `verify:marketing:sequences` **10/10** (overview counts after
  enroll+tick, recipient positions, email renders with a working unsubscribe).
  `build` + `tsc` + `lint` clean. No migration/secret. Resend remains optional —
  the page shows a "mock mode" banner until `RESEND_API_KEY` is set.

## Marketing studio — account tier + course picker + overview (Slice 4), 2026-06-22

A creator/account tier above course scope: one audience across all courses,
overall analytics, and per-course campaigns side by side.

- **Migration (applied):** `20260622000000_marketing_account_tier.sql` —
  `audience_contact` (`(author_id,email)` unique; consent; global `unsubscribed_at`;
  RLS `author_id = auth.uid()`) + nullable `contact_id` on `subscriber` &
  `analytics_event` (+ indexes) + an idempotent backfill deriving contacts from
  existing subscribers and linking them. Reversible down-migration documented.
  Types regenerated; advisors clean.
- **Contact linking:** `ingest.captureLead` upserts the account-level contact and
  stamps `contact_id` on the per-course subscriber + events — so one person is a
  single identity across every course (lead on A, enrolled on B).
- **Global unsubscribe:** `globalUnsubscribe()` (shared by the unsubscribe route +
  tests) flags the contact and suppresses EVERY linked per-course subscriber
  (CAN-SPAM/GDPR-safe — the scheduler already skips `unsubscribed`). User-chosen
  default.
- **Account rollup:** `analytics.getAccountSummary(authorId)` — distinct audience
  (contacts) + funnel summed across the creator's courses + per-course breakdown.
- **UI:** `/marketing/overview` (total audience, account funnel, a card per course
  → its hub, master mailing list); the per-course hub gained a **course picker**
  + Overview link; `analytics`/`audience`/`agent` now accept `?course=` so the
  selection persists.
- **Verified:** new `verify:marketing:account` **10/10** (unified contact across
  courses, account aggregation, global-unsubscribe cascade). Full suite green:
  gate 37 · flow 18 · analytics 12 · email 34 · agent 18 · landing-edit 11 ·
  account 10 · swap 7 = **147**; `build` + `tsc` + `lint` clean.

## Marketing studio — observability + AI page editing (Slices 1–3), 2026-06-22

Made the landing loop real & observable, the funnel legible, and the page
editable by chat. (Diagnosis first found the recurring "ingest not configured"
was an UNSAVED `.env.local` buffer + a second checkout/server on :3000 — the
code was already correct; saving the key + restarting :3001 fixed it. Flow verify
now 18/18 incl. ingest.)

- **Slice 1 — observable landing loop:** `GET /api/marketing/health`
  (`{adminConfigured,emailMode}`) + clearer ingest 503; **Accept/Reject now give
  feedback** — actions return `{message, href, hrefLabel}`, the hub shows a toast
  + an artifact link, the item leaves "staged"; **authed draft preview**
  `/marketing/preview/[id]` renders the draft via the renderer in `preview` mode
  (no beacon, disabled form) so you can see a page before publishing.
- **Slice 2 — legible scheduling:** `/marketing/audience` shows each subscriber's
  lifecycle stage + sequence position + next send; author-scoped **test controls**
  (seed lead, advance scheduler ±days via a future `nowMs`) exercise the funnel on
  the mock provider; plain-language flow doc in `docs/marketing-suite.md`.
- **Slice 3 — conversational editing + typed design layer:** additive (jsonb, no
  migration) `LandingTheme` tokens (colorTheme/typePairing/density/buttonStyle) +
  per-section layout `variant` (hero centered|split|minimal, outcomes grid|list);
  `components/marketing-pages/design.ts` resolves tokens → literal Tailwind
  classes (renderer owns all layout — the agent never emits CSS). New reversible,
  gated tools `set_page_design` / `set_section_variant` (+ `update_landing_section`
  for copy); **split-view editor** `/marketing/landing/[id]` (agent chat + live
  draft preview, page-scoped agent, `router.refresh()` per turn).
- **Verified:** `verify:marketing:flow` 18 · `:email` 34 (+audience) · new
  `:landing-edit` 11 (design tokens + variant + content edits stage & reject
  byte-for-byte; agent path page-scoped) · gate 37 · agent 18 — all green;
  `build` + `tsc` + `lint` clean.

## Marketing Assistant — Phase 5: real integrations swap (Resend + cron), 2026-06-19

The mock→real swap, behind one env var, zero contract changes.

- **`ResendEmailProvider`** (`lib/marketing/services/resend.ts`) — the ONLY file importing the `resend` SDK. Implements the same `EmailProvider` contract as the mock: renders the `EmailBody` to HTML + text (the pure renderers), sets a `List-Unsubscribe` header, returns the provider message id (no simulated engagement — real opens/clicks will arrive via Resend webhooks). Env: `RESEND_API_KEY`, `RESEND_FROM`.
- **Factory flip** (`services/factory.ts`): `createEmailProvider()` now returns Resend when `RESEND_API_KEY` is set, the mock otherwise — the single swap point. Tools, gate, agent, scheduler, and UI are untouched.
- **Cron**: the tick route gained a GET handler (Vercel Cron uses GET; external cron can POST with `x-cron-secret`); `vercel.json` schedules `/api/marketing/scheduler/tick` every 5 min. Guarded by `CRON_SECRET`.
- **Docs**: `docs/marketing-suite.md` (architecture, env, verify scripts, the swap); CLAUDE.md marketing section.
- **Verified:** `npm run verify:marketing:swap` **7/7** — no key → mock selected; key set → Resend selected; both expose the identical `EmailProvider` contract (zero downstream change). `build` + `tsc` + `lint` clean. Added runtime dep: `resend` (15 runtime deps total).

## Marketing Assistant — Phase 4: the Marketing Agent + Generate Kit + approval inbox, 2026-06-19

The assistant — it observes, generates, and stops at the gate.

- **Agent loop** (`lib/marketing/agent/loop.ts`) on the provider-agnostic `ModelClient` (same seam as the studio): **observe** (funnel + assets injected as a leading `developer` message — static system stays cacheable), **reason** (stream a turn with the marketing tool defs), **act** (every call through `executeMarketingTool` → the gate). Reversible auto-stages; reads execute; an irreversible call emits `approval_request` and **PAUSES** — the loop never sends/publishes on its own. Conversations reuse the shared `conversations`/`messages` tables (course-scoped, lesson_id NULL) with full history replay.
- **SSE** (`lib/marketing/agent/events.ts` + `app/api/marketing/agent/route.ts`, Node): `observation` / `assistant_delta` / `tool_start` / `tool_result` (status read|staged|pending_approval) / `approval_request` / `done{paused}`. OpenAI key server-only; 503s to a clean error event when unconfigured.
- **UI**: `components/marketing/agent/AgentPanel.tsx` (streaming chat with live tool cards + inline Approve/Deny) at `app/(app)/marketing/agent`. The hub gained a **unified approval inbox** — staged (Accept/Reject) + pending (Approve/Deny) from any surface (Generate Kit, cards, agent), labeled by action + flagged when the agent requested it — plus the **Generate Kit** batch button (`generateKitAction` runs the three reversible generators through the gate).
- **Verified:** `npm run verify:marketing:agent` **18/18** against live Supabase via the mock model client — observe step, reversible auto-stage, read tool, **irreversible pause** (page stays draft, one model call, pending action recorded), approve→executes, governance in the prompt, observe-as-developer-message, history persisted. `build` + `tsc` + `lint` clean.

## Marketing Assistant — Phase 3: email + subscriber state machine + scheduler (mock send), 2026-06-19

The full email lifecycle, on OUR state machine — Resend (Phase 5) only ever moves bytes.

- **Subscriber state machine** (`lib/marketing/stateMachine.ts`): a PURE reducer over the event stream (`form_submit→lead`, `email_sent→subscribed`, `open/click→engaged`, `enrollment→enrolled`, `unsubscribe/bounce→terminal`). Active statuses only advance; terminals stick. `applyEventToSubscriber` materializes it; `isSuppressed` gates sends.
- **The engine** (`lib/marketing/scheduler.ts`): `enrollSubscriber/Segment` → `sequence_enrollment` + the first due `scheduled_send`; `runSchedulerTick` claims due sends, delivers via the provider, emits `email_sent` (+ deterministic mock `open/click`) into the single stream, advances each enrollment to the next touch (or completes it); `processEventTrigger` enrolls on a matching behavioral event; `sendBroadcast` is an inline one-off. **Idempotent** via the unique `(touch_id, subscriber_id)`; suppressed subscribers skip + their enrollment cancels.
- **Content**: `lib/marketing/email/templates.ts` (deterministic 4-touch launch + 2-touch followup, grounded in the course) + `render.ts` (pure text/HTML; Phase 5 can swap React Email) — every email carries a one-click unsubscribe.
- **Tools** (`lib/marketing/tools/email.ts`): reversible `generate_email_sequence` / `generate_followup` / `write_email_touch`; irreversible (gated) `activate_sequence` / `enroll_segment_in_sequence` / `send_broadcast` / `send_test_email`. Sequence sends are pre-authorized by the activate approval (the gate sits at activate/enroll/broadcast, not per-touch).
- **Routes**: `app/api/marketing/scheduler/tick` (prod cron trigger; service-role + optional `CRON_SECRET`; runs the same `runSchedulerTick` the tests drive) and `app/api/marketing/unsubscribe` (one-click, service-role).
- **Verified:** `npm run verify:marketing:email` **31/31** against live Supabase — pure state-machine transitions, generate→accept, write→reject (byte-for-byte), activate→approve→enroll→tick, clock-advance to the next touch, idempotent re-tick, unsubscribe suppression, event-triggered enrollment, and a gated broadcast. `build` + `tsc` + `lint` clean.

## Marketing Assistant — Phase 2: analytics event stream + dashboard + observe, 2026-06-19

The single event stream becomes legible — to the creator AND the agent.

- **Aggregation (`lib/marketing/analytics.ts`).** `getAnalyticsSummary(courseId)` rolls the funnel (views → leads → email opens → clicks → enrollments) + rates + subscribers-by-status from `analytics_event` (cheap COUNT queries over the `(course_id,type)` / `(course_id,status)` indexes). Leads = distinct subscribers; enrollments = the materialized `enrolled` state. `queryAnalyticsEvents` returns a bounded, filtered slice.
- **Observe tools (`lib/marketing/tools/analytics.ts`).** `get_analytics_summary`, `query_analytics_events`, `get_subscriber_segments` — reads, added to `MARKETING_READ_TOOLS` (so they're in the agent's observe surface AND the generate phase). The dashboard and the agent now read the *same* numbers.
- **Dashboard (`app/(app)/marketing/analytics/page.tsx`).** A funnel view (renderer-owned bars), subscribers-by-status, and recent events — linked from the hub's now-live Analytics card.
- **Verified:** `npm run verify:marketing:analytics` **12/12** against live Supabase (funnel counts, rates, status breakdown, and all three observe tools), `build` + `tsc` + `lint` clean.

## Marketing Assistant — Phase 1: landing page generate → publish → lead capture, 2026-06-19

The first user-facing slice: a creator generates a landing page from their syllabus, reviews it, publishes it (gated), and it captures leads at a public URL.

- **Slot-schema + renderer (renderer owns layout).** `components/marketing-pages/*` renders the typed `LandingSection[]` in the warm-editorial identity (hero/outcomes/curriculum/instructor/social_proof/pricing_cta/lead_capture/faq). Public route **`app/p/[slug]/page.tsx`** server-renders a PUBLISHED page via RLS (drafts 404), with `generateMetadata`.
- **Public lead-capture ingest.** `LeadCaptureForm` + `PageViewBeacon` (client) POST to **`app/api/marketing/ingest/route.ts`** (Node), which uses a **service-role admin client** (`lib/supabase/admin.ts`) to write `subscriber` + `analytics_event` rows on behalf of anonymous visitors — `lib/marketing/ingest.ts` validates the target page is published, idempotently upserts the subscriber (by `campaign_id,email`), and emits `form_submit` (+ `free_lesson_capture`) and `page_view` into the single event stream. Route 503s cleanly when the key isn't configured.
- **Studio Marketing hub** (`app/(app)/marketing/`): replaced the mock placeholder with a real hub — generate a landing page, review the **staged** change (Accept/Reject), **Publish** (→ approval gate: Approve/Deny), View live / Unpublish. Server actions (`actions.ts`) route the SAME shared tool layer + gate as the agent will. Sequence/analytics/agent cards are honest "Phase N" placeholders.
- **New env:** `SUPABASE_SERVICE_ROLE_KEY` (server-only) for the ingest write path.
- **Verified:** `npm run build` (both `/p/[slug]` + `/api/marketing/ingest` registered), `tsc` + `lint` clean, `npm run verify:marketing:flow` **7/7** generate→accept→publish→approve→public-read against live Supabase (ingest's 6 lead-capture checks auto-run once the service-role key is in `.env.local`).

## Marketing Assistant — Phase 0: the spine (schema · gate · tools · mocks), 2026-06-19

First slice of the Marketing Assistant suite (PRD: `docs/prd/Marketing-Assistant-Creator-Studio-Web.html`). The architectural spine everything else hangs off — **one typed tool layer, one event stream, one governance gate** — built mock-first so the whole loop works before Resend/cron exist.

- **DB (applied, user-approved):** migration `20260618000000_marketing_assistant.sql` — 9 author-scoped tables (`marketing_campaign`, `landing_page`, `email_sequence`, `email_touch`, `subscriber`, `sequence_enrollment`, `scheduled_send`, `analytics_event`, `marketing_action`), denormalized `course_id` + `private.is_course_author` RLS everywhere, jsonb payloads. Two deliberate departures: `landing_page` is **public-read when `published`** (the /p/[slug] route), and `subscriber`/`analytics_event` take author-only RLS with public writes reserved for a Phase-1 service-role ingest route. Types regenerated; advisors clean (no new RLS gaps).
- **The governance gate (`lib/marketing/gate.ts`) — a first-class, reversibility-graded primitive.** Every mutating tool routes `runThroughGate`: **read** executes (no ledger); **reversible** executes + snapshots the target BEFORE + stages an `auto_approved` row (Reject-able, atomic byte-for-byte restore via the entity registry); **irreversible** does NOT execute — it runs the tool's side-effect-free preview, records a `pending` row, and waits for `approveMarketingAction` (runs the real effect) or reject (deny). The `marketing_action` table is the unified staging + approval + audit ledger.
- **One shared tool layer (`lib/marketing/tools/*`).** `Tool<P>` + `reversibility`, behind ONE entrypoint `executeMarketingTool` (the same seam the batch button, cards, and agent will all call). Phase 0 tools: reads (`get_campaign_context`, `get_course_plan`, `list/get_landing_page`), reversible (`create_campaign`, `generate_landing_page`, `update_landing_section`), irreversible (`publish/unpublish_landing_page`). Zod params → strict JSON schema via the studio's `toStrictJsonSchema`. Tool sets `MARKETING_READ/GENERATE/ACTION_TOOLS`.
- **Slot-schema + deterministic generator.** `lib/marketing/types.ts` + `schemas.ts` define the typed landing-section union (hero/outcomes/curriculum/instructor/social_proof/pricing_cta/lead_capture/faq) with `.max()` caps as the validate→repair guard; `generators.ts` fills them truthfully from the course plan (the mock-first content engine; Phase 1 adds an LLM variant behind the same signature).
- **Mock→real seam.** `lib/marketing/services/*`: `EmailProvider` + `Clock` interfaces, a deterministic `MockEmailProvider` (records sends, returns reproducible simulated engagement), and an env-gated `createMarketingServices` factory (one Phase-5 branch flips to Resend; nothing else changes).
- **Verified:** `npm run verify:marketing` — **37/37** against live Supabase (gate routing, reversible stage+reject-restore byte-for-byte, irreversible pend→approve / deny, published public-read RLS, author-scope RLS). `lint` + `tsc` clean.

## Per-phase model · prompt-cache fix · reject↔autosave race (A/B/C), 2026-06-17

- **A — per-phase MODEL (not just effort):** `ModelTurnParams.model` + `LoopOptions.model` make the model a per-call parameter (provider falls back to `OPENAI_MODEL`/`DEFAULT_MODEL`). PLAN/CRITIQUE = `gpt-5.5`/high, **GENERATE = `gpt-5.4-mini`/medium** (the high-volume phase stays cheap), classifier = `gpt-5.4-mini`/minimal. `agent_phase` logs the per-call `{phase, model, effort}` (was logging the client default). Both strings confirmed valid live.
- **B — prompt caching fix:** the `~19.5K` stable prefix wasn't caching because `buildSystemPrompt` put the **variable** course/lesson context BEFORE the large static catalogs, truncating the cacheable prefix at the course title (and `cached_tokens` wasn't even logged). Fix: `buildSystemPrompt` is now **STATIC only** (role + catalogs + teaching bar); the variable course/lesson/outline moves to a leading `developer` message in `input` (new `buildContextMessage`), so the static system + tool schemas form one byte-identical prefix. `cachedTokens` added to `PhaseUsage` + the log. **Live spot check: ~98% of input cached on a repeat call** (10,752 / 10,994), vs effectively the role-only prefix before.
- **C — Reject ↔ autosave race + resilient autosave:** the "Course autosave failed: TypeError: Failed to fetch" around Reject was the debounced autosave (`coursePersistence.ts`) racing the reject's reconcile — a stale in-flight flush (un-reverted client doc) writing concurrently with the server revert (it's a transport-layer fetch failure, not an abort; reject merely provokes it). Fix: Reject now **suspends + aborts** autosave before the POST (`suspendAutosaveForReject` + an `AbortController` threaded into `reconcileCourseDoc` via `abortSignal`), and `hydrate` resumes + **skips re-saving** the reverted doc (already server state); the reject POST-failure path resumes too. Autosave failures now **auto-retry with backoff** (2 attempts) before surfacing `saveStatus("error")` — a transient blip no longer silently loses work. Server reject was already pending-only + atomic; Accept-all is untouched.
- **Verified:** build + lint + tsc; `verify:ai` 63+16; `verify:slides` 17+8+48+23; `verify:ai:int` **53** (+per-phase-model + cacheable-split assertions); `verify:reject` 17. No DB migration.

## GENERATE quality — bind to the planned layout + teach with depth (A–E), 2026-06-17

PLAN was solid but GENERATE rendered skeletal primitives: a planned `concept_example`/`key_concept` "Greedy intuition" slide came out as three TIP boxes of ~5 words. General (not one-slide) fixes:
- **Root cause:** PLAN speaks the **structured** layout vocabulary, but GENERATE authored via `write_slide_deck` whose enum is the **14 FLAT layouts only** → a planned structured layout became a flat `step_by_step` (3 `variant:"tip"` callouts). Nothing bound slide *i* to the planned layout, and the prompt mandated brevity ("a few words each", "no walls of text") with max-only slot caps (no floor).
- **A — model `gpt-5.5`** (`openai.ts` `DEFAULT_MODEL`; `OPENAI_MODEL` overrides). Per-call effort already PLAN high / GENERATE medium / CRITIQUE high; logs carry model+effort. Confirmed valid against the live API.
- **B — deeper PLAN** (`outline.ts`): prompts now DECOMPOSE a concept into building sub-steps (each weight-bearing one its own slide), mandate ≥1 worked example + a low-stakes check, sequence primitive→improved, and — new — a required `keyPoints[]` per slide carrying the **actual content** (the writer's brief), surfaced in `outlinePromptFragment` as a "cover:" list.
- **C — bind to the planned (structured) layout + plain first-class:** new **`prose`** structured layout (a real teaching text slide: title + substantive body + optional points) added via the esd pattern (8 structured layouts now). `OUTLINE_LAYOUTS` is all-structured (`prose` replaces the bare "text" fallback). GENERATE/CRITIQUE run a new **`GENERATE_TOOL_NAMES`** set — reads + structured slide tools + `create_block` + `write_quiz/homework/lecture`, **excluding `write_slide_deck` and the flat slide ops** — so a flat tip/text deck is impossible; the prompt says render the planned layout, upgrade only to a better *structured* layout, never silently downgrade.
- **D — depth floor** (`context.ts`): the GENERATE teaching bar now demands real teaching (full sentences/steps/worked example, expand the brief, fill slots), **bans skeletal/3–6-word slots**, and the conflicting brevity lines are removed (max caps stay). A `agent_thin_slides` heuristic logs under-filled structured slides (observability — modules have no critique).
- **E — CRITIQUE enforces A–D** (single-lesson builds): fail-and-revise on skeletal slides, layout≠plan-without-justified-upgrade, missing worked example, should-build-up; structured-tool fixes only; one bounded pass. **Module builds stay GENERATE-only** (your call) — B+C+D carry module quality.
- **Verified:** build + lint + tsc; `verify:ai` 63+16; `verify:slides` 17+8+**48**+23 (prose); `verify:ai:int` 49 (GENERATE toolset asserted structured-only); `verify:reject` 17. **Live spot check (gpt-5.5, routed via the proxy):** a Kruskal lesson planned 14 all-structured slides with keyPoints, decomposed greedy→cut property→algorithm→DSU→worked trace→check→correctness→runtime, with a `prose` slide + worked examples. No DB migration.

## Fix: "create a module" misrouted + generation went off-script (FK + no module), 2026-06-17

"Please create module 4 … only do the first 2 lessons" produced no module 4, a tangle of create/list/delete-lesson tool calls, and a save error `insert or update on table "lessons" violates foreign key constraint "lessons_module_id_fkey"`.

- **Root cause — router (`lib/ai/intent.ts`):** the `generate_module` short-circuit was gated by `&& !/\blessons?\b/i.test(msg)`, so ANY module request that mentions "lessons" (nearly all do) was disqualified and fell through to `generate_lesson`/edit. The dedicated module pipeline never ran. **Fix:** dropped that guard; added a narrow `LESSON_INTO_MODULE` check ("add a lesson to/in module X" → `generate_lesson`) that takes priority, else a module build → `generate_module`. Now "create a module … with N lessons" routes to the module pipeline.
- **Compounding cause — unconstrained generation (`lib/ai/tools/index.ts`, `agentLoop.ts`, `phases.ts`):** the GENERATE/CRITIQUE loops were handed the FULL toolset, so the misrouted model improvised — `create_lesson` (into the wrong/current module, since it defaults there), `delete_lesson`, etc. — churning the tree into an inconsistent state that failed the whole-doc reconcile (the FK). **Fix:** GENERATE + CRITIQUE now run with `authoringOnly` — restricted to `AUTHORING_TOOL_NAMES` (read context + write/edit slides/decks/quiz/lecture), EXCLUDING structural + destructive tools. The pipeline owns module/lesson creation; the edit path keeps the full toolset.
- **Tests:** `scripts/verify-outline.ts` gained routing assertions (module-with-lessons → module; add-lesson-to-module → lesson; short-circuits make no model call); the live `verify-agent-integration.ts` module case now uses lesson-naming phrasing and asserts the GENERATE toolset excludes `create_lesson`/`delete_*` and includes the authoring tools. `verify:ai` 63+16, `verify:ai:int` 49, build/lint/tsc green. No DB migration.
- **Known follow-up (NOT in this change):** the FK was reached because the agent's server reconcile and the studio's browser autosave both do **full-snapshot whole-doc writes on the same course with no coordination** — interleaved upsert/delete-orphans can transiently orphan a row. Constraining generation greatly narrows the window, but the real fix (pause autosave during an agent run, or scope reconcile to touched subtrees / serialize writes) is tracked separately.

## Fix: PLAN structured-output always failed ("couldn't produce a valid outline"), 2026-06-17

Every lesson AND module PLAN failed with the generic "couldn't produce a valid {outline|plan}" — even a tiny request. `verify:ai:int` passed only because the MOCK provider never exercises OpenAI's real structured-output path. Reproduced against the live API (routed through the dev proxy since the openai SDK / undici ignores `HTTPS_PROXY`).

- **Root cause (provider text extraction):** for a reasoning + structured-output (`text.format` json_schema) response, the OpenAI Responses API returns the JSON in the `message` output item but **`final.output_text` is empty** (live: `outputTokens 13589`, `reasoningTokens 11507`, yet `output_text.length === 0`). The provider read only `final.output_text` → empty → `JSON.parse` failed → the generic error. **Fix (`lib/ai/providers/openai.ts`):** new pure `messageTextFromOutput(output)` reads the `message` items' `output_text` parts directly; the turn now uses `messageTextFromOutput(...) || final.output_text || streamedDeltas`. Confirmed live: both lesson + module now return valid outlines.
- **Hardening (defense in depth, also justified by the live numbers):**
  - **Output budget:** the PLAN call now passes `maxOutputTokens` 32000 (was the 16000 default) so high-effort reasoning (~11k tokens observed) can't starve the JSON.
  - **Bounds-relaxed parse (`lib/ai/outline.ts`):** OpenAI strict mode strips `min/max/minItems/maxItems` from the schema, so the model is never told the floors/ceilings — rejecting on them locally just bounced a good plan. New `coerceOutline`/`coerceModuleOutline` parse types + enums (enums ARE API-enforced) and **clamp counts** (≥1 slide accepted, >14 truncated; lessons ≤8; empty-slide lessons dropped) instead of hard-failing; the "3–14 / length" guidance stays in `.describe()` + the prompt. Resume re-validation uses the same coercion (so an approved relaxed plan isn't re-rejected at approve).
  - **Real errors surfaced:** `runStructuredPlan` logs the true cause on failure (`finishReason`, reasoning/output tokens, raw head) and the user message now distinguishes "cut off" (incomplete) / "service error" from "invalid"; `openai.ts` captures the API error status + body verbatim.
- **Closed the test gap (`scripts/verify-outline.ts`, in `verify:ai`):** asserts the generated lesson/module response schemas obey OpenAI strict rules (no forbidden keywords; every object `additionalProperties:false` + complete `required`), the relaxed parse accepts a 1-slide/over-count/long-title outline and clamps, and `messageTextFromOutput` recovers JSON when `output_text` is empty. No DB migration.

## Phased agent — fix the bypass: module-level plan, 3-way routing, forced layering, prominent review, 2026-06-16

The phased pipeline shipped but a real request — "Add a search algorithm module … also counting and radix sorts" — bypassed it: it created a module + 4 lessons + 4 **basic** decks with **no plan card** (even with auto-approve OFF). Root cause (confirmed): the router classified "add a … module" as `edit`; the pipeline was **per-lesson only** (couldn't build a module); and **all non-pipeline content creation ran the un-layered loop**. Fixed end-to-end. Verified: build + lint + tsc green, `verify:ai` 63, `verify:ai:int` **47** (39 prior + 8 module-build), slides/reject unchanged.

- **A — 3-way routing** (`lib/ai/intent.ts`): `generate_module | generate_lesson | edit`. High-precision regex short-circuits for module/lesson builds (incl. "add a … module"), a small-add guard so "add a knowledge check / a slide / fix wording" stays on the fast `edit` path, and a rewritten 3-mode classifier (defaults to `edit`).
- **B — module-level plan** (`lib/ai/outline.ts` `ModuleOutlineSchema` = ordered lessons, each with its slide outline): the module request produces ONE plan card (module title + every lesson's outline), approve once → create the module + lessons → GENERATE each lesson (layered). **Per the cost trade-off, module builds skip CRITIQUE** (single-lesson generation still runs it); revisit if quality needs it. One reconcile → **one** change-set across the whole module; per-lesson progress via `phase.detail` ("Linked lists (2/4)").
- **C — no un-layered content path** (`lib/ai/agentLoop.ts`, `phases.ts`): the `edit` loop and the delete-resume loop now run `layered:true` (teaching bar + layout guide, no plan gate, still single-turn) — so any deck the fast path creates still meets the bar. The fast path stays fast (no PLAN/CRITIQUE).
- **D — prominent review** (`components/editor/agent/AgentPlanHost.tsx`): the plan review moved from a scrollable inline card to a **modal mounted at the shell level** (scrollable body + sticky Approve & generate / Discard, renders lesson vs module), so it can't scroll past and shows even if the panel is collapsed. `plan_outline` + `pendingOutline` are now discriminated (`kind: "lesson" | "module"`). Auto-approve stays OFF by default + honored server-side.
- **Instrumentation:** every `agent_phase` log now carries `layered`, and the `edit` path logs a phase line too — every run is traceable.
- New route entry `resumeGeneratePlan` (replaces `resumeGenerateLessonTurn`) dispatches lesson vs module on approve. No DB migration (outlines stay transient).

## Phased content agent — PLAN → GENERATE → CRITIQUE (per-call effort + sidebar phases), 2026-06-16

The single-turn content agent produced shallow decks (text + code + tip boxes, structured layouts unused, foundational concepts skipped, a whole lesson in ~30s). Effort was already `medium` — a process/prompting problem, not a knob. Fixed by giving ONE agent (gpt-5.4-mini) an explicit three-phase pipeline with **per-call reasoning effort**, a teaching bar + layout decision guide, and a fresh-eyes critique. Verified: build + lint + tsc green, `verify:ai` 63, `verify:ai:int` **39** (25 prior + 14 phased), `verify:slides`/`verify:reject` unchanged.

- **Per-call reasoning effort** (the seam): `ModelTurnParams` gains `effort?` + `responseFormat?`; `ModelTurnResult.usage` gains `reasoningTokens`. `providers/openai.ts` applies `params.effort ?? envDefault`, passes `text.format` json_schema for structured turns, and maps `reasoning_tokens`. The env value is now a fallback default only.
- **Auto-detect routing** (`lib/ai/intent.ts`): each turn is classified `generate_lesson` vs `edit` — a regex short-circuit for obvious "build a lesson/deck" phrasing, else a minimal-effort structured classification (defaults to `edit`). Small edits keep the existing single-turn loop untouched.
- **PLAN** (`effort:high`, structured output → `lib/ai/outline.ts` `LessonOutlineSchema`): emits a slide-by-slide outline (concept · prerequisites · layout · depth · notes), validate→repair (one re-ask). Manual approval by default — emits a `plan_outline` event and pauses (mirrors the delete confirm flow); an **auto-approve toggle** collapses the pause. The outline is **transient** — it round-trips client→server and is consumed by GENERATE/CRITIQUE; never persisted (no `courses.plan` change, no migration).
- **GENERATE** (`effort:medium`): the shared loop with a layered system prompt (teaching bar + layout decision guide + the approved outline appended at the end so the stable prefix still caches).
- **CRITIQUE** (`effort:high`, ONE bounded pass): a fresh-eyes critic prompt with the lesson's deck serialized **as data**; revisions go through the same ops tools. The whole pipeline reconciles once and stages **one** reviewable change-set (baseline = doc before GENERATE).
- **Sidebar phase indicator** (user-requested): new `phase` + `plan_outline` SSE events → `agentStore` (`phase`, `pendingOutline`, `autoApprovePlan`) → `AgentPanel` shows a PLAN/GENERATE/CRITIQUE badge, an inline outline-review card (Approve & generate / Discard), and an auto-approve checkbox.
- **Instrumentation**: one structured `console.log({ tag:"agent_phase", phase, model, effort, toolCalls, inputTokens, outputTokens, reasoningTokens, latencyMs, … })` per phase.
- **Loop reuse**: `runConversationLoop`/`loopContext`/`LoopContext` are now exported and take per-call options (`effort`, `outline`, `layered`, `systemOverride`, `maxTurns`, `deferFinalize`) and return `{doc, usage, toolCalls, …}`. Legacy callers pass no options → byte-identical. New `lib/ai/phases.ts` owns the orchestration (`runContentAgentTurn`, `runGenerateLessonTurn`, `runGenerateThenCritique`, `resumeGenerateLessonTurn`); new route `app/api/ai/agent/plan/route.ts` resolves the approval (mirrors `/confirm`).

## Fix: agent staging crash on a divergent docked lessonId (change_sets FK), 2026-06-16

The agent could apply a slide/block edit successfully and then fail staging with
`insert or update on table "change_sets" violates foreign key constraint
"change_sets_lesson_id_fkey"`. Root cause: `change_sets.lesson_id` was populated
from the **client-supplied docked `lessonId`** (`useEditorStore.activeLessonId`
→ request body → `agentLoop` → `createChangeSet`), never validated against the
DB. When that id was a client-only / not-yet-autosaved / stale lesson (no
`lessons` row), the insert violated the FK. The tool edit itself already
persisted (the full-doc `reconcileCourseDoc` runs *before* `createChangeSet`, in
a separate non-transactional call), so the change survived reload while staging
crashed and surfaced a red error on a successful edit.

- **Fix (`lib/ai/agentLoop.ts`):** coalesce the change-set's `lesson_id` to a
  server-validated value — trust the docked id only if `findLesson(doc, …)`
  finds it in the just-reconciled doc, else fall back to a changed block's
  lessonId (always persisted) or `NULL` (the column is nullable). The FK target
  now provably exists or is NULL.
- **Twin (`lib/ai/conversations.ts`):** `getOrCreateConversation` now stores
  `lesson_id` only if the lesson exists, else `NULL` — the same latent
  `conversations_lesson_id_fkey` would otherwise fire on the first turn of a
  thread opened on an unpersisted lesson.
- **Regression (`scripts/verify-agent-integration.ts`, now 25 checks):** an
  agent turn with a non-existent docked `lessonId` editing a block in a real
  lesson — asserts the tool succeeds, no error event, the change_set is emitted,
  and its `lesson_id` is coalesced to the real lesson (not the bogus id); plus a
  conversation opened on a non-existent lesson stores `lesson_id NULL`. Verified
  it reproduces the exact FK error when the fix is reverted. `change_set_items`
  has no lesson FK and its `lesson_id` comes from the diff (always valid), so it
  was never affected. No schema/migration change.

## Three more structured layouts — section break · concept→example · outline list, 2026-06-16

Added three renderer-owned structured layouts through the EXISTING pattern (no
new architecture): one registry entry + strict length-enforced Zod schema +
React component + discriminated-union variant + dispatch case each, auto-exposed
to the AI catalog and the manual "Structured" picker. Brings the registry to
**7** structured layouts. Verified: `npm run build` + `npm run lint` clean, 44
pure structured-layout checks + 23 agent-facing checks (`npm run verify:slides`),
17 reject/revert checks (incl. a new structured slide restored byte-for-byte),
63 AI tool/schema checks (`npm run verify:ai`), and a 10-frame Playwright
near-max overflow sweep (every slot at its limit + max item/step/sub-item counts,
all variants, both decoration levels — no clipping or overflow).

- **`section_break`** (refs 1–4 = one layout): a chapter/section transition — a
  numbered mono kicker, a big title, a short accent underline, and a one-line
  framing. Variants `standard` / `hero_numeral` (giant outline numeral) ×
  `titleStyle` serif/sans. Serif titles get renderer-owned **two-tone** coloring
  (accent on the last word). Decoration = kicker/base rules + corner concentric
  arcs + dot-grid.
- **`concept_example`** (refs 5–6 = one layout): an abstract rule/definition
  (left) paired with a worked example (right) whose body is a discriminated union
  — `steps` (2–4, numbered) OR `paragraphs` (1–3, prose). Renderer owns the "in
  practice" connector (solid for steps, dotted for paragraphs), the badges, the
  step number badges, and the optional footnote callout.
- **`outline_list`** (ref 7): a titled nested list serving both lesson objectives
  and a module table of contents — 2–5 items, each with 0–2 optional sub-points.
  Renderer owns the top accent bar, the rule, number markers, two-tone
  main-vs-sub coloring, indentation, and count-based type scaling/reflow.
- **Decoration is renderer-owned and dial-able.** Each layout carries a
  `decor` (`"full" | "minimal"`) knob — present in the PERMISSIVE storage schema
  and the inspector, but DELIBERATELY ABSENT from the strict AI tool schema, so
  the model can never request or position flair. The AI's contract is the slot
  structure only.
- **Reliability guard unchanged:** every text slot carries an enforced `.max()`
  + length hint; counts are bounded; the validate→repair loop bounces overflow
  before render. New `RichText` slots reuse the nullable-`marks.color` schema (no
  `received null` regressions). New layouts have NO `ITEM_BOUNDS` entry (now
  `Partial`) — the inspector dispatches to bespoke panels for them and keeps the
  generic item editor for the original four. No DB migration (jsonb).
- **Files:** `lib/course/types.ts` (+content interfaces, `DecorLevel`, union),
  `lib/course/schemas.ts` (permissive storage branches),
  `lib/course/slide/structuredLayouts.ts` (LIMITS + strict schemas + registry +
  input union), `components/editor/slide/structured/{SectionBreak,ConceptExample,
  OutlineList}Layout.tsx` + `common.tsx` (`twoToneTitle`, `Badge`, `EditableText`
  children) + `StructuredSlide.tsx` dispatch, `LayoutPicker.tsx` (thumbnails),
  `components/editor/inspector/StructuredContentEditor.tsx` (dispatcher + 3
  bespoke editors). AI tools (`add_structured_slide` / `set_structured_slide`)
  pick them up automatically via the shared input union.

## Module & lesson deletion — for the user AND the agent (with confirmation), 2026-06-16

Neither the creator nor the agent could delete a module or a lesson; now both
can, and every delete is gated by a confirmation. For the agent, the
confirmation is a HARD PAUSE: it proposes the delete, the studio pops the dialog,
and the run is frozen until the creator decides — then it resumes. Verified by
`npm run build` + `npm run lint`, 63 pure + 19 live-Supabase agent checks (incl.
pause→confirm and pause→cancel), and a 10-check Playwright run of the manual flow.

- **New patches** `DELETE_MODULE` / `DELETE_LESSON` (`lib/course/patches.ts`,
  pure reducers + `deleteModulePatch`/`deleteLessonPatch` commands) — the one
  validated way structure is removed, used by BOTH the UI and the agent.
- **Manual deletes** with a shared confirm gate: a reusable `ConfirmDialog`
  (`components/ui/ConfirmDialog.tsx`, portal + focus-on-Cancel + Esc) driven by
  an imperative `confirm()` store (`lib/editor/confirmStore.ts`, one
  `<ConfirmHost/>` in the app layout). Hover-revealed trash affordances on the
  outline sidebar (module + lesson rows), the CoursePage module cards, and the
  ModulePage (a header "Delete" + per-lesson rows) all route through
  `confirmDeleteModule` / `confirmDeleteLesson` (`deleteConfirm.tsx`) → the
  patch pipeline → autosave. Deleting the open module returns to the course home.
- **Agent deletes pause for confirmation.** New `delete_module` / `delete_lesson`
  tools (`lib/ai/tools/structural.ts`) return a `confirm` descriptor instead of
  applying. The loop (refactored into a shared `runConversationLoop`,
  `lib/ai/agentLoop.ts`) detects it, stages a placeholder tool output (keeping the
  conversation valid), emits a new `confirmation_request` event, and STOPS —
  no further tool calls run. The docked panel shows the same `ConfirmDialog` and
  freezes the composer. The decision posts to **`/api/ai/agent/confirm`**, which
  `resumeAgentTurn`s: applies (or skips) the whitelisted delete patch, rewrites
  the placeholder output to "confirmed/declined", and continues the model loop so
  the agent finishes or acknowledges. Deletes are excluded from the reviewable
  change-set (the confirmation IS the gate). The agent's docked-lesson context,
  history replay, and persistence all stay consistent across the pause.
- The system prompt gained a STRUCTURAL EDITS rule (deletes are destructive,
  user-confirmed, and never a stand-in for an in-place edit); the manifest lists
  the new actions.

## Course-root page, light-blue modules & null-mark hardening, 2026-06-16

Closed the "blank course has no clear way to add a module" gap, gave modules
their own colour, and killed a raw validation error that leaked into the agent
chat. Verified by `npm run build` + `npm run lint`, the AI suites (84 checks,
incl. a new null-mark regression), and a temporary Playwright run
(`scripts/verify-coursepage-browser.ts`, 7 checks) driving the real studio
against live Supabase.

- **Course-root page** (`components/editor/CoursePage.tsx`): the center column
  when the COURSE is selected. Mirrors `ModulePage` one level up — a prominent
  "No modules yet → Add module" empty state (the old fall-through showed a
  dead-end "No lesson selected"), and a list of module **preview cards** once
  populated. "Add module" creates + jumps straight into the new module (the
  same guided flow as add-lesson). Wired into `CourseEditorShell`
  (`selection.kind === "course"` → `CoursePage`).
- **Modules are light blue** (sky), distinct from the warm-orange course/lesson
  accent, for the colour variance the studio lacked. Applied to the outline
  sidebar's selected-module row + "Module N:" prefix, the `ModulePage` eyebrow
  (now a sky `Layers` kicker) + not-found state, and every `CoursePage` module
  card. Lesson/content actions stay orange — module identity vs. content reads
  apart at a glance.
- **Agent no longer leaks raw Zod dumps** (`lib/ai/agentLoop.ts`): a failed tool
  call now shows the user a calm one-liner (`friendlyToolError`) while the MODEL
  still receives the full detail to self-correct. The validate→repair guard is
  an internal safety net, not a message addressed to the creator.
- **Null run-marks are accepted + normalized** (the reported `set_structured_slide`
  error). Strict tool schemas advertise every optional key as nullable, so the
  model emits `marks:{color:null,…}` on emphasized runs; the structured AI input
  schema (`lib/course/slide/structuredLayouts.ts`) now uses a local run schema
  that `.nullish().transform()`s those nulls to "absent" — so the produced patch
  is CLEAN and the (untouched, strict) storage schema validates it. Schema
  generation switched to `io:"input"` (`lib/ai/schema.ts`) so the transform is
  representable AND the model is still told null is allowed. Regression-tested in
  `scripts/verify-agent-structured.ts` (accepts null marks, stores no `:null`).

## Slide layouts, primitives & generation, 2026-06-16

Expanded the slide system's vocabulary — more layouts and primitives, not busier
slides — and made the agent use them; hardened Reject. Verified by 4 new pure
suites (`npm run verify:slides` + `verify:reject`, 74 checks) + a temporary
preview page screenshot-checked at seed AND near-max content. New runtime dep:
`shiki` (the only one; deps now 14).

- **Reject is now atomic** (`lib/ai/changeSet.ts`): a new pure
  `revertChangeSet(doc, items, now)` builds the full inverse first and aborts the
  WHOLE revert (throw, stay `pending`) if any item can't invert — no more silent
  `continue`, no half-reverted decks. DELETE-op restores re-add at the original
  index. `scripts/verify-reject-revert.ts` proves byte-for-byte restore
  (create+update+delete, incl. a deck) + the atomicity abort.
- **Sticker primitive library** (`lib/course/slide/stickers.ts`): one pure
  registry (20 lucide-mapped ids) → a new `{type:"sticker",stickerId}` element
  (types/schemas/patches/manifest/factories/`elementFromPlaceholder`), rendered
  single-color in the slide accent inside a tinted circle (`StickerElement.tsx`,
  reusable `StickerGlyph`). Manual picker = Insert→sticker grid; AI inserts by id
  (`add_sticker`, enum-validated). Icon geometry never leaves the renderer.
- **Tokenized fonts** (Task 2): `ElementStyle.fontScale`
  (display/title/heading/body/caption) resolves to a per-theme `typeScale`
  (`themes.ts`) and WINS over legacy raw px; the toolbar + Design tab size
  controls are now token dropdowns (raw px retired from the UI, still rendered).
  New `display` family = Fraunces (editorial serif). AI tool `set_text_style`.
- **Renderer-owned structured layouts** (Task 3): a slide may carry
  `template:{layoutId,content}` (typed, RichText slots) that a dedicated
  component draws — owning arrangement, arrows, numbering, reflow — bypassing the
  freeform element canvas. Four, from cgref1–5: `process_steps`, `key_concept`
  (sans+serif variants + optional spine), `metrics_overview` (chart deferred),
  `code_walkthrough_steps` (Shiki, `lib/course/slide/highlight.ts`, JS engine).
  Registry `structuredLayouts.ts` holds STRICT length-enforcing Zod schemas (the
  reliability fix — an over-long heading bounces back before it renders) + seeds.
  Patches `SET_SLIDE_TEMPLATE` / `UPDATE_TEMPLATE_CONTENT` (path-addressed,
  re-validated); `SlideStage` branches on `template`; `LayoutPicker` gains a
  "Structured" section; in-place text edit + a structured inspector
  (`StructuredContentEditor.tsx`) for add/remove/reorder/sticker/variant/delta.
- **Agent uses the vocabulary** (Task 5): `add_structured_slide` /
  `set_structured_slide` (strict per-layout union schema → validate→repair on
  overflow), `set_text_style`, `add_sticker`; the system prompt
  (`lib/ai/context.ts`) gained the structured-layout + sticker catalogs and
  match-layout-to-content guidance.
- **Export-fidelity ledger:** structured layouts (renderer-owned components) +
  Shiki code are NOT yet PPTX-mapped — flagged for the export workstream; they
  cost more to map than flat layouts. The metrics chart is deferred to
  charts-as-data and is NOT faked.

## Slide agent — production tool surface + content contract, 2026-06-15

Turned the slide agent from "rewrites the whole deck into title+bullets and
leaks `**markdown**`" into a Cursor-style editor bound to the studio's OWN
renderer primitives (one source of truth — no parallel definition). Verified
with the real model: it varies layouts, writes bold that renders, and switches
ONE slide's layout without touching the others.

- **Layout registry, shared:** the agent now binds to `SLIDE_LAYOUTS` (the same
  14-layout registry the renderer + `applyLayoutToSlide` use), incl. each
  layout's `ai.bestFor/avoidWhen` — surfaced as a strict layout enum + a catalog
  in the system prompt (`lib/ai/tools/slideContent.ts`, `context.ts`).
- **Rich text kills the asterisk leak** (`lib/ai/richText.ts`): emphasis is
  STRUCTURED runs (`{text,bold?,italic?}`) → the studio's `TextRun[]` (renders
  as bold/italic), with a markdown→runs safety net so a stray `**` can never
  ship; bullet items flatten to plain (per-item runs are a studio cut).
- **Granular, id-addressed, non-destructive tools** (`lib/ai/tools/slides.ts`):
  `get_deck`, `get_slide`, `add_slide`, `update_slide`, `set_slide_layout`,
  `reorder_slides`, `delete_slide` — each wraps an existing slide patch and
  touches one slide. New additive `SET_SLIDE_CONTENT` patch (slide-level analog
  of `SET_BLOCK_CONTENT`). `write_slide_deck` is now per-slide layout + rich
  content and reserved for generating a FRESH deck.
- **Validate → repair → stage:** content is validated against the chosen
  layout's slots; failures return the message to the model to self-correct; all
  edits flow through the existing change-set staging.
- **No data-model change** (your "fix the wiring, not the model"): slot↔element
  mapping is derived from the slide's current layout; emphasis uses the existing
  `runs` model.
- **Verified:** `npm run verify:ai` (50 checks incl. layout choice, bold-as-runs,
  no-`**`-leak, non-destructive layout switch) · `verify:ai:int` (11) ·
  `verify-agent-live` (13, **real gpt-5.4-mini**: varied layouts, bold runs,
  get_deck→set_slide_layout, slide count preserved). build/lint/tsc green.

## AI Content Agent — first real AI (OpenAI), 2026-06-15

The first real AI layer: a Cursor-style **Content Agent** docked beside the
lesson editor. A creator types a request ("write a 5-slide intro deck and a
4-question knowledge check"); the agent streams its work, mutates the course
through tools, highlights every change for review, and discusses it.

- **Provider-agnostic core** (`lib/ai/*`): a `ModelClient` seam with the OpenAI
  Responses API behind it in ONE file (`providers/openai.ts`) + a deterministic
  `providers/mock.ts`. Server-side agentic loop (`agentLoop.ts`): stream a turn →
  run tool calls → feed results back → repeat (cap 12 + checkpoint).
- **Tools = the ops layer** (`lib/ai/tools/*`): read / structural / content
  writers, all mutating ONLY through the validated CoursePatch pipeline (new
  additive `SET_BLOCK_CONTENT` patch). Tool schemas are Zod → OpenAI-strict JSON
  Schema (`schema.ts`).
- **Change-set staging**: per-turn block diff (`changeSetDiff.ts`) → reviewable
  change-set (`changeSet.ts`); Accept clears, Reject replays the inverse. Editor
  shows an amber pending ring + inline Accept/Reject (`BlockFrame`) and a panel
  review bar; pending state survives reload (server-loaded).
- **Conversation persistence + grounding**: threads/messages in Postgres,
  replayed each turn (no provider-side state); a stable, cache-friendly system
  prompt built from the course plan + current lesson (`context.ts`).
- **Migration** (human-reviewed, applied): conversations / messages /
  change_sets / change_set_items, all RLS author-only.
- **Low-stakes assessments enforced structurally**: removed
  scores/passing/time/attempts/difficulty/points/due-dates from the quiz &
  homework types, Zod schemas, patches, factories, mock, manifest, and the
  studio UI — the schemas can no longer express a grade.
- **Server-only key**: `OPENAI_API_KEY` in `.env.local` (optional `OPENAI_MODEL`
  default `gpt-5.4-mini`). Routes run on the Node runtime, stream SSE.
- **Verification**: `npm run verify:ai` (34 checks — tools/schema/patch round-
  trip, no key) and `npm run verify:ai:int` (11 checks — full loop → tools →
  persist → change-set → accept/reject vs LIVE Supabase via the mock provider).
  `npm run build` + `npm run lint` green.

## C7 — rich text runs (34/34 cumulative — Part C complete)

- **Character-level formatting** for text, heading, and callout elements:
  the model gains `runs: TextRun[]` (`{text, marks: {bold, italic,
  underline, color}}`), with a reducer-maintained invariant —
  `concat(runs.text) === text` — so lint, AI rules, measurement, and search
  keep reading plain `text` completely unchanged. Updating `text` without
  runs clears formatting (a plain rewrite resets styling); old documents
  need no migration.
- **Marks are tri-state**: `bold: false` explicitly REMOVES the element
  weight (so un-bolding a selection inside a semibold heading round-trips;
  `execCommand` toggling surfaced this in verification).
- **Editing**: double-click opens a contenteditable overlay (no new deps);
  ⌘B/⌘I/⌘U format the live selection, and the toolbar's B/I/U + text-color
  swatches route to the selection while a session is open (whole-element
  styling otherwise — toolbar buttons/swatches now preventDefault on
  pointerdown so they never steal the selection). Blur commits ONE undo
  step: text + runs + auto-grow; Esc cancels. Commit serialization
  normalizes whatever the browser produces (b/strong/i/em/u, font-weight
  styles, `<font color>`, div/br breaks) into canonical merged runs.
- Bullet lists keep the plain one-item-per-line textarea (per-item runs =
  known cut). Other known cuts: links, per-selection font size/family,
  toolbar button states don't reflect the live selection yet, inspector
  text edits stay plain (and reset formatting). `document.execCommand` is
  deprecated-but-universal — accepted for this stage, isolated behind
  `richText.ts` for a future custom range implementation.
- **Verify**: double-click any text box, select a word, ⌘B — only that word
  bolds; select all, toolbar Italic — the selection italicizes; one undo
  reverts formatting + text together.

## C6 — real 2-point lines (30/30 cumulative)

- **Lines and arrows are now genuine segments**, not horizontal boxes:
  endpoint geometry lives as frame fractions (`points` on shape elements),
  so the frame stays the selection/snap/marquee AABB and move/resize keep
  working untouched. Old documents need no migration — absent `points`
  renders the legacy horizontal mid-line.
- **Endpoint handles**: a sole-selected line/arrow swaps the 8-handle resize
  box for two endpoint dots; dragging one keeps the other fixed, reshaping
  live (transient frame + points through the shared dragStore). Endpoints
  snap to the usual edge/center candidates (⌘/Alt bypasses); **Shift
  constrains the segment to 45° increments** (verified dx=dy=429.7).
- **One patch per reshape**: new `SET_LINE_ENDPOINTS` (absolute coords; the
  reducer derives a padded AABB — min 24px on the thin axis for a usable
  hit area — and frame fractions atomically). In the AI manifest.
- Arrowheads are now proper SVG markers that orient along the segment at
  any angle; viewBox matches the logical frame, so diagonals render
  undistorted. Stroke style (dash) and color carry over.
- Known difference vs GS: hit-testing/selection still uses the AABB, not
  the stroke; connectors (snap-to-shape anchors) deliberately deferred.
- **Verify**: insert an arrow → drag its end dot anywhere — a real
  diagonal; hold Shift — it clicks to 45° steps; one undo restores.

## C5 — equal-gap spacing guides + px chips (25/25 cumulative)

- **Equal-gap snapping** (Canva/GS): dragging an element (or selection bbox)
  between two row/column neighbors snaps to the point where both gaps are
  equal — per axis, only when no edge/center snap claimed that axis, same
  threshold and ⌘/Alt bypass as everything else. Pure math in `snap.ts`
  (neighbors = non-participants overlapping the moving frame on the cross
  axis).
- **Px measurement chips**: the two gap segments render with rose chips
  showing the gap in logical px, sized against the zoom so they stay
  readable at any scale (`GuideLine.label`).
- **Verify**: three shapes in a row with uneven gaps → drag the middle one
  toward the balance point — it clicks into perfect spacing with "170 ·
  170" chips (verified gaps 170.0/170.0 in the run).

## C4 — OS clipboard integration (23/23 cumulative)

- **Element copy is mirrored to the system clipboard** as a markered JSON
  payload (`lib/editor/clipboard.ts`): ⌘V falls back to it when the
  in-memory clipboard is empty — so paste now **survives reloads and
  crosses tabs**. Same-slide/+24 and in-place placement semantics carry
  through. Foreign/malformed payloads are rejected by the normal Zod patch
  validation; permission denial degrades silently to in-memory-only.
- **Plain text from anywhere pastes as a new text element** (GS behavior):
  copy text in any app → ⌘V on the canvas (or right-click → Paste, which
  centers it on the cursor).
- **The clipboard now holds ONE thing**: copying elements clears the slide
  clipboard and vice versa (previously both ⌘V handlers could fire and
  paste a slide AND elements in one keystroke); payload markers keep the
  two paste paths from misfiring cross-session. Context-menu Paste is
  always enabled (no-op when both clipboards are empty).
- Known limitation (documented in the module): a copy in another tab won't
  beat this tab's newer in-memory clipboard until reload.
- **Verify**: copy a shape → reload the page → ⌘V: it's back (+24). Copy a
  sentence from any app → ⌘V: a text element. Paste into a text editor
  after copying an element: you get the JSON payload (machine format).

## C3 — canvas zoom (20/20 cumulative)

- **Zoom 50–300%** on top of the fit-to-width scale: toolbar − / % / ＋
  control (the % chip resets), **⌘+ / ⌘− / ⌘0** (overriding browser page
  zoom inside the editor), zoom steps ×1.25.
- The canvas container becomes a **scroll viewport** when zoomed past 100%
  (native pan via scrollbars/trackpad); zoom changes keep the viewport
  CENTER stable. At 100% nothing changes visually (no scrollbars).
- All pointer math (drag, marquee, right-click paste point, guides,
  handles) now derives from the scaled stage's own rect, so it stays exact
  at any zoom + scroll — verified: a 120-screen-px drag at 156% moves
  exactly 120/scale logical px (185.8 vs 185.8 in the run).
- Logical coordinates are untouched — elements, patches, and the document
  never see zoom.
- **Verify**: toolbar ＋ twice → 156%, scrollbars appear, drag still lands
  precisely; ⌘0 snaps back to fit.

## C2 — text reflow everywhere + TEXT_CLIPPED lint (17/17 cumulative)

User-confirmed policy: **the box grows and reformats; text is never shrunk
to fit.**

- **Style commits reflow**: changing font size/family/weight, line height,
  letter spacing, or padding on a text-like element re-measures the content
  (same hidden-twin markup as the canvas) and grows the box in the SAME
  commit — one undo reverts style + height together. Wired into both the
  toolbar and the inspector Design tab.
- **Resize commits floor at content height**: a text box can't be committed
  shorter than its re-wrapped content — narrowing it grows it taller, from
  any path (drag handles, inspector W/H fields, multi-selection bbox
  resize). Shrinking the font later does NOT shrink the box back (grow-only).
  Known difference vs GS: group resize doesn't scale font sizes, so a
  narrowed text member grows instead.
- **New lint check `TEXT_CLIPPED`** (+ one-click "Grow box to fit"): catches
  boxes shorter than their content from paths the UI can't guard (AI
  patches, imports). Lint stays UI-free via a registered measurer (the
  editor shell registers it; SSR skips the check). Seed slide 3 now trips
  it deliberately (6 lint demos).
- **Measurer rebuilt on renderToStaticMarkup** — the old createRoot +
  flushSync version was illegal during render (lint runs in render), which
  silently returned wrong heights. Static markup is synchronous and
  render-safe; measurements are cached per element id + metrics key.
- **BUG FOUND & FIXED**: the quality-hint dropdown rendered UNDER the
  sticky slide toolbar (both z-30, toolbar later in DOM) — its Fix buttons
  were unclickable in the overlap. Panel raised to z-40.
- **Verify**: select a text box → inspector W = 240 → it grows taller as
  the text wraps; font size down — height stays; font size up — it grows
  (one undo reverts both). Slide 3's badge now shows "Text is taller than
  its box" with a working one-click fix.

## C1 — audit quick wins (10/10 checks, audit-suite.mjs)

- **BUG FOUND & FIXED: right-click collapsed multi-selections.** A
  right-click also fires pointerdown, which started a move gesture whose
  pointer-up ran the deferred-collapse — so context-menu actions on a
  multi-selection silently operated on ONE element. All gesture starts
  (element move, marquee, resize handles, bbox handles) are now gated to
  the primary button; right-click preserves the selection like GS.
- **#9 Multi z-order kept honest**: reorder actions now apply in
  z-aware order (front/backward → bottom-most first; back/forward →
  top-most first), so "Send to back" on a multi-selection moves the whole
  set with its internal stacking intact (verified: z 3<4 → 0,1).
- **#10 Marquee respects the entered-group scope** — rubber-banding inside
  a group selects only that group's members (was: silently exited to root).
- **#11 Select all**: ⌘A selects every visible, unlocked element on the
  slide (works with just the slide selected too); inside an entered group
  it selects only the group's members. Also a context-menu item.
- **#12 Paste placement (GS semantics)**: the element clipboard now records
  its source slide — pasting on ANOTHER slide lands in place, same slide
  offsets +24/+24, and context-menu paste centers the clipboard's bounding
  box on the right-click point (`canvasPoint` carried in the menu state).
- **#3b Rotation honesty**: `rotation` removed from the element schema —
  validated patches can no longer introduce rotated elements while the
  selection chrome / snapping / hit-testing are axis-aligned. The TS field
  and render path remain for forward-compat (legacy data still renders).
- **#16 Thumbnails memoized**: the reducer deep-clones the doc per patch,
  so identity-based memo can't work — thumbnails now compare a WeakMap-
  cached JSON snapshot per slide and skip re-render + re-lint when their
  slide didn't change.
- **#14 Undo verified, cap raised 50 → 100**: measured the doc at ~24 KB
  JSON (3 slides; a heavy 100-slide course projects to ~780 KB → ~76 MB at
  cap 100) — snapshots are fine until real-scale docs; inverse patches
  deferred to post-Supabase (comment in store.ts records the numbers).
- **#17 Export-fidelity ledger** recorded in CLAUDE.md (justify, shadows,
  dashes, triangle, nested groups, auto-height) for when PPTX export lands.
- **Verify**: right-click one of two selected shapes → Send to back —
  BOTH go behind, still stacked the same. Copy a shape, switch slides,
  ⌘V — it lands at identical coordinates. Right-click empty canvas →
  Paste — it lands centered under your cursor. ⌘A inside vs outside a
  group. Marquee while inside a group.

## B7 — A4: shadows, align-to-selection + distribute, text auto-grow (46/46 cumulative — Part A complete)

- **Shadows**: expressive `style.shadow` model (`{color, blur, offsetX,
  offsetY, opacity}`) with a preset UI — Design tab pills None / Subtle /
  Medium / Strong. Rendered as CSS `drop-shadow` on a body wrapper, so the
  shadow follows the actual pixels (glyphs, triangle geometry, image alpha)
  and the selection ring/handles never inherit it. Custom AI-set values show
  a "custom" note instead of silently mapping to the nearest preset.
- **Align to selection + distribute** (Arrange menu, multi-selections):
  align Left/Center/Right/Top/Middle/Bottom moves every UNIT (lone element
  or whole group closure — groups never tear) to the selection bounding
  box's edge/center; Distribute H/V (3+ units) equalizes the gaps between
  adjacent units, outermost units stay put (`lib/course/slide/arrange.ts`,
  pure math). One applyMany per action = one undo. Locked elements receive
  no moves. Mock AI understands "align these to the left" / "distribute".
- **Text auto-grow (Google Slides behavior, grow-only)**: while editing, a
  hidden twin of the REAL markup (callout label row, bullet gaps — textarea
  scrollHeight gets these wrong) measures the draft each keystroke and the
  overlay grows live; on commit `commitElementTextPatches` lands text +
  height as ONE undo step, capped at the slide's bottom edge. Manually
  enlarged boxes are respected (never shrinks). The inspector Content tab
  commits through the same path via a one-shot flushSync measurer
  (`measureTextLike.tsx`), so text edited there auto-grows too.
- **Undo sweep**: the cumulative suite's cleanup phases double as the
  one-undo-per-operation audit — every editor operation introduced in Part A
  (insert, drag, resize, group, ungroup, duplicate, paste, align, distribute,
  shadow, text+grow commit) reverses with exactly one undo. 46/46 checks.
- **Verify**: select the heading → Design tab → Shadow "Medium" → soft drop
  shadow appears (one undo removes). Double-click it, add 3 lines — the
  editor grows as you type; click away — the box keeps the new height; ONE
  undo restores both text and height. Select 3 shapes → Arrange →
  "Distribute vertically" → equal gaps; "Align left" → flush left edges.

## B6 — A3d: selection-bbox multi-resize (38/38 cumulative)

- **Multi-selections now have a real transform box** (Google Slides):
  one bounding box with 8 handles around all selected members
  (`MultiSelectionBox.tsx`); dragging a handle scales EVERY member
  proportionally about the opposite edge/corner — positions and sizes scale
  by one factor, so arrangements never shear.
- **Min-size floor**: the scale factor stops where the smallest member
  would drop below the element minimum (floors capped at 1, so an already-
  tiny member just can't shrink further without wedging the gesture).
- **Same modifier language as single resize**: Shift on a corner locks the
  bbox aspect ratio; snapping moves only the dragged edge(s) with the same
  6-screen-px threshold + guides; Cmd/Ctrl/Alt bypasses.
- Handles hide while ANY member is locked (the box outline stays); the box
  follows live during move gestures too, since it derives from the shared
  dragStore frames. One `applyMany` per gesture = one undo.
- Shared resize math (`rawResize`/`anchor`/`isCorner`) exported from
  `useElementDrag` instead of duplicated.
- **Verify**: shift-click two shapes → a box with handles wraps both → drag
  its SE handle: both scale together, spacing scales, guides appear near
  snap targets; one undo restores both frames.

## B5 — A3c: nested group / ungroup (34/34 cumulative)

- **Three new patches** (Zod-validated like everything else):
  `GROUP_ELEMENTS` splices a fresh group id into each member's `groupPath`
  at the current scope depth (validates ≥2 distinct units — so groups nest,
  Google-Slides style); `UNGROUP_ELEMENTS` removes one group id from every
  path (peels exactly one level); `DUPLICATE_ELEMENTS` clones a whole
  selection in ONE patch with group ids remapped, so duplicating a group
  yields a NEW group instead of clones silently joining the original.
- **`normalizeGroups` sweep**: after delete / ungroup / duplicate / layout
  application, group ids left with <2 units are dissolved automatically —
  no orphan "groups of one" can survive any operation.
- **Shortcuts**: ⌘G groups the selection, ⇧⌘G ungroups; ⌘D now duplicates
  via the one-patch path (one undo, clones re-selected, group preserved).
- **Surfaces**: Arrange menu gains a Group/Ungroup section (and now opens
  for multi-selections); context menu gains Group/Ungroup items (disabled
  when not applicable); paste (⌘V) now also preserves group structure via
  remapped ids; lone `DUPLICATE_SLIDE_ELEMENT` strips group membership (a
  single duplicated member must not join the source group).
- **Mock AI**: "Group these elements" / "ungroup" now work on
  multi-selections; manifest `allowedActions` extended to match.
- **Verify**: insert 3 shapes → shift-click two → ⌘G → click one: both
  select as a unit. Shift-click the third → ⌘G again: nested group of 3.
  Double-click a member: enters the outer group (inner pair selected);
  Esc walks back up. ⇧⌘G peels only the outer level. ⌘D on the inner pair:
  clones appear offset +24/24, selected, and grouped together. Right-click
  → Ungroup dissolves it. Every operation is exactly one undo step.

## B4 — A3b: marquee, multi-select, multi-move (25/25 cumulative)

- **Marquee selection**: drag on empty canvas rubber-bands a selection
  (intersection semantics, like Google Slides; hidden/locked excluded; plain
  click still selects the slide). Marquee rect renders live.
- **Shift-click** toggles whole *units* (an element, or its entire group
  closure once groups exist) in/out of the selection.
- **Deferred collapse** (GS behavior): pointer-down on a selected member
  never breaks the selection — dragging moves ALL members (uniform delta,
  bounding-box clamped, bbox-snapped, locked members stay put, one undo);
  a plain *click* collapses to the clicked unit on pointer-UP.
- **Group navigation scaffolding**: double-click descends into a group
  (selection scope), Esc walks up the ladder (members → enclosing group →
  slide). Double-click still opens the text editor when the element is the
  sole selection (edit gate via `soleSelected`).
- **Multi keyboard**: arrows/Delete/⌘D/⌘C/⌘X/⌘V all operate on the whole
  selection as single undo steps.
- **DOM/AI**: selected elements now carry `data-ai-selected` — agents (and
  the test suite) can read selection state straight from the DOM.
- **Verify**: marquee over several elements → drag one member → all move,
  one undo restores all; shift-click to build a selection; click one member
  → collapses to it.

## B3 — A3a: snapping + guides, aspect-lock, element clipboard, context menu (19/19 cumulative)

- **Smart guides + snapping** (`lib/course/slide/snap.ts`): dragging snaps
  edges/centers to slide edges/center and to every other visible element's
  edges/centers; rose guide lines (1 screen px) render during the gesture.
  Threshold ≈ 6 *screen* px converted through the stage scale, so snapping
  feels identical at any zoom. **Cmd/Ctrl or Alt bypasses snapping.**
  Keyboard nudges never snap. Resize snaps only the dragged edge(s).
- **Shift = aspect-lock** on corner resize handles (anchored at the opposite
  corner; with snapping the dominant axis snaps, the other re-derives).
- **Element clipboard**: ⌘C/⌘X/⌘V on selected element(s) — paste re-ids,
  offsets +24/24, and selects what was pasted. Stored in-memory (uiStore,
  not persisted, separate from the slide clipboard).
- **Right-click context menu** on canvas elements (Cut/Copy/Paste/Duplicate/
  Delete + z-order; multi-aware: acting on one member of a selection acts on
  all) and on empty stage (Paste). Esc/backdrop closes. Right-click selects
  the element under the cursor unless already selected (Google Slides
  semantics).
- **BUG FOUND & FIXED (real UX bug surfaced by verification): selection used
  to change the toolbar's height** — contextual buttons appeared, the
  toolbar wrapped to a second row, and the entire canvas jumped ~16px mid-
  interaction. Element actions now render permanently and disable without a
  selection (constant toolbar height, like Google Slides). Regression-checked
  (`dy=0.0`).
- **Verify**: drag a shape near the slide center → rose guide appears and it
  clicks into place; hold ⌘ to place it 4px off an edge freely; Shift-drag a
  corner handle → ratio locked; ⌘C/⌘V → offset copy; right-click → menu.

## B2 — A2: shapes as first-class objects (8/8 cumulative checks)

- **Shape picker** in the toolbar Insert group (replaces the lone
  rectangle-only button): rectangle, rounded rectangle, ellipse, triangle
  (new `ShapeKind` + SVG polygon renderer), line, arrow — each with
  kind-appropriate default frames (`addShapePatch` in commands.ts). Rounded
  rectangle = rectangle + 24px corner radius preset (not a separate kind;
  radius stays editable).
- **Stroke style**: `borderStyle: solid | dashed | dotted` added to the
  element style model/schema; renders via CSS border for boxes and
  `stroke-dasharray` for triangle/line/arrow.
- **Inspector Design tab — Stroke section** (all element types): stroke
  color swatches, width, style pills. Fill/radius/opacity were already
  present; shadow lands in B7.
- Shapes already shared select/move/resize via the element pipeline; they
  now also participate in everything later batches add (snap, multi-select,
  group) for free.
- **Verify**: toolbar ⬡ Shapes → insert each kind; select the triangle →
  Design tab → Stroke width 4 + "dashed" → dashed outline; every insert and
  style change is one undo step.

## B1 — A1: text alignment fixed; object alignment moved to Arrange (11/11 checks)

- **BUG FIX (P0)**: the toolbar's align buttons previously MOVED the text box
  (`moveElementPatch`); they were removed from the element group. Text
  alignment is now a proper text control.
- **Text toolbar** gains two popovers (enabled for text/heading/callout/
  bullet list): *Text alignment* — left / center / right / **justify**
  (new option in the model + schema) — and *Vertical alignment* — top /
  middle / bottom. Both write `style.textAlign` / `style.verticalAlign` via
  `UPDATE_SLIDE_ELEMENT`; the box frame is untouched (verified byte-identical
  left/top/width).
- **Arrange menu** (new toolbar dropdown, Google-Slides "Arrange > Align"):
  *Position on slide* — Left/Center/Right/Top/Middle/Bottom — moves the BOX
  via `MOVE_SLIDE_ELEMENT` (new `alignedY` helper in geometry.ts). Menu
  closes on action, like Slides. Align-to-selection + distribute land in B7.
- Inspector Design tab: justify option + vertical-alignment pills added for
  parity.
- **Verify (click-path)**: select the "Two Pointers" heading on slide 1 →
  toolbar ¶-align button → Center: the text re-centers inside its box while
  the box stays put (watch x/y/w/h in Design tab). Toolbar ↕ button → Middle:
  text drops to the box's vertical center. Toolbar "Arrange" → Left: now the
  BOX moves to the slide's left margin. One undo per action.

## B0 — Selection groundwork (foundation, no visible behavior change)

- **Selection model**: added multi-select kind
  `{kind:"elements", ids, slideId, blockId, lessonId, scope?}` and an optional
  `scope` (entered-group path) to single-element selections
  (`lib/course/types.ts`).
- **Group encoding**: `groupPath?: string[]` on every slide element (nested,
  Google-Slides-style; outermost group first) + pure navigation helpers in
  `lib/course/slide/groups.ts` (unit closures, scope checks, degenerate-group
  detection). No UI yet — lands in B4/B5.
- **Selection repair fixes** (`lib/course/store.ts`, `lib/course/queries.ts`):
  multi-selections shed deleted ids instead of being destroyed by the
  after-commit repair; FIXED pre-existing bug where deleting a selected
  element collapsed selection to *course* instead of its lesson.
- **Transient gesture store** `lib/editor/dragStore.ts` (deliberately separate
  from the persisted uiStore — pointermove-frequency writes must not hit
  localStorage). `useElementDrag` now writes per-participant frames there;
  dragging an element of a future multi-selection moves the whole selection,
  clamped by the selection bounding box (not per-element, which would shear
  arrangements). One `applyMany` per gesture = one undo step, as before.
- Mock AI: minimal handling for multi-selections (batch delete; group/align
  verbs arrive with the Arrange feature).

**Verify**: existing flows unchanged — drag/resize a single element, undo once
restores it; selection ring/handles as before. (Covered by the B1 Playwright
run.)
