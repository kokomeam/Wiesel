/**
 * TUTOR-1 W3.3 — conversation history (layer L4) under the tutor
 * historyPolicy: BOUNDED, drop-oldest-whole-turns replay from tutor_turns.
 *
 * When TUTOR_ENABLE_CHAINING is on (P-3 — default OFF; the flag is read at
 * CALL time so tests can flip it), L4 collapses to the provider's
 * `previousResponseId` instead of a textual replay: the prior turn's stored
 * response_id carries the conversation server-side. Foreground turns ship
 * store:false while the flag is off — the flag is the ONE switch.
 */

export interface HistoryTurn {
  role: "learner" | "assistant" | "instructor";
  content: string;
  responseId?: string | null;
  /** The tutor_turns row id. OPTIONAL (the textual replay ignores it) — the
   *  service uses it to drop the just-written learner row from the replay BY
   *  ID, never a blind positional drop (A3/D-6). */
  id?: string;
  /** ISO timestamp of the turn (tutor_turns.created_at). OPTIONAL here (the
   *  textual replay doesn't need it), but the SESSION derivation (session.ts)
   *  does — the service maps it from the row. */
  createdAt?: string;
  /** The assistant turn's grounding jsonb (holds `sessionMarkers`, read by the
   *  session-state derivation) — the service loader also INJECTS the dedicated
   *  `rung` COLUMN into this object at load time (the DB jsonb never stores
   *  rung; the table is immutable). OPTIONAL; assistant rows carry the real
   *  payload. */
  grounding?: unknown;
}

/**
 * FROZEN (A3/D-6) — appended to a Learner history line whose question never
 * received a delivered tutor reply (the next turn is not assistant/instructor,
 * or the line ends the replay). L0's "THE CURRENT MESSAGE" section names these
 * bytes verbatim — never change one without the other.
 */
export const DANGLING_LEARNER_MARKER = " [no tutor reply was delivered]";

/** Hard turn cap regardless of budget — a marathon thread replays its tail. */
export const HISTORY_MAX_TURNS = 12;

/**
 * Serialize the thread tail for L4: at most HISTORY_MAX_TURNS turns AND at
 * most `budgetChars` characters, dropping OLDEST WHOLE TURNS first (never a
 * mid-turn truncation — a half-replayed turn misleads the model more than a
 * missing one). Deterministic.
 *
 * A3/D-6 replay framing: a Learner line whose NEXT turn is not an
 * assistant/instructor reply (including a trailing learner line) is a
 * visibly-unanswered question — it gets the frozen DANGLING_LEARNER_MARKER so
 * the model sees it went unanswered instead of treating it as the live request.
 */
export function serializeHistory(turns: HistoryTurn[], budgetChars: number): string {
  const tail = turns.slice(-HISTORY_MAX_TURNS);
  const lines = tail.map((t, i) => {
    const name = t.role === "learner" ? "Learner" : t.role === "instructor" ? "Instructor" : "Tutor";
    const next = tail[i + 1];
    const dangling =
      t.role === "learner" && (!next || (next.role !== "assistant" && next.role !== "instructor"));
    return `${name}: ${t.content}${dangling ? DANGLING_LEARNER_MARKER : ""}`;
  });
  // Drop oldest whole turns until the join fits the budget.
  let start = 0;
  while (start < lines.length && lines.slice(start).join("\n\n").length > budgetChars) {
    start += 1;
  }
  return lines.slice(start).join("\n\n");
}

/** TUTOR_ENABLE_CHAINING, read at CALL time (default OFF — P-3 pending). */
export function chainingEnabled(): boolean {
  return process.env.TUTOR_ENABLE_CHAINING === "true";
}

/**
 * When chaining is enabled AND the last assistant turn stored a provider
 * response id, L4 collapses to that id (the caller sends previousResponseId
 * and omits the textual replay). Null otherwise — the textual path stands.
 */
export function collapseToChaining(turns: HistoryTurn[]): { previousResponseId: string } | null {
  if (!chainingEnabled()) return null;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t.role === "assistant") {
      return t.responseId ? { previousResponseId: t.responseId } : null;
    }
  }
  return null;
}
