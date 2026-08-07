# TUTOR-1 — Amendment A2, Wave 4 Checkpoint: Tests & documentation — AMENDMENT CLOSE

**Date:** 2026-08-07 · **Status:** Wave 4 COMPLETE → **HARD STOP + A2 CLOSE.**
This is the amendment's final wave. Every §8 deliverable exists with no TODOs,
stubs, or deferred items; the consolidated A2-1..A2-18 ledger below is the
amendment's completion record.

## 1. Wave 4 deliverables (§8) — all delivered

| Deliverable | Where | Status |
| --- | --- | --- |
| Unit tests: tier table, fail-closed catch-all, phase floor | `verify-tutor-runtime` (85) A2 sections · `verify-tutor-client` (178) phaseFloor/fake-clock | ✅ (landed Waves 2–3) |
| Integration tests: POST, GET resume, abort, conflict | `verify-tutor-stream-int` (36, live Supabase) — POST/abort/A2-11×3/resume-follow; conflict RESTATED for the append-only transcript (a 409 cannot exist on an immutable table — the DB trigger IS the proof; grep + row-count assertions instead) | ✅ |
| Playwright e2e: send → phases → incremental text → completion | `verify:tutor:browser:stream` §§A2-13/§6 | ✅ |
| Playwright: refresh mid-answer → resume → completion | Same suite §A2-16 | ✅ |
| **NEW this wave — A2-8 HTTP auth matrix** (deferred from Wave 2) | Same suite: anonymous GET → **401** · signed-in-not-enrolled (cookie session) → **403** · enrolled-idle → **204**, against the real running route. Suite now **20/0**, zero flakes | ✅ |
| `docs/tutor/streaming.md` | The Inngest boundary + why the turn is not durable · the resume lifecycle · the tier table + how to add a tool (compile-error + CI-failure if unclassified) · the status phase contract + the `[FWD]` tool variant · Redis TTL + cost profile · the test map | ✅ |
| Env var documentation for Upstash | `.env.example` (Wave 1) + `docs/tutor/runbook.md` streaming/env section (this wave) | ✅ |
| Script wiring | `verify:tutor:browser:stream` added to package.json (server-required, like the existing browser suite — not in the `npm test` chain) | ✅ |

## 2. §8 before/after metrics — FINAL (same instrument, same prompt, real model, 5 runs/leg)

| Metric (median) | Before (buffered) | After (streamed) |
| --- | --- | --- |
| Time to first visible output | **14,915 ms** | **10,767 ms (−28%)** |
| Time to full answer | 14,915 ms | 13,337 ms (noise-level) |
| Rows written to the event stream per turn | identical writer set | identical writer set — **zero new persisted writers** (wave-diff grep) + the analytics union assertion-locked at its pre-A2 22 members; sampled per-run deltas were timing artifacts (analyzed, Wave 2 checkpoint §2) |
| Postgres bytes per turn | identical row set | identical row set (same transcript rows; same cost/evidence emitters) |

The §8 failure condition (streaming increasing persisted rows/bytes) does not
obtain — enforced by construction and by test, not by a one-off sample. The
remaining pre-token latency is reasoning time (medium effort), truthfully
covered by "Working through it"; reasoning-summary streaming is the
documented `[FWD]` lever.

## 3. Consolidated A2 acceptance ledger (the amendment's completion record)

| AC | Proven by | Wave |
| --- | --- | --- |
| A2-1 migration applies + rolls back | applied live; transactional rollback proof | 1 |
| A2-2 nullable, default null | information_schema | 1 |
| A2-3 chain id before first token (abort-proof) | stream-int: gated fake model, mid-flight DB read, abort → intact chain | 1 |
| A2-4 variants parse / reject | stream-infra (81) | 1 |
| A2-5 no delta/chunk in the persisted contract | the 22-member union lock (bidirectional) | 1 |
| A2-6 first token before close | int margin proof + live medians | 2 |
| A2-7 kill → GET replay, no gap/dup | verbatim-frame tee/replay + the LIVE Upstash smoke | 2 |
| A2-8 GET 204/401/403 | **HTTP-level, real route** (this wave) + seam-level (2) | 2+4 |
| A2-9 irreversible tool halts, never executes | synthetic tool: one model call, gate precedes dispatch | 2 |
| A2-10 unclassified tool fails CI | exhaustive-Record type + A2-10 test in `npm test` | 2 |
| A2-11 in-flight state null ×3 paths | stream-int (incl. the capture/clear race the tests caught) | 2 |
| A2-12 single write path | append-only restatement: grep + row counts + the DB trigger | 2 |
| A2-13 incremental text ≥3 samples | browser, live: 11 strictly-increasing samples | 3 |
| A2-14 400ms floor | phaseFloor fake-clock | 3 |
| A2-15 real events only, no component timers | source assertion + event mapping | 3 |
| A2-16 refresh → resume → completes | browser, live (fallback path; re-attach leg unit+Upstash-proven) | 3 |
| A2-17 aria-live + a11y | live DOM assertion + axe zero serious/critical | 3 |
| A2-18 reduced motion | reduced-motion context, zero animate-* | 3 |

**Non-negotiables (§2) — held throughout:** no Inngest on the turn (route
handler, always was); no deltas persisted (union lock); one write path
(append-only pair + trigger); approval gating strengthened (fail-closed tier
table where none existed); truthful generic status copy (§7-linted in test);
existing patterns extended (native ModelClient seam, the same SSE channel,
the same auth gate — **zero new runtime dependencies across the amendment**).

## 4. Files (this wave)

**Created:** `docs/tutor/streaming.md` · this checkpoint.
**Modified:** `scripts/verify-tutor-stream-browser.ts` (A2-8 section, 17→20)
· `docs/tutor/runbook.md` (streaming/env section) · `package.json`
(`verify:tutor:browser:stream`).
**Deleted:** none.

## 5. Repo gates (bare exit codes)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0** (1 pre-existing baseline warning) |
| `npm test` | exit **0** |
| `verify:tutor:browser:stream` (live, full) | **20/0**, exit 0, zero retries |
| Prior-wave gates | unchanged since `5eee76a` (int 16 suites 0 · build 0 · budgets 6/6, learn route byte-identical) |

## 6. Deviations (this wave)

None. The two §8 items that could not be delivered as literally written were
restated in earlier approved waves (the 409 test — impossible on an immutable
table; `tutor_sessions` — nonexistent) and are documented in their
checkpoints; nothing new deviated in Wave 4.

---

**A2 IS COMPLETE.** Four waves, each hard-stopped and approved; every
acceptance criterion green at its intended level; both §2 outcome goals
delivered — first visible output dropped from full-generation latency toward
first-token latency (14.9s → 10.8s median, reasoning-bound), and the dead gap
is gone (event-driven phases from dispatch). Commits: `b2bdb23` (Wave 0
audit) → `02aaf07` (Wave 1) → `19890ff` (Wave 2) → `5eee76a` (Wave 3) → this
wave's commit. **HARD STOP — nothing beyond A2's scope begins without a new
directive.**
