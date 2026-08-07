# TUTOR-1 — Amendment A3, Wave 0 audit (read-only)

**Date:** 2026-08-07 · **Scope:** the six §1 defects + every surface A3's later
waves land on. Method: six parallel auditors with mandatory file:line evidence,
plus a live D-6 reproduction (mock-model prompt capture + real-model runs; the
temp script was deleted, tree clean). Nothing in the repo was modified by this
wave except this document and its checkpoint.

Directive cross-reference: §7 Wave 0 asks for (1) the markdown renderer + why
parsing fails, (2) suggestion-chip generation + dedup, (3) the rung badge
emitter, (4) a D-6 reproduction + turn-boundary-vs-chain-id verdict, (5) the
current tool surface, (6) whether an intent-classification path exists for
`practice_request` to extend. §§1–6 below answer them in order; §7 maps every
A3 wave onto the surfaces it touches; §8 lists the rulings needed at this gate;
§9 is the risk register.

---

## 1. D-1 — markdown renders literally

**Root cause: there is no markdown renderer anywhere on the tutor surface, and
the prompt never mentions formatting.** A two-sided contract gap.

- Render sinks are plain React text nodes under `whitespace-pre-wrap`:
  the streaming bubble (`components/learn/tutor/TutorBody.tsx:425`), the
  settled per-span paragraphs (`:589`, `:592-594`), and the no-span fallback
  (`:576`). React escapes to literal DOM text; `**bold**`, `- ` markers, and a
  leaked ```` ```text ```` fence line all display as typed.
- The server pipeline strips ONLY the four ⟦g⟧/⟦/g⟧/⟦s⟧/⟦/s⟧ span markers —
  streaming leg `lib/tutor/runtime/proseExtractor.ts:45` (MARKERS), settle leg
  `grounding.ts:78-109` (parseSpans accumulates every non-marker char).
- The prompt is silent: zero formatting instructions across `promptLayers.ts`,
  `charter.ts`, and `outputContract.ts` (the prose field is a bare
  `z.string()`, `outputContract.ts:134`, no `.describe()`). The model falls
  back to its trained markdown habit.
- No markdown npm dep exists (deps: 22, none markdown). **Two in-house
  precedents exist:** `components/editor/agent/Markdown.tsx` — a purpose-built,
  dependency-free, streaming-safe markdown-lite renderer (paragraphs, bold,
  italic, inline code, lists, headings, fenced code with the language tag
  consumed not displayed; forgiving of half-typed streamed markup;
  `stableMarkdownPrefixEnd` prefix-caching for O(n) streaming), live in the
  editor agent chat (`AgentPanel.tsx:259`). And `lib/ai/richText.ts` (the
  slides' leaked-`**markdown**` fix — wrong target model, right proof that
  this bug class is solved in-house).

**Wave 1 fix direction:** render markdown per-span (spans are the visual
classification unit — supplemental chrome wraps whole spans,
`TutorBody.tsx:580-598`) plus the streaming bubble, by lifting `Markdown.tsx`
to a shared location (it imports only react + `cn`; zod-free, so the learn
bundle rule holds). Constraints: every import stays inside the lazy TutorBody
chunk (the 250 KB `/learn/[slug]/[lessonId]` budget measures eager JS only —
`scripts/verify-bundle-budgets.ts:77`, cutoff at `loadEventEnd+500ms`; the
TutorBody chunk loads on panel-open, after the cutoff); learner bubbles stay
plain text (the AgentPanel precedent); history parity (spans come from the
`grounding` jsonb on reload — the pass must apply identically,
`TutorBody.tsx:490`).

## 2. D-2 — the rung badge (and two bonus defects)

**Emitter: 100 % client chrome.** `RungBadge`
(`components/learn/tutor/TutorBody.tsx:561-569`) renders the literal
`Rung {rung} · {labels[clamped]}`; the `uppercase` class displays it as
"RUNG 2 · NUDGE". Mounted at `:510`; fed exclusively by the settled `turn`
SSE frame (`route.ts:480` → `sseProtocol.ts:59` → the zod-free mirror
`tutorClientTypes.ts:74`). Nothing server-side puts a rung label into prose,
and the prose extractor is pinned against leaking it
(`verify-tutor-prose-extractor.ts:190`) — removing the client badge fully
removes learner visibility.

**Bonus defect (a) — the badge labels are INVERTED.**
`labels = ["Direct answer", "Big hint", "Nudge", "Small nudge", "Socratic"]`
(`TutorBody.tsx:562`) is index-reversed vs the canonical ladder
(`promptLayers.ts:47-51`: rung 0 = probing question … rung 4 = full answer).
labels[0] describes rung 4; even the screenshot's "Nudge" is rung 1's
semantic shown for rung 2. Do not carry these strings into any A3 naming.

**Bonus defect (b) — `grounding.rung` is read but never written.**
`rungTrailFromHistory` (`loop.ts:784-795`) and the client history loader
(`tutorHistory.ts:64`) both read `grounding.rung`, but `buildGrounding`
(`service.ts:730-739`) never writes it and neither history select reads the
dedicated `rung` COLUMN. Consequences: the session rung trail is ALWAYS empty
(escalation candidates' `rung_trail` only ever carries the current turn), and
the badge silently vanishes on reload. Any A3 rung-history policy reads
nothing until this is fixed — and tutor_turns is immutable (BEFORE-UPDATE
trigger), so only a forward fix works (select the column, or write the key).

**The existing ladder (A3 §4 extends this — never a parallel policy):**
5 rungs 0–4, defined once in byte-stable L0 (`promptLayers.ts:45-51`); the
MODEL picks the rung each turn (`outputContract.ts:136`, required field), then
deterministic code overrides in order: `applyScaffolding`
(`scaffolding.ts:68-79` — the `detectJustShowMe` regex forces rung 4; opening
turns clamp to the charter style's `maxOpeningRung` 1/2/3) → the assessment
clamp (`loop.ts:609-616`, rung ≤ 3 while a quiz is live) → the charter `block`
short-circuit (`loop.ts:336-359`, rung 0, zero model calls). Persisted per
turn on `tutor_turns.rung` (smallint CHECK 0–4, migration
`20260804100000:78`); reaches analytics only as `learning_events.hint_rung`
on `hint_request` rows (mastery weights consume it, `weights.ts:69-72`).

**Wave 1 fix direction:** the minimal variant — delete the badge component +
mount and keep `rung` on the wire (D-4's gate needs it at render time). The
rung remains internal on the row, the wire payload, and telemetry.

## 3. D-3 — duplicate "Show me" chips

**They are citation chips, and there is no dedup anywhere in the pipeline.**
`CitationChips` (`TutorBody.tsx:624-641`) renders one button per surviving
citation with a CONSTANT label — `sameLesson ? "Show me" : "Go there"`
(`:637`) — and a React key that appends the array index (`:630`), so even
byte-identical citations render silently side by side. Grep-verified: no
dedup by label OR by (lessonId, blockId, slideId) at any layer; the only
dedup in the turn pipeline is for evidence (`loop.ts:772`).

**Worse, the server manufactures duplicates:** grounding's slide-downgrade
path (`grounding.ts:144`) maps two citations to the same block with different
unresolvable slideIds both to `{ ...c, slideId: null }` — two identical
survivors → two identical chips. The model may also emit the same citation
twice within the ≤8 allowance (`outputContract.ts:135`).

**Wave 1 fix direction:** dedup by ACTION — the (lessonId, blockId, slideId)
jump target — server-side in `validateTurnOutput` AFTER the slide-downgrade
normalization (so persisted grounding jsonb is clean for every future
consumer), plus the client key loses its index suffix. Never dedup by label:
two different blocks both labelled "Show me" are distinct actions
(over-collapse would silently lose jump targets).

## 4. D-4 — the unconditional escape hatch

**Literal root cause:** `{/* Always-visible de-scaffold escape hatch on tutor
replies. */}` (`TutorBody.tsx:521`) — the "Just show me" button renders on
EVERY assistant bubble with zero gate: on rung-4 turns (the full answer
already given) and even on the rung-0 assessment-block refusal, where
pressing it can never comply (the quiz clamp, `loop.ts:609-615`).

Pressing it sends the literal text `"just show me"` (`:525`) — byte-identical
to a typed message; the server re-derives intent by regex
(`scaffolding.ts:57-59`). **No provenance field exists on the POST body**
(`useTutorStream.ts:540-550`: action/courseId/…/message only) — a fact that
matters for Wave 3's deterministic `invitation_accepted`.

**Gating feasibility (Wave 1):** `rung` is available at render time on BOTH
live and history turns with zero new plumbing (`TutorBody.tsx:492`; live via
the turn frame, history via the persisted row → `tutorHistory.ts:65`) — the
"full answer already given" gate (A3-5) is `rung === 4`, handling
`rung === null` (legacy rows) as hatch-hidden, not hatch-shown. The
"first attempt on the active concept" gate (A3-4) has NO existing carrier —
attempt state today is a component-local `useRef` (`TutorBody.tsx:672`), lost
on remount; Wave 3 builds the real session-scoped attempt tracking (§7
below). Wave 1 ships the rung-4 gate; A3-4's attempt gate is Wave 3 scope
where the session state exists.

## 5. D-5 — ASCII diagrams

**Root cause: a gap of omission on both sides.** The entire prompt surface is
silent on visual formatting (exhaustive survey: L0's only prose-shape rules
are "be concrete" — which actively pushes toward drawing structure — and
"2–6 sentences"; no diagram/ASCII/monospace/markdown mention anywhere;
grep-verified), and the output contract offers NO structured visual channel
(`promptLayers.ts:76` names the model's complete vocabulary: prose, citations,
rung, evidence, practice, escalation) — so prose is the model's ONLY channel
for a tree, and ASCII art is what fits in prose. The render side compounds
it: `whitespace-pre-wrap` in proportional Geist Sans preserves the newlines
but collapses column alignment — "malformed" exactly as screenshotted.

**Wave 1 fix direction:** the L0 ban (§3.1's MUST NOT — "never produce ASCII
or monospace diagrams; describe structure in prose until a visual channel
exists"), sharing ONE `TUTOR_PROMPT_VERSION` bump with the D-6 prompt fix.

**Wave 4 (`renderStructure`) reuse assessment — strong:** the slide diagram
surface is pure, dependency-free, SSR-safe by construction
(`components/editor/slide/diagram/DiagramView.tsx` — "no hooks/store";
`lib/course/diagram/geometry.ts` — "no Math.random / Date.now"). Direct
kind mapping: tree → TreeView (`DiagramView.tsx:367-414` + `layoutTree`),
graph → GraphView (`:418-467`), axes → CoordinatePlot (`:149-212`); timeline
is the ONE gap — `number_line` (`:534-568`) is numerically axed, so a true
event timeline needs either numeric pre-mapping with labeled points (works
today) or a ~50-80-line categorical renderer following the per-kind pattern.
`validateDiagram` (`validate.ts`) gives deterministic drop-and-flag gating —
matching the tutor's `evidence_dropped` philosophy and the visual pipeline's
real-data-only lesson (never render fabricated structure, never fail the
turn). Bundle: ~1,150 runtime lines, zero external deps, single-digit KB gzip
into the LAZY TutorBody chunk — the eager 250 KB budget is untouched. The
learn client must import only `{types,geometry,validate}` + the renderers,
NEVER `lib/course/diagram/schemas.ts` (the Zod half).

**Wire path:** the settled `turn` frame carries the whole payload
(`sseProtocol.ts:89`; route assembly `route.ts:474-486`) — renderStructure
data rides free, no new SSE frame. It must be a `.nullable().optional()`
TurnOutputSchema field declared AFTER `proseWithSpanMarkers` (the prose
extractor streams the FIRST field's value and ignores everything after — the
field order is load-bearing, `proseExtractor.ts:6-11`). Four synchronized
touch points: outputContract → sseProtocol → tutorClientTypes (zod-free
mirror) → route payload assembly.

## 6. D-6 — "hello" answered the previous question · REPRODUCED

**Verdict: (a) a turn-boundary defect, with (c) prompt-framing as the
enabling amplifier. (b) chain-id and (d) client re-send are ruled out.**

**Mechanism (reproduced live, real model):** `persistLearnerTurn` runs BEFORE
the model (`service.ts:601-602`); `persistAssistantTurn` runs ONLY on a
completed `ok:true` turn (`service.ts:208-209`, `:681`). So any abort (tab
close mid-stream), model error, or `ok:false` grounding outcome strands the
learner's question in `tutor_turns` with no answer. The next turn's replay
then ends `Learner: <question>\n\nLearner: hello` — two visually identical,
adjacent learner lines (history serialization `history.ts:37` and the current
message `promptLayers.ts:104` use the SAME `Learner:` prefix and the SAME
`\n\n` separator, with no current-message delimiter), L0 contains no
"answer the learner's most recent message" instruction (regex-verified over
the live 6,515-char system string), and L3's "Recent session" synopsis
repeats the open question a second time. The model — reasonably — treats the
question as the active request.

**Reproduction:** mock-model capture of the exact turn-2 assembled input
(variant B, turn 1 aborted: the user item ends verbatim
`Learner: Why does a hash table lookup cost O(1)?\n\nLearner: hello`;
`previousResponseId: null` both variants), then real-model runs: with turn 1
persisted, 2/2 attempts greeted correctly; with turn 1 aborted, "hello"
received a full hash-table answer — reproduced. Temp script deleted;
`git status --porcelain` empty.

**Frequency amplifier (found during reproduction):** grounding's
`ok = !flags.includes("ungrounded") && …` (`grounding.ts:172`) settled BOTH
real happy-path greeting turns `ok:false ungrounded` (the model wrapped its
greeting in a grounded span with zero citations) — persisting no assistant
row. Routine turns create the D-6 precondition silently; aborts are not
required. The learner also watches the answer stream and then sees it vanish
(the route emits `text_delta` before validation, then an error frame) — the
UX that primes the "hello?" follow-up in the first place.

**Latent bug, same class:** `loadThreadHistory` orders ASCENDING with
`limit(40)` (`service.ts:250-257`) — a thread past 40 turns replays the
OLDEST tail and the blind `slice(0,-1)` (`:612`) drops a legitimate old row.
Needs descending-limit-then-reverse in the fix wave.

**Wave 1 fix direction (layered, mechanism-complete):** (i) delimit the
current message in the per-turn input (a non-L0 change — `promptLayers.ts:104`
is per-turn bytes, no cache cost) and mark visibly-unanswered questions in
the replay; (ii) add the "answer the learner's most recent message; earlier
lines are context" rule to L0 (shares the ONE `TUTOR_PROMPT_VERSION` bump
with D-5's ASCII ban); (iii) stop discarding streamed-then-ungrounded turns
as if they never happened — an `ok:false` turn should persist its assistant
row flagged (the transcript is the truth of what the learner SAW; grounding
flags ride the row) so the replay shows the question as answered; (iv) fix
the >40-turn history read. (iii) is the deepest cut and the one that kills
the precondition rather than the symptom; it needs care with the
sessionMarkers/evidence rules (evidence still gates on ok).

## 7. The A3 surface map (Waves 2–5 land here)

**Tool surface (§7 item 5).** Exactly five tools
(`lib/tutor/runtime/tools.ts:59-65`): `get_lesson_context` (read),
`get_mastery_summary` (read), `generate_practice` (read — no DB write, items
live only for the turn), `emit_evidence` (read — validates + hands back; the
ROUTE writes), `propose_escalation` (reversible — consent-pending insert).
Tiers in the exhaustive `TUTOR_TOOL_TIERS` Record (`toolTiers.ts:37-43`);
`tierOf` fails closed to irreversible (`:50-52`); the loop gates BEFORE
dispatch (`loop.ts:494-509`). Tool results are MODEL-FACING only
(`function_call_output`, `loop.ts:517-521`); the three side channels
(`collectToolOutputs`, `:735-756`) surface through `TutorTurnResult`, and the
client-facing practiceItems come from the model's final structured output —
**a bare tool result never reaches the client.** Class-A tools therefore land
their payloads in the settled turn output/payload (the practiceItems idiom),
with a mandatory tier row (compile error + A2-10 test failure if skipped).

**Intent classification (§7 item 6).** None exists in the tutor runtime. The
only message classification is the pure `detectJustShowMe` regex
(`scaffolding.ts:57-59`), applied deterministically after the model's rung
choice. The repo precedent to extend is `lib/ai/intent.ts` — high-precision
regex short-circuits, then a low-effort strict-JSON classifier.
`practice_request` should reuse exactly that two-stage shape: a narrow regex
in the runtime (the detectJustShowMe idiom — pure, testable, zero-cost),
optionally a low-effort `runStructuredCall` through the ALREADY-POOLED
`deps.model`, never a new model seam. Bias to false negatives per §4 — the
regex catches only unmistakable asks.

**Invocation-policy extension points (Wave 3).** Sessions are DERIVED, not
stored (`session.ts:107` `deriveSessionState` over a trailing 30-min window,
`SESSION_GAP_MS`); once-per-session behaviors stamp strings into the
assistant turn's `grounding.sessionMarkers` (`session.ts:26-42`,
`loop.ts:695`, persisted `service.ts:737`) — A3's invitation lifecycle
(offered/ignored ×2/accepted-reset) is a direct extension: new marker strings
+ a counting variant of the existing decline scan (`session.ts:154-161`,
`INTERJECTION_DECLINE_RE :47`). Existing counters: `countFailedScaffolds`
(`escalationTriggers.ts:142-160`), `rungTrailFromHistory` (empty today —
§2 bonus defect (b)), the opening-turn flag. Caveats: markers persist only on
ok turns (another reason for §6 fix (iii)), and the 30-min gap resets derived
counters — the two-ignore cooldown must decide window semantics.
`TurnInitiation` provenance requires a new wire field on the POST body + loop
ctx + zod-free mirror, in lock-step (guarded by `verify-tutor-client` greps).

**Evidence spine (Wave 2).** The persisted union is EXACTLY 22 members
(`lib/analytics/events.ts:370-393`); the tutor writes `tutor_inference`,
`practice_answer`, `self_report`, `hint_request` (+ `tutor_model_call` cost,
client `content_engagement`, `perf_vital` TTFT). Writer =`upsertEvent`
(`service.ts:307-319`): admin upsert, `onConflict: client_event_id`,
`ignoreDuplicates` — the UNIQUE constraint IS the idempotency store; ids are
purpose-prefixed sha256-uuids (`tutorEvidenceId`, `service.ts:277-284`).
Adding the new event type changes, in ONE commit: the events.ts union +
server-event set, `mapEventToColumns`, a migration dropping/recreating
`learning_events_event_type_check` (authoritative current CHECK:
`20260803110000:29-39`) + an envelope-CHECK arm, and the A2 union-lock list
(`verify-tutor-stream-infra.ts:171-194` — asserts both directions and WILL
fail otherwise). The ingest RPC needs NO change (`like 'tutor_%'` already
rejects any tutor-prefixed client submission). The live DB has branch drift —
SPLICE `database.types.ts`, never full-regen.

**"Versioned-update repository function" (§6).** No such function exists for
`learning_events` — the table is append-only by RLS construction (zero
update/delete policies); the only versioned-update precedent is the social
repository's optimistic-UPDATE idiom, categorically wrong for an event
stream. Reading: "the single-write-path repository idiom" — a named tutor
evidence repository function wrapping the existing append-only
deterministic-id discipline. A3-21's "409 conflict test" restates as: the
idempotent-replay proof on the event write, and a REAL version-conflict test
on the misconception registry's versioned rows (where get-or-create races
exist). Ruling R-3 below.

**Mastery read path (Wave 5's `fadeLevel`).** Runtime read =
`gatherLearnerState` (`tools.ts:179-245`): the `my_review_queue` definer RPC
+ own-rows `learner_mastery` select (`node_id, decayed_p`). The key is ALWAYS
`node_id` — a uuid FK to `concept_nodes.id`. **A "concept slug" does not
exist anywhere in the tutor system** (`concept_nodes` = id/title/aliases —
migration `20260803100100:31-51`; grep zero). Mastery-by-node at generation
time already exists; A3 needs only the conceptSlug→node resolution ruling
(R-1 below).

**Chaining for item generation (§5).** `previous_response_id` is wired
(`openai.ts:360`) but foreground/streaming calls default `store:false`
(`openai.ts:444,452`) — **a RECORDED privacy decision**
(P-3, `docs/tutor/architecture.md:56-58,172-175`). With store:false there is
nothing provider-side to chain onto. Ruling R-2 below. The completed-turn id
lives on immutable `tutor_turns.response_id`; within a live turn the freshest
id is the loop's `lastResponseId` (captured from the A2 `started` event).

**Concurrency (A3-20).** The ceiling is structural, not numeric-2:
`withPooledModel` is THE single interception point (`subagent.ts:228+`); the
tutor route wraps once with the LEARNER pool (default 8, per-instance —
`route.ts:411-412`), and tools receive that same pooled client
(`tools.ts:94-97` — "never wraps it again"). Item generation keeps using
`deps.model` and the invariant holds; the A3-20 assertion should be written
against the decorator, not the number two (the historic 2-cap is the CREATOR
pool). Generation-after-prose sequencing is the directive's real ask and is
honored by running item gen on invitation-accept turns.

**Creator analytics (Wave 2's misconception rollup, A3-23).** Console =
`/studio/[courseId]/tutor`, author-gated definer bundle RPC per tab; the
Analytics tab's numbers arrive pre-floored (≥5, Amendment D-4 —
`20260805120000:178`; TS mirror `MASTERY_MIN_COHORT`, drift-tested).
Misconception counts land as a new section/RPC on `AnalyticsTutorTab`
following that exact pattern; A3 §6's "<20 ⇒ raw counts" rule LAYERS ON TOP
of (never replaces) the ≥5 disclosure floor, applied INSIDE the definer RPC.

**Misconception registry (Wave 2).** Confirmed absent (grep: only marketing
clip enums + lesson-plan prose). Conventions to mirror: the tutor-graph
tables' shape (uuid PK, course_id FK cascade, checked enums, version int,
moddatetime; author-CRUD RLS — or the strict zero-policy + definer-RPC regime
if it carries learner-derived counts).

**Legacy practice surface (Wave 4 design note).** `generate_practice` +
`practiceItems` + `PracticeCard` are today's tutor-IMPOSED assessment — the
exact behavior §4 bans (no misconception labels, no invitation, attached at
the model's initiative). Wave 4's `checkUnderstanding` supersedes them; the
migration plan (retire the tool + schema field for new turns, keep history
rendering) belongs in Wave 4's checkpoint.

## 8. Rulings needed at this gate

- **R-1 — `conceptSlug` carrier.** No slug exists; concepts are uuid nodes
  (title + aliases). RECOMMEND: `conceptSlug` = the concept node's existing
  uuid id (the model already echoes node ids reliably via L2 id tags;
  drop-and-flag on mangled refs is proven) — no parallel identifier system,
  no slug-vs-merge drift. Misconception ids REMAIN human-readable slugs
  (model-proposed, e.g. `insertion-order-preserved`), scoped per course in
  the registry. Display names join from `concept_nodes.title`.
- **R-2 — §5 `previous_response_id` vs the standing P-3 ruling.** Chaining
  item generation requires the chained-from response STORED; foreground tutor
  turns ship `store:false` by recorded design. RECOMMEND: a scoped reversal —
  `store:true` on `tutor_turn` foreground calls only (our DB already persists
  the full transcript; the delta is provider-side retention of the same
  content; `TUTOR_ENABLE_CHAINING`/L4 replay stays OFF — storing enables
  item-gen chaining only). ALTERNATIVE (a §5 MUST deviation): re-send the
  last exchange as generation context.
- **R-3 — "the versioned-update repository function" (§6).** It does not
  exist for an append-only event stream. RECOMMEND: implement a named
  `recordToolEvidence` repository function wrapping the existing
  deterministic-id append-only upsert (single write path, spy-assertable);
  restate A3-21's 409 test as idempotent-replay on the event + a real
  version-conflict test on the registry rows.
- **R-4 — event naming.** `tutor.evidence.recorded` (dotted) breaks the
  stream's snake_case convention and every `tutor_%` pattern in SQL/tests.
  RECOMMEND the canonical name `tutor_evidence_recorded`.
- **R-5 — A3-20 wording.** The "two-concurrent ceiling" is the CREATOR pool;
  learner tutor turns ride the learner pool (8). RECOMMEND asserting the
  structural invariant (item gen never escapes `withPooledModel` /
  `deps.model`) + the after-prose sequencing, not the literal number.
- **R-6 — rung-table mapping.** A3 §4's ladder table names rungs 1–4; the
  existing ladder is 0–4 (model-chosen, code-clamped). RECOMMEND mapping A3's
  rows onto the existing rungs (A3 "1 Elicit" ⇒ rungs 0–1 · "2 Nudge" ⇒ 2 ·
  "3 Scaffold" ⇒ 3 · "4 Resolve" ⇒ 4) and extending in place — per the
  directive's own "extend the existing ladder" mandate.

## 9. Risk register (carried into Waves 1–6)

- **R-A3-1 (Wave 1):** any L0 edit costs a `TUTOR_PROMPT_VERSION` bump
  (cache lines + golden suite). Bundle ALL L0 changes (D-5 ban, D-6
  latest-message rule, D-1 formatting guidance if any) into ONE bump.
- **R-A3-2 (Wave 1):** persisting `ok:false` turns (D-6 fix iii) touches the
  evidence/sessionMarkers gates — evidence emission must STAY gated on ok;
  only the transcript row (flagged) is added. The int suites assert
  "an abort persists nothing assistant-side" — those assertions change
  meaning deliberately and must be updated with the fix, not worked around.
- **R-A3-3 (Wave 1):** markdown across span boundaries parses per-span
  (acceptable — Markdown.tsx is forgiving; goldens must cover a list and a
  fence split by a span boundary and by strict-canon suppression).
- **R-A3-4 (Wave 3):** invitation provenance touches three lock-stepped
  surfaces (POST body, loop ctx, zod-free mirror) guarded by grep suites; the
  downgrade path (model calls a Class-A tool on a `question` turn → becomes
  an invitation) must log `tutor.tool.downgraded` — naming per R-4 applies
  (`tutor_tool_downgraded` if persisted; wire-only otherwise).
- **R-A3-5 (Wave 4):** model-emitted structures follow the visual pipeline's
  real-data-only lesson — validate deterministically, drop-and-flag, never
  render fabricated structure, never fail the turn. DiagramView legibility at
  dock scale (300–520 px) needs a visual pass; timeline is the one renderer
  gap.
- **R-A3-6 (Wave 4/5):** rendered structures/items disappear from history on
  reload unless persisted into the assistant row's grounding jsonb (the
  practice-card precedent already has this gap) — decide persistence
  deliberately, don't inherit the gap silently.
- **R-A3-7 (Wave 2):** the union lock, DB CHECK, envelope arm,
  mapEventToColumns, and events.ts change in ONE commit or CI fails;
  database.types.ts is SPLICED.
- **R-A3-8 (all):** the A2 streaming contract is load-bearing — new
  TurnOutputSchema fields go AFTER `proseWithSpanMarkers`, `.nullable()`, or
  every turn fails schema_parse / the extractor breaks.
