/**
 * The CLIENT mirror of the tutor wire contract.
 *
 * This mirrors lib/tutor/runtime/outputContract.ts + the /api/learn/tutor route's
 * `TutorSSEEvent` — drift is caught by scripts/verify-tutor-client.ts field greps.
 * NEVER import zod or lib/tutor/runtime here — the learn route bundle must stay
 * schema-free (this file is interface-only + pure helpers, no runtime deps).
 *
 * The interfaces below are the plain-TS shape of the server's frozen contract:
 *   • TutorCitation / TutorSpan / TutorPracticeItem / TutorEscalationProposal
 *     mirror the sub-schemas in outputContract.ts.
 *   • TutorTurnPayload mirrors the `turn` SSE event's `payload` object.
 *   • TutorSSEEvent mirrors the route's own `TutorSSEEvent` union verbatim.
 * The SOURCES win: if a field name ever diverges, correct it here to match them.
 *
 * A3 Wave 4 additions: `TutorRenderStructureCard` (a validated lib/course/diagram
 * spec rendered via DiagramView) + `TutorAssessmentCard` (checkUnderstanding /
 * sequenceTask, discriminated on `toolName`) + `structures`/`assessments` on the
 * turn payload, plus the pure LOCAL scorers the client grades formative cards with
 * (the answer key ships on the payload — the practiceItems precedent).
 */

// TYPE-ONLY import — lib/course/diagram/types.ts is "PURE TYPES no Zod", so this
// is bundle-free (erased at compile) and never drags the Zod half onto the learn
// client. NEVER import lib/course/diagram/schemas.ts here (the PERF-1 zod-free
// learn-bundle rule).
import type { DiagramSpec } from "@/lib/course/diagram/types";

/* ───────────────────────────── wire shapes ───────────────────────────── */

/**
 * Which lesson/block (and optionally slide) in the publication snapshot backs a
 * grounded claim. `blockId` is a row uuid; `slideId` is the jsonb short id (null
 * for a block-level citation). Mirrors `TurnCitationSchema`.
 */
export interface TutorCitation {
  lessonId: string;
  blockId: string;
  slideId: string | null;
}

/** A classified run of reply text: `grounded` (backed by course material) or
 *  `supplemental` (general knowledge). Mirrors the grounded/supplemental span map. */
export interface TutorSpan {
  kind: "grounded" | "supplemental";
  text: string;
}

/**
 * A tutor-proposed practice item. The answer key RIDES the payload (formative,
 * low-stakes → the CLIENT grades locally). `choices`/`correctChoiceIndex` are set
 * only for `mc`; `acceptedAnswers` only for `short`; `itemBankRef` is always null.
 * Mirrors `TurnPracticeItemSchema`.
 */
export interface TutorPracticeItem {
  nodeId: string;
  practiceItemRef: string;
  kind: "mc" | "short";
  prompt: string;
  choices: string[] | null;
  correctChoiceIndex: number | null;
  acceptedAnswers: string[] | null;
  explanation: string | null;
  itemBankRef: null;
}

/** The tutor's proposal to escalate to a human instructor. Mirrors
 *  `TurnEscalationProposalSchema`. */
export interface TutorEscalationProposal {
  learnerQuestion: string;
  nodeIds: string[];
  proposedAnswer: string;
}

/**
 * A3 Wave 3 — a tutor-offered INVITATION to run a Class-A tool (offer-first
 * invocation policy). The learner accepts by pressing the invitation button:
 * the client sends the `label` VERBATIM as the message text (the learner
 * bubble shows what they pressed) plus a deterministic `initiation`
 * provenance payload — never inferred from typed text. History rows carry
 * the same shape in the assistant grounding jsonb (`grounding.invitation`).
 */
export interface TutorInvitation {
  toolName: string;
  nodeId: string;
  label: string;
}

/**
 * A3 Wave 4 · Class-P (presentational) render-structure card. The model emits a
 * tree/graph/timeline/axes shape as tool args; the SERVER maps it onto a
 * `lib/course/diagram` spec and validates it with `validateDiagram` (invalid ⇒
 * dropped server-side, never reaches the client). What ships is the built,
 * validated `diagram` (the storage-schema `DiagramSpec` shape) + a title +
 * `caption` (the alt text / accessible description). Rendered via DiagramView on
 * ANY turn — including a `question` turn (A3-12); it carries no evidence.
 * Mirrors `TurnRenderStructureCardSchema`.
 */
export interface TutorRenderStructureCard {
  kind: "tree" | "graph" | "timeline" | "axes";
  title: string | null;
  /** The alt text / accessible description of the diagram. */
  caption: string | null;
  /** A validated lib/course/diagram spec (storage-schema shape). */
  diagram: DiagramSpec;
}

/**
 * A3 Wave 4 · Class-A (assessment) card, discriminated on `toolName`. The model
 * emits the item as tool args; the answer KEY rides the payload (formative,
 * low-stakes → the CLIENT grades locally, the practiceItems precedent). Stripped
 * on a `question` turn exactly like `practiceItems`. `cardId` (a minted uuid) is
 * the evidence completion-key base. Mirrors `TurnAssessmentCardSchema`.
 *
 * - `checkUnderstanding` — a stem + 3–4 options; every WRONG option MUST name the
 *   misconception it represents (`misconceptionId`) — the server Zod enforces it.
 * - `sequenceTask` — an ordering task; `correctOrder` is a permutation of the
 *   `items[].id` set; scored `exact` (all-or-nothing) or `adjacent-pairs`.
 *
 * A3 Wave 5 adds three more variants (`fadedExample` / `predictThenReveal` /
 * `explainBack`). The first two grade LOCALLY (their keys ride the card, the
 * practiceItems precedent); `explainBack` grades on the SERVER (free text →
 * semantic rubric presence) via the `explain_back_grade` route action.
 */
export type TutorAssessmentCard =
  | {
      cardId: string;
      toolName: "checkUnderstanding";
      /** The concept node uuid this card checks (R-1). */
      conceptSlug: string;
      initiation: "practice_request" | "invitation_accepted";
      stem: string;
      options: {
        id: string;
        text: string;
        correct: boolean;
        misconceptionId: string | null;
        feedback: string;
      }[];
      /** Ask a sure/unsure confidence read BEFORE reveal. */
      collectConfidence: boolean;
    }
  | {
      cardId: string;
      toolName: "sequenceTask";
      conceptSlug: string;
      initiation: "practice_request" | "invitation_accepted";
      prompt: string;
      items: { id: string; text: string }[];
      /** Ships to the client — formative, the client scores locally. */
      correctOrder: string[];
      partialCreditRule: "exact" | "adjacent-pairs";
    }
  | {
      cardId: string;
      toolName: "fadedExample";
      conceptSlug: string;
      initiation: "practice_request" | "invitation_accepted";
      /** How much of the worked example is blanked (0 fully worked → 3 all
       *  trailing steps blanked). Derived server-side from the learner's decayed
       *  mastery (A3-16 — never the model, never turn count); fixed at authoring. */
      fadeLevel: number;
      problem: string;
      /** The COMPLETE worked example. A blanked step ships its `answer` for local
       *  grading (formative); a shown step ships its worked `answer` too, rendered
       *  inline. `blanked` marks the trailing steps the learner must fill. */
      steps: { text: string; blanked: boolean; answer: string }[];
    }
  | {
      cardId: string;
      toolName: "predictThenReveal";
      conceptSlug: string;
      initiation: "practice_request" | "invitation_accepted";
      setup: string;
      prompt: string;
      /** Ships to the client — formative, the client scores the committed
       *  prediction locally. A prediction that contains/equals one of these →
       *  demonstrated. */
      acceptedAnswers: string[];
      /** Ordered near-miss patterns: the FIRST whose `pattern` the (normalized)
       *  prediction contains names the misconception + its feedback. */
      nearMisses: { pattern: string; misconceptionId: string; feedback: string }[];
      /** Revealed AFTER the learner commits their prediction. */
      revealExplanation: string;
    }
  | {
      cardId: string;
      toolName: "explainBack";
      conceptSlug: string;
      initiation: "practice_request" | "invitation_accepted";
      prompt: string;
      /** The rubric the learner's free-text explanation is graded against —
       *  SERVER-side, on PRESENCE of each idea (never wording). 2–5 criteria. */
      rubric: { criterion: string; required: boolean }[];
    };

/** The outcome of a locally-graded assessment card (fed to `tool_evidence`). */
export type TutorAssessmentOutcome = "demonstrated" | "partial" | "not_demonstrated";

/**
 * The `turn` SSE event's `payload`. `prose` is the cleaned reply (span markers
 * stripped); `spans`/`citations` are the classified/anchored maps; `rung` is the
 * 0..4 scaffolding rung (null when absent); `practiceItems`/`escalationProposal`
 * are present only when the tutor generated practice or proposed a hand-off.
 * Mirrors the route's `turn` payload object.
 */
export interface TutorTurnPayload {
  prose: string;
  spans: TutorSpan[];
  citations: TutorCitation[];
  rung: number | null;
  practiceItems: TutorPracticeItem[] | null;
  escalationProposal: TutorEscalationProposal | null;
  /** W6 · the consent-pending candidate id (present when the tutor raised an
   *  escalation this turn), so the consent card can POST escalate_consent against
   *  the right row. Null when no escalation was raised. */
  escalationCandidateId: string | null;
  /** A3 Wave 3 · the tutor's pending invitation — non-null when this turn OFFERS
   *  a Class-A tool run the learner may accept. Renders ONLY per
   *  `shouldRenderInvitation` (final turn, idle, no practiceItems — the server
   *  already forces null alongside practiceItems, A3-9). */
  invitation: TutorInvitation | null;
  /** A3 Wave 4 · presentational diagrams for this turn (default []). Rendered on
   *  ANY turn, including a `question` turn (A3-12) — never stripped. */
  structures: TutorRenderStructureCard[];
  /** A3 Wave 4 · assessment cards for this turn (default []). Stripped on a
   *  `question` turn exactly like `practiceItems`. */
  assessments: TutorAssessmentCard[];
  flags: string[];
}

/** The provider usage counters carried by `turn_completed`. Each is nullable — a
 *  provider may not report a given counter. Mirrors `TutorWireUsageSchema`. */
export interface TutorWireUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
}

/**
 * The SSE event stream from /api/learn/tutor. The ZOD-FREE mirror of the server's
 * `TutorWireEventSchema` (lib/tutor/runtime/sseProtocol.ts) — eleven variants:
 * four legacy (queued/turn/error/done) + the A2 streaming lifecycle (turn_started
 * → model_started → first_token → text_delta* → turn_completed | turn_aborted) +
 * the dormant approval halt (approval_required). Keep this in lock-step with the
 * server schema BY REVIEW (the client can't import a zod schema without shipping
 * zod); scripts/verify-tutor-client.ts greps the variant names to catch drift.
 *
 * Emission order (per turn): turn_started → model_started → (first_token +
 * text_delta×N) → (turn + turn_completed | error [+turn_aborted] |
 * approval_required) → done.
 */
export type TutorSSEEvent =
  /* ── legacy variants ── */
  | { type: "queued"; position: number }
  | { type: "turn"; payload: TutorTurnPayload }
  | { type: "error"; message: string }
  | { type: "done" }
  /* ── A2 streaming lifecycle (transport frames, never persisted) ── */
  | { type: "turn_started"; streamId: string; ts: string }
  | { type: "model_started"; responseId: string | null }
  | { type: "first_token"; ttftMs: number }
  | { type: "text_delta"; delta: string }
  | {
      type: "turn_completed";
      finishReason: string;
      durationMs: number;
      usage: TutorWireUsage;
    }
  | { type: "turn_aborted"; reason: string; tokensEmitted: number }
  /* ── A2 approval halt (dormant — no tutor tool is irreversible today) ── */
  | { type: "approval_required"; toolName: string; message: string };

/* ───────────────────────────── pure helpers ──────────────────────────── */

/**
 * Grade a practice answer locally against the key that rides the item.
 *
 * - `mc`: correct iff `answer.choiceIndex === item.correctChoiceIndex`. A null key
 *   (no `correctChoiceIndex`) yields `null` — keyless, cannot grade.
 * - `short`: correct iff the trimmed/lowercased answer text is a member of
 *   `acceptedAnswers` (each compared trimmed/lowercased). A null/empty key yields
 *   `null` — keyless, cannot grade.
 *
 * @returns `true`/`false` for a verdict, or `null` when there is no gradable key.
 */
export function gradePracticeAnswer(
  item: TutorPracticeItem,
  answer: { choiceIndex?: number | null; text?: string | null },
): boolean | null {
  if (item.kind === "mc") {
    if (item.correctChoiceIndex === null) return null;
    return answer.choiceIndex === item.correctChoiceIndex;
  }
  // short-answer
  const accepted = item.acceptedAnswers;
  if (accepted === null || accepted.length === 0) return null;
  const guess = (answer.text ?? "").trim().toLowerCase();
  return accepted.some((a) => a.trim().toLowerCase() === guess);
}

/**
 * A3 D-3 — dedupe citations by their jump TARGET (the frozen identity key
 * `${lessonId}|${blockId}|${slideId ?? ""}`), order-preserving: the FIRST
 * occurrence of each target survives. Never dedups by label — two different
 * blocks both rendered "Show me" are distinct actions. The server dedups new
 * turns at validate time; this covers legacy persisted rows that still carry
 * duplicates.
 */
export function dedupeCitations(citations: TutorCitation[]): TutorCitation[] {
  const seen = new Set<string>();
  const out: TutorCitation[] = [];
  for (const c of citations) {
    const key = `${c.lessonId}|${c.blockId}|${c.slideId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * A3 D-4 — should a tutor turn offer the "Just show me" de-scaffold hatch?
 * Two gates compose (A3-5 + A3-4):
 *  - RUNG: rung 4 = the full answer was already given → no hatch; null/unknown
 *    (legacy rows without a rung) → no hatch (hidden, the safe default).
 *  - ATTEMPT: the learner must have made at least one attempt THIS SESSION
 *    before de-scaffolding is offered (`hasAttempted` — derive it with
 *    `hasAttemptedFor` over the tutor store's session-attempts slice).
 */
export function shouldOfferEscapeHatch(
  rung: number | null,
  hasAttempted: boolean,
): boolean {
  return rung !== null && rung < 4 && hasAttempted;
}

/**
 * A3-4 — has the learner attempted enough this session to earn the hatch?
 * `attempts` is the tutor store's per-user SESSION slice (undefined = none; the
 * slice is never persisted, so a refresh clears attempts — the conservative
 * direction, deliberate). When the turn NAMES practice nodeIds, an attempt on
 * ONE OF THEM is required; otherwise any session attempt (count > 0) qualifies.
 * An empty `turnNodeIds` array names nothing → the count gate applies.
 */
export function hasAttemptedFor(
  attempts: { nodeIds: string[]; count: number } | undefined,
  turnNodeIds: string[] | null,
): boolean {
  if (!attempts) return false;
  if (turnNodeIds !== null && turnNodeIds.length > 0) {
    return turnNodeIds.some((id) => attempts.nodeIds.includes(id));
  }
  return attempts.count > 0;
}

/**
 * A3-9 / A3-11 (client legs) — THE render rule for an invitation button.
 * An invitation renders ONLY on the FINAL transcript turn, only while status
 * is idle (no send in flight, nothing streaming), never on a turn that
 * carries practiceItems (the A3-9 belt — the server already forces
 * `invitation` null there), and only when the turn actually carries one.
 * TutorBody consumes THIS helper — never re-derive the condition inline.
 */
export function shouldRenderInvitation(args: {
  isFinalTurn: boolean;
  status: string;
  hasPracticeItems: boolean;
  invitation: TutorInvitation | null;
}): boolean {
  return (
    args.invitation !== null &&
    args.isFinalTurn &&
    args.status === "idle" &&
    args.hasPracticeItems === false
  );
}

/**
 * The stable idempotency key for a per-node self-report on a given day. Scopes to
 * the node + lesson (falling back to `"course"`) + the ISO date (day granularity).
 */
export function selfReportStableKey(
  nodeId: string,
  lessonId: string | null,
  isoDate: string,
): string {
  return `selfreport:${nodeId}:${lessonId ?? "course"}:${isoDate.slice(0, 10)}`;
}

/**
 * Bucket a time-to-first-token latency (ms) into a coarse rating: `good` (<4000),
 * `needs-improvement` (<12000), else `poor`.
 *
 * ── A2 RE-POINT ──────────────────────────────────────────────────────────────
 * This vital now measures the FIRST VISIBLE TOKEN (the first `text_delta` frame —
 * the learner-visible moment), not first bytes off the wire. On a
 * reasoning-dominated model at medium effort real first-token latency is ~9–13s,
 * so the OLD buckets (good <1500 / ni <3000) measured against first BYTES (~50ms)
 * rated essentially every send "good" — vacuous. These wider buckets are honest
 * about the reasoning tail: good < 4s, needs-improvement < 12s, else poor.
 */
export function ttftRating(ms: number): "good" | "needs-improvement" | "poor" {
  if (ms < 4000) return "good";
  if (ms < 12000) return "needs-improvement";
  return "poor";
}

/* ──────────────── A3 Wave 4 · formative card scorers (pure) ───────────────── */

/** A `checkUnderstanding` card. */
type CheckUnderstandingCard = Extract<TutorAssessmentCard, { toolName: "checkUnderstanding" }>;
/** A `sequenceTask` card. */
type SequenceCard = Extract<TutorAssessmentCard, { toolName: "sequenceTask" }>;
/** A `fadedExample` card. */
type FadedExampleCard = Extract<TutorAssessmentCard, { toolName: "fadedExample" }>;
/** A `predictThenReveal` card. */
type PredictCard = Extract<TutorAssessmentCard, { toolName: "predictThenReveal" }>;
/** An `explainBack` card. */
type ExplainBackCard = Extract<TutorAssessmentCard, { toolName: "explainBack" }>;

/**
 * A3 Wave 4 (A3-13/§3) — grade a checkUnderstanding pick LOCALLY. The answer key
 * ships on the card (formative, low-stakes → the practiceItems precedent).
 *
 * - `demonstrated` iff the picked option is `correct`; feedback = a brief
 *   affirmation (the option's own `feedback`).
 * - else `not_demonstrated`, carrying THAT distractor's `misconceptionId` (the
 *   reasoning it names) + its `feedback` (which explains the misconception —
 *   never "the answer is X"; §3).
 *
 * An unknown / null `pickedOptionId` (no option matched) is treated as an
 * unanswered wrong: `not_demonstrated`, null misconception, empty feedback.
 */
export function scoreCheckUnderstanding(
  card: CheckUnderstandingCard,
  pickedOptionId: string | null,
): { outcome: "demonstrated" | "not_demonstrated"; misconceptionId: string | null; feedback: string } {
  const picked = pickedOptionId === null ? undefined : card.options.find((o) => o.id === pickedOptionId);
  if (!picked) {
    return { outcome: "not_demonstrated", misconceptionId: null, feedback: "" };
  }
  if (picked.correct) {
    return { outcome: "demonstrated", misconceptionId: null, feedback: picked.feedback };
  }
  return {
    outcome: "not_demonstrated",
    misconceptionId: picked.misconceptionId,
    feedback: picked.feedback,
  };
}

/**
 * A3 Wave 4 (A3-15) — score a sequenceTask ordering LOCALLY against the card's
 * `correctOrder` + `partialCreditRule`. MUST agree with the server twin's
 * semantics (each side owns its own copy).
 *
 * - `exact`: all positions equal ⇒ `demonstrated`, else `not_demonstrated`.
 *   `ratio` is 1 iff fully correct, else 0.
 * - `adjacent-pairs`: `ratio` = (# adjacent pairs in the submitted order whose two
 *   items are in the correct relative order) / (total adjacent pairs). A pair
 *   counts iff BOTH ids exist in `correctOrder` and the earlier-submitted one has
 *   the smaller correct index. `ratio ≥ 0.999` ⇒ `demonstrated`; `> 0` ⇒
 *   `partial`; else `not_demonstrated`.
 *
 * A length mismatch or an id not in `correctOrder` never throws — pairs with an
 * unknown id simply don't count as correctly ordered.
 */
export function scoreSequenceCard(
  card: SequenceCard,
  submittedOrder: string[],
): { outcome: TutorAssessmentOutcome; ratio: number } {
  const correct = card.correctOrder;

  if (card.partialCreditRule === "exact") {
    const allRight =
      submittedOrder.length === correct.length &&
      submittedOrder.every((id, i) => id === correct[i]);
    return { outcome: allRight ? "demonstrated" : "not_demonstrated", ratio: allRight ? 1 : 0 };
  }

  // adjacent-pairs
  const rank = new Map<string, number>();
  correct.forEach((id, i) => rank.set(id, i));

  const totalPairs = Math.max(0, submittedOrder.length - 1);
  if (totalPairs === 0) {
    // A 0- or 1-item ordering: trivially in order (there are no pairs to violate).
    return { outcome: "demonstrated", ratio: 1 };
  }

  let ordered = 0;
  for (let i = 0; i + 1 < submittedOrder.length; i++) {
    const a = rank.get(submittedOrder[i]);
    const b = rank.get(submittedOrder[i + 1]);
    if (a !== undefined && b !== undefined && a < b) ordered += 1;
  }
  const ratio = ordered / totalPairs;
  const outcome: TutorAssessmentOutcome =
    ratio >= 0.999 ? "demonstrated" : ratio > 0 ? "partial" : "not_demonstrated";
  return { outcome, ratio };
}

/**
 * A3 Wave 4 — a pure, seeded shuffle so a sequenceTask presents its items in a
 * stable NON-authored order (never the answer order, never `Math.random` in
 * render). A small LCG (Numerical Recipes constants) drives a Fisher–Yates pass;
 * the seed comes from `hashSeed(cardId)`, so the same card always shuffles the
 * same way (idempotent across re-renders / reloads). Returns a NEW array — never
 * mutates the input.
 */
export function shuffleDeterministic<T>(ids: readonly T[], seed: number): T[] {
  const out = ids.slice();
  // Fold the seed to a positive 32-bit state; a 0 state would freeze the LCG.
  let state = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    // LCG: state = (a·state + c) mod 2^32, then normalize to [0,1).
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** A stable 32-bit hash of a string (FNV-1a) — seeds `shuffleDeterministic` from
 *  a cardId so the presentation order is deterministic per card. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ──────────────── A3 Wave 5 · formative card scorers (pure) ───────────────── */

/** Normalize a free-text token for comparison: trim + lowercase (the practiceItems
 *  short-answer precedent). */
function normText(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * A3 Wave 5 (A3-16) — grade a `fadedExample` submission LOCALLY. The answer key
 * ships on the card (each blanked step carries its `answer`; formative,
 * low-stakes → the practiceItems precedent). Compares each BLANKED step's filled
 * input to its answer trim/lowercase; a non-blanked step is worked (never graded).
 *
 * - all blanks right → `demonstrated`
 * - some blanks right → `partial`
 * - none right → `not_demonstrated`
 * - a card with ZERO blanked steps (fadeLevel 0, fully worked) → `demonstrated`
 *   on acknowledge (there was nothing to fill — the learner read the worked example).
 *
 * `filledAnswers` is keyed by the step INDEX (into `card.steps`); a missing entry
 * for a blanked step is an empty (wrong) answer. Never throws.
 */
export function scoreFadedCard(
  card: FadedExampleCard,
  filledAnswers: Record<number, string>,
): { outcome: TutorAssessmentOutcome; correctCount: number; blankCount: number } {
  const blankIndexes: number[] = [];
  card.steps.forEach((step, i) => {
    if (step.blanked) blankIndexes.push(i);
  });
  const blankCount = blankIndexes.length;

  // Zero blanks (fully worked, fadeLevel 0) → demonstrated on acknowledge.
  if (blankCount === 0) {
    return { outcome: "demonstrated", correctCount: 0, blankCount: 0 };
  }

  let correctCount = 0;
  for (const i of blankIndexes) {
    const filled = normText(filledAnswers[i] ?? "");
    if (filled.length > 0 && filled === normText(card.steps[i].answer)) {
      correctCount += 1;
    }
  }

  const outcome: TutorAssessmentOutcome =
    correctCount === blankCount
      ? "demonstrated"
      : correctCount > 0
        ? "partial"
        : "not_demonstrated";
  return { outcome, correctCount, blankCount };
}

/**
 * A3 Wave 5 — grade a `predictThenReveal` committed prediction LOCALLY (formative;
 * the keys ride the card). The commit-before-reveal is the whole point — this is
 * called only AFTER the learner commits.
 *
 * - normalize the prediction (trim/lowercase). If it CONTAINS or EQUALS any
 *   `acceptedAnswer` (each normalized) → `demonstrated`, `matched: "accepted"`,
 *   null misconception, empty feedback.
 * - else the FIRST `nearMisses[i]` whose normalized `pattern` the prediction
 *   CONTAINS → `not_demonstrated`, `matched: "nearMiss"`, that `misconceptionId` +
 *   its `feedback`.
 * - else `not_demonstrated`, `matched: "none"`, null misconception, empty feedback.
 *
 * An empty `pattern` never matches (guards against a degenerate near-miss). Never
 * throws.
 */
export function scorePredictCard(
  card: PredictCard,
  prediction: string,
): {
  outcome: "demonstrated" | "not_demonstrated";
  misconceptionId: string | null;
  feedback: string;
  matched: "accepted" | "nearMiss" | "none";
} {
  const guess = normText(prediction);

  const accepted =
    guess.length > 0 &&
    card.acceptedAnswers.some((a) => {
      const key = normText(a);
      return key.length > 0 && guess.includes(key);
    });
  if (accepted) {
    return { outcome: "demonstrated", misconceptionId: null, feedback: "", matched: "accepted" };
  }

  for (const nm of card.nearMisses) {
    const pattern = normText(nm.pattern);
    if (pattern.length > 0 && guess.includes(pattern)) {
      return {
        outcome: "not_demonstrated",
        misconceptionId: nm.misconceptionId,
        feedback: nm.feedback,
        matched: "nearMiss",
      };
    }
  }

  return { outcome: "not_demonstrated", misconceptionId: null, feedback: "", matched: "none" };
}

/** One graded rubric criterion from the SERVER `explain_back_grade` response —
 *  `present` = the idea was found (never wording), `note` names why. */
export interface ExplainBackCriterionResult {
  criterion: string;
  present: boolean;
  note: string;
}

/** The view row `TutorExplainBackCard` renders per criterion. `met` drives the
 *  ✓ / ○ marker; `note` is the model's per-criterion note. There is deliberately
 *  NO pass/fail verdict field (A3-17): the learner sees criterion-level met/unmet
 *  only, never an overall grade. */
export interface ExplainBackCriterionView {
  criterion: string;
  met: boolean;
  note: string;
}

/**
 * A3 Wave 5 (A3-17) — the PURE map from the server's graded criteria to the view
 * rows the card renders. Each row carries `met` (the ✓/○ marker) + the note; the
 * function NEVER yields a pass/fail verdict string — the whole point of A3-17 is
 * that the learner sees criterion-level presence only, never an overall grade.
 * Exported so the client suite can assert the no-verdict guarantee directly.
 */
export function explainBackCriteriaView(
  criteria: ExplainBackCriterionResult[],
): ExplainBackCriterionView[] {
  return criteria.map((c) => ({
    criterion: c.criterion,
    met: c.present === true,
    note: typeof c.note === "string" ? c.note : "",
  }));
}

/** Referenced so the ExplainBackCard type is exported-in-spirit for the suite; a
 *  no-op that keeps the alias from being unused while documenting the card shape. */
export type { ExplainBackCard, FadedExampleCard, PredictCard };
