# A3 Wave 4 — frozen build contract (renderStructure · checkUnderstanding · sequenceTask)

> Temporary build-coordination doc for the two parallel builders. The permanent
> design lands in the Wave 6 docs pass. Both builders build to THESE shapes
> verbatim — do not deviate; raise a question instead.

## Tool model (consistent with Wave 3 + the existing generate_practice)

Three NEW tools in the tutor tool surface. Each is a real `TutorTool` in
`lib/tutor/runtime/tools.ts`, added to `TUTOR_TOOL_NAMES` and (mandatory,
compile-enforced) `TUTOR_TOOL_TIERS` — all THREE are tier `read` (no DB write;
the card lives for the turn; the ROUTE writes evidence on learner interaction).

- **`renderStructure`** — Class **P** (presentational). **NOT** in
  `CLASS_A_TOOL_NAMES` → the Wave-3 intercept never touches it; it executes on
  ANY turn including a `question` turn (A3-12). The model emits the structure
  as tool ARGS (no internal model call — the data IS the args). The tool maps
  the A3 `kind` onto a `lib/course/diagram` spec and VALIDATES it with
  `validateDiagram` (`lib/course/diagram/validate.ts`); an invalid spec is
  DROPPED-AND-FLAGGED (returns `{ data: { structure: null, error } }`, logged
  `tutor_structure_dropped`) — NEVER fails the turn (A3-24 discipline).
- **`checkUnderstanding`** — Class **A** (gated; add to `CLASS_A_TOOL_NAMES`).
  The model emits the item as tool ARGS. Zod ENFORCES A3-13: any option with
  `correct === false` and a null/empty `misconceptionId` FAILS parse (the tool
  returns invalid_args → the loop feeds that back; on an accepted-invitation
  turn a persistently invalid item is dropped and the invitation re-renders —
  A3-18). Generated live, per invocation.
- **`sequenceTask`** — Class **A** (gated; add to `CLASS_A_TOOL_NAMES`). Zod
  validates `correctOrder` is a permutation of the `items[].id` set.

**Item generation (§5):** the item rides the tool ARGS in the
practice_request / invitation_accepted turn — generated live, reflecting the
conversation (history already carries the just-delivered explanation), after
the model's reasoning, sequentially inside the pooled loop (the concurrency
ceiling holds). **R-2 store:true** is flipped ON for tutor foreground turns so
the `previous_response_id` chaining seam is LIVE (documented); a separate
chained generation call is a documented [FWD] refinement — the in-turn
authoring already reflects the explanation.

**Legacy `generate_practice`:** stays callable + governed (Wave-3 int legs use
it), but is NO LONGER the preferred offer — `invitationToolForRung` now
resolves to `checkUnderstanding` (rungs 0–1, 4) and `sequenceTask` (rung 2)
since they are implemented. Full retirement = a documented follow-up.

## The wire payload (sseProtocol server Zod ↔ tutorClientTypes zod-free mirror)

Two NEW fields on `TutorTurnPayloadSchema`, appended AFTER `invitation`
(streaming/prose-extractor order unaffected — these ride the settled `turn`
frame only). Client mirror in `lib/learn/tutorClientTypes.ts` (zod-free),
drift-guarded by the `verify-tutor-client` field-parity grep — add both names.

```ts
// Class P — presentational; MAY appear on a question turn (A3-12).
RenderStructureCard = {
  kind: "tree" | "graph" | "timeline" | "axes";
  title: string | null;
  caption: string | null;          // the alt text / description (accessibility)
  diagram: DiagramSpec;            // a validated lib/course/diagram spec (storage schema shape)
}
// Class A — assessment; NEVER on a question turn (stripped like practiceItems).
AssessmentCard =
  | { cardId: string;              // minted uuid — the evidence completionKey base
      toolName: "checkUnderstanding";
      conceptSlug: string;         // concept node uuid (R-1)
      initiation: "practice_request" | "invitation_accepted";
      stem: string;
      options: { id: string; text: string; correct: boolean; misconceptionId: string | null; feedback: string }[];  // 3–4
      collectConfidence: boolean }
  | { cardId: string;
      toolName: "sequenceTask";
      conceptSlug: string;
      initiation: "practice_request" | "invitation_accepted";
      prompt: string;
      items: { id: string; text: string }[];   // ≥3
      correctOrder: string[];      // ships to client — formative, client scores
      partialCreditRule: "exact" | "adjacent-pairs" }

TutorTurnPayload += {
  structures: RenderStructureCard[];   // default []
  assessments: AssessmentCard[];       // default []
}
```

`applyInvocationPolicy` (invocationPolicy.ts) strips `assessments` on a
`question` turn EXACTLY as it strips `practiceItems` (the downgrade→invitation
path is unchanged; a downgraded `checkUnderstanding`/`sequenceTask` call
already becomes an invitation via the Wave-3 intercept). `structures` are
NEVER stripped (A3-12). The loop forces `assessments: []` on question turns
belt-and-braces, mirroring `practiceItems`.

`TutorTurnResult` gains `structures: RenderStructureCard[]` and
`assessments: AssessmentCard[]` (default []). The loop's `collectToolOutputs`
routes: `renderStructure` → structures sink; `checkUnderstanding`/
`sequenceTask` → assessments sink (the tool mints `cardId` + stamps
`initiation` from the ctx). Route assembles both onto the payload.

`firstNodeIdFromArgs` (Wave-3 helper) MUST also read a scalar `conceptSlug`
arg (the new tools' node arg) so a downgraded checkUnderstanding/sequenceTask
invitation carries the right node.

## renderStructure → diagram mapping (server-side, in the tool)

- `tree`  → `tree_diagram`
- `graph` → `graph_diagram`
- `axes`  → `coordinate_plot`
- `timeline` → `number_line` (labeled points in sequence; a true categorical
  timeline is a documented [FWD] — number_line carries an ordered labeled
  sequence today). The tool accepts a compact per-kind arg schema and BUILDS
  the diagram spec; `validateDiagram` gates it; the built spec is what ships.
  Import ONLY `lib/course/diagram/{types,geometry,validate}` server-side, and
  the client imports `{types,geometry,validate}` + `DiagramView`/`svg` — NEVER
  `lib/course/diagram/schemas.ts` (the Zod half) on the client (PERF-1
  zod-free learn-bundle rule).

## Evidence on interaction (§6, A3-21)

A NEW route action `tool_evidence` (plain JSON, POST /api/learn/tutor). The
client POSTs when the learner COMPLETES a card (answers checkUnderstanding /
submits a sequenceTask ordering — one evidence per card):
```ts
body = { action: "tool_evidence", courseId, publicationId, version, lessonId?,
  cardId, toolName, conceptSlug,
  outcome: "demonstrated" | "partial" | "not_demonstrated",
  misconceptionId?: string | null,   // the selected distractor's misconceptionId (checkUnderstanding)
  confidence?: "sure" | "unsure" | null,
  fadeLevel?: number | null,         // null in Wave 4 (fadedExample is Wave 5)
  initiation: "practice_request" | "invitation_accepted",
  latencyMs?: number | null }
```
The route (access-gated exactly like practice_answer): builds
`completionKey = "toolcard:" + cardId` (idempotent per card), calls
`recordToolEvidence(admin, { ...map..., itemSource: "generated",
reviewedItemId: null, completionKey })`, then fires the SAME mastery refold the
existing evidence endpoints fire (mirror recordPracticeAnswer's refold call —
read the route + service). Returns `{ ok, access, emitted, misconceptionId }`.
Author-preview / not-enrolled / disabled → no-op `{ ok:true, emitted:false }`.
renderStructure emits NO evidence.

Client grades LOCALLY (formative, low-stakes — the answer key ships on the
payload, the existing practiceItems precedent): checkUnderstanding →
demonstrated if the picked option.correct, else not_demonstrated + carry that
option's misconceptionId; feedback shown = the picked option's `feedback` (§3:
names the reasoning, never "the answer is X"). sequenceTask → exact: all
positions right ⇒ demonstrated else not_demonstrated; adjacent-pairs:
proportion of correctly-ordered adjacent pairs ≥ ~0.99 ⇒ demonstrated, > 0 ⇒
partial, else not_demonstrated (pure scorer, unit-tested — A3-15).

## Session attempts (A3-4 hatch gate)

Completing a checkUnderstanding or sequenceTask card calls the Wave-3
`recordSessionAttempt(userId, conceptSlug)` (client store) so the escape-hatch
attempt gate counts these too.

## Prompt (ONE L0 bump → tutor-v4)

Add the tools to the L0 capability list + a terse teaching line: use
`renderStructure` for any tree/graph/timeline/axes instead of ASCII (it
replaces the Wave-1 "describe in prose" stopgap for these shapes); use
`checkUnderstanding` (never bare practice) for retrieval checks — every wrong
option MUST name the misconception it represents; use `sequenceTask` for
order-carrying content. Keep the Wave-3 PRACTICE & INVITATIONS governance
line. Bump `TUTOR_PROMPT_VERSION` "tutor-v3" → "tutor-v4"; update the
verify-tutor-runtime pin + L0 section-inventory assertion.
