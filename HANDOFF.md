# HANDOFF — WiseSel

> **Refreshed 2026-07-07.** (Replaces a stale 2026-06-28 checkpoint that predated
> publishing, the learner runtime, analytics, the maintenance agent, and the
> marketing suite.) For the exhaustive architecture reference, read
> **`CLAUDE.md`**; for the dated change log, **`CHANGELOG.md`**. This file is
> the fast orientation. Most recent workstream: the **Engagement & Retention
> wave** — M7 (learner-comms delivery tracking via Resend webhooks +
> suppression) landed 2026-07-07; M8–M11 follow. See §4.
>
> **2026-07-08 — Portal split + UI redesign** (see `docs/portal-split.md` +
> the CHANGELOG entry): the app now has a **student portal**
> (`/home`,`/my-courses`,`/explore`, route group `app/(student)/`, learn-blue
> accent) and a **creator portal** with a REAL-data `/dashboard`; signup has a
> learner/teacher role picker and login routes by `profiles.role`; the learn
> runtime got accordion outlines + completion celebration; the editor agent
> chat got an honest status model + humanized tool labels; heavy routes have
> loading/error boundaries.
>
> **2026-07-11 — Course covers + creator identity + landing redesign** (see
> `docs/creator-identity.md` + the CHANGELOG entry): courses got uploadable
> **cover images** (`courses.cover_image_url` — live-mutable card metadata,
> never snapshotted; deterministic `CoverArt` gradient fallback on every
> card), creators got a **public identity** (`profiles.headline`/`bio` +
> existing `avatar_url`, edited on a now-REAL `/settings` page — no longer a
> lib/data.ts placeholder), the public **`/learn/[slug]` landing was
> redesigned** (glow hero, sticky cover conversion card, "This course
> includes", plan-outcomes checklist, `#instructor` section with stats via
> the new `course_landing_extras` definer RPC), and the UI primitives
> (Card/Button/PageHeader/Stat) + several surfaces got a polish pass. New
> pure suite `npm run verify:identity` (90 checks, in `npm test`).
> ✅ **Both migrations were APPLIED to the live Supabase project on
> 2026-07-14** (`20260708000000_user_roles_portal.sql`, then
> `20260711000000_course_covers_creator_identity.sql`) — browser suites re-ran
> green in post-migration mode (39 portal + 15 learn). Historical note: (Supabase SQL editor
> or `supabase db push`; no type-regen needed afterwards —
> `lib/database.types.ts` was already hand-spliced). Everything degrades
> gracefully
> until then (role routing/streaks/ratings from 07-08; covers → fallback art,
> instructor/extras sections hidden, settings headline/bio + cover upload
> locked with a notice — full degradation matrix in
> `docs/creator-identity.md`). The **browser suites pass in BOTH modes**
> (pre-migration degraded + post-migration) — re-run
> `verify:portal:browser` + `verify:learn:browser` after applying.
> ⚠ New `app/globals.css` custom utilities (`.paper-glow`/`.eyebrow`/
> `.grain`/`.font-display`) — the Tailwind v4 dev server must **RESTART** to
> emit newly added custom utility classes (prod builds are unaffected).

---

## 1. What the product is

**WiseSel** (formerly "CourseGen Pro") — an AI co-pilot for educators. Creators turn expertise into
engaging, monetizable courses; learners buy and study them. The heart of the
product is a **Google-Slides-like, AI-native course Studio**: a creator authors a
course (modules → lessons → blocks), and a docked, Cursor-style **AI Content
Agent** writes slide decks, knowledge checks, homework, and lecture text by
calling tools that mutate the course through the same validated patch pipeline
the UI uses — streaming its work and staging every change for review
(highlight → Accept/Reject).

- **Audiences:** creators (educators, competition coaches, SMEs, trainers) and learners.
- **Pricing:** Hobbyist (free) / Pro ($29) / Expert ($79); marketplace commission 15–25%.
- **Live today:** Supabase auth + persistence; the AI Content Agent (OpenAI,
  server-side) with the structured slide editor + AI visual pipeline; **video
  lessons** (Mux record/upload, captions, filmstrip trim); **publishing**
  (immutable versioned snapshots, M1); the **learner runtime + real
  marketplace** (`/learn/*`, server-graded quizzes, M2); the **analytics
  pipeline + creator dashboard** (M3+M4); the **maintenance agent + learner
  comms** (M5+M6, draft→approve→send with opt-out); **comms delivery tracking**
  (Resend webhooks + suppression, M7); and the whole **marketing suite**
  (campaigns, leads/consent, autonomy governance, social posts).
- **Not built yet:** Stripe payments, exports (PPTX/PDF/SCORM), multi-modal
  avatars. `/exports` is the last `lib/data.ts` mock placeholder page
  (`/settings` went real 2026-07-11; the dashboard went real 2026-07-08).

**Document model:** `CourseDocument` → modules → lessons → **blocks** (slides
are absolutely-positioned `SlideElement`s on a 1280×720 canvas plus
renderer-owned "structured layouts"; `imported_deck` is an asset-backed PPT/PDF
deck in a rail viewer; `video` is a Mux-hosted lesson). **Every** change —
human or AI — flows through one Zod-validated `CoursePatch` pipeline
(`applyCoursePatch`, pure).

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Framework | **Next.js 16** (App Router, Turbopack), **React 19**, **TypeScript** |
| Styling | **Tailwind CSS v4** (CSS-first `@theme` in `app/globals.css`; **no** `tailwind.config`). NOT a shadcn project — primitives in `components/ui/`, `cn` from `@/lib/cn`. |
| State | **Zustand** (`lib/course/store.ts` = editor doc + undo; `lib/editor/*Store.ts` = UI/drag/agent) |
| Validation | **Zod** (schemas mirror the doc model; patches are a discriminated union) |
| Animation / icons | `framer-motion`, `lucide-react`; `@dnd-kit` for reordering |
| Backend | **Supabase** — Postgres (RLS) + Auth + Storage, via `@supabase/ssr` + `@supabase/supabase-js` |
| AI | **OpenAI** Responses API, server-only, behind a provider-agnostic `ModelClient` seam; `shiki` for code highlighting |
| Pkg / deps | npm; **14 runtime deps** (see `CLAUDE.md`). `undici` is a **dev** dep (proxy shim for live OpenAI on proxy-only machines). |

**Dev:** `npm run dev` (localhost:3000) · `npm run build` · `npm run lint`.
**Env (`.env.local`):** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`OPENAI_API_KEY` (server-only); optional `OPENAI_MODEL` / `OPENAI_PROXY_URL` /
`OPENAI_IMAGE_MODEL` / … (see CLAUDE.md "AI Content Agent").

---

## 3. Architecture you need to know

- **Supabase project** `mfqolkzocxssgogcmhzf` · `https://mfqolkzocxssgogcmhzf.supabase.co`.
  Schema in `supabase/migrations/*`: `profiles` (auto-created on signup) +
  `courses → modules → lessons → blocks`, **RLS on everywhere** (author full CRUD;
  public read only when `status='published' AND visibility='public'`); block
  payloads live in `blocks.content` jsonb; `course-assets` storage bucket.
  Regenerate `lib/database.types.ts` after any migration.
- **Persistence = a whole-doc snapshot reconcile of normalized rows.** A
  module/lesson/block is a Postgres **row** (its id IS the primary key), never
  embedded JSONB. `lib/course/persistence.ts` maps doc ↔ rows (pure);
  `lib/course/persistenceSync.ts` `reconcileCourseDoc` upserts parents→children
  then deletes orphans children→parents. The browser autosave
  (`lib/editor/coursePersistence.ts`) and the server-side AI agent
  (`lib/ai/serverPersistence.ts`) share this one reconcile.
- **The AI agent** (`lib/ai/*`) is provider-agnostic: the OpenAI SDK lives in
  exactly one file (`lib/ai/providers/openai.ts`); `providers/mock.ts` is a
  deterministic client so the whole stack is testable **with no API key**.
  Pipeline: **PLAN → GENERATE → VALIDATE/REPAIR → (LIGHT REVIEW) → STAGE**, with
  per-phase model/effort config (`lib/ai/modelConfig.ts`). Tools are pure over
  `ctx.doc` → return `CoursePatch`es (`lib/ai/tools/*`). Changes stage as a
  reviewable **change-set** (`lib/ai/changeSet*.ts`); Reject replays inverse patches.
- **During an agent run**, the browser autosave is **paused** (`agentRunActive`),
  the agent persists server-side per batch, and the editor re-syncs live via
  `lib/editor/liveSync.ts` (`syncLiveDoc` replaces the in-memory doc) + a Supabase
  Realtime sub on `change_set_items`.
- **Verification convention:** no-key suites (`npm run verify:ai`, `verify:reject`,
  `verify:slides`, `verify:visuals`) use the mock provider; `npm run verify:ai:int`
  runs the full loop against **live Supabase** (still no OpenAI key — mock
  provider). Browser flows use temporary Playwright harnesses.

---

## 4. Most recent work — Engagement & Retention wave, M7–M10 (2026-07-07)

**M10 — granular slide feedback** (CHANGELOG has the full entry): the 10th
learner event type `slide_feedback` (👍/👎 + optional ≤500-char note) rides
the existing contract/SDK/ingest-RPC unchanged; append-only with
latest-reaction-wins enforced in `rollup_content_feedback` (per slide + per
lesson); thumbs toggle in the deck player (state via `my_slide_feedback`);
Content health gained the unified "Slide health" table (dwell ⋈ feedback +
inline comments + Confusing flag) and a funnel Feedback column. Migration
`20260707030000`.

**M9 — course reviews (creator-only)** (CHANGELOG has the full entry):
`course_reviews` (1–5 + optional text, one per (course, learner),
upsert-on-edit) gated by SQL eligibility (completed OR ≥70% progress) in both
the RPC and the RLS write policies; learner ask = a non-blocking slide-in on
the player (progressive disclosure, "Maybe later" with a 7-day gap / 3-ask
cap) + a persistent "Your review" section on the course landing; creators get
a ReviewsCard on the analytics Overview (rollup avg/distribution + paginated
recent text). Migration `20260707020000`.

**M8 — inactivity nudge tuning** (CHANGELOG has the full entry): threshold
7→4 days + flag renamed `inactive_incomplete` (computation extracted into
`private.recompute_learner_flags`); filing-time nudge guards (opt-out,
suppression, 14-day cooldown vs `learner_messages` — one check-in per
silence); the learner-risk dedupe-key mismatch fixed (SQL now files ONE
finding per learner under the TS `learner_risk:<userId>` key, so Analyst
adoption works); Stuck queue rows show each learner's last check-in delivery
outcome. Migration `20260707010000`.

**M7 — learner-comms delivery tracking** (full detail:
`docs/comms-delivery-tracking.md` + CHANGELOG):

- Every learner-comms send now carries Resend **tags** (`send_source=
  learner_comms` + message/course/user ids) and seeds a **delivery trail** on
  `learner_messages` (`delivery_status` + `delivery_events`).
- New Svix-verified webhook `POST /api/comms/webhooks/resend`
  (`RESEND_COMMS_WEBHOOK_SECRET`, separate from the marketing endpoint's
  secret) maps `email.delivered/opened/clicked/bounced/complained` to five new
  `comms_email_*` types in the ONE analytics event contract (course-only
  envelope, `client_event_id` derived from the retry-stable `svix-id`),
  advances the trail rank-monotonically via the `apply_comms_delivery` RPC,
  and **suppresses** learners on hard bounce / complaint
  (`comms_suppressions`, server-only RLS) — `approveAndSend` re-checks
  suppression at send time; the composer shows "Suppressed: bounced/
  complained" instead of the send button.
- The shared verifier `lib/webhooks/svix.ts` now backs the marketing webhook
  too, closing its missing replay-tolerance gap.
- Verified: `verify:comms` 61 pure · `verify:comms:int` 46 live · full pure
  chain, `verify:analytics{,:int}`, `verify:learn:int`,
  `verify:maintenance{,:int}`, lint + build all green.

Earlier waves (all live, see CHANGELOG for each): scoped agent reconcile +
structural change-sets (2026-06-28/07-01), video lessons + captions
(2026-07-01/02), publishing M1 + learner runtime M2 (2026-07-02), analytics
M3+M4 (2026-07-03), maintenance agent + comms M5+M6 (2026-07-03), marketing
autonomy + approval sync (2026-07-03/06), social posts (2026-07-06).

---

## 5. Deferred / suggested next steps
1. **Engagement & Retention wave, M11** (in flight): feedback-theme findings —
   the Analyst synthesizes review/feedback text into evidence-backed findings
   → draft-only change-sets. (M7–M10 landed 2026-07-07.)
2. **Optimistic-concurrency guard** — a `revision` column + compare-and-set to
   close the last-write-wins class across autosave/agent/reject.
3. Larger roadmap (from `CLAUDE.md`): real course list/picker on the dashboard
   (still mock courses), Stripe payments, PPTX export, `/pricing` page.

---

## 6. Gotchas (evergreen — keep)
- **Set `course_id` on lessons & blocks on insert** — it's denormalized for RLS
  and not derivable by the DB.
- `order` is a SQL reserved word — quoted as `"order"` in migrations; fine as
  `order` in TS.
- Money is integer **cents** everywhere (`price_cents`).
- RLS helper functions live in a non-exposed `private` schema — reference qualified.
- Persistence is whole-doc snapshot upsert + orphan-delete; ids ARE the row PKs,
  so there's no diffing — BUT it's last-write-wins with no version guard (see §4).
- No `Math.random()` / `Date.now()` in React render (hydration); none in workflow
  scripts either.

## 7. Quick reference
- **Run:** `npm run dev` → http://localhost:3000 (sign in at `/login`, Studio at `/studio`).
- **No-key tests:** `npm test` (chains every pure suite, ~1000 checks).
- **Live tests (ask first):** `verify:ai:int`, `verify:learn:int`,
  `verify:analytics:int`, `verify:maintenance:int`, `verify:comms:int`, the
  `verify:marketing*` live suites.
- **Type/lint:** `npx tsc --noEmit` · `npm run lint`.
- **Deep docs:** `CLAUDE.md` (architecture, AI pipeline, design system, Supabase
  schema) · `CHANGELOG.md` (dated change log) · `docs/*` (publishing, analytics
  events, comms delivery tracking, agent architecture, marketing suite).
