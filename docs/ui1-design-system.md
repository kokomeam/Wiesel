# UI-1 design system — tokens, primitives, humanization, activity templates

> The marketing surface's design layer, built in UI-1 (2026-08). Enforced by
> `npm run verify:ui` (pure, in `npm test`) and `npm run verify:ui:browser`
> (Playwright + axe vs a prod server on :3100; temp `npm i -D playwright
> axe-core` first — both are removed after runs per repo convention).
> Reports: `docs/ui1-task0-audit.md` (audit + design plan),
> `docs/ui1-checkpoint-{w2,w4,final}.md`.

## 1. Tokens — `app/globals.css` `@theme` (the single source of truth)

**Semantic status colors** — one fixed meaning everywhere; components never
define their own status colors (use `StatusChip`):

| Status | Meaning | Trio |
|---|---|---|
| `success` | published / completed / live / sent | `--color-status-success{,-bg,-ring}` |
| `pending` | queued / processing / held | `--color-status-pending…` |
| `attention` | needs review / approval / question | `--color-status-attention…` |
| `neutral` | draft / dismissed / reverted | `--color-status-neutral…` |
| `destructive` | cancelled / unpublished / failed | `--color-status-destructive…` |

**Type scale** (`text-meta` 12 · `text-secondary` 13 · `text-body` 14 ·
`text-title` 16 · `text-section` 20 · `text-display` = the page title only).
Two weights per size max; counts/timestamps add `tabular-nums`. The serif
display family is the `font-display` **@utility** (NOT an @theme token —
next/font owns the `--font-display` variable; a theme entry would emit a
circular :root definition).

**Spacing** (4px grid): `card-pad` 20 (a card's inside) · `gutter` 24 ·
`section-gap` 24 · `row-h` 40 (list rows) · `fab-clearance` 88 (reserved dock
above the agent FAB) · `rail` 336 (the hub's contextual column). Used as
`p-card-pad`, `gap-gutter`, `pb-fab-clearance`, `lg:grid-cols-[minmax(0,1fr)_var(--spacing-rail)]` …

**Radius**: `rounded-card` 16 (cards) · `rounded-panel` 12 (inner panels) ·
`rounded-control` 8 (inputs) · pills stay `rounded-full`.
**Elevation**: `shadow-card` (the warm whisper — was a 46×-duplicated literal)
· `shadow-overlay` (drawer/popover/toast).
**Motion**: `ease-out-brand` + built-in `duration-150/200`; disclosure and
drawer transitions stay in 150–250 ms; the global reduced-motion kill switch
applies. **Tracking**: `tracking-eyebrow`. **Z order**: nav 20 < FAB 40 <
overlay 50 < toast 60.

**Contrast rules (AA, learned the hard way — Tailwind v4 stone-500 is
`#79716b`):** `text-stone-500` passes ONLY on white (4.86:1). On the warm
canvas it is 4.47 and on `stone-100` tints 4.38 — use `text-stone-600` there.
`text-brand-600` on white fails (3.56) — text links use `text-brand-700`.
User-supplied values (keywords, hooks, titles) render inside curly quotes
(`“…”`); the copy-lint exempts quoted spans from the shouted-caps rule.

**The raw-value lint** (`tokens-no-raw-values.test`): no hex colors, no
`shadow-[`/`tracking-[`/`text-[N`, no px inside any bracket value, across the
UI-1 surface file list in `scripts/verify-ui.ts` (deep sub-page editors adopt
tokens as their own workstreams touch them).

## 2. Primitives — `components/ui/`

All states are pinned as fixtures (`components/ui/fixtures.tsx`), rendered by
the dev route `/zz-ui-fixtures` and snapshot-tested (goldens in
`scripts/fixtures/ui-snapshots.json`; regenerate with
`UI_SNAPSHOT_RECORD=1 npm run verify:ui` after a deliberate visual change).

| Primitive | Notes |
|---|---|
| `StatusChip` | The five semantic statuses; `data-status` attr; colors only from the trios |
| `Drawer` | Portal slide-over (right/left; full sheet <sm): focus trap, Escape, restored focus, overlay refcount (FAB vacates). ⚠ Its lifecycle effect deps on `open` only — `onClose` rides a latest-ref, because parents pass inline closures and re-running the effect teleports focus |
| `SegmentedControl` | radiogroup + roving tabindex + arrows. Badge-bearing segments are `flex-none` (content-sized) so neither label nor badge can truncate |
| `Toggle` | `role="switch"`, Space/Enter, `aria-label(ledby)` required |
| `FieldGroup` / `Input` / `Select` | Label + control + help/error (`aria-live="polite"`, `aria-invalid`) |
| `StickyActionBar` | Drawer footer: note left, actions right |
| `SectionHeader` | icon · title (h2/h3) · badge · ⓘ info popover (standing explainer copy lives HERE, not in card bodies) · action slot |
| `Eyebrow` | Mono uppercase tracked label, stone-500 (override to stone-600 on non-white) |
| `IconTile` / `ListRow` | The icon chip (md/sm) and the row shell (link/button/static) |
| `Card`/`CardHeader` | `CardHeader as="h2"` for page-level sections (heading order) |
| `CollapsibleCard` / `ConfirmDialog` / `Button` / `Badge` | Pre-UI-1, tokenized |

Skeletons: `components/marketing/HubSkeleton.tsx` (mirrors the hub's real
dimensions; used by `app/(app)/marketing/loading.tsx`). Empty states are
designed and fixture-pinned (`activity-empty`, `hub-skeleton`).

## 3. The humanization map — `lib/marketing/humanize.ts`

Every MUTATING marketing tool → verb-first label + category (icon).
**Contribution rule: a new mutating tool ⇒ add it to `MUTATING_TOOL_NAMES` +
`TOOL_HUMANIZATION` or the build fails** — exhaustiveness is type-enforced
(`satisfies Record<MutatingToolName, …>`), and `humanization-map.test`
asserts the union ≡ the LIVE registry, so a registry addition without a label
fails CI even if the map file is untouched. Raw tool identifiers must never
render (browser-asserted against all 66 names). Read tools + `ask_creator`
are deliberately absent (they never reach the `marketing_action` ledger).

## 4. Activity summary templates — `lib/marketing/activitySummaries.ts`

The feed renders `marketing_action` ROWS. Tools emit a small typed
`summaryFields` bag alongside their prose summary (`ActionSummaryFields`:
entity/count/dropped/platform/stage/keyword/shortCode/preset/layout/note/
outcome), persisted by the gate to `marketing_action.summary_fields`
(migration `20260802100000`, additive; historical NULL rows render the
generic humanized template with their prose relegated to the expanded
detail).

**Template rules** (enforced by `activity-summaries.test`):
- One template per mutating tool, same exhaustive union as the map.
- ≤80 chars for ANY input (entity/keyword clamp via `q()`); degrade
  gracefully when fields are missing.
- Never emit internal vocabulary: funnel codes translate
  (tofu→Awareness…), presets translate, guardrail names go through
  `GUARDRAIL_EXPLANATIONS`, short links store the CODE and resolve against
  the current origin at render.
- Chips come from `activityChip` (outcome → the five statuses; a
  card-routed action the creator resolved is "Approved by you", never the
  policy badge — D-16).
- Adding a tool: label in humanize.ts → template here → (optional but
  preferred) emit `summaryFields` from the tool's execute → add an
  exact-output fixture if the line is creator-critical.

## 5. Copy rules — `copy-lint.test`

Rendered strings (fixtures + all templates + guardrail/mode/consequence copy
+ nav labels + standing copy) must not contain: snake_case tokens, funnel
codes, `localhost`, double spaces, or shouted ALL-CAPS (>4 letters) outside
the acronym allowlist — user values in `“…”` are exempt. Trust reassurance
("never posts…") lives in EXACTLY three places (social notice · Activity
first-run hint · `ACCOUNTS_TRUST_NOTE`), location-pinned by
`trust-copy-locations.test`. Sentence case; verb-first action labels; an
action keeps its name through the whole flow.

## 6. Budgets & a11y gates

`verify:ui:browser` asserts: `/marketing` load-scoped JS ≤
`MARKETING_JS_BUDGET_KB` (620; raise only with a checkpoint note) · axe
zero serious/critical on hub (1440 + 390), open drawer, and the empty hub ·
keyboard-only walkthrough (drawer via Enter, arrows select modes, Space
flips toggles, Escape restores focus) · no clipped interactive elements at
1440/1024/768/390 · zero horizontal overflow including inside the inner
`<main>` scroll container.
