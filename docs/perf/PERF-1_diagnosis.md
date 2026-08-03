# PERF-1 Phase A — Diagnosis

**Date:** 2026-07-17 · **Tree:** `f1609e4` (origin/main incl. the Social Post Generator wave, merged mid-diagnosis) + the uncommitted local wave (portal split / covers / clips)
**Status:** Phase A complete — STOPPED at Checkpoint 1 per §8. No optimization code has been written.
**Method:** 12 parallel static auditors over the codebase + a delta audit of the `d01695d..f1609e4` marketing wave + live-database audit (pg_stat_statements, Supabase advisors, `pg_policies`, RLS-simulated `EXPLAIN ANALYZE`) + lab measurements against a production build (`next start` on `:3100`) with Playwright (desktop, unthrottled) and Lighthouse 12.8.2 (throttled mobile default + desktop preset), authenticated via the seeded analytics fixture (`npm run seed:fixtures`).

---

## A1. Stack inventory

| Layer | What it is | Evidence |
|---|---|---|
| Framework | **Next.js 16.2.9, App Router, Turbopack**; React 19.2.4; TypeScript 5 | package.json:65-68 |
| Router | App Router only; route groups `(app)` `(learn)` `(student)` `(marketing)` + `/login`, `/p/[slug]` | `app/` tree |
| Data fetching | **RSC direct Supabase reads** (dominant) + 5 server-action files + 38 `/api` route handlers (all `runtime=nodejs`, `force-dynamic`) + client `fetch`/browser supabase-js. **No React Query / SWR / tRPC — no client query cache exists.** | audit §A1.3 |
| State | 8 zustand stores (course doc, editor UI, drag, agent, confirm, marketing dock/approvalSync/hubUi); 2 persisted to localStorage with `skipHydration` | lib/course/store.ts, lib/editor/\*, lib/marketing/\* |
| Build | `next build`, no flags; **`next.config.ts` is empty** — no `images` config, no analyzer, no `staleTimes` tuning. Build emits a deprecation: `middleware` file convention → `proxy` | next.config.ts:3-5, build log |
| Hosting | **Unknown/local-only.** `vercel.json` holds one cron (intended target: Vercel); no `.vercel/`, **no `.github/` — no CI at all**; `NEXT_PUBLIC_SITE_URL=http://localhost:3000`. Do not assume a CDN or Vercel image optimization exists in production. | vercel.json, env |
| Image pipeline | **`next/image` used only for the brand logo** (`components/brand/WiseSelLogo.tsx`). All remote images (covers, avatars, AI slide images, deck pages, posters) are raw `<img>` — 28 sites. No `remotePatterns`, no srcset, no Supabase transforms. | audit §A4 |
| Fonts | `next/font/google`: Geist + Geist Mono + **Fraunces (normal+italic) in the root layout** (despite "loaded only where used" comment). Default `display:swap`, self-hosted. Preload set measured **131 KB** (4 woff2; Fraunces italic ≈29 KB rides every route). | app/layout.tsx:2-14,30; components/intro/fonts.ts:9-13 |
| Middleware | Matcher covers **every page and every `/api` request** (only `_next/static`, `_next/image`, favicon, image extensions excluded). Per request it creates a Supabase client and calls **`auth.getUser()` — a network round trip to Supabase Auth** — then regex-gates protected paths. | middleware.ts:9-13; lib/supabase/middleware.ts:42-53 |
| Perf tooling | **None.** No web-vitals, no RUM, no Lighthouse CI, no bundle analyzer, no size budgets. | grep-verified |

**Routing, end-to-end.** Every request passes the middleware auth round trip. Client nav is standard `next/link` (62 files, default prefetch — zero overrides), plus `router.push/refresh` in 16 client files. Per-route `loading.tsx` skeletons exist on all heavy routes; each group has `error.tsx`.

**Data loading, end-to-end.** A navigation to an authenticated page performs, in sequence: middleware `getUser()` (network) → the group layout's **own** `getUser()` + a `profiles` select → the page's **third** `getUser()` → the page's query waves. `createClient()`/`getUser()` are **not memoized per-request** (no `react cache()` in `lib/supabase/server.ts`), so ~3 auth round trips precede any data query (4 on `/marketing`, which has a second nested layout). **27 pages export `force-dynamic`; zero `revalidate`/`unstable_cache`/fetch-cache anywhere**; the only request-level dedupe is `react cache()` on the learn landing + `/p/[slug]`. After hydration, reads refresh via `router.refresh()` (which re-runs the entire server render) or bespoke polling (deck import 2.5 s, video asset 3 s while active).

---

## A2. Route transition profile (top-5 routes)

Top-5 by design intent (no production usage data exists): `/dashboard`, `/studio` (editor), `/learn/[slug]/[lessonId]` (player), `/studio/[courseId]/analytics`, `/marketing` (hub + agent review).

### Measured — production build, localhost:3100

**Cold load (Playwright, desktop unthrottled, median of 3, authenticated):**

| Route | TTFB | FCP | LCP | CLS | JS wire (gz) | Client data reqs |
|---|---|---|---|---|---|---|
| /dashboard | 1084 ms | 1148 ms | 2944 ms | 0.000 | 456 KB | 0 |
| /studio | 2664 ms | 2740 ms | 3052 ms | 0.000 | **639 KB** | 0 |
| /learn/[slug]/[lessonId] | 919 ms | 960 ms | 4476 ms | 0.000 | 590 KB | 0 |
| /studio/[courseId]/analytics | 2243 ms | 2308 ms | **6584 ms** | 0.000 | 391 KB | 0 |
| /marketing | 1469 ms | 1544 ms | 2496 ms | 0.000 | 396 KB | 0 |

**Lighthouse, throttled mobile (Moto G, slow 4G, 4× CPU) / desktop preset:**

| Route | Mobile score | Mobile LCP | Mobile TTFB | Mobile TBT | Desktop score | Desktop LCP | Desktop TTFB |
|---|---|---|---|---|---|---|---|
| /dashboard | 69 | 6.3 s | 3818 ms | 18 ms | 95 | 1.1 s | 1678 ms |
| /studio | 72 | 6.6 s | 3478 ms | 44 ms | 96 | 1.2 s | 2186 ms |
| /learn lesson | 74 | 6.0 s | 1888 ms | 156 ms | 93 | 1.1 s | 623 ms |
| /studio analytics | 74 | **7.4 s** | 1666 ms | 9 ms | 82 | 2.8 s | 1503 ms |
| /marketing | 76 | 5.2 s | 2928 ms | 31 ms | 81 | 2.6 s | 2645 ms |

CLS = 0.00 on every cold load (mobile + desktop). Total mobile page weight 763 KB–1.08 MB.

**Transitions (Playwright, real `<a>` click from a hub page, event-timing + content-selector):**

| Route | Click → URL change | Click → content | Click handler duration | Back-nav → content | Forward revisit | Slide advance |
|---|---|---|---|---|---|---|
| /studio | 189 ms | 882 ms | 16 ms | 15 ms | 4 ms | — |
| /learn lesson (from landing) | 549 ms | **5386 ms** | 48 ms | 20 ms | 10 ms | **3.1 ms** |
| /studio analytics | 906 ms | **5922 ms** | 48 ms | 11 ms | 5 ms | — |
| /marketing | **2424 ms** | 2437 ms | 16 ms | 8 ms | 7 ms | — |
| /dashboard | n/a — harness measured the other four; dashboard was the origin page | | | | | |

Interpretation: the click *handler* is fast (16–48 ms) but **nothing visible happens until the server responds** — on `/marketing` the URL doesn't even change for 2.4 s (no progress bar; `loading.tsx` paints only at navigation commit, which waits on the RSC response for non-prefetched dynamic routes). Back/forward is already instant (8–20 ms) via bfcache/Router-Cache restore — the pain is **forward navigation and cold loads**. Slide advance within a deck is pure client state (3 ms) — C5's remaining gap is *asset* lookahead (image slides cold-fetch their PNG on arrival), not deck data.

### Request waterfalls (static trace, verified file:line)

Every route repeats the same three structural taxes: **(1)** middleware `getUser` (network) → **(2)** layout `getUser` + `profiles` → **(3)** page `getUser` — before any page data. Then:

- **/dashboard — 13 round trips, 5 sequential waves.** Page `getUser` → W1 (`profiles select("*")` [dupes the layout fetch] ∥ `courses`) → W2 (5-way `.in(courseIds)`: pubs, **all `enrollments` rows to count in JS**, review rollups, **unbounded `agent_findings` incl. `finding` jsonb** [UI renders 5], draft `learner_messages`) → W3 (funnel rollup ∥ **full `course_publications.snapshot` jsonb fetched only for lessonId→title labels** — the largest payload on the route). Zero Suspense; the identity band is held hostage by W3. `router.refresh()` after every avatar/profile save replays all 13 RTs. (app/(app)/dashboard/page.tsx:65-207)
- **/studio?course= — 13 round trips, 5-hop critical chain.** `getUser` → `courses select("*")` (**needlessly sequential** — the wave below only needs `courseId` from searchParams) → Promise.all(modules/lessons/**blocks `select("*")` = full jsonb content of every block in the course**, `getPendingBlocks` [internal 2-hop], `getPendingNodes` [**re-runs the identical `change_sets` query**], findings `count:"exact"` for a badge). The whole CourseDocument is then serialized into the RSC payload, copied again into the zustand store post-hydration (editor is never in server HTML — LCP is hydration-bound), and re-uploaded wholesale on every autosave (7 serial writes per debounced edit). `router.refresh()` fires after every agent run/stop/reject. (app/(app)/studio/page.tsx:20-98; lib/ai/changeSet.ts:118-156; lib/editor/coursePersistence.ts; lib/course/persistenceSync.ts:135-169)
- **/learn/[slug]/[lessonId] — 12 round trips (3 auth + 9 DB), 5 sequential stages (7 with an imported deck).** `getUser` → `resolveLivePublicationBySlug` (**`select("*")` drags the whole-course `snapshot` + unused `linter_report`, then full strict Zod parse — per view AND per progress POST**) → access pair → one wave (progress ×2 [mergeable], quiz attempts, unbounded homework history, 2 RPCs, per-media admin reads; `video_assets select("*")` drags `transcript`+`transcript_vtt`). The page's `getUser` is needlessly serialized ahead of the independent slug resolve (the landing page already parallelizes that exact pair). Slide content is NOT in SSR HTML (client ResizeObserver gates SlideStage paint) — hence LCP 4.5 s on a 919 ms TTFB. **Each `slides_viewed`/`video_progress` POST re-runs middleware auth + route auth + access + full snapshot fetch/parse ≈ 2 auth + 6–8 queries per batch.** (app/(learn)/learn/[slug]/[lessonId]/page.tsx:39-150; lib/learn/resolve.ts:37-77) 
- **/studio/[courseId]/analytics — ~20 round trips, 4 serial waves.** `getUser` → (course ∥ publication `select("*")` incl. **full snapshot, parsed on every tab** — the Learners tab never uses the result) → 15-query Promise.all (5 rollups + `learner_flags` + `course_analytics_overview` + **unbounded `course_roster`** + enrollments + duplicate `profiles` + **all `learner_messages` ever, reduced to latest-per-user in JS** + admin suppressions sub-chain + reviews). **9+ of those depend only on `courseId` yet wait behind the publication fetch. Every `?tab=` click re-runs all of it** (~15 queries where 4–6 would do). Learner detail: `course_roster` recomputed in full to `.find()` one learner; `quiz_attempts` + nested `question_responses(*)` unbounded; heartbeat `count:"exact"` with `event_type` outside the index; OFFSET timeline pagination. (app/(app)/studio/[courseId]/analytics/page.tsx:54-160; learners/[learnerId]/page.tsx:93-152)
- **/marketing — ~28 round trips (4 auth + ~24 DB), 6 sequential waves.** The marketing layout adds a 4th `getUser` + its own `selectCourseForAuthor` (duplicating the page's). Spine: course → `listAuthorCourses` (**needlessly serial**) → Promise.all(5) → `listLandingPages` (**serial though `course_id`-indexed**) → **per-pending-approval `previewMarketingAction` re-executes the full tool: a `launch_campaign` preview alone is ~12 sequential round trips** (course context 3 + N+1 list counts + sequence 2 + audience snapshot 2 …) → `loadSequencesOverview` (4 serial; **fetches every `scheduled_send` + `sequence_enrollment` row to count in JS**). `select("*")` drags `before_snapshot`/`sections`/`body` jsonb the hub never renders. Post-wave: each approval resolution triggers an immediate `router.refresh()` **and** a deferred `revalidatePath` when the ≤180 s background follow-up lands — two full hub re-renders per approval. (app/(app)/marketing/page.tsx:49-143; lib/marketing/gate.ts:456-502; lib/marketing/persistence.ts:349-391; actions.ts:391-449)

**Fetch A→B→C chains (explicit):** dashboard `courses → .in(courseIds)×5 → spotlight snapshot`; studio `getUser → course row → change_sets → change_set_items`; learn `getUser → resolve → access → wave` (+ per-deck `deck_imports → pages → signed URLs`); analytics `getUser → publication → 15-query wave → suppressions`; marketing `getUser → course → courses → wave → landing pages → previews → sequences overview`, with `preview: campaign → checklist → course context → lists → sequence → audience snapshot` nested inside.

### Delta (merged mid-diagnosis): Social Post Generator wave `d01695d..f1609e4`

- Hub server load unchanged (zero new queries); approval resolution is now fast-return (win) at the cost of a second deferred hub re-render + one serverless invocation pinned up to 180 s per follow-up.
- New `/marketing/social`: 5 serial waves (lessons + `listAuthorCourses` needlessly outside the Promise.all); `listSocialPosts` ships ≤100 **full `select("*")` rows unfiltered by course** (body ≤3000 + source_text ≤8000 + jsonb) into the RSC payload for 2-line-clamp cards; queue sort `(creator_id, updated_at)` has **no matching index** (the advisor-flagged unused `social_post_creator_status_idx` is the near-miss); `countRevisionActionsSince` runs an **exact count over the ever-growing `marketing_action` ledger with no `tool_name`/`created_at` index before every AI edit**; compliance review now issues real sequential external HEAD/GET fetches per button href (4 s timeout each); **`PostEditor.tsx` contains two literal NUL bytes (`hashtags.join("\x00")` written raw) — git treats the file as binary**, breaking diffs and endangering grep-based verify suites; live DB has `social_post.regenerated_from_post_id` **absent from any migration → schema drift to reconcile**. Clean: keyset pagination, initplan-form RLS, no polling, zod type-only imports, no framer-motion.

---

## A3. Database audit

**Caveat:** the live project is dev-scale (74 courses / 293 blocks / 2.7 k messages; stats dominated by verify-suite traffic). Absolute times are small; the findings below are *structural* and their impact ratings assume documented growth profiles (`learning_events`, `analytics_event`, `scheduled_send`, `learner_messages` grow per learner-action/send).

### pg_stat_statements

Top by total time (app-shaped, infra noise excluded): **`blocks` INSERT (autosave reconcile) — 4385 calls, 26.3 ms mean** (every debounced edit re-uploads every block's full jsonb); **`SELECT blocks.* WHERE course_id=$1` — 4255 calls, 5.9 ms mean** (studio load + every liveSync/visual-job full reload); lessons/modules/messages inserts (test traffic); `refresh_all_course_analytics` 337 ms mean (nightly cron — acceptable). Top by mean time is dominated by migration/infra statements; no app query exceeds ~26 ms mean at current scale.

### RLS: policy form is already right; the cost is per-row helper functions

- **Zero policies call `auth.uid()` bare.** All ~110 policies verified in live `pg_policies`: initplan form `( SELECT auth.uid() )` or a helper. Supabase advisors report **no `auth_rls_initplan` findings**. The directive's "rewrite `auth.uid()` → `(select auth.uid())`" item is **N/A — already done everywhere** (evidence: live pg_policies dump; migrations grep).
- **The real cost:** ~90 policies gate via `private.is_course_author(course_id)` / `can_read_course(course_id)` — STABLE SECURITY DEFINER SQL functions taking a **row column** argument, so they run **once per candidate row** (not inlinable: SECURITY DEFINER + `SET search_path`). Live evidence: `courses` shows **1,579,295 index scans against 74 rows** (every helper call = one PK probe), and RLS-simulated `EXPLAIN (ANALYZE, BUFFERS)` on the studio's hot query shows the filter:

```
Index Scan using blocks_course_id_idx on blocks (actual time=3.298..5.885 rows=3)
  Index Cond: (course_id = '3b30f06d-…'::uuid)
  Filter: private.can_read_course(course_id)     ← executed per row
  Buffers: shared hit=190
```

  Fix direction (C3): rewrite hot **SELECT** policies to the uncorrelated semi-join form `course_id in (select id from courses where author_id = (select auth.uid()))` (hashed once per statement). Priority order: `blocks`/`lessons`/`modules` (studio reads every row of a course), `analytics_event` (marketing dashboards aggregate thousands of rows), `learning_events` (timeline), `change_set_items` (realtime evaluates the policy per replicated row). Keep helpers on write paths (~1 row/stmt). Also: `deck_import_pages` uses a per-row **join** helper (100-page deck = 100 joins); `course_reviews` has two permissive SELECT policies (advisor-flagged) → merge.
- Baseline plans for C3's before/after comparison are recorded above and in §A2 (publication-by-slug: 6.3 ms, 124 buffers, helper in filter; courses-by-author: initplan, 1.8 ms).

### Indexes

- **Unindexed FKs (Supabase advisors + migration audit, 35 total):** the ones that matter — `learning_events.attempt_id` (largest table, SET NULL cascade), `analytics_event.campaign_id` (big table **and** an app filter, lib/marketing/segments.ts:44), `homework_submissions.publication_id` (CASCADE), `marketing_action.conversation_id`, `agent_findings.change_set_id`, `learner_messages.finding_id`, `course_reviews.user_id`, `learner_flags.user_id`, social wave: `social_post.{campaign_id,module_id,lesson_id}` + `social_post_batch.{course_id,module_id,lesson_id}` + rollup `course_id` FKs (low). 
- **Missing functional indexes:** `course_publications` has no `(status, visibility, published_at)` — `marketplace_listings()` seq-scans + sorts all publications; `social_post` has no `(creator_id, updated_at) where deleted_at is null` for the queue's primary sort; `learning_events` heartbeat exact-count filters `event_type` outside its index.
- **Redundant single-column prefix indexes (drop candidates, write amplification):** `learner_flags_course_idx`, `subscriber_campaign_id_idx`, `marketing_campaign_course_id_idx`, `email_sequence_course_id_idx`, `change_sets_course_id_idx`, `marketing_action_course_id_idx`. Advisor-confirmed unused: `social_post_creator_status_idx`, `analytics_event_anonymous_id_idx`, `subscriber_anonymous_id_idx`, + 9 more.
- `previous_slugs @>` containment (slug-rename fallback) has no GIN index — miss-path only, low.

### Over-fetch / heavyweight RPCs (feeding C1/C2)

- The **immutable publication `snapshot` jsonb** is the single most re-fetched payload in the system: learn lesson view, every progress POST, every homework POST, every analytics tab, student home (up to 4 per render), dashboard spotlight (titles only), publish-settings PATCH (twice). It has a `content_hash` — a perfect cache key — and is never cached.
- Definer RPCs re-expand that snapshot per row per request: `marketplace_listings()` and `my_learning()` run `jsonb_array_elements(snapshot->'modules')` per listing/enrollment; `is_review_eligible` (via `review_prompt_state`, called on every learn page) counts lessons by expanding the live snapshot. Fix direction: persist `lesson_count`/`module_count` as publication columns at publish time (immutable — snapshot model makes this safe).
- Fetch-to-count: dashboard + `/analytics` picker fetch all `enrollments` rows to count in JS; `loadSequencesOverview` fetches all `scheduled_send`+`sequence_enrollment` rows for two integers; marketing analytics runs **~13 exact counts per course per call** — fanned out per course on `/marketing/overview`, and in the agent's observe step every run.
- Exact counts on growing tables: heartbeat count per learner detail; `countRevisionActionsSince` per AI edit (unindexed predicates); guardrails exact counts with unbounded `.in(subscriberIds)` arrays (URL-length hazard).

---

## A4. Bundle and asset audit

### Route JS (measured, gzip wire bytes, prod build)

Baseline: **/studio 639 KB · /learn lesson 590 KB · /dashboard 456 KB · /marketing 396 KB · /studio analytics 391 KB** — every route exceeds the 250 KB default ceiling. (Turbopack's build table omits per-route sizes; figures are measured `encodedBodySize` sums over script resources at runtime — the same definition the CI budget should use.)

### Heavy-dep placement (import-graph verified)

| Dep | Client? | Where | Verdict |
|---|---|---|---|
| openai, resend | no | server-only (single importers) | ✅ |
| shiki | lazy `import("shiki")` on first highlight | studio/learn on-demand | ✅ as designed |
| framer-motion | **every `(app)` route** via layout → `ConfirmHost` → `ConfirmDialog` | dashboard/studio/analytics/marketing | ❌ layout leak (~30–40 KB gz); learn route is verifiably framer-free (2 existing `dynamic()` imports do their job) |
| @supabase/supabase-js | **every `(app)` route** via layout → `Sidebar` → `SignOutButton` → `lib/supabase/client` | all (app) | ❌ layout leak; legitimate on studio (realtime/autosave) + learn (homework upload) |
| @dnd-kit/* | studio only | outline + block editors | ✅ scoped |
| lucide-react | all routes, 173 icons named-from-root | — | ✅ `optimizePackageImports` covers it — no change needed |
| zod v4 + ~3,750 lines of schemas | **studio AND the learner lesson route** | see below | ⚠ the worst leak |

**The single worst cross-surface leak:** the read-only learner player imports the editor's authoring subsystem — `LearnSlideDeck` → `components/editor/slide/SlideStage.tsx:30` → `useEditorStore` → `lib/course/store.ts` → `patches.ts` (1,621 lines) + `schemas.ts` (831) + `factories.ts` → `structuredLayouts.ts` (1,044) + diagram schemas + drag/ui/clipboard stores + every element renderer. Learners download the patch reducer, undo machinery, and the AI zod registry to view slides in `mode="thumbnail"`. This is most of why the learn route is 590 KB.

**The studio monolith:** `CourseEditorShell` statically imports every modal-gated subsystem — `VideoStudioModal` (recording/trim, 2,585 lines), `PublishPanel` (publish hash/preflight/snapshot + 273-line zod), `AgentPlanHost` (imports framer-motion directly), `GlobalImageDialog`, `AgentPanel` (+ comms `DraftList`/`MessageComposer`). All are `next/dynamic` candidates. Marketing: `AgentDock` statically bundles the full chat `AgentPanel` on every `/marketing/*` page (closed pill by default). Only 3 dynamic imports exist in the whole repo (all on the learn route — all correct).

**Barrels:** none that hurt (no `components/ui/index`, no `lib/course/index`; existing `index.ts` files are server-only or correctly scoped). `app/zz-materialize-preview` is a leftover dev harness route shipping in the build.

### Assets & cache headers

- **`cacheControl` is set on ZERO of the 5 storage upload sites** (AI slide images, avatars, covers, homework files, deck pages) → Supabase default `max-age=3600`. Every object name embeds a UUID (immutable-by-construction; replace-flows delete the old object) — `31536000, immutable` is safe at every public site. This is C4's core item and a one-line fix per site.
- **AI slide images are full-res PNGs** (1536×1024 / 1024×1024, `mimeType: "image/png"` pinned in the provider) — multi-MB per image slide, no compression/variants/srcset, re-fetched hourly by cache expiry.
- **No responsive pipeline:** `next.config.ts` has no `images` config; 1600×900 covers render in 160 px boxes (student home) and 56 px boxes (dashboard) at full bytes. All rendered images sit in fixed-aspect boxes (**no image CLS**) and card grids consistently use `loading="lazy"` (✅). Learn-landing LCP cover is eager but lacks `fetchpriority="high"`/preload.
- Lighthouse image audits agree: `uses-responsive-images` scores 0.5 on all five routes; modern-formats/offscreen/font-display/render-blocking all pass.
- **Zero `preconnect`/`dns-prefetch`** anywhere; candidates: the Supabase project origin (all data + storage), `image.mux.com` (posters/filmstrips), `stream.mux.com` (MP4s + captions).
- Video: native `<video>` `preload="metadata"` + poster (✅); delivery is a single `highest`-resolution progressive MP4 (no ABR — documented trade-off, Mux Player/HLS is the upgrade path).
- Fonts: 131 KB preload (see A1); Fraunces italic (~29 KB) preloads on every route for a sparsely-used style.
- Deck pages: signed URLs (1 h TTL) — browser caching structurally capped at 1 h even if object TTLs are raised; batch-signing already one round trip (✅). Social wave stores a 1 h-signed image URL **on the row** and serves it stale from list responses (re-signed only on single-post GET) — expired-URL landmine.
- `globals.css` 5.5 KB, no large data URIs, no third-party scripts (✅). Apple-touch icon ships a 137 KB PNG (should be a pre-sized 180×180).

---

## A5. Render audit (static; profiler runs are Phase-B/D lab work)

**Structural facts:** no virtualization library exists anywhere; the editor patch reducer **`structuredClone`s the entire course document on every patch** (lib/course/patches.ts:704) so node identities churn per edit and identity memoization can never hit below the doc root.

1. **Editor whole-doc subscriptions × clone-per-patch:** 15 components subscribe to the entire doc — including the editor ROOT (`CourseEditorShell.tsx:80`, no memoized children → **one patch re-renders the whole editor tree**) and **every** outline `SortableLesson`/`SortableModule` (only to feed a click handler — a `getState()` would eliminate the subscription). Undo keeps 100 whole-doc snapshots.
2. **The filmstrip is the most expensive list in the app:** one full `SlideStage` per slide (own ResizeObserver each, full 1280×720 DOM, `lintSlide` per thumbnail per render, async shiki per code slide) with a JSON.stringify structural comparator whose WeakMap cache misses across every patch (identities churn) → **O(deck bytes) restringify per keystroke**.
3. **Agent SSE streaming re-renders the whole panel per token:** unbatched `assistant_delta` → new `messages` array → full transcript re-render (674-line component, un-memoized bubbles); the streaming bubble re-parses its entire accumulated markdown per token (O(n²)); a defeated `useMemo` (`Object.values(changeSets)` rebuilt in render) forces a **full modules×lessons×blocks walk per token**; `AgentPanel` also subscribes to the editor doc, so every editor patch re-renders the agent panel too. Same un-memoized transcript pattern in the marketing panel. `scrollTo({smooth})` re-fires per delta.
4. **Selection fan-out:** every `ElementView` subscribes to the whole selection unconditionally — a selection change re-renders every element on the canvas **and inside every mounted filmstrip thumbnail**; during drags the active slide's thumbnail re-renders per pointermove.
5. **Unthrottled high-frequency handlers:** element drag / marquee / multi-transform / line-endpoint writes per raw pointermove (no rAF coalescing; >250 ev/s mice); intro pointer-glow does `getBoundingClientRect()` per pointermove.
6. **Unvirtualized unbounded lists:** marketplace/explore grids (server-rendered — payload problem), analytics roster/stuck-queue/Content-health per-slide tables, comms `DraftList` (unbounded fetch), marketing leads (fetch uncapped, render capped 200), social `PostQueue` (≤100, unmemoized cards, whole-array replacement per save). The learner-detail timeline is the one list already paginated correctly (50/page).
7. **Per-render computation:** `useVisualJobs` walks the whole doc during render (mounted for the studio session); `PublishPanel` runs whole-course preflight + snapshot + SHA-256 per doc change (mounts only on the publish step); `SlideStage` copies+sorts elements per render.
8. **CLS sources (soft-nav, not captured by cold-load Lighthouse):** marketplace/explore skeleton cards are `h-24` vs real `aspect-[16/9]` (~200 px) → whole-grid shift; marketing skeleton is `max-w-6xl` 3-col vs real `max-w-7xl` ask-bar + 2-col; **studio double-skeleton** (gallery-shaped `loading.tsx` → different full-bleed `StudioSkeleton` → editor, guaranteed shift every course open); analytics skeleton shows a stat band absent from 3 of 4 tabs; learner detail has **no** `loading.tsx`. Verified CLS-safe: fonts (swap + size-adjust), all images in fixed-aspect boxes, charts fixed-height, toasts absolute.
9. **Hydration:** 203 client files. `/studio` = the entire editor client-side, with the doc serialized into flight then copied into the store (three paint phases). `/learn` lesson body fully client with all blocks permanently mounted (dwell-tracking contract) — slide content absent from SSR HTML (ResizeObserver-gated) → the measured FCP≈1 s vs LCP≈4.5 s gap. Marketplace/explore/analytics/landing are already correctly server-shaped with small client islands.

---

## A6. Ranked findings

Impact assumes production-scale data; Phase = the PERF-1 item that owns the fix. S/M/L = effort.

| # | Finding | Impact | Effort | Phase |
|---|---|---|---|---|
| 1 | 3–4× `auth.getUser()` network RTTs per navigation (middleware + layout(s) + page), no `react cache()`; middleware also auths every `/api` call (double-auth) and every Link prefetch | High | S | C1 |
| 2 | Zero caching: 27 `force-dynamic` pages, no `revalidate`/`unstable_cache`/client cache — every forward nav refetches everything; immutable snapshots (DB-trigger-enforced, content-hashed) re-fetched + re-Zod-parsed per view/POST | High | M | B5/C1 |
| 3 | Learner route ships the editor authoring subsystem (patches/schemas/layouts/zod/stores ≈3,750 lines) via `SlideStage → useEditorStore` — 590 KB gz on a read-only route | High | M | D1 |
| 4 | `cacheControl` unset on all 5 storage upload sites — immutable UUID-named objects (AI slide PNGs, covers, avatars, deck pages) expire hourly | High | S | C4 |
| 5 | No navigation feedback: no progress bar; `/marketing` click→URL 2.4 s with nothing visible; loading.tsx only paints at commit | High | S | B1 |
| 6 | Per-route fetch waterfalls: dashboard 13 RT/5 waves; studio 13 RT/5-hop chain (course row needlessly serial; duplicate change_sets query); learn 12 RT/5 stages (getUser needlessly before resolve); analytics ~20 RT (9+ queries needlessly behind publication fetch; every tab re-runs all); marketing ~28 RT/6 waves (previews re-execute full tools, ~12 RT per launch card) | High | M | C1 |
| 7 | Studio: full course jsonb fetched up front, serialized into flight, copied to store; autosave re-uploads the whole course over 7 serial writes per edit (26 ms mean per blocks insert); liveSync/visualJobs full-doc reloads; `router.refresh()` after every run/reject/save replays all 13 RT | High | M | C1/C2 |
| 8 | Learn progress POST ≈ 2 auth + 6–8 queries incl. full snapshot fetch/parse per slide batch (5–8 POSTs per 10-slide walkthrough) | High | M | C1 |
| 9 | Slide content absent from SSR HTML (ResizeObserver-gated) → learn LCP 4.5 s on 0.9 s TTFB; studio editor never server-rendered (3 paint phases) | High | M | B2/D5 |
| 10 | No slide asset lookahead: image slides cold-fetch full-res PNGs on advance; no next-lesson prefetch | Med | M | C5 |
| 11 | AI slide images: full-res PNG only, no compression/variants; covers full-size into 56–160 px boxes; no responsive pipeline (`uses-responsive-images` 0.5 on all routes) | Med | M | D3 |
| 12 | Per-row RLS helper functions on hot SELECTs (`can_read_course` per block row; `analytics_event`/`learning_events` aggregates; `deck_import_pages` per-row JOIN; realtime per-row) — EXPLAIN-confirmed; 1.58 M courses probes | Med→High at scale | M | C3 |
| 13 | Unindexed FKs (35; worst: `learning_events.attempt_id`, `analytics_event.campaign_id`, `homework_submissions.publication_id`, social wave set); missing `(status,visibility,published_at)` for marketplace scan + `(creator_id,updated_at)` for social queue; 6 redundant prefix indexes; 12 advisor-flagged unused indexes | Med | S | C3 |
| 14 | Snapshot re-expansion inside definer RPCs per row per request (`marketplace_listings`, `my_learning`, `is_review_eligible`) — persist `lesson_count`/`module_count` at publish time | Med | M | C1/C3 |
| 15 | Fetch-to-count: enrollments (dashboard, /analytics picker), `scheduled_send`+`sequence_enrollment` (hub/sequences), `learner_messages` latest-per-user; ~13 exact counts × per course on `/marketing/overview` + agent observe | Med | S | C2 |
| 16 | Unbounded list queries: agent_findings (jsonb, UI needs 5), learner_messages, course_roster (recomputed to `.find()` one learner), quiz_attempts+nested responses, subscribers, comms drafts API, marketplace/explore RPCs, pending approvals/questions | Med | S | C2 |
| 17 | (app) layout leaks framer-motion (ConfirmDialog) + supabase-js (SignOutButton) to every route; studio monolith statically imports VideoStudioModal/PublishPanel/AgentPlanHost/GlobalImageDialog/AgentPanel; marketing AgentDock bundles the chat panel everywhere | Med | S | D1 |
| 18 | Skeleton geometry mismatches: marketplace `h-24` vs `aspect-video`; marketing 6xl/3-col vs 7xl/2-col; studio double-skeleton; analytics tabs; learner-detail has none | Med | S | B2 |
| 19 | No optimistic UI: Accept/Reject, review submit, settings toggles all round-trip + full `router.refresh()`; approval resolution now triggers **two** full hub re-renders (immediate + deferred ≤180 s) | Med | M | B3 |
| 20 | Editor render waste (INP risk): whole-doc subscriptions ×15 incl. per-outline-row; structuredClone per patch + 100-snapshot undo; filmstrip SlideStage-per-slide + lintSlide + stringify compare per edit; selection fan-out into thumbnails; unthrottled pointermove store writes | Med (editor INP) | M | D5 |
| 21 | Agent panel streaming: per-token full-transcript re-render + O(n²) markdown + defeated doc-walk memo + smooth-scroll per delta (editor + marketing panels) | Med | M | D5 |
| 22 | No preconnect (Supabase/image.mux/stream.mux); learn-landing LCP cover lacks `fetchpriority` | Med | S | B4/D3 |
| 23 | No virtualization on unbounded tables (roster, content-health per-slide, leads, drafts, PostQueue) — server-payload today, render cliff at scale | Med | M | D2 |
| 24 | Marketing scheduler tick N+1 (~8 q/send → ~800 q per 100-send tick; wave's own `ctaDestCache` proves the fix shape); compliance now serial external HEAD/GETs per button (4 s timeout each) | Med (cron) | M | C1 |
| 25 | `countRevisionActionsSince`: exact count on the unbounded `marketing_action` ledger, unindexed predicates, before **every** social AI edit | Med (grows) | S | C2/C3 |
| 26 | Social queue: ≤100 full `select("*")` rows unfiltered by course into RSC; dead cursor (posts >100 unreachable); same-timestamp keyset skip | Med | S | C2 |
| 27 | `PostEditor.tsx` binary-in-git (raw NUL bytes) — review/diff/grep hazard; `social_post.regenerated_from_post_id` exists live but in no migration (drift) | Med (tooling/correctness) | S | C3 (migration reconcile) |
| 28 | Video asset poll every 3 s = a live Mux API call per tick, continues while captions generate though video is playable; response carries full transcript ×2 | Low–Med | S | C2 |
| 29 | Fraunces italic (~29 KB) preloads on every route; root-layout font placement contradicts "loaded only where used" | Low | S | D4 |
| 30 | Duplicate work per nav: layout+page `profiles` fetch ×2; marketing layout duplicates `selectCourseForAuthor`; studio duplicate `change_sets` query | Low | S | C1 |
| 31 | Zero perf instrumentation: no web-vitals/RUM, no Lighthouse CI, no bundle budgets, **no CI pipeline at all** (no `.github/`) — E-phase must also bootstrap CI | High (guardrail) | M | E1–E3 |
| 32 | `zz-materialize-preview` dev harness route ships in prod build; apple-icon 137 KB | Low | S | D1 |

**Verified healthy (do not "fix"):** all RLS policies already initplan-form; loading.tsx coverage on heavy routes; shiki lazy; learn route framer-free via existing dynamic imports; no barrel files; lucide via `optimizePackageImports`; dependency-free charts; analytics SDK batching (10 s flush, keepalive, backoff) sound; no polling at rest; storage signing batched; learner-detail timeline paginated; back/forward nav already instant; social wave: keyset pagination, no polling, type-only zod imports, agent-loop hard deadline + fast-return approvals (removed two real hang classes).

---

## Before-metrics baseline vs §2 targets

Environment: prod build, localhost:3100, seeded fixture (3-lesson course, 2-slide deck; marketing hub near-empty). Fixture-scale is a **best case** — real AI-generated courses (6–14 slides × many lessons) and active marketing accounts will be slower on every data-bound metric. Localhost TTFB includes real Supabase network RTTs (remote project) but no client↔server network; production (Vercel) will differ in both directions.

| §2 metric | Target | Baseline (worst route → best) | Status |
|---|---|---|---|
| LCP (throttled mobile P75 proxy) | ≤ 2.5 s | **5.2–7.4 s** (marketing → analytics) | ❌ all 5 fail |
| INP (P75) | ≤ 200 ms | No field data (no RUM). Lab proxies: TBT 9–156 ms; nav-click handler durations 16–48 ms; known INP risks in editor/agent streaming (A5 #1–5) | ⚠ measurable only after E1; proxies pass |
| CLS | ≤ 0.1 | 0.00 on all cold loads (mobile+desktop). Known un-measured soft-nav shifts (A6 #18) | ✅ cold; ⚠ soft-nav gap |
| TTFB (app routes, P75 proxy) | ≤ 800 ms | Desktop-LH 623–2645 ms; mobile-LH 1666–3818 ms; Playwright 919–2664 ms | ❌ 4–5 of 5 fail (learn desktop 623 ms passes) |
| First visual feedback on nav | ≤ 100 ms | Click→URL(=first possible paint): studio 189 ms · learn 549 ms · analytics 906 ms · **marketing 2424 ms**; no progress bar exists | ❌ all measured fail |
| Back-nav → content painted | ≤ 200 ms | **8–20 ms** (bfcache/Router-Cache) | ✅ passes today |
| Slide advance (prefetched) → rendered | ≤ 100 ms | **3.1 ms** (client-state advance; image-slide assets not prefetched — C5 gap is assets, not data) | ✅ data-path passes; ⚠ asset-path unmeasured |
| Data round trips per view | ≤ 2 | Server-side: dashboard 13 · studio 13 · learn 12 · analytics ~20 · marketing ~28 (browser-visible: 0 — all RSC) | ❌ all 5 fail |
| Route JS (gz) | ≤ 250 KB default | 391–639 KB | ❌ all 5 fail |
| Production RUM vitals | alerts only | No RUM exists | build in E1/E2 |

**Proposed per-route JS budgets (Phase-A deliverable; CI-enforced in D):** /dashboard **250 KB** · /studio **400 KB** (full authoring editor; modal subsystems split out — revisit after D1) · /learn lesson **250 KB** (achievable once the editor-store leak is cut) · /studio analytics **250 KB** · /marketing **300 KB** (hub + dock shell; chat panel dynamic). Everything else: 250 KB default.

## Measurement provenance & reproduction

- Harnesses (session scratchpad, to be productized as CI tests in Phase E): `perf-baseline.mjs` (Playwright: cold loads ×3 median, transitions, back-nav, slide advance, JS wire bytes, Supabase request counts) and `perf-lighthouse.mjs` (Lighthouse ×10 runs via `~/.npm-lighthouse`, auth via `sb-*` cookie header from Playwright `storageState`, `CHROME_PATH` = Playwright chromium; final-URL asserted ≠ /login). Raw outputs: `lab-results.json`, `lighthouse-summary.json`, `lh-*.json`.
- Fixture: `npm run seed:fixtures` (author + 2 learners, published course `econ-fixture-*`, claimed-scale rollups; do **not** press "Refresh data" on its analytics — it would overwrite the seeded rollups). Login = `/login` form; prod-server clicks can beat hydration → retry-click loop required.
- DB audit: Supabase MCP `execute_sql` under a transaction with `set local role authenticated` + `request.jwt.claims` for RLS-true EXPLAIN.
- pg_stat caveat, fixture-scale caveat, and hosting-unknown caveat as noted inline.

## Items requiring checkpoint decision (before Phase B–E work starts)

1. **Studio JS budget exception** — 250 KB is not realistic for the full editor; proposed 400 KB. Approve/adjust.
2. **INP** — lab cannot produce real INP; propose: E1 RUM (`perf_vital` event) is the INP source of truth; CI enforces TBT + the transition/interaction tests as proxies. The §2 table row stays "CI-enforced (test)" via those proxies.
3. **Auth-tax fix shape** (C1): per-request `react cache()` dedupe + local JWT verification (`getClaims`) vs. keeping one network `getUser` per request. Recommend cache() + `getClaims` with the middleware as the single verifier; needs sign-off since it touches the auth path.
4. **Snapshot-derived count columns** on `course_publications` (C1/C3): schema addition at publish time — safe under the immutability model (columns are new, snapshot untouched), but it is a migration on a core table.
5. **Live-DB drift**: `social_post.regenerated_from_post_id` (+ its advisor-flagged FK) exists in the live DB but in no migration — reconcile before C3's index migrations.
6. **`PostEditor.tsx` NUL bytes** — one-character fix (`" "` escape) but it rewrites a file owned by the other worktree's wave; coordinate to avoid a conflict.
7. **Baseline realism** — metrics were captured on fixture-scale data and a near-empty marketing hub. Accept as the official baseline (re-measured identically at each checkpoint), or require a scaled fixture first?

**AC-PERF-01: satisfied** — A1–A6 complete with before-metrics for all §2 targets on the top-5 routes.
