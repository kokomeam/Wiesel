# TUTOR-1 — Amendment A3, Wave 0 Checkpoint: Audit (read-only)

**Date:** 2026-08-07 · **Status:** Wave 0 COMPLETE → **HARD STOP.**
Deliverable: `docs/audits/TUTOR-1-A3-audit.md` — every §7 Wave-0 item answered
with file:line evidence, D-6 reproduced against the live model, three bonus
latent defects surfaced, and the full A3 surface map for Waves 1–6.

## 1. §7 Wave-0 tasks → where answered

| Task | Answered | Result |
| --- | --- | --- |
| Locate the markdown renderer; why parsing fails | audit §1 | There IS no renderer — three plain-text sinks (`TutorBody.tsx:425/576/589-594`), server strips only span markers, prompt has zero formatting rules. In-house fix exists: `components/editor/agent/Markdown.tsx` (streaming-safe, dependency-free, live in the editor agent chat) |
| Locate suggestion-chip generation + dedup | audit §3 | Two families: 4 static composer chips (no dup risk) + the D-3 chips = CITATION chips, constant "Show me" label, index-suffixed keys, **zero dedup at any layer** — and grounding's slide-downgrade path (`grounding.ts:144`) actively manufactures duplicates |
| Locate the rung badge emitter | audit §2 | `RungBadge`, `TutorBody.tsx:561-569`, mounted `:510` — pure client chrome; prose can't leak it. Bonus: labels INVERTED vs the ladder; `grounding.rung` read-but-never-written (session rung trail always empty) |
| Reproduce D-6; turn-boundary vs chain-id | audit §6 | **REPRODUCED (real model): turn-boundary defect**, prompt-framing amplifier; chain-id + client re-send ruled out with evidence. Aborted/errored/`ungrounded` turns strand the question; both happy-path greetings settled `ok:false ungrounded` — routine turns prime it. Latent >40-turn ascending-read bug found |
| Enumerate the current tool surface | audit §7 | 5 tools + tiers + the fail-closed gate; tool results are model-facing only; Class-A payloads must ride the settled turn output (practiceItems idiom) |
| Does an intent-classification path exist for `practice_request`? | audit §7 | Not in the tutor; `detectJustShowMe` regex + `lib/ai/intent.ts` two-stage precedent are the shapes to extend — regex-first, pooled low-effort fallback, false-negative bias |
| Produce `docs/audits/TUTOR-1-A3-audit.md` | — | Written |

## 2. Files

**Created:** `docs/audits/TUTOR-1-A3-audit.md` · this checkpoint.
**Modified:** none. **Deleted:** none.
The D-6 reproduction created `scripts/zz-a3-repro-d6.ts` transiently and
deleted it; `git status --porcelain` verified empty afterwards. Reproduction
DB rows used throwaway users (self-provisioned, cleaned up in-run; the
`*@example.com` auth users remain, as always, deletable only from the
Supabase console). Real-model spend: 5 `tutor_turn` calls (cents).

## 3. Deviations

None from the read-only mandate. One directive-text observation recorded for
the rulings below: §6's "versioned-update repository function" names a
mechanism that cannot exist on an append-only event stream (audit §7).

## 4. Rulings requested at this gate (audit §8 has the full rationale)

| # | Question | Recommendation |
| --- | --- | --- |
| R-1 | `conceptSlug` — no slug exists on concept nodes | conceptSlug = the existing node uuid; misconception ids are the human-readable slugs |
| R-2 | §5 `previous_response_id` requires `store:true`, reversing the recorded P-3 ruling | Scoped reversal: `store:true` on `tutor_turn` foreground calls only; chaining flag/L4 replay stays off |
| R-3 | §6 "versioned-update repository function" doesn't exist for learning_events | Named `recordToolEvidence` wrapping the append-only deterministic-id upsert; A3-21's 409 test restated (registry rows get the real conflict test) |
| R-4 | `tutor.evidence.recorded` breaks the stream's snake_case + `tutor_%` patterns | Canonical name `tutor_evidence_recorded` |
| R-5 | A3-20 "two-concurrent" is the CREATOR pool; tutor rides the learner pool (8) | Assert the structural invariant (never escapes `withPooledModel`) + after-prose sequencing |
| R-6 | A3 §4 rung table is 1–4; the existing ladder is 0–4 | Map onto the existing rungs (1⇒0–1 · 2⇒2 · 3⇒3 · 4⇒4), extend in place |

Approving this checkpoint without comment approves the six recommendations.

## 5. Wave-1 scope confirmed by the audit (unchanged from §7, now grounded)

D-1 per-span markdown (lift `Markdown.tsx` to shared, lazy-chunk-only) ·
D-2 remove the badge, keep rung on wire/row (D-4's gate needs it) ·
D-3 dedup citations by jump target server-side post-downgrade ·
D-4 rung-4 gate now (the attempt-based A3-4 gate lands with Wave 3's session
state) · D-5 L0 ASCII ban · D-6 the four-layer fix: current-message delimiter
(non-L0) + L0 latest-message rule + persist flagged `ok:false` assistant rows
(kills the precondition) + the >40-turn history read — all L0 edits share ONE
`TUTOR_PROMPT_VERSION` bump. Plus the two latent repairs in the same areas:
`grounding.rung` write gap, citation-duplicate persistence.

## 6. Risk changes for later waves

The audit's risk register (§9, R-A3-1..8) supersedes assumptions in the
directive where they conflicted: evidence-suite assertions change meaning
with the D-6 persistence fix (deliberately, not silently); Wave-4 structures
follow the real-data-only validation discipline; history-reload persistence
of rendered tools is a deliberate decision, not an inherited gap.

---

**Awaiting approval to proceed to Wave 1.**
