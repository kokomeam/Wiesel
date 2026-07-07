# Social Post Generator — Marketing Phase 1

> PRD: `docs/prd/Social-Media-Post-Generator-Marketing-Web.html` · shipped 2026-07-06.
> Phase 1 of 4: the **generation backbone**. The creator publishes everything
> manually — WiseSel never connects to, schedules on, or posts to any social
> platform in this phase. Phase 1.5 adds lesson-video repurposing, Phase 3 a
> unified social API + real scheduling, Phase 4 the closed loop.

## What it is

Creators turn real course content into 1–5 platform-ready **LinkedIn /
Facebook** drafts — grounded in actual modules and outcomes, shaped by a
derived per-creator **voice profile**, tagged with a **funnel stage**
(tofu/mofu/bofu), planned on a manual posting calendar, and exported by
copy/download. Manual performance logging starts accumulating closed-loop data
from day one. Instagram is deliberately excluded until image/video generation
ships (it's an image-first platform); the platform enum is closed at 2.

## Architecture (three spines, same as the rest of the marketing suite)

```
UI (app/(app)/marketing/social + components/marketing/social)
REST (app/api/marketing/social-posts/* · social-voice-profile/*)
Agent (19 tools in lib/marketing/tools/socialPosts.ts)
        ╲            │            ╱
         executeMarketingTool → THE GATE (read executes · reversible
         auto-commits + before-snapshot + revert window · NOTHING here
         is irreversible — no approval cards, by design)
                     │
         lib/marketing/social/*  (the service layer)
                     │
         social_post_batch · social_post · social_voice_profile
         (+ the single analytics_event stream, 13 new event types)
```

- **All three surfaces call the same tools.** REST mutations go through
  `executeMarketingTool` too — that's what gives UI edits revert-log entries
  and makes the per-day revision budget countable on the `marketing_action`
  ledger (RLS scopes the count per creator).
- **Everything is reversible-tier.** The gate stages each write with a
  before-snapshot; `social_post_batch` has a **composite snapshotter**
  (batch + posts) so reverting a generate/variants call restores the post SET
  byte-for-byte. Because posts are **soft-delete-only** (zero delete policies),
  revert-of-create *archives* rather than deletes.

## The generation pipeline (`lib/marketing/social/generate.ts`)

1. **Resolve source context** — `contextAssembly.ts` reuses
   `loadCourseMarketingContext` (never a second retriever) + module/lesson
   narrowing + verbatim creator text; token budget `SOCIAL_CONTEXT_MAX_TOKENS`
   (default 6k, ~4 chars/token) with PRD priority truncation.
2. **Voice profile** — `ensureSocialVoiceProfile` loads or derives+persists
   (small tier; deterministic fallback keeps the zero-key path whole). The
   email suite's `voice_profile` rules feed the derivation as extra signal.
3. **Prompt** — `prompt.ts`: byte-stable static prefix (role + both platform
   style guides + safety rules; prompt-cache eligible) → voice block → context
   block → request block. **`PROMPT_VERSION`** is stamped into `ai_metadata`
   on every batch and post — bump it whenever the static prefix or output
   contract changes.
4. **ONE structured batch call** (mid-tier, `stream:false`), wrapped in
   `withSemaphore` (the platform-wide 2-concurrent-call ceiling) under the
   hard `SOCIAL_GENERATION_TIMEOUT_MS` ceiling (default 180s — quality-first,
   NOT a latency target; timeout ⇒ typed error, nothing persisted).
5. **Zod gate + exactly one repair call** — the repair input carries the
   invalid JSON + issue paths; the mock provider routes it by the
   `social_post_batch_repair` responseFormat name, so tests script
   invalid-then-valid without mock changes.
6. **Deterministic safety lint** (`lint.ts`, table-driven) — earnings claims,
   fabricated student results, fake scarcity, fabricated testimonials, hashtag
   stuffing, ALL-CAPS. **Creator-supplied context whitelists its own claims.**
   Flagged drafts get the repair pass (if unused) or drop with a surfaced
   reason; clean drafts survive.
7. **Transactional persist** via the `social_create_batch` SQL function
   (SECURITY **INVOKER** — RLS applies; atomicity + in-DB Idempotency-Key
   replay) → events → `onDraft` streams each saved post to the SSE route.

**No model configured?** `templates.ts` builds grounded deterministic drafts
(`ai_metadata.model = "template-fallback"`) — the mock-first contract. Free-form
revisions (revise/retone/regenerate/rewrite/variants) require a model and say
so in a typed error; hashtags + alt-text keep deterministic fallbacks.

## The versioned-write rule

The ONLY legal content update is `repository.ts · versionedUpdateSocialPost`:

```sql
update social_post set ..., version = version + 1
  where id = $1 and version = $2 and deleted_at is null returning *;
```

Zero rows ⇒ `SocialVersionConflictError` ⇒ HTTP 409 / an agent-facing message
that teaches **re-read (get_social_post) → re-apply → retry**. The UI resolves
a 409 by re-fetching and re-applying the patch once, then surfacing the
"Updated elsewhere" toast. Deliberately NOT a DB trigger — the gate's revert
path must restore before-snapshots verbatim (including their version).
`verify-social.ts` greps that `social_post` writes stay confined to
`repository.ts` + `entities.ts`. Lifecycle (`status`, `posted_manually_at`),
`performance`, and image attachment are intentionally non-versioned
single-column updates (last-write-wins is the wanted semantics).

## The 19 agent tools

Read/suggest (5, execute freely): `list_social_posts` · `get_social_post` ·
`get_social_voice_profile` · `suggest_hashtags` · `draft_image_alt_text`.
Writes (14, all reversible): `generate_social_post_drafts` ·
`revise_social_post` · `change_post_tone` · `regenerate_social_post` ·
`create_social_post_variant` · `create_social_post` · `update_social_post` ·
`delete_social_post` (soft) · `mark_social_post_status` ·
`attach_social_post_image` · `remove_social_post_image` ·
`rewrite_for_platform` · `update_planned_post_time` ·
`log_social_post_performance`.

The agent prompt (`agent/prompt.ts` — "SOCIAL POSTS" + "MANUAL PUBLISHING"
sections) teaches the Cursor loop (inspect → targeted versioned edit →
explain why the revision may perform better) and the honesty contract (never
claim a post was published/scheduled; `plannedPostAt` is a label).

## Config (all optional, `.env.example`)

`SOCIAL_MAX_BATCHES_PER_DAY` (20) · `SOCIAL_MAX_REVISIONS_PER_DAY` (100) ·
`SOCIAL_GENERATION_TIMEOUT_MS` (180000) · `SOCIAL_CONTEXT_MAX_TOKENS` (6000) ·
`SOCIAL_GENERATE_MODEL`/`SOCIAL_GENERATE_EFFORT` (provider default / medium) ·
`SOCIAL_REVISE_MODEL`/`SOCIAL_REVISE_EFFORT` (provider default / low).

## How to add a platform

1. `constants.ts`: extend `PLATFORMS` + add a `PLATFORM_LIMITS` entry
   (register/lengths/hashtags/structure/emoji/imageNorm).
2. Migration: widen the two `platform` CHECK constraints.
3. Done — the Zod enums, prompt style guides, UI counters/pickers, and tests
   read the constants. Add a template branch in `templates.ts` if the default
   copy shapes don't fit, and a style-guide row in the PRD.

## How to add a goal

1. `constants.ts`: extend `SOCIAL_GOALS`, `GOAL_STAGE_MAP`, `GOAL_LABELS`
   (+ `buildBatchPlan` if it should participate in the balanced mix).
2. Migration: widen the `goal` CHECK constraint.
3. `templates.ts`: add the fallback copy branch (the switch is exhaustive —
   TypeScript will point at it).

## Events (the single `analytics_event` stream)

`social_post_batch_generated` · `social_post_created` · `social_post_updated`
· `social_post_revised_by_agent` · `social_post_status_changed` ·
`social_post_copied` · `social_post_downloaded` · `social_post_image_attached`
· `social_post_image_removed` · `social_post_performance_logged` ·
`social_post_generation_failed` · `social_voice_profile_derived` ·
`social_voice_profile_edited`. Marketing events, not course-consumption
events: `course_id` carries the hub's course context; `source =
"social_posts"`. TS union (`lib/marketing/types.ts`) and the DB check extend
TOGETHER. Copy/download events are the Phase-1 proxy for "which drafts were
actually used" (the save-without-rewrite success metric).

## Images (PRD §15)

Upload only — never generated. Private bucket `social-post-images`, path
`{creatorId}/social/{postId}/{uuid}.{ext}` (own-folder storage RLS), client
uploads directly then calls finalize. The server validates by **magic bytes**
(`imageMeta.ts` — dependency-free PNG/JPEG/WebP dimension parsing), checks
size (≤10MB), warns softly on platform-norm mismatch (never blocks), and
signs short-TTL display URLs (re-signed on view). Remove detaches the
reference; the object is retained (revert-friendly) until a later retention
purge (Phase 3+ TODO).

## Forward-compat fields (`[FWD]` — present, unused by Phase 1 UI)

`social_post.post_type` ('text'; 'clip'/'carousel' in 1.5) ·
`social_post.external_ref` (Phase 3 unified-API publish state) ·
`performance.source` ('manual'; Phase 4 adds 'api') · `planned_post_at` is
read by the Phase 3 scheduler under the same name — do not rename.

## Deviations from the PRD (deliberate, repo conventions win)

- **Table names are singular** (`social_post`, `social_post_batch`) like every
  other marketing table; the voice table is `social_voice_profile` because the
  email suite already owns a `voice_profile` (creator-authored RULES — a
  different lifecycle from this derived, versioned profile; the rules feed the
  derivation instead).
- **Tool names are snake_case** (`generate_social_post_drafts`, not
  `generateSocialPostDrafts`) per the marketing registry convention.
- `uploadSocialPostImage` became **`attach_social_post_image`** — the agent
  can't move bytes; it attaches an already-uploaded object (the REST finalize
  route does the byte validation for the UI path).
- **`delivery_profile` doesn't exist in this repo** — tone/platform defaults
  seed from course context (teaching style/audience) + the voice profile.
- Voice-profile routes live at **`/api/marketing/social-voice-profile`** (not
  `/voice-profile`) to avoid ambiguity with the email voice profile.
- The revert of a created post **archives** rather than deletes
  (soft-delete-only tables); reverting a batch archives its posts and leaves
  the empty batch row as an audit artifact.
- `social_voice_profile` alone has a DELETE policy (migration
  `20260706120100`) — the gate's revert-of-create needs it; posts/batches keep
  zero delete policies.

## Tests

- `npm run verify:social` — **127 pure checks** (no key/DB): Zod gates +
  platform caps, funnel-mix table + value-first ordering, every lint rule +
  the whitelist escape, timing presets incl. the DST spring-forward edge,
  export builders, imageMeta magic-byte parsing, prompt stability +
  version pin, template grounding, the 19-tool registry snapshot (5 read + 14
  reversible + ZERO irreversible), and the hardening greps (banned UI
  language, no social hosts, no scheduler primitives, single-writer rule).
  In the `npm test` chain.
- `npm run verify:social:int` — **59 checks** vs live Supabase + the mock
  model: the full pipeline (happy/repair/repair-fail/lint-drop/template
  fallback), idempotency replay, the DB 1–5 cap, rate limiting, versioned-
  write conflicts at repository and tool layers, lifecycle + performance +
  soft-delete-only, byte-for-byte reverts (single post AND whole batch),
  the complete creator-A/creator-B RLS matrix, storage + magic-byte image
  finalize, voice profile lifecycle, and a mock-model agent turn end-to-end
  with zero pauses. (The script pins `dns.setDefaultResultOrder("ipv4first")`
  — supabase.co's IPv6 route is broken on the dev machine's network.)

## Explicitly NOT here (hard fences, tested by greps)

No email imports, no platform APIs/OAuth/webhooks, no cron/scheduler (nothing
fires from `planned_post_at`), no AI image generation, no approval cards, no
new runtime dependencies (the 15-dep invariant holds).
