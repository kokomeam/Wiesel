# UI-1 · CHECKPOINT-W4 — Waves 3–4 (Activity feed + Autonomy redesign) landed

> Date: 2026-08-02 · Branch: `feat/marketing-analytics` · Status: **awaiting checkpoint approval — Wave 5 not started.**
> Verification: `npm run verify:ui` **148/148** (in the `npm test` chain, which passes end-to-end: 30 suites, 0 failures) · `npm run verify:ui:browser` **101/101** vs the production build · `next build` + lint clean.
> Screenshots: `screenshots/ui1/after-w4/` (hub, full 100-row feed with the expanded D-14 entry, drawer in auto/manual-consequence/validation states, 1024/768/390 matrix, 390 sheet). Before-baselines: `screenshots/ui1/` (Task 0) and `after-w2/`.

## Wave 3 — the Activity timeline (closes D-10..D-16, D-19)

- **Data (DEV-1, approved):** additive migration `20260802100000_marketing_action_summary_fields.sql` (applied; types spliced). Every mutating tool can emit a small typed `summaryFields` bag (entity/count/dropped/platform/stage/keyword/shortCode/preset/layout/note/outcome) alongside its prose summary; the gate persists it on all three insert paths (reversible outcome, pending preview, auto-executed outcome). **40 emission sites across 6 tool modules** (clips 6 · landing 8 · leads 8 · email 8 · campaign 5 · social 5) cover the feed's real traffic; tools not yet emitting degrade to their humanized label template.
- **Templates (`lib/marketing/activitySummaries.ts`, pure):** one collapsed-line template per mutating tool — exhaustively typed over the same union as the humanization map (compile-error on a new unlabeled tool; registry drift caught by verify:ui). Every template proven ≤80 chars for null/empty/adversarially-long fields (66 tools × 3 stress shapes). Appendix-A quality bar matched exactly (`Found 3 clip moments · 1 dropped`, `Posting kit ready — Instagram Reels · keyword “THETA”`, `Queued clip render — “…”` …). Render-time translation lives here too: tofu/mofu/bofu → Awareness/Consideration/Conversion, preset ids → human names, per-guardrail creator language replacing the joined debug details (D-12/D-14). No model call anywhere in the path.
- **Feed (`components/marketing/ActivityFeed.tsx`,** replaces ActivityLogEntry**):** entry = category icon · one-line template summary (truncating single line at rail width) · StatusChip · tabular relative timestamp (absolute on hover) · inline one-click revert icon (INV-2) — expandable to clean rationale, translated metadata chips, origin-resolved short links (never a baked URL — the stored `localhost` prose class is contained to historical rows' detail area), entity "Open" links, the humanized policy-routing panel, and Revert/Dismiss. Day dividers (sticky), default 7 entries + "Show all activity" expanding in place (100+ rows render in ~1s, no overflow, no new dependency). "Recent changes" → **Activity**; the standing D-10 sentence is gone — it lives in the header's ⓘ popover and the dismissible (persisted) first-run hint.
- **D-16 fixed:** `route === "auto_execute"|"auto_log"` is now the only "ran on its own" treatment; a card-routed action the creator resolved renders **"Approved by you"** with "This asked you first — {humanized guardrails} You approved it." + a "Change autonomy settings" link that opens the drawer (shared `autonomyDrawerStore`). The `auto · policy` badge no longer exists.
- **Trust copy (W3.8):** exactly three canonical locations — `MANUAL_PUBLISH_NOTICE` (social), the Activity first-run hint, and a new `ACCOUNTS_TRUST_NOTE` on connected accounts (worded within that surface's banned-copy fence; verify:accounts 64/64 still green). The reassurance clauses were **removed from the three stored-summary templates** (clips render/kit, social generate — summaries now state facts); a source-level lint pins the phrase to the three locations (comment mentions exempt).

## Wave 4 — the autonomy drawer (closes D-4..D-9 for good)

- **W4.2:** modes are a SegmentedControl (radiogroup, roving tabindex, arrow keys); exactly one description line for the selected mode; "Compare modes" popover (3-column, one line per row); the Recommended chip renders whole — badge-bearing segments size to content so neither label nor chip can truncate (browser-asserted `scrollWidth ≤ clientWidth`).
- **W4.3:** permissions are grouped **single-column Toggle rows** (groups derived from the humanization map's categories: Landing pages / Email / Audience / Publishing — grouping can never drift from labels); the six hard-locked actions live in a separate **"Always asks you"** group: lock icon · humanized label · right-aligned "Always requires your approval". No toggles, no dashes-in-prose, no collisions at any width.
- **W4.4:** guardrails as FieldGroups with inline validation (max recipients ≥1; revert window 1–720 with error + disabled save); allowed hours = Toggle + two time selects + a **timezone Select** (Intl.supportedValuesOf, constrained to the drawer); first-send review Toggle with its one-line description; revert window help = "How long drafts and edits stay revertible from Activity."
- **W4.5:** StickyActionBar with dirty detection ("You have unsaved changes" → Save enabled; "Everything saved" otherwise), Discard, close-with-dirty ConfirmDialog guard, success toast "Autonomy settings saved", and the pill updating from the refreshed server props. **DEV-2 guarded save implemented:** `saveAutonomySettingsGuarded` rides the existing `updated_at` column (`.eq(course_id).eq(updated_at)`; first save = INSERT, losing the unique race = conflict). On conflict the action re-reads, re-applies the creator's complete form once, and informs ("your view was refreshed…") — proven live in the browser suite with a genuine concurrent writer. The legacy read-merge upsert remains exported for legacy callers/suites; hard-deny stripping and tolerant policy parsing are byte-unchanged (INV-1/INV-3).
- **W4.6:** the mode-consequence line is computed from actual settings (`modeConsequence`, unit-tested over permutations) — e.g. "4 opted-in actions will run without cards… Social publishing always asks." / the honest inert-policy line when nothing is opted in.

## AC ledger (Waves 3–4)

| AC | Test (named section) | Status |
|---|---|---|
| AC-W3.1 zero standing copy; ⓘ popover | browser `activity.test [AC-W3.1]` | **PASS** (hint dismiss persists; popover carries the revert explanation) |
| AC-W3.2 anatomy; ≤80ch; single-line at rail width | pure `activity-summaries.test` + browser `[AC-W3.2/W3.3]` | **PASS** (66×3 stress ≤80; measured line height 20px) |
| AC-W3.3 deterministic templates, exhaustive | pure `activity-summaries.test` (+ registry drift guard) | **PASS** (10 exact-output fixtures incl. Appendix A) |
| AC-W3.4 detail structured + translated; no localhost | browser `[AC-W3.4]` + pure translation checks | **PASS** (origin-resolved links; legacy prose detail-only) |
| AC-W3.5 revert visible/near-expiry/expired | browser `[AC-W3.5]` | **PASS** (23h/29m labels; expired = no control at all) |
| AC-W3.6 grouping + 100-fixture load | browser `[AC-W3.6]` | **PASS** (103 rows, show-all in-place, <8s, no jank/overflow) |
| AC-W3.7 fallback humanized (+D-16) | pure chip tests + browser `[AC-W3.7 + D-16]` | **PASS** ("Approved by you"; guardrails in creator language; settings link opens drawer) |
| AC-W3.8 trust copy in exactly 3 places | pure `trust-copy-locations.test` | **PASS** (offender scan + presence in all three) |
| AC-W4.1 drawer focus trap/Escape/restore | browser (W2 suite carried; drawer.test) | **PASS** |
| AC-W4.2 no truncation; per-mode snapshot states | browser `[AC-W4.1/W4.2]` + drawer screenshots ×3 | **PASS** (untruncated-chip assertion) |
| AC-W4.3 zero overlap 390–1440 | browser locked-group + layout matrix | **PASS** (single-column rows; overflow checks at 4 widths incl. the 390 sheet) |
| AC-W4.4 no overflow at drawer width; validation states | browser `[AC-W4.4]` | **PASS** |
| AC-W4.5 dirty→save, discard guard, conflict | browser `[AC-W4.5]` ×3 sections | **PASS** (conflict staged with a REAL concurrent write, not a mock) |
| AC-W4.6 consequence from settings state | pure `autonomy-copy.test` + browser `[AC-W4.6]` | **PASS** |

Fixture gallery for every event type: `activity-summaries.test` enumerates all 66 mutating tools × 3 field shapes with the exact-output table for the flagship ten; run `npm run verify:ui` to print it.

## Invariants & deviations (none silent)

- **INV-1/INV-7 intact:** approval cards untouched this wave; hard-deny list renders locked in every mode; no human-input surface routes through approvals.
- **INV-2 strengthened:** revert is one click from the COLLAPSED row (inline icon w/ window label) and present in detail; expired rows show nothing.
- **INV-3:** every setting survives with identical semantics; the save path changed exactly as DEV-2 approved (guarded, informed re-apply); server-side stripping/parsing unchanged.
- **Deviation — W4.4 placeholder copy:** the directive's suggested placeholder ("Unset — sends of any size can auto-run") is the OPPOSITE of the engine (every unset field fails closed). Shipped truthful copy: "Unset — sends still ask first" + help "Unset fails closed." Flagging per protocol: governance language must not contradict the policy engine.
- **Deviation — W3.7 scope:** the directive's fallback example ("Broadcast held for your approval" linking to the approval card) describes a PENDING row, but pending rows render as approval cards in the attention zone, never as feed entries. The feed's fallback treatment applies to the resolved row ("Approved by you" + guardrail explanations + settings link); the pending case remains the approval card itself.
- Historical prose rows (pre-`summary_fields`) render generic template + prose in detail — including old baked `localhost` links (D-19 contained, documented; the copy-lint fixture set covers new-format rows, historical detail is exempt).
- Transient note: a mid-hydration duplicate of the rail was once observed by an ad-hoc screenshot script (two pill nodes during streaming); not reproducible on any settled load and the suite's count checks pass on every run — recorded here for honesty, will re-check under W5's axe/keyboard passes.
- `playwright` remains a devDependency for Wave 5.

**STOP — awaiting approval to proceed to Wave 5 (copy-lint, axe + keyboard pass, empty/loading states, responsive matrix, performance parity + budget tooling per DEV-4, docs), then CHECKPOINT-FINAL.**
