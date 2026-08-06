# TUTOR-1 — Wave 6 Checkpoint: The Escalation Loop (final wave)

**Date:** 2026-08-06 · **Status:** COMPLETE → **HARD STOP + project close.** This
is the final wave of TUTOR-1; the companion `TUTOR-1-completion-report.md` is the
project's completion artifact (consolidated Waves 1–6 AC ledger, final privacy
proof, economics, open-items).

Preconditions: **P-W6.1** hard-stop release recorded — Henry, in session: *"yes
please improve discoverability, and secondly improve the ui/ux of these tabs as
well … after that please finish wave 6"* and *"lets finish wave 6 now."*
**P-W6.2** Henry drove the Wave-5 console (all four tabs incl. the graph editor)
and reported two UX issues (discoverability + tab blandness) — landed as the
Wave-6 pre-items BEFORE loop work. **P-W6.3** delta check clean (the consent
invariant's baseline — `tutor_escalation_candidates` learner-own RLS + status
trigger — was already correct).

---

## 1. Commits (all wave-authored, on `main`)

| Commit | Package |
| --- | --- |
| `3b279a6` | Pre-items — console discoverability (dashboard Tutor button) + warm-editorial design pass on all 4 tabs |
| `1adf417` | W6.1 — consent + deterministic escalation triggering (flag on) |
| `198937c` | W6.2 — dossier synthesis + clustering (identity-free clusters, zero-policy dossiers) |
| `c0a05ec` | W6.3 — creator escalation queue + exactly-once reply delivery |
| `512edbb` | W6.4 — content-patch promotion closes the loop |
| `ea455a6` | W6.5 — creator digest seam (dry-run default, footgun-guarded) |
| `a067e8a` | W6.6 — full Terra cost tracking, escalation fixture, a11y + docs |

**Migrations** (applied to the live project + verified): `20260806100000_escalation_consent`
· `…110000_escalation_dossier_cluster` · `…120000_escalation_reply` ·
`…140000_escalation_promotion` · `…150000_creator_digest` ·
`…160000_tutor_cost_jobtypes`.

---

## 2. Acceptance criteria — every AC, named test, literal result

| AC | What was proven | Test | Result |
| --- | --- | --- | --- |
| AC-T6.4 | Declining leaves nothing in creator scope; the RLS matrix confirms `consent_pending` AND `withdrawn` candidates are creator-unreachable (direct + join), even after a `consented` row exists | `verify-tutor-escalation-int` | **18/0** |
| AC-W6C.1 | The consent card renders the exact payload; the learner's edited question is what the `consented` row carries; browser-verified | `verify-tutor-escalation-browser` | **14/0** (axe 0) |
| AC-T6.1 | 10 near-duplicate escalations on one node collapse to ONE cluster (count 10); an 11th joins the same cluster id without reshuffling | `verify-tutor-escalation-cluster-int` | **35/0** |
| AC-W6D.1 | Dossier synthesis idempotent per candidate + cost-emitted; Terra prompt carries no learner identity; the dossier is author-unreadable | `verify-tutor-escalation-cluster` + `-int` | **27/0 · 35/0** |
| AC-T6.2 | A cluster reply delivers exactly one instructor turn to every member (incl. a learner owning 2 dossiers → 1 turn), and a retry delivers ZERO more (idempotent per (cluster,user)) | `verify-tutor-escalation-queue-int` | **23/0** |
| AC-W6Q.1 | The queue card shows a count with no learner identity by any path (RLS matrix + UI); author reads zero dossier/ledger rows | `verify-tutor-escalation-queue` + `-int` + `-browser` | **33/0 · 23/0 · 14/0 (axe 0)** |
| AC-T6.3 | Promotion stages a change-set in the STANDARD rail (pending block/create + evidence); accept attaches the FAQ + the cluster shows resolved (derived) + the node lists the clarification; reject restores byte-identical | `verify-tutor-escalation-promotion-int` | **31/0** |
| AC-W6P.1 | Full loop on the fixture: consent → dossier → cluster → reply → promote → accept, asserted at each hop | `verify-tutor-escalation-promotion-int` | **31/0** |
| AC-W6E.1 | The same (course, day) digest never sends twice (unique idempotency key); opt-out at send suppresses; provider_mode recorded on every row; DRY_RUN → status='dry_run', no send | `verify-creator-digest` + `-int` | **32/0 · 23/0** |
| AC-W6E.2 | `verify:comms` negatives green — exactly one send site in `lib/comms`; the tutor runtime reaches no `provider.send` | `verify-comms` | **73/0** |

**a11y:** axe zero serious/critical on the consent card AND the queue panel;
keyboard-operable end to end (both browser suites). One real contrast defect was
found + fixed (ClusterCard eyebrow labels stone-400 → stone-500).

---

## 3. Repo gates (bare exit codes)

| Gate | Result |
| --- | --- |
| `npm test` (full pure chain) | exit **0** |
| `npm run verify:tutor:int` (full tutor int chain, 13 suites) | exit **0** (all 0 failed) |
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0** — the 1 pre-existing warning baseline (zero added) |
| `npm run build` | exit **0** |
| `npm run verify:budgets` | 6/6 · exit **0** (`/studio/[courseId]/tutor` 234.8 KB / 250; `/learn/[slug]/[lessonId]` 216.3 KB — untouched) |
| `verify-tutor-telemetry` (6 job types + cost drift guard) | 39/0 · exit **0** |
| `seed:tutor-escalation-demo` (end-to-end) | exit **0** — prints the queue URL |

---

## 4. The two invariants — held (final proof)

**Consent invariant.** `tutor_escalation_candidates` unchanged: learner-own RLS,
no author policy, status-only trigger (relaxed only to permit the question edit on
the `consent_pending → consented` transition). The identity-bearing
`escalation_dossier` has RLS on + **zero policies** (definer/service-role only);
the creator-visible `escalation_cluster` has **no `user_id` column**. A creator
sees a count + a representative question, never a roster. Proven across
`escalation-int`, `cluster-int`, `queue-int` RLS matrices.

**No-auto-send invariant.** `lib/comms` has exactly one `provider.send` (learner
mail); `lib/notify/creatorDigest.ts` is a separate seam that never imports it; the
tutor runtime reaches no send path. Proven by `verify:comms` negatives (AC-W6E.2)
+ the digest suites. `DIGEST_DRY_RUN` defaults ON; provider_mode persisted per row.

---

## 5. The demo path

`npm run seed:tutor-escalation-demo` (exit 0) publishes the fixture course with a
scripted scenario (1 learner-requested + 10 near-duplicate consented escalations
on one node → **one cluster of 11**) and prints the author login + the
`/studio/{courseId}/tutor?tab=escalations` URL. Drive it: reply to the cluster (11
instructor turns, exactly-once), promote it (an FAQ draft in the Accept/Reject
rail), and inspect the dry-run digest that summarizes it — all with no learner
identity anywhere in the creator's view.

---

## 6. Deviations & disclosures (target: empty)

1. **Fixture cluster topic** — the demo cluster forms on the fixture node titled
   "Scarcity" while the near-duplicate question family is Theta-bound phrasing;
   the queue mechanics (one cluster of 11, stable representative question) are
   correct, only the node title vs. question topic differ. A topic-matched
   question family is a one-line swap — disclosed for Henry.
2. **`practice_gen` cost still not row-emitted** — it stays skipped (a luna
   precedent, not Terra); all Terra spend is now tracked (the two deferred
   deviations from Waves 5–6 are CLOSED by the `job_type` CHECK widen). A
   mock-based int suite shows the new Terra cost row as a global idempotency
   no-op (the mock's deterministic response ids collide on the unique
   `client_event_id`); a live-id probe confirmed the row emits in production.

---

**HARD STOP + PROJECT CLOSE.** TUTOR-1 is complete. Nothing beyond its scope
begins without a new directive. See `TUTOR-1-completion-report.md`.
