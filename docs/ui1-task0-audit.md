# UI-1 · Task 0 — Marketing Hub Overhaul: Audit + Design Plan (CHECKPOINT-0)

> Date: 2026-07-31 · Branch: `feat/marketing-analytics` · Status: **awaiting checkpoint approval — no implementation performed.**
> Baseline evidence: `screenshots/ui1/` (10 PNGs) · metrics JSON in the session scratchpad (`ui1-baseline-report.json`, mirrored in §T0.5 below).
> Task 0 was strictly read-only toward the codebase. The only writes: this document, `screenshots/ui1/*`, a throwaway Supabase creator (`ui1-baseline-*@example.com`) with seeded demo rows, and a temporary `playwright` devDependency (left installed for the implementation waves; runtime deps untouched).

---

## T0.1 — Component & style inventory (findings)

**Component library.** `components/ui/` holds 9 primitives: Button (pill, 4 variants, sm/md only, no Link/asChild support), Badge (+`statusTone`), Card/CardHeader, CollapsibleCard, ConfirmDialog (framer portal — **unused by the entire marketing surface**), PageHeader, Stat (**unused by marketing** — `overview/page.tsx:17-24` re-implements its own `Stat`), RotatingText, background-paths. No shadcn, no Storybook, no fixtures route (the only `zz-` route is the studio's `zz-materialize-preview`).

**Adoption is thin.** Only `MarketingHub` + `CampaignCard` import `Card`; ~38 other marketing components re-type the card shell by hand. Fully hand-rolled (zero `ui/` imports): `QuestionCard`, `agent/AgentPanel`, `agent/AgentDock`, `clips/ClipsView` (834 lines), `social/StageChip`, `ManualPublishNotice`; `ActivityLogEntry` hand-rolls its buttons. `Cta.tsx` is a second, parallel button system (legacy landing set).

**Missing primitives** (each re-invented repeatedly): input/select/textarea (≥5 local `inputCls`/`selectCls` consts), toast (3 independent implementations: MarketingHub, SocialPostsView dark variant, ClipsView), modal/drawer (4 hand-rolled: ConnectedScheduler, PublishStates history drawer, MultiImportDialog, VoiceProfileSheet — while ConfirmDialog sits unused), mono-uppercase eyebrow label (dozens of `font-mono text-[10px] uppercase tracking-[0.12em]`), alert/callout (~15 amber/rose/sky panels), status chip (≥6 local chip+tone-map pairs: PostQueue `StatusPill`, `StageChip`, `FilterChip`, `BUCKET_CLS`, `STATUS_TONE` maps in email/leads/audience pages, `MANIFEST_TONE`, `HEALTH_TONE`), skeleton, table, segmented control.

**Token layer** (`app/globals.css`, 79 lines): `@theme` defines ONLY font-sans/mono, the brand orange ramp (50–950), `--color-canvas`, `--color-line`. **Not defined:** type scale, spacing, radius, elevation, motion, z-index, semantic status colors. `--font-display` is set by next/font (`components/intro/fonts.ts`) and consumed via the arbitrary property `[font-family:var(--font-display)]` 13× — never declared in `@theme`. Body color and selection colors are raw hexes in `@layer base`. `.brand-gradient` starts at `#f59e0b` (amber-500 — not in the brand ramp).

**Bypass inventory (marketing scope):**
- The warm card shadow `shadow-[0_1px_2px_rgba(68,48,28,0.05)]` is duplicated as an arbitrary literal **46×** (CampaignBuilder alone 13×) and also baked into `ui/Card` + `ui/CollapsibleCard`.
- Arbitrary type sizes: `text-[10px]` ~35×, `text-[11px]` ~45×, plus `text-[11.5px]`, `text-[12px]`, `text-[12.5px]`, `text-[13px]`, `text-[1.7rem]` (3×); tracking literals from `[0.06em]` to `[0.24em]`.
- Raw hexes in classes: `bg-[#FAF7F1]/85`+`bg-[#FAF7F1]` (MarketingNav), `bg-[#faf7f1]` (AgentDock:41), `bg-[#fdfbf7]` (PostQueue:171 — a hex that exists in no token).
- Inline styles: funnel bar width (`analytics/page.tsx:40`), usage meter width (`AccountCard:124`), landing-set mask/tilt/dot-grid styles.
- Palette drift: raw `red-*` (LifecycleControls:34, AgentPanel:286-292/320-322) vs the surface's `rose-*`; **violet** for mofu/planned (StageChip:10, PostQueue:37) — a family used nowhere else; raw `orange-*` instead of `brand-*` (PublishApprovalCard:127, AutonomySettings `accent-orange-600`, the whole legacy landing set); `font-serif` (PostQueue:172) instead of `var(--font-display)`. Zero `gray/neutral/slate/zinc` hits — the stone rule holds.

**String definition sites.** Hub chrome strings inline + `ASK_SUGGESTIONS`/`EXPLORE_LINKS` consts; social vocabulary single-sourced in `lib/marketing/social/constants.ts` (incl. `MANUAL_PUBLISH_NOTICE`, `BANNED_UI_PHRASES` grep fence); publish vocabulary allowlisted to 3 path prefixes (`lib/marketing/publish/languageAllowlist.ts`) with `HOLD_REASON_COPY`, `cardCopy.ts`; accounts copy in `lib/marketing/accounts/constants.ts`; clips labels in `lib/marketing/clips/constants.ts`+`textStyles.ts`. **Feed + approval-card + toast body text = server data rendered verbatim** (tool summaries, `ActionResult.message`).

**Stores.** `hubUiStore` (persisted, skipHydration; only the two disclosure booleans), `agentDockStore` (in-memory open/seed), `approvalSync` (in-memory + BroadcastChannel). framer-motion is used **only** by the legacy landing set; the entire hub/product surface animates with CSS transitions.

**Structural note.** `components/marketing/` mixes two surfaces: the hub product suite AND the public `/educators` landing set (MarketingNav, Hero, HeroPreview, TrustStrip, DualPath, HowItWorks, Features, StatsBand, MarketplacePeek, FinalCTA, Cta, CountUp, MarketingFooter, motion.tsx) which is on a different visual dialect (raw orange/amber, different shadow literal) and is out of UI-1 scope. See DEV-6.

## T0.2 — Layout audit (findings)

**Shell:** `app/(app)/layout.tsx` = `flex h-screen overflow-hidden`; sidebar `w-64` (collapsible to `w-16` only via a manual, persisted toggle — **no responsive breakpoint**); content scrolls inside `<main class="flex-1 overflow-y-auto">`. Topbar `h-16 sticky z-20` outside the scroll container.

**Hub:** container `mx-auto max-w-7xl space-y-6 p-6 lg:p-8` (the no-course branch uses `space-y-8` — same route, two rhythms). Main split `grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]` — fluid work column + fixed 320px rail. Work column `space-y-6`, rail `space-y-4` (sibling columns, different rhythm). Explore = 10 rows (`px-3 py-2`, `size-8` icon tiles) + `CardHeader py-3` override.

**Padding census (one screen):** CampaignCard `p-5` · ask-bar Card `p-4` · landing-pages body `p-4` · ApprovalCard `p-4` · CollapsibleCard body `px-4 pb-4 pt-3` · empty states `p-8`/`p-10` · Explore nav `p-2`. Header geometries: CardHeader `px-5 py-4` vs CollapsibleCard `px-4 py-3`. Icon tiles: `size-9 rounded-xl` / `size-8 rounded-lg` / `size-7 rounded-lg`. Inner-panel radius `rounded-xl` vs inputs `rounded-lg` (ask input breaks the rule at `rounded-xl`); toast `rounded-xl` vs cards `rounded-2xl`. Muted sub-lines: `text-xs stone-500` vs `text-xs stone-400` vs `text-[11px] stone-400`, mixed freely.

**Breakpoints:** only `sm` and `lg` are used on the surface. **The load-bearing mismatch:** the rail becomes a 320px column at `lg` (≈286px content inside CollapsibleCard, ≈260px inside the auto-panel), but `AutonomySettings` keys its grids off `sm` — so at ≥640px they are permanently multi-column, including inside the rail: mode cards `sm:grid-cols-3` (≈90px columns), checkbox/caps grids `sm:grid-cols-2` (≈124px columns).

**Defect mechanics established (with `file:line`):**
- **D-4 "recomm":** `AutonomySettings.tsx:154` — the badge is an inline span with no wrap/truncate control inside a `minmax(0,1fr)` column; it overflows its button and is **occluded by the next grid cell's opaque background** (not CSS-truncated). Mode cards have intrinsic heights (no equalization).
- **D-5 collisions:** the 3 hard-deny rows share one `sm:grid-cols-2 gap-1.5` grid with the 7 opt-in checkboxes (`:168-187`); each locked row is a no-wrap flex of icon + label + `— always needs you` span with no `min-w-0`; min-content exceeds the ~124px cell → spills into the adjacent column; labels have no opaque background so text visibly overlaps text.
- **D-7 timezone overflow:** `:205-239` — an un-wrappable flex row (two intrinsic-width `<select>`s + `–` + a **fixed `w-32` input**) inside a `minmax(0,1fr)` cell with no `min-w-0`; overflows the cell, the stone panel, and the card edge (nothing clips). Confirmed at desktop 1440 too (screenshot `ui1-05`).
- **D-3 FAB:** `AgentDock.tsx:86` `fixed bottom-6 right-6 z-40`; grep confirms **zero** bottom-padding reserve anywhere in `app/(app)/marketing/**`; the autonomy save bar right-aligns via `ml-auto` into exactly the FAB corner. Toast is `fixed bottom-6 right-6 z-50` — same anchor, covers the FAB; drawer `inset-y-4 right-4 z-50` covers both (see D-18).
- **D-8 container:** confirmed — the whole settings surface renders `embedded` inside a CollapsibleCard in the 320px rail; the container, not just the contents, is wrong.
- Safe/risky long-string inventory: feed kind label, campaign name, Explore subs are correctly `min-w-0 truncate`; ApprovalCard preview `URL:`/dl rows and landing-page titles lack `break-all`/`truncate`.

## T0.3 — String provenance (findings)

**The feed renders ACTIONS, not events.** "Recent changes" = `listRecentActivity` (`gate.ts:489-502`) over **`marketing_action`**: `status='auto_approved'` (staged reversible) OR `status='executed' AND autonomy_decision IS NOT NULL`. The `analytics_event` stream never reaches this surface.

**Critical:** the row already carries structured fields — `tool_name`, `action_kind`, `params`, `target_ref` (entity kind/id), `autonomy_decision` (full `{route, mode, guardrails[{name,status,detail}], reason}` jsonb), `revert_expires_at`, `requested_by` — but `page.tsx:114-129` drops everything except prose at the VM boundary. **Structured RESULT data (counts, titles, platforms) is NOT stored** — it exists only inside the frozen prose `summary` composed in each tool's `execute()`/preview and persisted at execution time (`gate.ts:126-142, 229-236, 309-316, 335-343`). Re-rendering cannot change historical summaries.

**Traced defect sources:**
- D-11/D-12: `tools/clips.ts:142-147` + `candidateLine` (`:86-89`) emit the multi-line dump: `Found N moment(s) … (transcript: platform)` + per-candidate `[mm:ss–mm:ss · momentType · tofu · layout] "hook" — rationale`. `generate_lesson_clips` (`:280`) emits `preset tofu_hook`, "provider reframe", and caps-in-prose "queued is NOT rendered yet". Social generate (`socialPosts.ts:280-287`) emits `(tofu/tofu/mofu)` + raw lint reasons.
- D-12 localhost: `clips.ts:369-376` passes `process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"` → `postingKit.ts:246` bakes the absolute `/l/{code}` URL into `fullText` → embedded in the stored summary. Historical rows keep `localhost` forever. The clips PAGE already re-resolves at render (`ClipsView.tsx:498-508` via `useSyncExternalStore(window.location.origin)`) — the feed does not.
- D-14: `autonomy.ts:379-386` builds `Auto mode fell back to approval: {guardrail details joined}` from `detail` strings (`:309`, `:318`). The **structured decision is persisted** (`marketing_action.autonomy_decision`); only the prose renders.
- **New defect (D-16):** approving a pending card (`markActionExecuted`, `gate.ts:437-453`) never clears `autonomy_decision` → the row re-enters the feed filter, `page.tsx:115` flags it `autoExecuted`, and a **human-approved** action renders the `auto · policy` badge plus the stale "fell back to approval" prose.
- D-6: `AutonomySettings.tsx:48-62` label maps cover only the 7+3 pre-M-B tools; fallbacks `{TOOL_LABELS[t] ?? t}` render `retry_publish`, `cancel_scheduled_publish` (opt-in list) and `publish_social_post`/`schedule_social_post`/`unpublish_social_post` (locked list) raw. These two maps are the **only** tool-name→label maps in the repo (plus per-tool `effectLabel` strings on approval previews, and domain enum label maps: PLATFORM_LABELS, CLIP_LAYOUT_LABELS, GOAL_LABELS, STATUS_LABELS×2, HEALTH_TONE, platformLabel).
- D-15 census: stored-prose reassurances in clips.ts:280/:388 + socialPosts.ts:287; UI locations: `MANUAL_PUBLISH_NOTICE` (social constants → ManualPublishNotice), ClipsView "post it yourself" step; plus ~8 model-facing prompt/tool-description occurrences (not creator-visible).

**Tool union (for W1.4):** 69 registered tools — 27 read + `ask_creator` (never hit the ledger) + 41 mutating (reversible auto-execute+quiet-log; irreversible 15). Hard-denied (6): `launch_campaign`, `cancel_campaign`, `send_consent_confirmations`, `publish_social_post`, `schedule_social_post`, `unpublish_social_post`. Irreversible-but-optable (9): `publish_landing_page`, `unpublish_landing_page`, `activate_sequence`, `enroll_segment_in_sequence`, `send_broadcast`, `send_test_email`, `send_consent_confirmation`, `retry_publish`, `cancel_scheduled_publish`. Appendix B corrections: `enroll_segment` → **`enroll_segment_in_sequence`**; singular `send_consent_confirmation` and bulk `send_consent_confirmations` are distinct tools; `bulk_consent_confirmations` is not an identifier.

**Revert affordance today:** `ActivityLogEntry.tsx:71-81` (`Revert · 22h left`, window label precomputed server-side in `page.tsx:35-42`; static per load, no countdown); expiry fail-closed in `gate.ts:407-428` (TS pre-check + `.gt(revert_expires_at)` in the UPDATE WHERE).

## T0.4 — Autonomy settings data model (findings)

- **Persisted shape:** `marketing_autonomy_settings` (migration `20260703000000:53-67`): `course_id` unique, `mode` (manual|assisted|auto, default assisted), `policy` jsonb (`{autoApproveTools[], maxRecipients, maxBudgetCents, allowedHours{startHour,endHour,timezone}, firstSendToNewSegmentManual}` — `'{}'` = the inert empty policy), `revert_window_hours` (default 24, check 1–720). **No version column.** No row = defaults (assisted / empty policy / 24h) — `autonomyStore.ts:22-37`.
- **UI mapping:** every INV-3 setting confirmed present and mapped (`AutonomySettings.tsx:80-105`); `maxBudgetCents` has no control and is force-`null` on save (`actions.ts:597`). Auto-policy sub-form renders only in `auto` mode; revert-window input renders in all modes.
- **Hard-lock enforcement is triple-layered** (all server-side): policy engine checks `HARD_DENY_TOOLS` first (`autonomy.ts:262-273`, order documented load-bearing), the gate routes through the same engine + its own `hardDenied` flag (`gate.ts:250, 306`), and the save action strips hard-denied/unknown tools from any submitted allowlist (`actions.ts:592-596`). INV-1 rails intact.
- **⚠ Save path is NOT versioned** (`autonomyStore.ts:39-61`): read-merge → plain `upsert(onConflict: "course_id")`, last-writer-wins; no version column, no conflict error, no 409 path. W4.5's premise ("the existing single versioned-update repository function") is **false** for this table. Flagged, not fixed → DEV-2.
- **Status pill needs no new query:** the hub page already loads full settings in its parallel fetch and passes them to the client (`page.tsx:79-85, 167-177`); "N actions opted in" = `autonomy.policy.autoApproveTools.length` (computed nowhere today).
- Validation is tolerant-coercing only (Zod `.catch()` on policy; plain TS envelope) — malformed input silently narrows autonomy (safe direction, no user feedback).

## T0.5 — Baseline captures (before-metrics)

Environment: production build (`next build` — note: Next 16.2.9/Turbopack no longer prints a per-route size table; per-route JS measured as decoded bytes transferred to an authenticated client, cold context per route, local prod server). Seeded state: 1 course, active `launch_course` campaign, 2 landing pages (1 published/1 draft), autonomy row (auto mode, 5 opted-in tools incl. the 2 unlabeled ones, allowed-hours enabled w/ timezone), 9 `marketing_action` rows whose summaries are byte-faithful to the real template code (incl. the localhost kit link, tofu_hook preset, D-14 decision jsonb, one expired-window row).

**Screenshots** (`screenshots/ui1/`):

| File | Shows |
|---|---|
| `ui1-01-hub-1440.png` | Hub at rest, 1440 — D-1 inverted weight |
| `ui1-02-hub-autonomy-expanded-1440.png` | Full page w/ autonomy expanded |
| `ui1-03-autonomy-card-1440.png` | **D-3+D-4+D-5+D-6 in one frame** (rail card: "recomm", overlapping locked rows, raw ids, FAB over content) |
| `ui1-04-recent-changes-1440.png` | **D-10..D-15** (paragraph dumps, localhost link, caps-in-prose, "auto · policy" on the human-approved broadcast = D-16, debug fallback line, FAB over feed) |
| `ui1-05-fab-overlap-1440.png` | D-3 at desktop + D-7 timezone select clipped at card edge + D-1 empty main column |
| `ui1-06/07/08-hub-{1024,768,390}.png` | Responsive matrix; 390 shows **D-17** (134px content strip beside the never-collapsing sidebar) |
| `ui1-09-autonomy-card-390.png` / `ui1-10-fab-overlap-390.png` | Mobile panel + FAB states |

**Measured overlap/overflow:** FAB ∩ "Save autonomy settings" = **1,813 px²** at 1440 (boxes: FAB 1264,836 151×40; Save 1271,819 120×32). Horizontal overflow **inside `<main>`**: 1024 → scrollWidth 906 vs clientWidth 768; 768 → 586 vs 512; 390 → 379 vs **134** (sidebar `w-64` never collapses responsively → D-17). Document-level scrollWidth clean at all widths (the overflow is trapped in the scroll container — invisible scrollbar, clipped content).

**Per-route JS (decoded KB, authenticated, cold):**

| Route | JS KB | files | HTML KB |
|---|---|---|---|
| /marketing | 457 | 21 | 92 |
| /marketing/social | 406 | 20 | 48 |
| /marketing/publish | 469 | 19 | 38 |
| /marketing/clips | 491 | 20 | 40 |
| /marketing/accounts | 355 | 19 | 43 |
| /marketing/leads | 355 | 19 | 52 |
| /marketing/email | 420 | 19 | 42 |
| /marketing/analytics | 442 | 18 | 47 |
| /marketing/audience | 395 | 19 | 47 |
| /marketing/sequences | 395 | 19 | 37 |
| /marketing/agent | 426 | 18 | 33 |

**Lighthouse (authenticated /marketing, headless Chrome for Testing):** desktop — performance **0.78**, accessibility **0.90**, best-practices **1.00**; FCP 1.0s, LCP 2.4s, CLS **0**, TBT 20ms, SI 3.5s. Mobile — performance 0.76, accessibility 0.90, CLS 0, LCP 4.4s. Failing a11y audits (before-baseline): `aria-hidden-focus`, `color-contrast` (the muted `text-[10px] stone-400` annotations), `heading-order`. Zero console errors during capture.

**⚠ INV-5 reality (DEV-4):** this branch has **no** CI bundle-budget or Lighthouse enforcement (the PERF-1 tooling lives on another branch; the only "bundle" script here is the env-leak grep `verify:accounts:bundle`). The numbers above are the before-metrics; Wave 5 proposes a marketing-scoped budget check so "remains green" becomes enforceable.

---

## Defect ledger — D-1..D-15 confirmed + root causes, new defects D-16..D-21

| # | Verdict | Root cause (file:line) |
|---|---|---|
| D-1 | Confirmed (amended: Explore has **10** items; the 11th destination is the header "Overview" link) | Rail carries nav+activity+autonomy (`MarketingHub.tsx:400-453`); work column has 2 cards; no stats/attention density at rest |
| D-2 | Confirmed | No token layer; padding census shows 5+ card paddings, 3 header geometries, 3 icon-tile sizes, 2 sibling rhythms (T0.2 tables) |
| D-3 | Confirmed, measured 1,813px² | `AgentDock.tsx:86` z-40 fixed; zero clearance reserve anywhere; save bar `ml-auto` lands in the FAB corner; toast shares the exact anchor at z-50 |
| D-4 | Confirmed (mechanism: occlusion, not truncation) | `sm:grid-cols-3` inside a 320px rail; badge span `:154` overflows under the next cell's opaque bg; intrinsic card heights |
| D-5 | Confirmed | Locked rows share the `sm:grid-cols-2` grid with checkboxes; no-wrap flex + no `min-w-0` in ~124px `minmax(0,1fr)` columns (`:168-187`) |
| D-6 | Confirmed | Label maps predate M-C/M-AG (`AutonomySettings.tsx:48-62`); `?? t` fallbacks render 5 raw identifiers |
| D-7 | Confirmed at rail AND desktop | Fixed `w-32` timezone input in an un-wrappable flex inside `minmax(0,1fr)`; nothing clips (`:205-239`) |
| D-8 | Confirmed | Whole surface renders `embedded` in a rail CollapsibleCard; `sm:` grids can never fit its 286px |
| D-9 | Confirmed | Humanized labels + raw ids + `— always needs you` machine annotations mixed in one list; eyebrow convention applied inconsistently |
| D-10 | Confirmed | Standing subtitle hardcoded at `MarketingHub.tsx:429` |
| D-11 | Confirmed | Multi-line prose composed in `tools/clips.ts:86-89,142-147` etc., frozen into `marketing_action.summary` at execution |
| D-12 | Confirmed | Internal identifiers (`transcript: platform`, tofu/mofu, `tofu_hook`, provider internals) + localhost URL baked into stored prose (`clips.ts:280,369-388`, `postingKit.ts:246`) |
| D-13 | Confirmed | `ActivityLogEntry` renders one prose block; status shouted in caps inside summaries ("queued is NOT rendered yet"); no chip |
| D-14 | Confirmed | Guardrail `detail` strings joined into `reason` (`autonomy.ts:379-386`) rendered raw; structured decision IS persisted |
| D-15 | Confirmed | 3 stored-prose sites + `MANUAL_PUBLISH_NOTICE` + ClipsView step copy (census in T0.3) |
| **D-16 (new)** | Human-approved actions mislabeled | Approve never clears `autonomy_decision` (`gate.ts:437-453`) → feed filter match → `auto · policy` badge + stale "fell back" prose on creator-approved rows |
| **D-17 (new)** | Mobile shell breakdown | Sidebar `w-64` has no responsive collapse (`Sidebar.tsx:68-69`); at 390px the hub gets a 134px strip; horizontal scroll trapped inside `<main>` at ≤1024 |
| **D-18 (new)** | Toast/FAB/drawer stack collision | Toast `fixed bottom-6 right-6 z-50` covers the FAB (z-40); AgentDock drawer (z-50, later in DOM) covers the toast |
| **D-19 (new)** | Historical prose is permanent | Summaries frozen at execution: localhost links, preset codes, trust copy live in stored rows forever — render-layer fix must handle legacy rows generically |
| **D-20 (new)** | Palette drift | red vs rose, violet mofu chips, raw orange ring, amber-500 in `.brand-gradient`, `accent-orange-600` (T0.1 §4) |
| **D-21 (new)** | Primitive duplication | Local `Stat` clone (overview page), ConfirmDialog unused while 4 modals/drawers are hand-rolled, 3 toast implementations, ≥6 chip systems |

---

## T0.6 — Design plan

### Signature element (accepting the directive's recommended candidate)

**The Activity timeline as the agent's visible work log.** This product's one-line pitch on this page is *"an agent worked for you, under your rules, and you can see — and undo — everything it did."* No generic dashboard convention expresses that; a timeline with per-entry status chips, revert-with-countdown, and policy-routing footnotes does. It also makes governance legible in the exact place governance happens (INV-2's one-click revert lives inside it), turning the compliance rail into the product's proof-of-work. The redesign therefore promotes Activity from a collapsed rail card to the rail's first-class resident, with day grouping, chips, and inline revert — and everything else on the page quiets down around the two loud things: "Needs your attention" and the timeline.

### Token proposal (Wave 1 — extends `@theme` in `app/globals.css`; single source of truth)

- **Color/status (fixed meaning everywhere):** `--color-status-success` emerald-600 (+`-bg` emerald-50) = published/completed/live · `--color-status-pending` amber-600/amber-50 = queued/processing/held · `--color-status-attention` rose-600/rose-50 = needs review/approval (QuestionCard folds from sky into attention — one "needs you" color; differentiation by icon) · `--color-status-neutral` stone-500/stone-100 = draft/dismissed · `--color-status-destructive` red-600/red-50 = cancel/unpublish/failure actions. Violet is retired; red-vs-rose split becomes semantic (attention surfaces vs destructive actions/failures). `--font-display` moves into `@theme`. `.brand-gradient` endpoints become tokens.
- **Type scale:** `--text-meta 12px` (eyebrows/mono/timestamps — tabular numerals via `font-variant-numeric: tabular-nums` utility) · `--text-secondary 13px` (feed summaries, help text) · `--text-body 14px` (controls, body) · `--text-title 16px` (card titles) · `--text-section 20px` · `--text-display 24px` (page title only; replaces `text-[1.7rem]`). Two weights per size max. Kills every `text-[10px]`/`[11px]`/`[11.5px]`/`[12.5px]`.
- **Spacing (4px grid):** `--space-{1..10}` = 4…40; exactly one token each for card padding (`--card-pad: 20px`), list-row min-height (`--row-h: 40px`), section gap (`--section-gap: 24px`), page gutter (`--gutter: 24px`).
- **Radius:** `--radius-card 16px` · `--radius-panel 12px` · `--radius-control 8px` · pills stay `rounded-full`.
- **Elevation:** `--shadow-card` = the warm literal (46 dups → 1 token) · `--shadow-overlay` for drawer/popover/toast.
- **Motion:** `--duration-fast 150ms` / `--duration-base 200ms` / `--ease-out cubic-bezier(0.22,1,0.36,1)` (mirrors `lib/ease.ts`); global reduced-motion kill switch already exists.
- **Z-index scale:** `--z-nav 20` / `--z-fab 40` / `--z-toast 60` / `--z-overlay 50` — resolves D-18 (toast above FAB, drawer exclusion handled by W2.5 behavior, not z-wars).

### Primitives (Wave 1, all extending `components/ui/`)

Normalize/extend: Card/CardHeader (padding from tokens), **StatusChip** (5 semantic tones, replaces the ≥6 local chip systems), **IconTile** (one size/radius pair), **ListRow**, **Drawer** (portal, focus trap, Escape, restored focus — built on ConfirmDialog's existing portal/AnimatePresence pattern), **SegmentedControl**, **Toggle** (replaces checkboxes where semantics are on/off), **FieldGroup** (label+control+help+error), **StickyActionBar**, **Eyebrow** (the mono-uppercase label), **Toast** (one implementation replacing 3), plus Input/Select primitives. Fixture route: a dev-only `/zz-ui-fixtures` page rendering every primitive in all states (the repo has no Storybook; this is the "lightweight fixtures route" the directive allows), driven by the verify suite.

### Humanization map (W1.4)

`lib/marketing/humanize.ts`: `TOOL_HUMANIZATION: Record<MutatingMarketingToolName, { label: string; icon: LucideIcon; category: "landing"|"email"|"audience"|"social"|"clips"|"publishing"|"campaign" }>` — the key type derived from the actual registry so a new tool without a label **fails compilation** (`satisfies` over the union; read tools + `ask_creator` excluded — they never reach the ledger). Seed (Appendix B corrected): `enroll_segment_in_sequence` → "Enroll a segment", `send_consent_confirmation` → "Send one consent confirmation", `send_consent_confirmations` → "Bulk consent confirmations", `retry_publish` → "Retry a failed publish", `cancel_scheduled_publish` → "Cancel a scheduled post", `publish_social_post` → "Publish a social post", `schedule_social_post` → "Schedule a social post", `unpublish_social_post` → "Take down a social post", plus the ~33 remaining mutating tools authored in-wave. `AutonomySettings`' two local maps are deleted in favor of this module.

### Layout & IA (Wave 2)

**Grid:** keep `max-w-7xl` (1280); 12-col mental model realized as `lg:grid-cols-[minmax(0,1fr)_336px]` with the single `--gutter`; rail fixed 336px. <1024 rail stacks below main; <768 single column. **D-17 fix (shell):** sidebar auto-collapses to the icon rail below `lg` and becomes an overlay below `md` (see DEV-3).

**Navigation (W2.2 — option (a), amended for 1-click parity):** the Explore rail card is replaced by a **grouped inline section strip** directly under the page header — all destinations visible (no dropdowns: a popover would make every destination 2 clicks and violate INV-4/AC-W2.6). Groups: **Audience** (Leads, Audience) · **Email** (Email campaigns, Sequences) · **Social** (Social posts, Lesson clips, Connected accounts, Publish review) · **Insights** (Analytics). Agent chat is promoted to the FAB + ask bar (still 1 click). Overview stays a header action. Anatomy: icon+label chips grouped by hairline separators + group eyebrows, wrapping to ≤2 rows ≤88px at desktop; horizontally scrollable chip row below 768. Every destination stays exactly 1 click from hub.

**Hub at rest (desktop ≥1024):**

```
┌ Marketing Assistant                [course ▾] [Overview] [Generate kit] ┐
│ Sell "Data Structures Interview Prep." …                                │
│ AUDIENCE          EMAIL              SOCIAL                    INSIGHTS │
│ [Leads][Audience]│[Campaigns][Seqs]│[Posts][Clips][Accounts][Review]│[Analytics]
├──────────────────────────────────────────────┬──────────────────────────┤
│ [✦ Ask your marketing agent……………  Ask]       │ ACTIVITY            ⓘ 6  │
│                                              │ Today ─────────────────  │
│ ▲ Needs your attention (2)                   │ ▶ Queued clip render —   │
│ ┌ ApprovalCard ──────────────┐               │   "Big O only gives…"    │
│ └────────────────────────────┘               │   [Pending] · 10m        │
│ ┌Campaign┐┌Needs   ┐┌Awaiting┐┌Pages   ┐     │ ✂ Found 3 clip moments · │
│ │Active  ││review 2││you    3││live 1/2│     │   1 dropped [Done] · 5m  │
│ └────────┘└────────┘└────────┘└────────┘     │   ↩ Revert · 23h left    │
│ ┌ Campaign — status · delivery · controls ┐  │ ◇ Broadcast held for     │
│ └──────────────────────────────────────────┘ │   your approval          │
│ ┌ Landing pages ───────────────────────────┐ │   [Needs review] · 2h    │
│ └──────────────────────────────────────────┘ │ Yesterday ─────────────  │
│                                              │ … Show all activity      │
│                                              │ ┌ Autonomy · Auto ─────┐ │
│                                              │ │ 5 actions opted in ▸ │ │
│                                              │ └──────────────────────┘ │
└──────────────────────────────────────────────┴──────────────────────────┘
                                   (reserved dock: [✦ Ask the agent] FAB —
                                    every scroll surface gets bottom clearance)
```

**Mobile (390):** single column — header → nav chip strip (h-scroll) → ask bar → attention → 2×2 stat tiles → campaign → pages → activity (N=5) → autonomy pill. FAB keeps its dock; safe-area inset; all scrollables padded.

**Stats strip (W2.3):** 4 tiles from data the page already loads — Campaign (status + queued/sent), Needs review (pending+questions count), Revertable changes (activity), Landing pages (published/total). "Posts awaiting manual copy" and "Subscribers" require calls to *existing* repository helpers (no new endpoints); included only if Henry reads "existing endpoints provide" as permitting an added page-level call to an existing helper — otherwise dropped per the directive.

**Rail (W2.4):** exactly two residents — Activity (first-class) + the Autonomy status pill (`Autonomy · Auto — 5 actions opted in`, computed from the already-delivered settings prop). Nav leaves the rail entirely.

**FAB discipline (W2.5):** fixed dock bottom-right w/ safe-area inset; every scrollable surface gets matching bottom padding (token); the FAB hides while any Drawer is open (drawer footprint = exclusion zone); toast moves above the FAB in the z scale and offsets its anchor. Playwright asserts zero click-target intersection (the current baseline: 1,813px²).

### Activity feed (Wave 3)

**Entry anatomy:** `[category icon] one-line summary ≤80ch (single line, truncate) · StatusChip · relative time (tabular; absolute on hover)` → click expands: rationale prose → labeled metadata chips (time range, format, platform/destination) → entity link(s) → Revert (`Revert · 22h left`) or nothing when expired. Day dividers; default 7 entries + "Show all activity" **expanding in place** (batched +20; no new route, no virtualization dependency — capped incremental render).

**Summary architecture (DEV-1 — re-anchored):** the feed renders `marketing_action` rows, not analytics events; and structured *result* data currently exists only inside frozen prose. Therefore: (1) additive migration `marketing_action.summary_fields jsonb` — each mutating tool emits a small typed result payload (counts, titles, platform, keyword, short code…) alongside its prose summary; the Zod schema per tool colocated with the registry; (2) `summarizeAction(row)` — a pure, exhaustively-typed template function over `(tool_name, status, summary_fields, autonomy_decision, revert state)` producing `{summary ≤80ch, chip, icon}`; one template per mutating tool (≈41), enforced by the same union type as W1.4 so a new tool without a template fails compilation; (3) **historical rows** (`summary_fields IS NULL`) render under a generic template — humanized tool label + StatusChip — with the legacy prose relegated to the expanded detail area (this is also the D-19/localhost containment: legacy prose never renders collapsed, and short links in NEW `summary_fields` store the code, resolved against the current origin at render exactly as ClipsView already does). No LLM anywhere in this path.

**Fallback events (W3.7):** rendered from the structured `autonomy_decision.guardrails`, not the joined prose — `Broadcast held for your approval` + detail "Auto mode doesn't cover broadcasts yet — you haven't opted this action in." + links to the approval card and autonomy settings; per-guardrail template map (tool_allowlist / recipient_cap / allowed_hours / first_send / budget / hard_deny). **D-16 fix folded in:** a `pending_approval`-routed row that was later human-approved renders "Approved by you", never `auto · policy`.

**Trust copy (W3.8):** stated in exactly 3 places (social section header, connected-accounts page, first-run hint); stripped from all NEW summary templates; historical stored prose exempt (detail-area only) and documented as such in the lint.

### Autonomy drawer (Wave 4)

Rail pill → right **Drawer** (480px; full-screen sheet <768):

```
┌ Agent autonomy ──────────────────────────── ✕ ┐
│ MODE   [ Manual ] [ Assisted ✓Recommended ] [ Auto ] │  ← SegmentedControl
│ One-line description of the SELECTED mode only.      │
│ Compare modes ▸ (popover: 3-col, 1 line per row)     │
│ WHAT CAN RUN ON ITS OWN                              │
│  Landing pages                                       │
│   Publish a landing page                    (tog)    │
│   Unpublish a landing page                  (tog)    │
│  Email                                               │
│   Activate a sequence / Enroll a segment /           │
│   Send a broadcast / Send a test email /             │
│   Send one consent confirmation             (tog×5)  │
│  Publishing                                          │
│   Retry a failed publish / Cancel a scheduled post   │
│ ALWAYS ASKS YOU                                      │
│  🔒 Publish a social post      Always requires you   │
│  🔒 Schedule a social post     Always requires you   │
│  🔒 Take down a social post    Always requires you   │
│  🔒 Launch / Cancel a campaign · Bulk consent conf.  │
│ GUARDRAILS                                           │
│  Max recipients per auto-send  [ 25 ]                │
│  Allowed hours (tog)  [09:00 ▾]–[17:00 ▾]            │
│    Timezone [America/Los_Angeles          ▾]         │
│  First-send review (tog) — one-line description      │
│  Revert window [24] hours — "How long drafts stay    │
│    revertible from Activity"                         │
├──────────────────────────────────────────────────────┤
│ (dirty) You have unsaved changes   [Discard] [Save]  │  ← StickyActionBar; FAB hidden
└──────────────────────────────────────────────────────┘
```

Single-column grouped rows (no two-column grid → D-5 dead by construction); locked group separate with a consistent right-aligned muted annotation (D-9); mode consequence preview line computed from actual settings (W4.6); save flow per W4.5 with the concurrency approach from DEV-2. All INV-3 settings present; `maxBudgetCents` stays UI-less and force-null (unchanged semantics).

### Copy voice + enforcement (Wave 5)

Sentence case; verb-first labels; action name stable through the flow. `verify:ui` (pure, in `npm test`): tokens-no-raw-values grep (scoped per DEV-6), humanization-map + summary-template exhaustiveness (type-level + runtime), summary ≤80ch for every tool fixture, copy-lint over all rendered fixture output (snake_case, `tofu|mofu|bofu`, `localhost`, double spaces, ALL-CAPS >4 letters outside an acronym allowlist), trust-phrase location allowlist. `verify:ui:browser` (Playwright + axe-core): layout assertions at 1440/1024/768/390, FAB intersection = 0, drawer focus trap/Escape/restore, keyboard walkthrough, axe zero serious/critical, revert states, empty/loading states; screenshot matrix as the after-baseline. Before-metrics for W5.5 comparisons are §T0.5.

---

## Wave-item → defect mapping

| Defect | Closed by |
|---|---|
| D-1 | W2.2 (nav strip) + W2.3 (stats + attention on hub) |
| D-2 | W1.1 (tokens) + W2.1 (grid) |
| D-3, D-18 | W2.5 (FAB dock + clearance + z scale) |
| D-4 | W4.2 (segmented control + single description) |
| D-5, D-7, D-8 | W4.1 (drawer container) + W4.3 (single-column grouped rows) + W4.4 (FieldGroups) |
| D-6, D-9 | W1.4 (humanization map) + W4.3 |
| D-10 | W3.1 |
| D-11, D-13 | W3.2 + W3.3 (structured templates + chips) |
| D-12, D-19 | W3.4 (render-time translation/omission; origin-resolved links; legacy-prose containment) |
| D-14, D-16 | W3.7 (structured fallback templates; approved-by-you state) |
| D-15 | W3.8 |
| D-17 | W2.1 amendment (responsive shell — DEV-3) |
| D-20 | W1.1 + W1.3 (status tokens; palette consolidation) |
| D-21 | W1.2 (primitive normalization) |

## Invariant risks & checkpoint decisions (DEV-1..DEV-7)

1. **DEV-1 (W3.3 re-anchor).** The feed renders `marketing_action` rows, not `analytics_event`s, and structured result data is not stored. Proposal: templates keyed off the **tool union** + additive `summary_fields jsonb` emitted at execution (no historical migration; legacy rows → generic template). Deterministic, no LLM — the T0.3 hard requirement holds.
2. **DEV-2 (W4.5 premise false).** Autonomy save is a plain last-writer-wins upsert; no versioned function exists for this table. Options: (a) **recommended** — optimistic guard on the existing `updated_at` column (`.eq("updated_at", loaded)` update; 0 rows → conflict → re-read/re-apply + inform), delivering W4.5's UX with no schema change; (b) keep the plain upsert and drop the 409 path (INV-3 letter, weaker UX). Decision requested.
3. **DEV-3 (D-17 / shell).** AC-W2.1's "zero horizontal overflow at 390" is impossible without the shared shell: sidebar must auto-collapse below `lg` and overlay below `md`. This touches `app/(app)/layout.tsx` + `components/shell/Sidebar.tsx`, which affects every in-app page (in scope per "all shared chrome those surfaces touch", but it changes non-marketing pages too). Decision requested.
4. **DEV-4 (INV-5).** No CI bundle/Lighthouse enforcement exists on this branch. Before-metrics recorded (T0.5); propose a marketing-route budget script in Wave 5 so the invariant becomes enforceable.
5. **DEV-5 (D-1 amendment).** Explore = 10 items; "11 destinations" = 10 + the header Overview link. Grouping adjusted accordingly (9 grouped + Agent→FAB; Overview stays a header action).
6. **DEV-6 (lint scope).** The public `/educators` landing set lives inside `components/marketing/` on a different visual dialect. Proposal: move it to `components/educators/` (pure rename, no behavior) so W1.1's zero-raw-values grep is enforceable over the real surface; alternative: an explicit file-list scope in the lint. Decision requested.
7. **DEV-7 (nav parity).** Dropdown-grouped nav would regress destinations to 2 clicks (INV-4 violation) — the plan uses a fully-visible grouped strip instead; confirm the ≤88px anatomy above is acceptable as "option (a)".

Also noted for Henry (not blocking): `retry_publish`/`cancel_scheduled_publish` currently render raw in the *opt-in* list (D-6) — they get labels in W1.4; the tolerant-coercing settings validation (silent narrowing) gains inline validation UI in W4.4 without changing the parse semantics; INV-1/INV-2/INV-7 verified intact in T0.4 (triple-layer hard-deny; fail-closed revert expiry; no human-input surface routes through approvals).

## Baseline artifacts

- Screenshots: `screenshots/ui1/ui1-01…10.png` (index in T0.5).
- Metrics JSON + throwaway creds + auth state: session scratchpad (`ui1-baseline-report.json`, `ui1-creds.json`, `ui1-state.json`); capture script: `t0-baseline.mts` (re-runnable; server on :3100).
- Lighthouse JSON: `/tmp/ui1-lh-desktop.json`, `/tmp/ui1-lh-mobile.json`.
- Throwaway creator `ui1-baseline-*@example.com` (cleanable via Supabase → Auth; its rows cascade with the course).
