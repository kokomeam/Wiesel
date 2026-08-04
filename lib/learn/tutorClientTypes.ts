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
  flags: string[];
}

/** The SSE event stream from /api/learn/tutor. Mirrors the route's own
 *  `TutorSSEEvent` union. */
export type TutorSSEEvent =
  | { type: "queued"; position: number }
  | { type: "turn"; payload: TutorTurnPayload }
  | { type: "error"; message: string }
  | { type: "done" };

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
 * Bucket a time-to-first-token latency (ms) into a coarse rating: `good` (<1500),
 * `needs-improvement` (<3000), else `poor`.
 */
export function ttftRating(ms: number): "good" | "needs-improvement" | "poor" {
  if (ms < 1500) return "good";
  if (ms < 3000) return "needs-improvement";
  return "poor";
}
