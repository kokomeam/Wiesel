# UI-1 · CHECKPOINT-FINAL — the Marketing Hub overhaul is complete

> Date: 2026-08-02 · Branch: `feat/marketing-analytics`.
> Verification at close: `npm run verify:ui` **151/151** (in the `npm test` chain — 30 suites, exit 0) · `npm run verify:ui:browser` **121/121** vs the production build · `next build` + `eslint` clean.
> Docs: `docs/ui1-design-system.md` (tokens · primitives · humanization contribution rule · activity template guide) + a CLAUDE.md section. Reports: `ui1-task0-audit.md`, `ui1-checkpoint-w2.md`, `ui1-checkpoint-w4.md`, this file.
> Screenshot matrix: before `screenshots/ui1/` (Task 0) → after `screenshots/ui1/after-w4/` (1440/1024/768/390, drawer ×3 states, expanded feed, mobile sheet, empty hub).
> `playwright` + `axe-core` were temp devDependencies for the browser suite and are uninstalled (repo convention; the suite header documents `npm i -D playwright axe-core` as its prereq). Runtime deps unchanged (22).

## Before → after metrics

| Metric | Before (Task 0) | After |
|---|---|---|
| Lighthouse a11y (desktop/mobile) | 0.90 / 0.90 — 3 failing audits | **1.00 / 1.00 — zero failing audits** |
| axe serious/critical (hub, drawer, mobile, empty) | not gated | **0/0/0/0, gated in CI suite** |
| Lighthouse perf (desktop) | 0.78 (LCP 2.4s) | 0.78 (LCP 2.9s; 0.76–0.83 across runs — local-server variance; TBT 20ms→0ms) |
| CLS | 0 | **0** (AC ≤0.02) + a real loading skeleton for soft navs |
| /marketing JS | 457 KB (networkidle) | 488–551 KB load-scoped, budget-gated ≤620 KB (DEV-4); networkidle ≈ 540–680 incl. prefetch noise (methodology note in W4 report) |
| FAB × click-target overlap | 1,813 px² | **0 px² across ~44 targets, gated** |
| Horizontal overflow (inner `<main>`) | 1024/768/390 all overflowed; 134px mobile strip | **zero at all four widths, gated** |
| Raw tool identifiers rendered | 5 | **0 (all 66 gated)** |
| Feed entry | ~150-word prose dump | ≤80-char template + chip + detail, gated |

## Complete AC ledger

| AC | Test / evidence | Status |
|---|---|---|
| AC-W1.1 zero raw values | `tokens-no-raw-values.test` (verify-ui) | **PASS** (scoped file list per CHECKPOINT-0) |
| AC-W1.2 primitives all states + snapshots | `primitives-snapshot.test` + `/zz-ui-fixtures` | **PASS** (22 fixtures incl. empty/skeleton) |
| AC-W1.3 status→token 1:1 | `status-chip.test` | **PASS** |
| AC-W1.4 exhaustive humanization | `humanization-map.test` + browser `humanize.test` | **PASS** (66 ≡ registry; type + drift enforced) |
| AC-W2.1 layout matrix, no overflow | browser `layout.test` | **PASS** |
| AC-W2.2 nav ≤88px, all destinations | browser `nav.test` | **PASS** (68px; 9 links + FAB agent) |
| AC-W2.3 overview, approvals ≤1 click | browser `overview.test` + parity table (W2 report) | **PASS** (0 clicks) |
| AC-W2.4 two-resident rail | browser `rail.test` | **PASS** |
| AC-W2.5 zero FAB intersection | browser `fab.test` | **PASS** |
| AC-W2.6 reachability parity | table in `ui1-checkpoint-w2.md` | **PASS** (no regressions) |
| AC-W3.1 no standing copy; ⓘ popover | browser `activity.test [W3.1]` | **PASS** |
| AC-W3.2 anatomy, ≤80ch, single line | `activity-summaries.test` + browser | **PASS** |
| AC-W3.3 deterministic exhaustive templates | `activity-summaries.test` | **PASS** (66×3 stress + exact fixtures) |
| AC-W3.4 translated detail, no localhost | browser `[W3.4]` + copy-lint | **PASS** |
| AC-W3.5 revert visible/near/expired | browser `[W3.5]` | **PASS** |
| AC-W3.6 day groups + 100-fixture load | browser `[W3.6]` | **PASS** |
| AC-W3.7 humanized fallbacks (+D-16) | chip tests + browser `[W3.7+D-16]` | **PASS** |
| AC-W3.8 trust copy ×3 locations | `trust-copy-locations.test` | **PASS** |
| AC-W4.1 drawer focus/Escape/restore | browser drawer tests + keyboard walkthrough | **PASS** |
| AC-W4.2 modes, no truncation, compare | browser `[W4.1/W4.2]` + drawer screenshots | **PASS** |
| AC-W4.3 grouped rows, zero overlap | browser locked-group + clipped matrix | **PASS** |
| AC-W4.4 form groups + validation | browser `[W4.4]` | **PASS** |
| AC-W4.5 dirty/save/discard/conflict | browser `[W4.5]` ×3 (REAL concurrent write) | **PASS** |
| AC-W4.6 consequence from state | `autonomy-copy.test` + browser | **PASS** |
| AC-W5.1 copy-lint over rendered strings | `copy-lint.test` (271 strings) | **PASS** |
| AC-W5.2 axe zero serious/critical + keyboard | browser axe ×4 + `keyboard.test` | **PASS** (Lighthouse a11y 1.00) |
| AC-W5.3 empty/loading states, CLS ≤0.02 | fixtures + browser `empty-states.test` + Lighthouse CLS 0 | **PASS** |
| AC-W5.4 matrix, no clipped elements | browser clipped checks ×4 widths + screenshots | **PASS** |
| AC-W5.5 perf parity + budget | metrics above + `budget.test` | **PASS** (a11y ↑, CLS =, perf within run variance; budget gated) |
| AC-W5.6 docs | `docs/ui1-design-system.md` + CLAUDE.md section | **PASS** |

Defects D-1..D-15 (directive) all closed; bonus defects found and closed: D-16 (auto·policy mislabel), D-17 (mobile shell), D-18 (toast/FAB/drawer stack), D-19 (baked-URL containment), D-20 (palette drift), D-21 (primitive duplication) — plus two REAL bugs the new tests caught: the Drawer focus-teleport on parent re-render, and the segmented-control label truncation.

## Invariant attestation

- **INV-1 (approval rail load-bearing):** ApprovalCard/QuestionCard changed visually only; approve/edit/reject flows untouched; the six hard-denied actions render locked in every mode with no toggle (browser-asserted); the gate/engine/save-strip triple enforcement is byte-unchanged (verify:marketing:autonomy in the green chain).
- **INV-2 (revert reachable):** one click from the collapsed feed row for the whole window (inline control asserted with fresh/near-expiry labels); expired rows show nothing; `rejectAction`'s fail-closed expiry untouched.
- **INV-3 (settings survive identically):** every field present and mapped (drawer screenshots); persistence semantics changed exactly once, as DEV-2 approved (guarded save with informed re-apply, proven live); server-side stripping/parsing unchanged.
- **INV-4 (reachability):** parity table — no destination regressed; approvals 0 clicks.
- **INV-5 (budgets/perf):** no CI enforcement existed on this branch (DEV-4, flagged at CHECKPOINT-0); the budget gate now exists in verify:ui:browser; deltas reported every checkpoint; Lighthouse a11y improved, CLS held at 0, perf within measured run variance.
- **INV-6 (no parallel systems):** one token source (`@theme`), primitives extend `components/ui/`, zero new runtime dependencies; the only structural move was the approved DEV-6 relocation.
- **INV-7 (human input never routes through approvals):** no review/feedback surface was touched; nothing in the feed or drawer ingests direct human input into approval flows.

## Deviations raised across checkpoints (all approved or flagged, none silent)

DEV-1 (templates over the tool union + `summary_fields`), DEV-2 (`updated_at`-guarded save), DEV-3 (responsive shell, boundary amended to xl by measurement), DEV-4 (budget tooling in-suite), DEV-5 (Explore = 10 + header Overview), DEV-6 (educators relocation), DEV-7 (fully-visible nav strip; scroll strip 768–1023 by measurement), the W4.4 placeholder-copy truthfulness amendment, and the W3.7 pending-vs-resolved scope note.
