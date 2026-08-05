# TUTOR-1 — Wave 5 Checkpoint: Creator Tutor Console

**Date:** 2026-08-05 · **Status:** COMPLETE → **HARD STOP** (Directive-mandated).
Wave 5 is the wave that determines whether creators trust the tutor; the review
artifact is **Henry driving the console against the seeded fixture** — reviewing
a staged graph, editing it, and reading the analytics — before Wave 6.

Preconditions (all met before code): **P-W5.1** Wave 4 closed + pushed
(`f353db5`); **P-W5.2** Henry drove the Wave-4 demo and confirmed it works (no
behavioral/tonal defects → no fix pre-items); **P-W5.3** delta check clean (git
tree clean, every Wave-5 table/RPC present live, no contradicting drift).

---

## 1. Commits (all wave-authored, on `main`)

| Commit | Package |
| --- | --- |
| `c25d1ec` | W5.1 — console shell + Overview + Enablement + Charter |
| `a754985` | W5.2 — concept graph editor (pure-SVG, versioned edits, cohort-floored overlays) |
| `277f800` | W5.3 — analytics: most-missed, bad-lesson detection, funnels |
| `16a06ed` | W5.4 — fixture, demo seed, browser AC suite, edge editing + a11y |

**Migrations** (applied to the live project + live-verified — see §6):
`20260805100000_tutor_console_rpcs` · `20260805110000_tutor_graph_console` ·
`20260805120000_tutor_lesson_health`.

---

## 2. Acceptance criteria — every AC, named test, literal result

> Naming: the order's `e2e/*.spec.ts` / `*.test.ts` names map to this repo's
> runnable `scripts/verify-*.ts` suites (no `e2e/` dir — the convention since
> Wave 1). Browser section ids match the AC ids verbatim.

| AC | What was proven | Test | Result |
| --- | --- | --- | --- |
| AC-T5.1 | enable toggle OFF → learner sidebar absent + typed disabled; ON without an accepted graph → routes to the extraction flow, blocked until acceptance | `verify-tutor-console-int` + `verify-tutor-console-browser` (T5.1, 9) | int 21/0 · browser PASS |
| AC-T5.2 (UI) | changing `guidance_style` writes a `tutor_charter_versions` row (actor + timestamp) + moves the pointer; the next assembled prompt reflects it; history row rendered | `verify-tutor-console-int` + `-browser` (T5.2-UI, 5) | int 21/0 · browser PASS |
| AC-W5O.1 | Overview usage is cohort-floored (`>= 5`); a sub-floor course renders the suppressed state with NO counts | `verify-tutor-console-int` + `-browser` (W5O.1, 3) | int 21/0 · browser PASS |
| AC-T5.3 | rename persists; a cycle-creating edge is REJECTED by `tutor_upsert_concept_edge` with the specific offending-path message; lock persists; **(W5.4) the node drawer now exposes add/lock/remove edge affordances** | `verify-tutor-graph-console-int` + `-browser` (T5.3, 7) | int 25/0 · browser PASS |
| AC-T5.4 (merge mastery) | editor merge folds `learner_mastery` per §1.4 (evidence-weighted survivor; absorbed rows summed then deleted) — the only path is the definer `tutor_merge_concept_nodes` | `verify-tutor-graph-console-int` (T5.4) | 25/0 |
| AC-W5G.1 | layout purity: golden outputs for 3 fixture graphs (linear / branching / deep-prereq); zero edge-crossing regressions | `verify-tutor-graph-console` (W5G.1 goldens) | 24/0 |
| AC-W5G.2 | staged change-set review: per-node classification rendered; edit-before-accept persists; Accept activates; Reject restores byte-for-byte | `verify-tutor-graph-console-int` + `-browser` (W5G.2, 8) | int 25/0 · browser PASS |
| AC-T5.5 | the seeded degraded lesson ranks #1 in "Lessons needing attention" with evidence naming the implicated question/node | `verify-tutor-analytics-console` + `-int` + `-browser` (T5.5) | int 26/0 · browser PASS |
| AC-T5.6 | cohort < 5 → suppressed; a creator session reads ZERO individual mastery/detail/turn rows by any path (RLS matrix extended to every new RPC) | `verify-tutor-analytics-console-int` + `-graph-console-int` | 26/0 · 25/0 |
| AC-A1.3 | aggregate `most_missed_questions` RPC: suppression below floor; first/second-attempt rates + per-option counts match hand-computed fixture values | `verify-tutor-analytics-console` + `-int` | 30/0 · 26/0 |
| AC-A1.4 | panel renders ranked questions + distractor counts; suppressed state sub-floor; teaching-slide deep link navigates | `verify-tutor-analytics-console-browser` (A1.4, 12) | browser PASS |
| AC-A1.5 | first-attempt error rate demonstrably moves the bad-lesson ranking (fixture A vs B differing only in that input) | `verify-tutor-analytics-console` (composite goldens) | 30/0 |
| AC-T5.4 (a11y) | axe **zero serious/critical** on all four panels; the graph editor is keyboard-operable (node-list nav + keyboard edit) | `verify-tutor-console-browser` (T5.4, 6) | browser PASS |

**Browser suite total:** `verify-tutor-console-browser` → **51 passed, 0 failed,
exit 0** (live server + seeded fixture). axe serious/critical per panel:
**overview 0 · charter 0 · graph 0 · analytics 0**.

---

## 3. Repo gates (bare exit codes)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0** — the 1 pre-existing warning baseline (zero added) |
| `npm run build` | exit **0** |
| `npm run verify:budgets` | 6/6 PASS · exit **0** |
| `verify-tutor-console` / `-graph-console` / `-graph-ui` / `-analytics-console` (pure) | **25 / 24 / 92 / 30**, exit 0 each |
| `verify-tutor-console-int` / `-graph-console-int` / `-analytics-console-int` (live) | **21 / 25 / 26**, exit 0 each |
| `verify-tutor-console-browser` (live, 8 AC sections) | **51/0** · exit 0 |
| `seed:tutor-console-demo` (end-to-end) | exit 0 — prints the click-path |
| `npm test` (full pure chain, 57 suites) | exit **0** (all suites 0 failed) |
| `npm run verify:tutor:int` (full tutor int chain) | 14/33/36/32/24/21/25/26 · exit **0** |

---

## 4. Bundle (new route, measured with headroom)

| Route | Warm JS (gz) | Budget |
| --- | --- | --- |
| **`/studio/[courseId]/tutor`** (the new console, full graph editor + analytics) | **230.7 KB** | **250** (measured 218.6 KB at the shell + editor/analytics; NOT inherited from /studio's 600) |
| `/learn/[slug]/[lessonId]` | 216.3 KB | 250 — **UNTOUCHED** by this wave |

The graph editor is fenced off the ~590 KB editor bundle — **zero**
`lib/course/store` / `patches` / `uiStore` / `dragStore` / `SlideStage` imports
(fence-tested in `verify-tutor-graph-console` + `-graph-ui`) — so the console
carries only its own weight on its own budget.

---

## 5. The demo path (the review artifact)

`docs/tutor/demo.md`'s sibling for the console: **`npm run seed:tutor-console-demo`**
(verified exit 0). It publishes a Microeconomics course, enrolls ≥6 learners with
per-question detail, seeds an accepted concept graph + a deliberately degraded
lesson, enables the tutor, recomputes lesson-health, and prints:

```
  Author email      : tutor-fixture-<rand>@example.com
  Author password   : Test-passw0rd!
  Console URL       : /studio/<courseId>/tutor
  Tour (four tabs):
    Overview      → cohort-floored usage (≥5) + tutor spend
    Charter       → change the guidance style; every save is versioned
    Concept graph → an accepted, editable graph (rename/add-edge/merge/split,
                    mastery/confusion overlays, drawer detail)
    Analytics     → the degraded lesson ranks #1 + the most-missed questions table
```

Run `npm run dev` (has `OPENAI_API_KEY`), sign in as the printed author, open the
Console URL. Each run mints fresh throwaway `*@example.com` users — clean them in
Supabase → Auth afterward.

---

## 6. Privacy-proof (D-4) — every new creator-reachable RPC + its floor + RLS

The invariant: every creator-facing number comes from an author-gated, cohort-
floored (`>= 5`) SECURITY DEFINER RPC; the raw learner tables keep ZERO author
policies. All six new functions were **verified live** (security-definer, anon
revoked, grants as stated):

| RPC | Author-gated | anon exec | auth exec | Cohort floor | Notes |
| --- | --- | --- | --- | --- | --- |
| `tutor_console_bundle(uuid, text)` | yes (null for non-author) | **no** | yes | usage `>= 5` (else `usageSuppressed`, no count) | cost = author's own spend, no learner attribution |
| `tutor_graph_console(uuid)` | yes | **no** | yes | mastery + confusion overlays `>= 5` (`suppressed`) | nodes/edges are author-owned (author RLS) |
| `tutor_merge_concept_nodes(uuid, uuid, uuid[])` | yes (raises) | **no** | yes | — (write path) | the ONLY writer of service-role-only `learner_mastery` (§1.4 fold) |
| `most_missed_questions(uuid)` | yes | **no** | yes | question omitted if `< 5` distinct learners | first/second-attempt + distractor counts derived in SQL, NO learner rows emitted |
| `lesson_health(uuid)` | yes | **no** | yes | per-lesson inputs floored | ranked read of the composite |
| `recompute_lesson_health_admin(uuid)` | — | **no** | **no** | — | **service-role only** — the nightly Inngest entry point |

**Untouched (still ZERO author policies / own-only):** `learner_mastery` (one
own-select policy), `quiz_attempt_detail` (zero policies), `tutor_turns`
(own-only), `mastery_review_queue` / `mastery_course_aggregate` (zero policies).
Authors read these ONLY through the floored definer RPCs above.
`verify-tutor-analytics-console-int` + `-graph-console-int` assert a non-author
authenticated session gets `null`/zero rows from every new RPC.

---

## 7. Deviations & disclosures

The order's target was empty deviations. Disclosed in full; none is a new
capability/table/behavior beyond the governing documents (zero-surprise rule),
none weakened a test.

1. **a11y contrast remediation (AC-T5.4-driven).** The axe scans surfaced three
   pre-existing low-contrast text spots on the console/graph surfaces (tab nav,
   overlay legend, empty-drawer aside) — fixed as `text-stone-400/500 → 500/600`
   className swaps (the documented WiseSel stone gotcha). No logic touched.
2. **Terra cost telemetry deferred for the lesson-health rationale.** The
   `tutor_model_call.job_type` CHECK is closed to the four existing jobs; adding
   a `lesson_rationale` cost row would widen an existing migration's constraint
   (cross-file, out of scope). The nightly call is semaphore-pooled but not
   cost-emitted; the composite/ranking is fully deterministic SQL, so the
   model's spend is not correctness-load-bearing. A one-line CHECK-widen is the
   clean follow-up if per-job tutor cost tracking is wanted.
3. **`rollup_lesson_health` accessed via the `rpcJson` untyped-client cast**
   (not a `database.types.ts` splice) — the new table isn't in the generated
   types and a full regen risks the cross-branch drift the repo already carries;
   the cast is the documented house escape-hatch. Functionally complete; a types
   splice is an optional tidy-up.
4. **A `recompute_lesson_health_admin` service-role wrapper** (not named in the
   order) — `private.recompute_lesson_health` isn't on the PostgREST RPC surface,
   so the nightly Inngest job needs a grantable entry point (mirrors
   `refresh_all_course_analytics`); service-role-only, verified.
5. **Two migration-history rows per applied migration** (the MCP `apply_migration`
   artifact — a create then a create-or-replace during authoring). Each repo
   migration file is the single canonical fresh-apply artifact and matches the
   live function; consistent with the project's MCP-managed migration reality
   (live version numbers never match repo filenames).

---

**HARD STOP.** Wave 6 (the escalation loop) does not begin without Henry's
explicit release. The review artifact is Henry using the console against the
seeded fixture (`npm run seed:tutor-console-demo`) — reviewing the staged graph,
editing nodes/edges, and reading the analytics — before anything else proceeds.
