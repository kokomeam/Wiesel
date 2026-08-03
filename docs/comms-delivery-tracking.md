# Learner-comms delivery tracking — Resend webhooks (Milestone 7)

Per comms record, we know whether the email was **sent → delivered → opened /
clicked**, or **bounced / complained** — and a bad address is suppressed before
it can damage sender reputation. Source of truth: `lib/comms/webhook.ts` +
`lib/webhooks/svix.ts` + migration `20260707000000_comms_delivery_tracking.sql`
+ the route `app/api/comms/webhooks/resend/route.ts`.

## Architecture

```
approveAndSend (lib/comms/service.ts)
  ├─ suppression gate (comms_suppressions re-read AT SEND TIME)
  ├─ Resend POST + tags: send_source=learner_comms, message_id, course_id, user_id
  └─ learner_messages: provider_message_id, delivery_status='sent', trail seeded

Resend ──Svix-signed POST──▶ /api/comms/webhooks/resend
  1. raw body read BEFORE parsing (signature covers exact bytes)
  2. verifySvixSignature (shared, lib/webhooks/svix.ts — HMAC + ±5min tolerance)
  3. mapResendEvent → comms_email_* | trail-only (email.sent/delivery_delayed)
  4. attribute: provider_message_id lookup → message_id-tag fallback
  5. emitCommsDeliveryEvent (learning_events; clientEventId = uuidFromSvixId)
  6. apply_comms_delivery RPC (atomic: rank-monotone status + svixId-deduped trail)
  7. hard bounce / complaint → upsert comms_suppressions
```

- **Two Resend endpoints coexist.** Resend webhooks are account-wide, so this
  endpoint also receives marketing-suite events (and vice versa). Each ignores
  what isn't its own: this one filters on the `send_source` tag and drops
  events with no matching `learner_messages` row; the marketing endpoint
  (`/api/marketing/webhooks/resend`) drops on its `scheduled_send` lookup miss.
  Each endpoint has its OWN Svix signing secret.
- **Idempotency is ID-based, not reconciliation-based.** The Mux webhook
  re-fetches asset state, so duplicates converge naturally; delivery events
  are deltas with nothing to re-fetch. `svix-id` is stable across retries →
  `client_event_id = uuidFromSvixId(svixId)` and the `learning_events` UNIQUE
  constraint make redelivery a no-op. Trail entries dedupe on the stored
  `svixId`; the status ladder (`none < sent < delivered < opened < clicked <
  bounced < complained`) only ever climbs, so out-of-order webhooks can't
  downgrade. Side effects re-run on duplicates (they're idempotent), so a
  retry after a partial failure self-heals.
- **HTTP contract:** 503 unconfigured · 401 bad signature · 400 bad JSON ·
  **200 for unattributable/foreign/unknown events** (Svix retries on failure
  status — never let it retry-storm events we'll never own) · 500 only on
  infrastructure failure (we WANT the retry).
- **Attribution trust:** the learner is always `learner_messages.user_id`.
  Tags are routing hints — a forged `user_id` tag changes nothing. The
  `message_id`-tag fallback (for a webhook racing the send commit) is accepted
  only when the row's provider id is unset or matches the event's `email_id`.

## The comms record trail (`learner_messages`)

- `delivery_status` — the single authoritative state the dashboard and M8
  measurement read. Seeded `'sent'` by `approveAndSend`, advanced only by the
  `apply_comms_delivery` RPC (service-role-only; `FOR UPDATE` lock).
- `delivery_events` — audit trail, `{type, at, via: send|webhook, svixId?,
  detail?}`, capped at 50 entries. `email.sent` / `email.delivery_delayed` log
  here without minting analytics events (low signal, keeps the taxonomy clean).

## Suppression (`comms_suppressions`)

- Per **user** (a hard-bouncing address is bad for every course), reasons
  `hard_bounce` (Resend bounce.type `Permanent` — `Transient`/`Undetermined`
  never suppress) and `complaint`.
- RLS enabled, **zero policies** (the `quiz_answer_keys` precedent): only the
  service role touches it. `approveAndSend` re-checks it at send time →
  `{ok:false, reason:"suppressed"}`, row STAYS draft. Creators see suppression
  state only through `GET /api/comms/messages` (advisory `suppressions` map for
  learners whose messages they already own); the composer replaces its send
  button with a "Suppressed: bounced/complained" notice.
- M8 will also exclude suppressed learners at flag-filing time.

## Setup (Resend dashboard)

1. Resend → **Webhooks → Add endpoint** →
   `https://<your-domain>/api/comms/webhooks/resend`.
2. Select the event types: `email.sent`, `email.delivered`,
   `email.delivery_delayed`, `email.opened`, `email.clicked`, `email.bounced`,
   `email.complained`.
3. Copy the endpoint's signing secret (`whsec_…`) into
   **`RESEND_COMMS_WEBHOOK_SECRET`** in `.env.local` / production env. This is
   a DIFFERENT secret from the marketing endpoint's `RESEND_WEBHOOK_SECRET` —
   Svix secrets are per-endpoint.
4. **Open & click tracking must be enabled on the sending domain** (Resend →
   Domains → your domain → enable "Open tracking" + "Click tracking"),
   otherwise `email.opened` / `email.clicked` never fire and delivery status
   stops at `delivered`. Note the usual caveats: opens undercount (image
   blocking) and overcount (Apple MPP prefetch) — clicks are the honest signal.
5. Without the secret the route answers 503 and processes nothing; the system
   degrades gracefully (sends still work, statuses just stay at `sent`).

## Tests

`npm run verify:comms` (61 pure — Svix verifier incl. tamper/replay, event
mapping incl. bounce taxonomy, uuid derivation, tags, the contract extension) ·
`npm run verify:comms:int` (46 live — end-to-end webhook processing,
idempotency, rank-monotone trail, suppression enforced at the send seam,
attribution edges, forgery surface).
