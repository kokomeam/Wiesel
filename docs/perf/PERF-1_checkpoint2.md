# PERF-1 Checkpoint 2 — Phases B + C complete

**Date:** 2026-07-17 · **Scope:** Phase B (perceived performance) + Phase C (data layer & caching), per the approved Checkpoint-1 plan and decisions (studio budget 400 KB · RUM-as-INP source · `react cache()` + middleware scope-down auth fix · publication count columns · drift reconcile · NUL fix · fixture-scale baseline).
**Gate at this checkpoint:** `npx tsc --noEmit` clean · `npm run lint` clean · `npm run build` green · **`npm test` = 27 suites, 0 failures** (now includes `verify:perf`) · `verify:publish:int` 50 + `verify:learn:int` 61 green against the live DB post-RPC-swap · all migrations applied live and recorded.

---

## Acceptance criteria

| AC | Requirement | Status | Evidence / test |
|---|---|---|---|
| AC-PERF-02 | Transition feedback ≤ 100 ms on top-5 transitions | **PASS** | `scripts/verify-perf-browser.ts` (§1): NavProgress enters active state 0.0–0.1 ms after click (synchronous capture-phase trigger), visible 9–14 ms; two routes exercised |
| AC-PERF-03 | No blank/spinner-only data views; CLS ≤ 0.1 on top-5 | **PASS** | browser suite (§2): buffered layout-shift CLS 0.0000 on all 5 routes; skeleton-or-content race asserts never-blank; all 8 skeletons geometry-matched (wave 1) |
| AC-PERF-04 | Back-nav paints ≤ 200 ms from cache + background revalidation | **PASS** | browser suite (§3): content 5–10 ms, zero blank frames; honesty branch — a background RSC refetch is asserted when observed, otherwise the entry is asserted inside the `staleTimes.dynamic` 30 s freshness window (both branches exercised across runs) |
| AC-PERF-05 | Optimistic mutations incl. Accept/Reject with tested rollback | **PASS** | `scripts/verify-optimistic.ts` 35 pure checks (state machines: apply→confirm, apply→fail→rollback byte-for-byte, double-fire/stale-op guards); browser suite (§4): settings radio flips 11 ms → injected 500 → rollback + toast → real flip persists. Learner-review browser rollback SKIPPED honestly (fixture student below the 70 % eligibility gate) — covered by the pure machine + static hook checks |
| AC-PERF-06 | Hover warms the destination cache before click | **PASS** | browser suite (§5): full prefetch fires 152 ms after hover; warm click paints 372 ms vs 1920 ms cold (5.2×). Found+fixed a real bug en route: on Next 16's segment cache, bare `router.prefetch()` = AUTO/partial (a no-op vs viewport prefetch) — `IntentLink` now pins `{kind:"full"}` |
| AC-PERF-07 | ≤ 2 data round trips per top-5 route | **PASS** | `scripts/verify-perf-rt.ts` 20 checks — Proxy counting clients over every route loader: dashboard 1 (+≤1 cold snapshot), studio 1, learn 2, analytics 1/tab + 1 detail, marketing 2 (course resolve + bundle). Streamed approval previews are deliberately outside the primary budget (documented) |
| AC-PERF-08 | Index/RLS migrations + before/after EXPLAIN | **PASS** | 4 migrations applied (`20260717100000–100300`) + 5 route-RPC migrations (`100400–100800`). EXPLAIN before: `Filter: private.can_read_course(course_id)` per row, 190 buffers/3 rows → after: `Filter: (ANY (course_id = (hashed SubPlan 3).col1))`, 7 buffers (plans recorded in the diagnosis §A3 and below). 37 indexes added, 6 redundant dropped |
| AC-PERF-09 | Published assets return immutable cache headers; repeat view from cache | **PASS** | browser suite (§6): fresh upload through the shared `IMMUTABLE_ASSET_CACHE_SECONDS` path serves `cache-control: max-age=31536000`; second GET logged `cf-cache-status: HIT` (CDN layer noted environment-dependent); object cleaned up |
| AC-PERF-10 | Slide advance into prefetched slide ≤ 100 ms; lookahead caps + saveData | **PASS** | browser suite (§7): advance 5.2 ms; `scripts/verify-lookahead.ts` 26 pure checks (concurrency cap 2, saveData/2g gate, dedupe, bounds). Image-warm browser assertion SKIPPED (fixture deck has no image slides) with the pure-suite pointer |
| AC-PERF-01 | (Phase A) diagnosis + baseline | PASS at Checkpoint 1 | `docs/perf/PERF-1_diagnosis.md` |

Suite entry points: `npm run verify:perf` (87 pure, in the `npm test` chain) · `npm run verify:perf:browser` (39 + 2 documented skips; self-manages `next start -p 3100`) · `npx tsx scripts/verify-perf-rt.ts` (20, live Supabase).

## Phase B/C items — disposition

- **B1 Navigation feedback — done.** `components/perf/NavProgress.tsx`: starts synchronously on same-origin link clicks + popstate, trickles asymptotically (position easing toward an unknown-duration event — not fake completion), fills only on real pathname/searchParams change, 15 s abandon fade, reduced-motion jumps states. Mounted in the root layout.
- **B2 Skeletons — done.** All eight route skeletons rebuilt/verified against their real layouts (marketplace/explore aspect-16/9 card twins, marketing 7xl ask-bar 2-col, dashboard card-grid + two-card rail, analytics overview, learner-detail two-col + timeline [new file], learn lesson progress-pill + objective rows, studio neutral frame). Studio's variant ambiguity (`?course=` — loading.tsx can't read searchParams) is documented in-file; the neutral frame is deliberately variant-agnostic.
- **B3 Optimistic UI — done.** Change-set Accept (instant pending-clear, snapshot rollback), Reject ("reverting" chrome; the doc revert stays server-authoritative and `suspendAutosaveForReject` ordering is preserved exactly), learner review submit/dismiss, settings portal radio. Shared machines in `lib/perf/optimistic.ts`, 35 checks.
- **B4 Intent prefetch — done.** `IntentLink` (hover/focus/touch → full-route `router.prefetch({kind:"full"})`, 80 ms debounce, ≤3 concurrent, 30 s TTL — `lib/perf/intentPrefetch.ts`, 26 checks) on both sidebars, course nav, and course cards; viewport code-prefetch remains at the Link default; preconnects to the Supabase origin + `image.mux.com` + `stream.mux.com` in the root layout.
- **B5 Cache-first — done.** Router Cache is the client cache (`staleTimes {dynamic:30, static:300}` — §9-compliant: no parallel query library); entity tiering lives server-side (immutable publication bodies cached forever, drafts never, analytics via rollups). Documented in `docs/perf/caching-policy.md`.
- **B6 View Transitions — N/A with evidence.** Stable React 19.2.4 exports no `ViewTransition` (`node -e` check recorded); Next's `experimental.viewTransition` requires the experimental React channel. Degraded behavior = current behavior; revisit when React ships it stable.
- **C1 Waterfalls — done.** One SECURITY DEFINER bundle RPC per hot route (`creator_dashboard`, `studio_course_bundle`, `learn_lesson_state`, `course_analytics_bundle` + `learner_detail_bundle`, `marketing_hub_bundle`), auth pinned inside, Zod-parsed loaders with injectable clients; auth tax 3–4 → 1 network call per render pass (`getSessionUser`/`getSessionProfile` `react cache()`); middleware off `/api` and zero-RTT for anonymous public pages; imported decks off the lesson SSR path; marketing approval previews stream behind the shell (per-card Suspense slots — typed input survives previews landing); progress/quiz/homework POSTs use the snapshot cache (quiz keeps "grade what they saw" — cached fetch is BY publication id).
- **C2 Hygiene — done** (within B+C scope): counts moved into SQL (enrollments, sequences overview, findings, heartbeat), `learner_messages` DISTINCT ON, timeline offset→keyset (`?before=`), attempts capped 25 (+ exact `attempt_count`), approvals/questions bounded 20, narrow projections in every bundle (no `before_snapshot`/`params` over-fetch, `video_assets` sans dead `transcript`). Remaining flagged sites outside the top-5 hot paths (marketing overview per-course count fan-out, scheduler-tick N+1, video-poll payload/backoff, social queue course filter) are recorded for Phase D/E backlog — see "Deferred" below.
- **C3 Indexes/RLS — done, applied live.** Semi-join SELECT policies (9 tables + `course_reviews` merge), 37 FK/functional indexes, 6 redundant drops, publication `lesson_count`/`module_count` (trigger-guarded, backfilled 10/10, RPC consumers rewritten with COALESCE fallbacks), social drift reconciled. Post-swap: `verify:publish:int` 50 + `verify:learn:int` 61 green.
- **C4 CDN caching — done.** `cacheControl: 31536000` at all five upload sites (UUID-immutable objects; replace-flows delete old objects); deck pages stay signed-URL by design (documented trade-off). Draft assets unaffected.
- **C5 Lookahead — done.** Slides N+1/N+2 image warm (≤2 concurrent, saveData/2g-gated, session-deduped, author-preview-gated); advance 5.2 ms measured.

## After-metrics vs baseline (same fixture, same environment, prod build on :3100)

**Playwright desktop unthrottled (median of 3):**

| Route | TTFB before→after | LCP before→after | JS gz before→after |
|---|---|---|---|
| /dashboard | 1084 → **1075 ms** | 2944 → **1440 ms** | 456 → 458 KB |
| /studio | 2664 → **1106 ms** | 3052 → **1460 ms** | 639 → **717 KB** ⚠ |
| /learn lesson | 919 → **674 ms** | 4476 → **1068 ms** | 590 → 593 KB |
| /studio analytics | 2243 → **1014 ms** | 6584 → **1404 ms** | 391 → **318 KB** |
| /marketing | 1469 → **1027 ms** | 2496 → **1384 ms** | 396 → **379 KB** |

**Lighthouse throttled mobile (score · LCP · TTFB):** dashboard 69→74 · 6.3→5.2 s · ~flat; studio 72→76 · 6.6→6.7 s · 3478→1531 ms; learn 74→78 · 6.0→5.6 s · 1888→1174 ms; analytics 74→77 · 7.4→5.7 s · 1666→1420 ms; marketing 76→81 · 5.2→4.9 s · 2928→1747 ms. Desktop scores: 97/97/97/81/85 (were 95/96/93/82/81).

**Transitions (cold click, no hover intent):** click→content learn 5386→**1397 ms**, analytics 5922→**1682 ms**, marketing click→URL 2424→**1081 ms**; with hover intent the same navigation paints in **372 ms** (AC-06). First VISUAL feedback is now the NavProgress bar at ~10 ms regardless. Back-nav 8–20 ms (unchanged, still passing); slide advance 14 ms.

**Server data round trips per view:** 13/13/12/~20/~28 → **1–2 everywhere** (counting-client-verified).

**Reading.** Phases B+C moved what they target: round trips (13–28 → ≤2), TTFB (worst route 2664 → 1106 ms), desktop LCP (all routes now ≤1.5 s except none), feedback (2.4 s of nothing → 10 ms bar), and honest caching. **Throttled-mobile LCP remains above the 2.5 s target on all routes** — it is now dominated by JS transfer + hydration under 4× CPU/slow-4G simulation (route bundles 318–717 KB vs the 250/400 KB budgets), which is exactly **Phase D's** mandate (code-splitting, the learner-route editor-store leak, image pipeline). Mobile-LCP is expected to close there; it is not evidence of a failed B/C item.

## Deviations & judgment calls (all recorded by the implementing lanes)

1. Behavior-preserving payload extensions: `enrollments_total` (dashboard "Total learners" counted dropped learners), severity-ranked attention findings (plain newest-first would change the rail), `quiz_attempt_counts` (LearnQuiz renders "N previous attempts"), analytics `stuck_count`/`computed_at`/reviewer-name join, stuck-tab snapshot maps.
2. Sanctioned bounds (spec-assigned, mildly visible at extreme data sizes): homework history latest-20/course, attempts newest-25 (+exact count), approvals/questions newest-20.
3. Learner-detail pager semantics: keyset cursor can't express "one page newer" — "Newer" jumps to latest; label shows "Before {date}".
4. Approve is NOT disabled while previews stream (approve re-runs the tool server-side and never consumes the preview — disabling would have changed semantics).
5. Two browser-suite SKIPs (review rollback eligibility; image-warm with an imageless fixture deck) — both covered by pure suites and documented in-script.
6. Measurement caveat: the after-Lighthouse runs use system Chrome — the Playwright Chromium binary stopped painting under Lighthouse mid-wave (NO_FCP even on example.com; environment issue, binary unchanged since June). Simulated throttling normalizes most of the difference; Playwright-lab numbers (same browser before/after) are the primary comparison.
7. `docs/perf/baseline/after-bc/` holds the after-run raw JSON next to the Phase A baseline.

## Deferred (recorded, not silent): Phase D/E backlog additions

Studio bundle grew 639→717 KB gz (new perf client components + loaders — Phase D splits the modal-gated editor subsystems and owns the 400 KB budget); marketing-overview per-course exact-count fan-out; scheduler-tick per-send N+1 (cron path; the wave's own caches prove the fix shape); video asset-status poll backoff + narrow projection; social queue course filter + narrow list projection; `zz-materialize-preview` route removal; Fraunces italic preload; `verify-perf-rt.ts` package.json wiring (goes in with Lighthouse CI in E3).

**STOPPED at Checkpoint 2 per §8. Phases D (rendering & bundle) and E (instrumentation & CI guardrails) await approval.**
