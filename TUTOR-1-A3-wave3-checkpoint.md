# TUTOR-1 — Amendment A3, Wave 3 Checkpoint: Invocation policy

**Date:** 2026-08-07 · **Status:** Wave 3 COMPLETE → **HARD STOP.**
The three-path invocation policy is live and enforced IN CODE, before any new
Class-A tool exists — the directive's ordering requirement. The legacy
practice surface (`generate_practice` + `practiceItems`) is now the GOVERNED
Class-A prototype: yesterday it was tutor-imposed assessment (the exact §4
ban); today it renders only on a learner request or an accepted invitation,
and a model attempt to impose it becomes one quiet invitation. Wave 4's
`checkUnderstanding` lands into this governed surface. No migration
(invitation/initiation ride the grounding jsonb); no new dependencies; ONE L0
bump (`tutor-v3`).

## 1. In-scope acceptance criteria → proofs

| AC | Criterion | Proven by | Result |
| --- | --- | --- | --- |
| A3-4 | No escape hatch before the first attempt on the active concept | `shouldOfferEscapeHatch(rung, hasAttempted)` + `hasAttemptedFor` (node-scoped when the turn names practice nodes, else any-attempt) + the non-persisted session-attempts store slice fed by both PracticeCard interactions — full matrix in `verify-tutor-client` §A3-4 (incl. the partialize-exclusion proof) | **PASS** |
| A3-6 | No Class-A tool renders on a `question` turn — property test over ≥100 turns | `verify-tutor-runtime` §A3-6: seeded-LCG property, **120 generated turns** through `applyInvocationPolicy` — zero retained practiceItems, invitation ≤ 1 and well-formed, non-vacuous; Paths 1/2 leave items intact. Live real-model leg: SMOKE A (§5) | **PASS** |
| A3-7 | A Class-A call on a question turn downgrades to an invitation naming that tool — never blocked/dropped — and logs the downgrade | Loop-level int leg (a): `generate_practice` NOT executed (mock records zero calls), the turn CONTINUES (ok, never approvalRequired), one invitation carrying the called tool + nodeId, `tutor_tool_downgraded` logged, invitation stamped in grounding | **PASS** |
| A3-8 | An explicit practice request renders the tool directly, no invitation | The conservative regex (server-side; "Quiz me on this lesson" matches; 9 near-miss negatives proven, e.g. "is this best practice", "I practiced yesterday") → direct execution; int leg (c) + LIVE real-model SMOKE B (§5) | **PASS** |
| A3-9 | ≤1 invitation per turn; none on a turn already carrying a Class-A tool | `applyInvocationPolicy` invariant (property-tested); the client renders through ONE pure `shouldRenderInvitation` rule (matrix-tested; source-asserted no inline re-derivation) | **PASS** |
| A3-10 | No invitation after two consecutive ignored; reset on acceptance or explicit request | `deriveInvitationState` (stateless, over the 30-min session window) + `effectiveCooldown` (folds the offer the current message resolves — the "third turn" timeline works exactly); resets proven both ways; int leg (d) end-to-end | **PASS** |
| A3-11 | An unaccepted invitation is discarded on any other message | Structural, two independent enforcements: the client renders invitations ONLY on the final transcript turn while idle; the server validates acceptance claims ONLY against the immediately-prior assistant turn (anything else fails toward `question` — int leg (e) + SMOKE C live: a stale acceptance after an intervening turn delivered nothing) | **PASS** |

## 2. What was built

**Server** — `lib/tutor/runtime/invocationPolicy.ts` (pure, zero I/O):
`TurnInitiation` · `CLASS_A_TOOL_NAMES` ({generate_practice} today) · the
directive's invitation copy verbatim (`INVITATION_LABELS`, all six tools) ·
the FULL R-6 rung→tool map as data (consumed for tool availability in Waves
4/5; a tool-call downgrade preserves the called tool's name) ·
`detectPracticeRequest` (regex-ONLY, false-negative-biased per §4 — the
low-effort model fallback is documented `[FWD]`, not built) ·
`resolveInitiation` (acceptance validation, fail-toward-question) ·
`deriveInvitationState`/`effectiveCooldown` · `applyInvocationPolicy`.
Loop: the PRE-EXECUTION intercept beside the tier gate — a Class-A call on a
question turn never runs (§5's generate-on-acceptance-not-offer falls out
structurally: an ignored invitation costs zero model calls), the model gets a
plain synthetic tool result and finishes its prose turn; per-turn
extraInstructions for the acceptance/practice-request/cooldown cases (input
tail, cache-neutral). Service: initiation resolved server-side and stamped on
the learner row at insert; the offered invitation stamped in the assistant
grounding (the cooldown derivation's marker AND the history-render carrier).
Wire: `invitation` on the turn payload; the optional acceptance claim on the
POST body (malformed → question). L0 `== PRACTICE & INVITATIONS ==`
(invite-don't-impose, deliver-immediately-on-ask) → **tutor-v3**.

**Client** — the invitation pill (`data-ai-tool="tutor-invitation"`;
label-verbatim send + the deterministic `initiation` payload — provenance is
a button press, never inference); the ONE render rule; the session-attempts
store slice (non-persisted — a refresh clears attempts, the conservative
direction); the A3-4 hatch gate; zod-free mirrors + parity greps extended.

## 3. Files

**Created:** `lib/tutor/runtime/invocationPolicy.ts` ·
`scripts/tutor-client-localstorage-stub.ts` (suite-only; fixes a latent
pre-existing bug — the inline localStorage stub never ran before the store
module under esbuild import hoisting, so zustand's persist API was silently
absent in tests) · this checkpoint.
**Modified:** `lib/tutor/runtime/{loop,promptLayers,service,sseProtocol}.ts`
· `app/api/learn/tutor/route.ts` · `lib/learn/{tutorClientTypes,
useTutorStream,tutorHistory,tutorStore}.ts` ·
`components/learn/tutor/TutorBody.tsx` · `scripts/verify-tutor-runtime.ts`
(127→181) · `scripts/verify-tutor-client.ts` (260 total) ·
`scripts/verify-tutor-route-int.ts` (+5 lifecycle legs) ·
`scripts/verify-tutor-stream-{infra,int}.ts` (payload literals only).
**No migration. No package.json change.**

## 4. Repo gates (bare exit codes)

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit **0** |
| `npm run lint` | exit **0**, zero warnings |
| `npm test` (full pure chain) | exit **0**, zero failures |
| `npm run verify:tutor:int` (16 live suites incl. the 5 new lifecycle legs) | exit **0**, every suite 0 failed |
| `npm run verify:budgets` | **6/6** — `/learn/[slug]/[lessonId]` byte-identical **216.3 KB** (the invitation pill rides the lazy chunk) |
| Live governance smoke (real model, transient script — §5) | **7/0** |
| `verify:tutor:browser:stream` (live: dev server + real model + Upstash) | **20/0, zero flake retries** |

## 5. The live smoke (real model) — and what its first run taught

Final run 7/0: a substantive question → grounded answer, ZERO practice items
(A3-6 live); "Quiz me on this lesson" → ONE MC item delivered directly, no
invitation, `practice_request` stamped (A3-8 live); a deliberately-stale
acceptance claim after an intervening turn → fell to question, nothing
delivered (A3-11 live).

The first run FAILED usefully: on a placeholder-content fixture the model
refused to deliver practice — *"not enough course material to create a
substantive quiz without inventing content"* — and instead proposed an
escalation. That is the grounding discipline composing correctly with the new
surface (practice is grounded teaching, not trivia generation); the fix was
giving the fixture real lesson content, not changing any code.

**Known legacy-surface limitation (recorded, not fixed here):** the delivered
item's `nodeId` was a model-invented slug, not a real concept-node uuid —
`TurnPracticeItemSchema.nodeId` is a bare string and the legacy surface never
enforced node echo. The evidence gate already drops unresolvable refs at
emission, and Wave 4's `checkUnderstanding` (validated conceptSlug per R-1 +
L2 id-tag echo) replaces this surface — tracked there, per the Wave-0 plan.

## 6. Deviations

1. **`deriveInvitationState(turns, nowIso)`** — the clock seam added
   (matches `deriveSessionState`).
2. **`effectiveCooldown` added** — the persisted-only count could not make
   the directive's "no third offer" timeline work (the second offer is still
   pending when the third message arrives); the helper folds in the offer the
   current message resolves. Pinned by the property test and int leg (d).
3. **History load moved BEFORE the learner-row insert** in the service —
   forced by immutability: the resolved initiation must be stamped at insert,
   which needs the prior invitation first. This also RETIRES Wave 1's
   drop-by-id/positional dance entirely (the new row can no longer echo into
   its own replay); the "learner persists before the MODEL dispatch"
   guarantee is unchanged.
4. **The intercept pushes a paired `function_call` item** alongside the
   synthetic output (providers require call/output pairing in conversation
   state); the plan named only the output.
5. **Downgrade telemetry is log-only** (`tutor_tool_downgraded` structured
   tag) — a persisted event would require the full union/CHECK/lock recipe;
   deliberate, revisit only if dashboards need it.

## 7. Risk changes for later waves

- Wave 4 tools slot in by: adding the tool name to `TUTOR_TOOL_NAMES` +
  `TUTOR_TOOL_TIERS` + `CLASS_A_TOOL_NAMES`, flipping its availability in the
  R-6 map, and calling `recordToolEvidence` (completionKey) + the refold on
  completion. The invitation copy already exists for all six tools.
- The R-2 ruling (`store:true` scoped to tutor turns) is NOT yet exercised —
  Wave 4/5's post-prose item generation lands it alongside its first user.
- The legacy `generate_practice`/`practiceItems` retirement decision is due
  in Wave 4's checkpoint (its nodeId looseness recorded above strengthens the
  case).

---

**Awaiting approval to proceed to Wave 4 (core tools: `renderStructure`,
`checkUnderstanding`, `sequenceTask`).**
