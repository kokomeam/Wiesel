# Performance — suites, budgets, RUM, CI (PERF-1 E3)

The wave's history: `PERF-1_diagnosis.md` (Phase A baseline) → `PERF-1_checkpoint2.md` (Phases B+C) → `PERF-1_checkpoint3.md` (Phases D+E). Caching rules: `caching-policy.md`. Raw measurement data: `baseline/` (Phase A) · `baseline/after-bc/` (post-B/C) · `baseline/after-de/` (final).

## Running the perf suites locally

| Command | What it is | Needs |
|---|---|---|
| `npm run verify:perf` | Pure logic: intent-prefetch (26) · optimistic rollback (35) · slide lookahead (26) · virtual windowing (26). In the `npm test` chain. | nothing |
| `npm run verify:vitals` | Pure RUM contract: perf_vital schema/builder/route-normalization/sampling (60). In the chain. | nothing |
| `npm run verify:perf:rt` | AC-PERF-07: counting-client proof that each top-5 route loads in ≤2 data round trips. | live Supabase (.env.local) |
| `npm run verify:perf:browser` | AC-PERF-02…06/09/10 in a real browser (39 checks + 2 documented skips). Self-manages `next start -p 3100`. | live Supabase + seeded fixture (`npm run seed:fixtures`) + a prod build |
| `npm run verify:budgets` | **The route-JS budget gate** (below). `-- --all` also holds every other route to the 250 KB default. | live Supabase (self-provisions its fixture) |
| `npm run verify:budgets:lh` | Lighthouse desktop assertions: CLS ≤ 0.1, TBT ≤ 300 ms, image audits (AC-PERF-13). | live Supabase + a Chrome install (`LIGHTHOUSE_BIN` optional) |
| `node docs/perf/baseline/perf-baseline.mjs` / `perf-lighthouse.mjs` | The checkpoint measurement harnesses (not gates) — full vitals + transition timings for before/after tables. | prod server on :3100 + seeded fixture |

Conventions that bite: prod server on **:3100** (**:3000 is the dev server — never touch it**); prod-served pages can beat hydration, so scripted clicks need the retry-click loop; Lighthouse must NOT use Playwright's chromium (`NO_FCP` — it stops painting under Lighthouse on some machines; system Chrome works); tsx does not auto-load `.env.local` (each suite loads it itself).

## Route JS budgets (AC-PERF-11)

**The single source of truth is the `BUDGETS` map in `scripts/verify-bundle-budgets.ts`.** Budgets are gzip wire bytes over script resources fetched before the load event (+500 ms hydration grace) — post-load idle prefetches of *other* routes' chunks are deliberately excluded (counting them would penalize B4's intent prefetching and bill every route for its neighbors). Stylesheets are excluded (they're not JS). Measured browser-cold / server-warm, upper-median of 2.

Current budgets: `/dashboard` 250 · `/studio` **550** (renegotiated from 400 at Checkpoint 3 — the map documents the decomposition: the editor's legitimate core is ~490 KB before feature code) · `/learn/[slug]/[lessonId]` 250 · `/studio/[courseId]/analytics` 250 · `/marketing` 300 · everything else 250 (`--all`).

Changing a budget = editing that ONE map, with a comment saying why. Never silently.

## §2 target → enforcement mapping

| Target | Enforced by |
|---|---|
| CLS ≤ 0.1 | CI: `verify:budgets:lh` + `verify:perf:browser` |
| INP ≤ 200 ms P75 | **RUM** (perf_vital → `perf_vitals_daily`); CI proxy = TBT ≤ 300 ms + the interaction/transition tests |
| LCP ≤ 2.5 s / TTFB ≤ 800 ms P75 | **RUM alerts only** (lab absolutes are machine-dependent; printed unasserted by the LH gate; trends in checkpoint tables) |
| First feedback ≤ 100 ms · back-nav ≤ 200 ms · slide advance ≤ 100 ms · ≤ 2 round trips | CI: `verify:perf:browser` + `verify:perf:rt` |
| Route JS budgets | CI: `verify:budgets` |

## RUM (perf_vital)

`components/perf/WebVitalsReporter.tsx` (root layout) reports final LCP/INP/CLS/FCP/TTFB via the `web-vitals` library → the EXISTING analytics ingest (`/api/analytics/ingest` → `ingest_learning_events` RPC, user pinned server-side, `client_event_id` idempotent). App-scoped rows (NULL course envelope) are invisible to client RLS; read them via the `perf_vitals_daily` view (P50/P75/P95 per metric/route/device/day, service-role only). Sampling: `NEXT_PUBLIC_PERF_VITALS_SAMPLE` (default 1 = report everything). **Production RUM thresholds are monitoring alerts, never quality gates** (standing rule; thresholds documented in the view header). Known gap (recorded, not worked around): signed-out visitors report nothing — the ingest path requires auth. `[FWD: agent-runtime-perf]` extends the same discriminated union later.

## CI (`.github/workflows/`)

- **`test.yml`** — the full pure chain (`npm test`, 31+ suites) on every PR. No secrets.
- **`perf.yml`** — build + `verify:perf` + `verify:budgets` + `verify:budgets:lh` on every PR. Requires the Supabase secrets listed in the workflow header; both gates self-provision throwaway users (point CI at a non-production Supabase project).
- The live-Supabase int suites (`verify:*:int`) and the browser suites stay local/manual by design (they exercise a shared live project).

## Proof the gate trips (AC-PERF-15, run 2026-07-23, then reverted)

A deliberate regression — `import "@/lib/course/patches"` (zod + schemas) + a static `framer-motion` import added to `components/shell/Sidebar.tsx` — and `npm run verify:budgets`:

```
route                             budget    run1      run2      median    status
------------------------------------------------------------------------------------
/dashboard                        250 KB    303 KB    303 KB    302.8 KB  FAIL (+52.8 KB over)
/studio                           550 KB    588 KB    588 KB    588.0 KB  FAIL (+38.0 KB over)
/learn/[slug]/[lessonId]          250 KB    212 KB    212 KB    212.3 KB  PASS
/studio/[courseId]/analytics      250 KB    301 KB    301 KB    300.7 KB  FAIL (+50.7 KB over)
/marketing                        300 KB    316 KB    316 KB    316.1 KB  FAIL (+16.1 KB over)
```

Every route sharing the bloated shell fails with the overage named; the learner route (different shell) correctly stays green. After reverting the two lines and rebuilding:

```
/dashboard                        250 KB    174 KB    174 KB    173.6 KB  PASS
/studio                           550 KB    544 KB    544 KB    544.4 KB  PASS
/learn/[slug]/[lessonId]          250 KB    212 KB    212 KB    212.3 KB  PASS
/studio/[courseId]/analytics      250 KB    172 KB    172 KB    171.5 KB  PASS
/marketing                        300 KB    250 KB    250 KB    250.0 KB  PASS
```
