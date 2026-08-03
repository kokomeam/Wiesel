# UI-1 · CHECKPOINT-W2 — Waves 1–2 (foundation + layout) landed

> Date: 2026-08-01 · Branch: `feat/marketing-analytics` · Status: **awaiting checkpoint approval — Waves 3–5 not started.**
> Verification: `npm run verify:ui` **110/110** · `npm run verify:ui:browser` **59/59** (vs prod build on :3100) · full `npm test` chain **exit 0** (verify:ui now in the chain) · `next build` + `eslint` clean.
> Screenshots: before = `screenshots/ui1/` · after = `screenshots/ui1/after-w2/` (matrix at 1440/1024/768/390 + drawer + mobile nav + FAB states).

## What landed

**Wave 1 — tokens & primitives**
- `app/globals.css` `@theme` gained the UI-1 token layer: 5 semantic status trios (text/bg/ring for success·pending·attention·neutral·destructive), type scale (`--text-meta/secondary/body/title/section/display`), spacing (`--spacing-card-pad/gutter/section-gap/row-h/fab-clearance/rail`), radii (`card/panel/control`), elevation (`--shadow-card` — the 46×-duplicated literal is now one token — and `--shadow-overlay`), motion (`--ease-out-brand`), `--tracking-eyebrow`, gradient endpoints, and a `font-display` custom utility (replaces 13× `[font-family:var(--font-display)]`; not an `@theme` token because next/font owns the variable — a theme entry would be circular).
- New primitives in `components/ui/`: **StatusChip** (the one status vocabulary), **Drawer** (portal, focus trap, Escape, restored focus, overlay refcount, left/right, full-screen sheet <sm), **SegmentedControl** (radiogroup + roving tabindex), **Toggle** (role=switch), **FieldGroup**, **Input/Select**, **StickyActionBar**, **SectionHeader** (with the info-popover slot W3.1 needs), **Eyebrow**, **IconTile**, **ListRow**; existing Card/CardHeader/CollapsibleCard/PageHeader/ConfirmDialog tokenized. `lib/ui/overlayStore.ts` (FAB exclusion) + `lib/ui/useMediaQuery.ts` (hydration-safe matchMedia).
- Fixtures: `components/ui/fixtures.tsx` (20 canonical states) rendered by the dev route `/zz-ui-fixtures` AND snapshot-pinned by verify:ui (goldens in `scripts/fixtures/ui-snapshots.json`, regenerate with `UI_SNAPSHOT_RECORD=1`).
- **Humanization map** `lib/marketing/humanize.ts`: all **66 mutating tools** → verb-first label + category (icon). Exhaustiveness is type-enforced over the name union (`satisfies`), and verify:ui asserts the union ≡ the LIVE registry (a registry addition without a label fails CI). Wired into AutonomySettings and the activity feed's kind label — **no raw tool identifier renders anywhere** (browser-asserted against all 66 names).
- DEV-6: the 14 legacy `/educators` landing components moved to `components/educators/` (pure `git mv` + 4 importer fixes; guarded by relocation.test).

**Wave 2 — layout & IA**
- **Shell (DEV-3/D-17):** the app sidebar auto-collapses to the icon rail below `xl` and hides below `md`, where a Topbar hamburger opens the same nav in a left Drawer. *Amendment:* the collapse boundary is **xl (1280), not lg** — measured at 1024, an expanded sidebar still left a ~344px work column, so 1024–1279 gets the icon rail. The manual expand toggle applies ≥xl only.
- **Nav (W2.2/DEV-7):** the Explore rail is gone; a grouped section strip renders under the header — Audience (Leads, Audience) · Email (Campaigns, Sequences) · Social (Posts, Clips, Accounts, Publish review) · Insights (Analytics); Agent = ask bar + FAB; Overview stays a header action. Group eyebrows/separators are lg-up; **768–1023 is a single-row horizontal scroll strip** (wrapping produced 3 rows/104px — measured). Height: **68px** at 1440/1024 (≤88 AC).
- **Hub overview (W2.3):** 4 stat tiles from already-loaded data only (campaign status + queued/sent + goal · needs-review count with `#attention` anchor · revertable count · pages published/total). Attention zone unchanged (still 0 clicks). Landing-page status now renders via StatusChip (draft→neutral, published→success, unpublished→destructive).
- **Rail (W2.4):** exactly two residents — the activity card and the **autonomy pill** (`Agent autonomy · Auto — 4 actions opted in`, computed from the existing settings prop, zero new queries) which opens the settings in a 480px **Drawer** (W4.1's container landed early; contents still the existing form until Wave 4). Grid: `minmax(0,1fr)` + `var(--spacing-rail)` (336px), one gutter token.
- **FAB discipline (W2.5/D-3/D-18):** `DockClearance` reserves 88px (`--spacing-fab-clearance`) on every marketing scroll surface; the FAB **vacates while any Drawer is open** (overlay refcount); the toast moved above the dock (`bottom-24`, `z-60` — z now ordered nav 20 < FAB 40 < overlay 50 < toast 60); the closed agent dock is now `inert` (keyboard parity with its aria-hidden — also clears the Lighthouse `aria-hidden-focus` audit).
- Interim autonomy fixes (full redesign is W4): humanized labels everywhere, hard-locked rows single-column with a consistent right-aligned "Always requires your approval", timezone input made shrinkable/wrappable, "Recommended" on its own line. D-4/D-5/D-6/D-7 are already visually dead (screenshot `after-w2/w2-04`).

## AC ledger (Waves 1–2)

| AC | Test (named section) | Status |
|---|---|---|
| AC-W1.1 zero raw hex/px in surface components | `tokens-no-raw-values.test` in `scripts/verify-ui.ts` | **PASS** (scope = the UI-1 surface file list per CHECKPOINT-0 scope; deep sub-page editors adopt tokens when their waves touch them — list in the test) |
| AC-W1.2 primitives render all states + snapshots | `primitives-snapshot.test` in `scripts/verify-ui.ts` + `/zz-ui-fixtures` | **PASS** (20 fixtures, goldens + structural a11y asserts) |
| AC-W1.3 1:1 status→token mapping | `status-chip.test` in `scripts/verify-ui.ts` | **PASS** |
| AC-W1.4 exhaustive humanization map | `humanization-map.test` (pure) + `humanize.test` (browser) | **PASS** (66 tools ≡ registry; 0 raw ids rendered) |
| AC-W2.1 layout at 1440/1024/768/390, zero h-overflow | `layout.test` in `scripts/verify-ui-browser.ts` | **PASS** (doc AND inner `<main>`; before-baseline had inner overflow at 1024/768/390) |
| AC-W2.2 all destinations reachable, nav ≤88px | `nav.test` | **PASS** (9×1-click links + FAB agent; 68px @1440/1024) |
| AC-W2.3 no dead zone; approvals 1 click | `overview.test` + screenshots | **PASS** (tiles + attention zone at 0 clicks; see note 3) |
| AC-W2.4 rail = 2 residents, fits viewport | `rail.test` + `w2-01` screenshot | **PASS** |
| AC-W2.5 zero FAB/click-target intersection | `fab.test` | **PASS** (44 targets checked, 0px² — before: 1,813px² on the save bar; FAB hidden while drawer open) |
| AC-W2.6 reachability parity | table below | **PASS** (no regressions) |

## Reachability parity (clicks from hub)

| Destination / action | Before | After |
|---|---|---|
| Leads · Audience · Email campaigns · Sequences · Social posts · Lesson clips · Connected accounts · Publish review · Analytics | 1 (Explore rail) | 1 (section strip) |
| Agent full-screen / chat | 1 | 1 (FAB or ask bar; full-screen via dock header) |
| Overview | 1 (header) | 1 (header) |
| Pending approvals / questions | 0 (inline zone) | 0 (inline zone; + stat-tile anchor) |
| Revert a change | 1 | 1 (feed inline, `Revert · Nh left`) |
| Autonomy settings | 1 (expand card) | 1 (pill → drawer) |
| Generate kit / landing page · campaign lifecycle · course switch | 1 | 1 |

## Metrics (before → after)

- **Lighthouse desktop (authenticated /marketing):** performance 0.78 → **0.83** · accessibility 0.90 → 0.90 (same three pre-existing audits: `color-contrast` on residual muted text, `heading-order` — both Wave-5 scope; `aria-hidden-focus` fixed via `inert` after the after-capture, re-verify at W4) · best-practices 1.00 → 1.00 · CLS 0 → 0 · TBT 20ms → 0ms.
- **JS transferred, /marketing (decoded, authenticated, cold):** 457KB → ~483–542KB across runs (**≈ +30–60KB**: the Drawer/framer path on the hub, the humanization map + icons, new primitives). HTML 92→99KB. Methodology note: `networkidle` captures include Next's link prefetches, so per-run numbers wobble ±10%; before-numbers had the same methodology. Other marketing routes are within noise of their baselines (full tables: `/tmp/ui1-w2-metrics.json`, §T0.5 of the audit doc).
- **INV-5:** no formal CI budget exists on this branch (DEV-4, accepted) — Wave 5 adds the marketing-route budget check; these numbers are the tracked deltas until then.

## Invariant attestation (interim)

- **INV-1:** ApprovalCard/QuestionCard changed visually only (tokens; sky→attention fold per the approved plan); approve/edit/reject flows and the gate untouched; hard-deny surfaces render locked (browser-asserted labels + no toggles).
- **INV-2:** Revert inline in the feed with window label — browser-asserted (`activity.test`).
- **INV-3:** zero persistence changes — `updateAutonomySettingsAction`/`upsertAutonomySettings` byte-untouched; every setting still mapped (drawer screenshot).
- **INV-4:** parity table above — no regressions.
- **INV-5:** deltas reported above; budget tooling lands W5 per DEV-4.
- **INV-6:** one token source (`app/globals.css @theme`); no parallel styling system; primitives extend `components/ui/`.
- **INV-7:** untouched (no review/feedback surface was modified).

## Notes & deviations raised (none silent)

1. **Sidebar boundary = xl, not lg** (measurement-driven; see Shell above).
2. **SectionNav at 768–1023 = scroll strip** (wrap measured 104px > 88).
3. **overview.test runs without a seeded pending approval** — `previewMarketingAction` runs live server-side per pending row and needs deeper campaign fixtures; the attention zone code path is unchanged from before the overhaul (0-click, structurally asserted). The W4 checkpoint browser suite seeds a real pending action end-to-end.
4. **The autonomy drawer currently hosts the existing form** (interim, per plan: container in W2, contents in W4). Interim overflow/label fixes applied; W4 replaces them with SegmentedControl + grouped Toggle rows + FieldGroups + sticky save.
5. Wave-3 defects (D-10..D-16: feed anatomy, templates, localhost links, trust-copy dedupe, `auto · policy` mislabel) remain visible in the after-screenshots **by design** — that is Wave 3.
6. `playwright` remains a devDependency for Waves 3–5 (runtime deps untouched at 22).

**STOP — awaiting approval to proceed to Waves 3–4 (activity feed + autonomy redesign, CHECKPOINT-W4).**
