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
 */

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
