# Task 0a findings — Upload-Post as `SocialPublishProvider` + Inngest runtime

> Status: **COMPLETE — all live tests run 2026-07-23.** Scope: **LinkedIn + YouTube only**
> (TikTok / Instagram / Facebook deferred to Task 0b). Profile `henry`, plan `"Default"` (free,
> 10 uploads/month). Raw evidence (redacted) in [`samples/`](./samples/).
>
> **Budget accounting:** 3 publish calls fired (the approved hard cap) — but only **2 counted
> against quota** (the rejected duplicate didn't consume; `usage.count` = 2 of 10).
> **8 uploads remain for Task 0b.**

## Pass/fail — tests 1–5

| # | Test | Verdict | Evidence |
|---|------|---------|----------|
| 1 | **LinkedIn: result retrieval + idempotency + first comment** (2 uploads) | **PASS** — post ID + URL retrievable via API **two ways** (sync response AND history); identical second call **rejected, not double-posted** ("Duplicate post detected. LinkedIn prevents posting the same content consecutively"); **first comment landed and is verifiable via API** (`GET /uploadposts/comments`). The disqualifying criterion (external_ref unreachable) is cleared decisively. | `samples/01-test1-upload-text-call1.json` · `02-…call2-identical.json` · `03/04-…history…` · `05-test1-summary.json` · `06-test1-first-comment-verified.json` |
| 2 | **YouTube Shorts: vertical video E2E** (1 upload) | **PASS** — async accepted in 3.3 s → platform-complete at **9 s** → **live on YouTube at 19.3 s** (target ≤120 s; single sample). Video ID `oG1hZXB2EJ8` + URL retrievable from **both** the status poll and history. **Registered as a Short** (confirmed by canonical URL + `isShortsEligible:true` + `/shorts/` serving directly, desktop and mobile) — with a ~2–3 min classification lag caveat. | `samples/01-test2-upload-youtube-async.json` · `02-test2-status-final.json` · `03/04-test2-history…` · `06-test2-summary.json` · `08-test2-shorts-confirmation.json` |
| 3 | **Delete** (0 uploads) | **NO API DELETION — confirmed live.** 7 probes across plausible paths (LinkedIn URN + YouTube video ID; DELETE and POST forms) all 404. Matches the spec (no delete-published-post endpoint exists). Retraction is manual on-platform; support question filed. Not disqualifying: publish is irreversible-tier in our marketing gate regardless. | `samples/01-test3-delete-probes.json` |
| 4 | **Docs pass: limits / errors / lifecycle / scheduling / webhooks** (0 uploads) | **DONE** — taxonomy below. Notable live findings: failed uploads don't consume quota; the webhook config endpoint's documented base is wrong; webhook_events shape contradicts between spec and docs; **zero webhook deliveries observed**; history `limit` is quantized. | `samples/02-test4-deliberate-400.json` · `03-webhook-configure-corrected.json` · `07-webhook-shape-contradiction.json` |
| 5 | **Inngest durable runtime** (0 uploads) | **ALL PASS** (2026-07-17) — `sleepUntil` to a 2-min-out timestamp woke with **389 ms drift**; `cancelOn` event cancelled an in-flight 10-min sleep instantly (the following step never ran); `RetryAfterError` produced exactly one retry after the requested 5 s. | `inngest/spike-results.json` · `inngest/results.json` |
| — | TikTok | **DEFERRED — Task 0b** (not connected; free-plan 403 risk to verify) | — |
| — | Instagram Reels | **DEFERRED — Task 0b** (not connected) | — |
| — | Facebook Page | **DEFERRED — Task 0b** (account connected but `GET /uploadposts/facebook/pages` → 404 "No Facebook pages found" — a Page must be linked before 0b can post) | — |

## Test 1 detail — the exactly-once + attribution story

- **Sync response is reference-complete.** `POST /upload_text` (LinkedIn) returned in ~5–7 s with
  `results.linkedin.{success, post_id, url, platform_post_id, status:"completed", attempts}` plus
  `usage {count, limit, last_reset}`, `request_id`, `job_id`. `post_id` = the LinkedIn URN
  (`urn:li:share:7485955623193542656`), `url` = the public post URL → **fills `external_ref`
  directly from the publish call**, no second request needed.
- **Idempotency is better than spec predicted.** The spec has no idempotency key, so we expected a
  double-post. Instead the immediate identical call returned HTTP 200 with
  `results.linkedin.success:false`, `status:"failed"`, and the verbatim platform error
  *"Duplicate post detected. LinkedIn prevents posting the same content consecutively."* — i.e.
  LinkedIn's own consecutive-duplicate check is surfaced cleanly, only ONE post went live. Caveats
  for the adapter: this is a **LinkedIn-side** protection (consecutive+identical only), not
  provider-level idempotency — non-adjacent or slightly-varied content will double-post. Our
  exactly-once story stays **verify-before-republish**: on ambiguous failure, scan `history`
  (`request_id` / title + window) before re-firing.
- **Quota semantics (measured):** `usage.count` stayed at 1 after the failed duplicate —
  **failed uploads do not consume the monthly quota**.
- **First comment: PASS, on the TEXT endpoint, via the generic param.** `/upload_text` has no
  `linkedin_first_comment` (that exists only on `/api/upload` video), but the generic
  `first_comment` **landed on the LinkedIn text post**. Better: it's **verifiable via API** —
  `GET /uploadposts/comments?user=henry&platform=linkedin&post_id={urn}` returns the comment
  (exact text + LinkedIn comment URN). Docs are Instagram-focused but the endpoint works for
  LinkedIn; note the query param is `user`, not `profile` (400 otherwise).
- History shows **both** attempts (success row with `platform_post_id` + `post_url`; failed row
  with `success:false` and null refs) — a clean audit trail.

## Test 2 detail — async path + Shorts

- `POST /upload` with `async_upload=true` → 200 in 3.3 s:
  `{success, message:"Upload queued successfully in the durable worker.", request_id, total_platforms, job_id}`.
- **The async status poll is richer than the spec.** OpenAPI documents only
  `{platform, success, message, upload_timestamp}` per result — the real response carries
  `platform_post_id`, `post_url`, `media_type`, `media_size_bytes`, and structured failure fields
  (`error_message`, `error_signature`, `error_code`, `failure_stage`). **`verifyPost` can be built
  on the status poll alone**; history remains the audit/backstop. (This closes the draft's
  criterion-1 caveat — in our favor.)
- Timeline (single sample): API call t0 → platform-complete **9 s** → public URL returning
  HTTP 200 at **19.3 s**. Well inside the 120 s target. `video_was_transcoded:false`, `changes:[]`
  (the ffmpeg-generated clip passed prevalidation untouched).
- **Shorts registration: YES, with lag.** ~30 s after upload, `/shorts/{id}` still redirected to
  `/watch` (not yet classified). ~3 min after upload: `/shorts/{id}` serves directly (desktop and
  mobile UA), the watch page's canonical URL is the `/shorts/` URL, and the page source carries
  `"isShortsEligible":true`. Adapter rule: don't assert Short-ness in the immediate verify pass.

## Test 4 detail — taxonomy

**Error shapes (all observed live):**
- 400 validation: `{"success":false,"message":"Invalid platforms for text post: ['myspace']"}` —
  rejected before quota.
- 401: `{"success":false,"message":"Invalid API key format"}`.
- 404 (unknown route): `{"error":"Not Found","message":"The requested URL was not found…","request_id":…}` —
  note this shape differs from the `{success:false}` family.
- Platform-level failure inside HTTP 200: `results.{platform}.{success:false, error, status:"failed", attempts}` —
  publish outcomes are per-platform, never a top-level HTTP error.
- History: `GET /uploadposts/history?limit=5` → `{"error":"Invalid limit"}` — **`limit` is
  quantized** (10 works; 5 doesn't; valid set undocumented). Treat `limit=10` as the safe page size.
- Docs-only (not triggered): 429 monthly `{…,"usage":{count,limit,last_reset}}`; Professional-tier
  per-account daily cap ("daily limit of 5 uploads for: …"); 403 plan-gating (e.g. TikTok on Free).

**Rate limits:** no per-minute/per-hour limit documented anywhere; **no `X-RateLimit-*` /
`Retry-After` headers observed** on any captured response (samples record full headers). The only
enforced limits are the monthly quota and (paid tier) per-account daily caps. Support question filed.

**Quota visibility gap:** `usage` rides **only in sync upload responses** (and 429 bodies). The
async accept has no `usage`; `GET /uploadposts/me` returns plan but no counter. There is **no free
endpoint that reports current usage** — an adapter must track it from sync responses or tolerate
429s. Support question filed.

**Token expiry / disconnection signaling:** per-platform
`social_accounts.{platform}.reauth_required` on `GET /uploadposts/users` (live: `false` for both
connected accounts, with `display_name`/`handle`/avatar), plus documented webhook events
`social_account_connected` / `_disconnected` / `_reauth_required` carrying a `reason`
(`manual_disconnect`, `account_blocked`, `token_refresh_threshold_exceeded`, `max_auth_strikes`).
Good signal surface — but see the webhook delivery caveat below.

**Webhooks (mixed picture — the weakest area found):**
- The OpenAPI `servers` override pointing config at `app.upload-post.com` is **wrong**: that host
  serves the dashboard SPA (POST → raw nginx `405 Not Allowed` HTML). The endpoint actually lives
  on the normal base: `POST/GET https://api.upload-post.com/api/uploadposts/users/notifications`.
- **Spec vs docs contradiction** on `webhook_events`: spec says an *array of dot-form names*,
  docs say an *object of underscore-name booleans* (all-enabled if omitted). The API accepts and
  persists **either shape verbatim — no validation**.
- **Zero deliveries observed**: with the (spec-shape) config active and confirmed persisted, two
  successful uploads produced **no** `upload_completed` POSTs to the webhook.site inbox
  (re-polled minutes later). Root cause unknown (shape mismatch? free-tier gating? async-only?).
  Config is now left in the **docs-shape** form; **delivery verification is deferred to Task 0b**
  (which fires uploads anyway).
- Docs state delivery is at-least-once ("strive for exactly once — handle duplicates"), payload
  carries `job_id` for correlation, and there is **no signature/HMAC** anywhere. Adapter rule
  (same as our Mux handling): webhooks are **hints** — always re-verify via the status/history API
  before trusting.

**Scheduling (documented, NOT used — our runtime owns fire times):** `scheduled_date`
(ISO-8601, ≤365 d ahead) + `timezone` (IANA) on the upload endpoints; `add_to_queue` with
queue-slot management (`/uploadposts/queue/{settings,preview,next-slot}`); scheduled-job CRUD
`GET/PATCH/DELETE /uploadposts/schedule/{job_id}`. We deliberately ignore all of it — Inngest
(proven in test 5) owns fire times, so scheduling stays in OUR domain (cancellation, rescheduling,
and observability under our control, provider-agnostic).

## Test 5 — Inngest (durable runtime): ALL PASS ✅

| Behavior | Result | Proof |
|---|---|---|
| `step.sleepUntil` (timestamp 2 min out) | woke at `09:11:58.898Z` vs target `09:11:58.510Z` = **389 ms drift** | `inngest/spike-results.json` |
| Cancel by event (`cancelOn` + `match: "data.runKey"`) | run → `Cancelled` the moment the event landed (+10 s); in-flight 10-min sleep aborted; the step after it never executed | dev-server run `01KXQNDY7Q054MR0EKV9YPS7ZG` |
| Step retry on thrown error | `RetryAfterError(…, "5s")` → exactly one retry, succeeded on attempt 2, 5 s later | run output `{succeededOnAttempt: 2}` |

**Free-tier (Hobby) limits:** sleeps ≤ **7 days**/step · **5 concurrent steps** · **50 k
runs/month**; sleeping runs do NOT count against concurrency — the right shape for
publish-at-scheduled-time workloads. **Gotcha:** the local dev server's
`GET /v1/events/{id}/runs` reports `Completed` with `ended_at:null` for runs that are actually
sleeping — don't use it for liveness; `Cancelled`/`Failed` + function-side evidence are reliable.

## Proposed `SocialPublishProvider` → Upload-Post mapping

| Provider method | Upload-Post endpoint | Status / notes |
|---|---|---|
| `createCreatorProfile(id)` | `POST /api/uploadposts/users {username}` | 201; 409 on duplicate → treat as success (idempotent-ish) |
| `getLinkUrl(id, platforms, redirect)` | `POST /api/uploadposts/users/generate-jwt` | **verified live** — `access_url` valid 48 h; `platforms` filter, `redirect_url`, branding params. The flow works end-to-end: the user completed it and the accounts appeared connected |
| `listConnectedAccounts(id)` | `GET /api/uploadposts/users` | **verified live** — `social_accounts.{platform}.{display_name, handle, social_images, reauth_required}` |
| `publish(post)` | `POST /api/upload` \| `/upload_text` \| `/upload_photos` | **verified live (both modes)** — sync: refs + `usage` in the response; async: `{request_id, job_id}` and refs come from the status poll. Per-platform first comments via `first_comment` + `{platform}_first_comment` overrides (generic works on LinkedIn text — proven) |
| `verifyPost(ref)` | `GET /uploadposts/status?request_id=` → backstop `GET /uploadposts/history` (`limit=10`) | **verified live** — status carries `platform_post_id` + `post_url` + structured failure fields (richer than spec). History = audit trail incl. failed attempts. Webhook = hint only |
| `verifyFirstComment(ref)` *(bonus)* | `GET /uploadposts/comments?user&platform&post_id` | **verified live on LinkedIn** — returns comment text + platform comment ID |
| `deletePost(ref)` | **NO ENDPOINT — proven live (test 3)** | capability absent; encode as `capabilities.delete=false`; retraction is manual |
| connection health | `reauth_required` flag + `social_account_*` webhook events | flag verified live; webhook delivery unverified (see gaps) |

## Benchmark lens — vs industry-standard vertical agentic SaaS (Ayrshare-class)

| Dimension | Assessment | Shortfalls |
|---|---|---|
| Hosted linking flow | **At par.** JWT `access_url` with platform filter, redirect, and branding (logo/title); connected accounts return display name/handle/avatar for a real "connected as …" UI. Proven end-to-end on this account. | 48 h link expiry is short but regenerable — *cosmetic* |
| Token lifecycle signaling | **Good surface**: per-platform `reauth_required` + disconnection webhooks with machine-readable `reason`. | Webhook delivery unproven (0 observed) — *potentially structural* until 0b verifies; polling `GET /uploadposts/users` is the reliable fallback |
| API ergonomics | **Adequate-to-good.** Sync publish returns everything (refs + quota) in one call; async status is reference-complete; per-platform overrides are consistent (`{platform}_{field}`). | Multipart-form for text posts (*cosmetic*); spec/docs contradictions — webhook base, webhook_events shape (*doc quality, moderate*); config endpoint silently accepts invalid shapes (*moderate*); quantized history `limit` with an unhelpful error (*cosmetic*); no idempotency key (*moderate — mitigated by platform-side dup rejection + verify-before-republish*); no quota read endpoint (*cosmetic*) |
| Failure transparency | **Strong.** Per-platform verbatim platform errors (the LinkedIn duplicate message), structured `error_code`/`failure_stage` in async results, `attempts` count, failed uploads don't burn quota, history keeps failed rows. | None significant |
| Capability coverage | Publish/verify/link/list all there. | **No delete API** (*structural*, Ayrshare has one — acceptable because our gate treats publish as irreversible); webhooks unsigned (*structural but standard mitigation: re-verify via API*) |

Net: the connector experience is genuinely Ayrshare-class on the flows that matter to our adapter
(link → list → publish → verify). The shortfalls cluster in documentation quality and the webhook
channel — neither blocks the adapter design, because verification is poll-first by construction.

## Task 0b prep — exact request shapes (from the live OpenAPI spec; zero uploads spent)

All multipart/form-data on the same three endpoints; `user` + `platform[]` (+ media) required.

**TikTok video** — `POST /api/upload`: `platform[]=tiktok`, `video`, `title`
(+ `tiktok_title` override). Options: `privacy_level` (default `PUBLIC_TO_EVERYONE`; enum
`MUTUAL_FOLLOW_FRIENDS`/`FOLLOWER_OF_CREATOR`/`SELF_ONLY`), `disable_duet`, `disable_stitch`,
`cover_timestamp` (ms, default 1000), `brand_content_toggle` (paid partnership),
`brand_organic_toggle` (own business). ⚠️ verify the Free-plan 403 gate first — it's the
documented example for plan-gating. No TikTok-specific first-comment param.

**Instagram Reels** — `POST /api/upload`: `platform[]=instagram`, `video`, `title`
(+ `instagram_title`). Options: `media_type` (default `REELS`, or `STORIES`), `share_to_feed`
(default true), `collaborators` (comma-separated usernames), `cover_image` (JPEG ≤8 MB) or
`cover_url` (url wins), `thumb_offset`, `instagram_first_comment` / generic `first_comment`.

**Facebook Page video** — `POST /api/upload`: `platform[]=facebook`, `video`,
`facebook_page_id` (**required**, auto-detected only if exactly one Page is connected),
`facebook_media_type` (default `REELS`, or `STORIES`), `facebook_title`, `facebook_description`,
`facebook_first_comment`. **Prerequisite found live:** henry's Facebook connection has no Page —
`GET /uploadposts/facebook/pages` → 404 "No Facebook pages found". A Page must be linked before
0b can test Facebook. Text posts: `/upload_text` supports `facebook_link_url` for link previews.

**0b should also:** re-verify webhook delivery with the docs-shape config (already left in place),
observe whether a single multi-platform call counts 1 or N against quota, and capture the TikTok
403 body if the free-tier gate is real.

## Gaps / ambiguities (final 0a list)

1. **No published-post deletion API** — proven live (7 probes, all 404). Manual retraction only.
2. **Webhook delivery unproven**: 0 deliveries after 2 successful uploads; spec/docs disagree on
   the `webhook_events` shape; endpoint accepts anything without validation; payloads unsigned.
   Poll-first verification is mandatory; 0b re-tests delivery.
3. **OpenAPI `servers` override for notifications is wrong** (points at the SPA host → nginx 405).
4. **No idempotency key.** Mitigated: LinkedIn rejects consecutive identical content (proven), and
   the adapter's recovery path is verify-before-republish via `history`/`request_id`.
5. **No quota read endpoint** — `usage` only in sync upload responses and 429 bodies.
6. **History `limit` quantized** with a bare `{"error":"Invalid limit"}`; valid set undocumented.
7. **Shorts classification lags** upload by ~2–3 min — verify passes must tolerate the transient
   `/watch` redirect.
8. `linkedin_first_comment` is video-endpoint-only, but the **generic `first_comment` works on
   text posts** (proven) — asymmetry to encode in provider capabilities, not a blocker.

## Open questions for Upload-Post support

1. Any API (or roadmap) to delete/retract a published post?
2. Webhooks: which `webhook_events` shape is canonical (spec array vs docs object)? Are webhooks
   delivered on the Free plan? Retry policy on non-2xx? Any signing header planned?
3. Idempotency keys / provider-side dedupe beyond LinkedIn's consecutive-duplicate rejection?
4. Per-minute/per-hour API rate limits, and are limit headers ever returned?
5. Endpoint to read current monthly `usage` without firing an upload?
6. Valid `limit` values for `/uploadposts/history`?
7. Does one multi-platform call count 1 or N against the monthly quota?
8. Is TikTok publishing available on the Free tier (docs imply 403)?

## Go / no-go recommendation

**CONDITIONAL GO** for Upload-Post as the default `SocialPublishProvider`.

**Proven (0a):** the disqualifier is cleared with margin — platform post ID/URL retrievable via
two independent API paths on both platforms; publish→live latency excellent (19 s, target 120);
Shorts registration works; first comments work AND are API-verifiable; failure transparency is
strong; the hosted linking flow is Ayrshare-class; accidental double-posting of identical
consecutive content is platform-rejected. Inngest is a clean **GO** as the durable runtime
(sleep/cancel/retry all proven; free tier fits scheduled-publish workloads).

**Contingent on Task 0b:** TikTok (free-tier 403 risk), Instagram Reels, Facebook Page coverage
(Page linkage prerequisite discovered), and webhook delivery with the corrected config shape.

**Fallback:** **Postproxy**, if 0b disqualifies (trip-wires: a platform we need being hard-gated,
or systemic result-retrieval failure on the 0b platforms — neither seen on 0a platforms).

## Cleanup checklist

- [ ] LinkedIn: delete the ONE live test post `urn:li:share:7485955623193542656`
      (https://www.linkedin.com/feed/update/urn:li:share:7485955623193542656/) — the duplicate
      attempt never posted. Its first comment deletes with the post.
- [ ] YouTube: delete video `oG1hZXB2EJ8` (https://www.youtube.com/watch?v=oG1hZXB2EJ8) via
      YouTube Studio (no API delete).
- [ ] After Task 0b: remove the webhook config (points at a throwaway webhook.site inbox
      `4b340de7-…`) — keep it until 0b so delivery can be re-tested.
- [ ] Throwaway local files: `state.json`, `webhook-inbox.json` (git-ignored spike dir).
