/**
 * TUTOR-1 Wave 3 (W3.5) — SESSION STATE, DERIVED FROM THREAD HISTORY (no storage).
 *
 * A "session" is not a stored entity: migrations are frozen this wave and
 * tutor_threads has no session column. Rather than persist session flags (which
 * are PER-REQUEST today and would be lost between turns), session state is
 * DERIVED — statelessly — from the thread's own turn history, so any turn can
 * reconstruct "what has happened this session" from the rows it already loads.
 *
 * ── THE SESSION DEFINITION (load-bearing — the checkpoint quotes this) ────────
 * A session is the TRAILING WINDOW of thread turns whose consecutive gaps are
 * EACH strictly less than SESSION_GAP_MS (30 minutes). Walking newest → oldest,
 * we keep including turns until we hit a gap ≥ 30 minutes; everything from that
 * boundary forward (inclusive of the newer side) is the current session. A gap
 * of EXACTLY 30 minutes STARTS A NEW SESSION (the boundary is `< 30min` to stay
 * in-session; `>= 30min` breaks it). A thread with one turn is a one-turn
 * session; an empty thread is an empty session.
 *
 * Consequences the behaviors below rely on:
 *   • Session membership is a function of TIMESTAMPS ONLY (createdAt), never of
 *     content — so it's deterministic and testable at the minute boundary.
 *   • "Once per session" means "within the current trailing < 30-min window":
 *     a 31-minute silence resets every once-per-session behavior.
 *
 * ── MARKERS (how a behavior remembers it fired this session) ──────────────────
 * A once-per-session behavior can't rely on request flags (they don't persist),
 * so it leaves a MARKER on the assistant turn it fired on: a string in that
 * turn's `grounding.sessionMarkers` array. The NEXT turn's derived state reads
 * the markers on this-session assistant turns and knows the behavior already
 * ran. The root-cause interjection marker is `ROOT_CAUSE_INTERJECTION_MARKER`.
 *
 * PURE — no IO, no clock of its own; `nowIso` is a seam the caller supplies.
 */

/** The maximum in-session gap between two consecutive turns. A gap `< this` keeps
 *  the pair in one session; a gap `>= this` (incl. EXACTLY 30 min) starts a new
 *  one. 30 minutes. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/** The marker a fired root-cause interjection stamps into the assistant turn's
 *  `grounding.sessionMarkers`. The next turn's derived state detects it. */
export const ROOT_CAUSE_INTERJECTION_MARKER = "root_cause_interjection";

/** The regex that recognizes a learner DECLINING an offered interjection. Narrow
 *  by design: only an explicit brush-off suppresses the (already-once) offer.
 *  Case-insensitive. */
export const INTERJECTION_DECLINE_RE = /no thanks|not now|skip|just answer|later/i;

/* ─────────────────────────────── inputs ─────────────────────────────────── */

/**
 * The minimal turn shape session derivation consumes. It EXTENDS the loop's
 * HistoryTurn with a REQUIRED `createdAt` (the session window is a time window)
 * and an OPTIONAL `grounding` (the marker store — assistant turns carry it). The
 * service's history loader maps these from the tutor_turns rows it already reads.
 */
export interface SessionTurn {
  role: "learner" | "assistant" | "instructor";
  content: string;
  /** ISO timestamp of the turn (tutor_turns.created_at). Required — the session
   *  window is defined over these. A missing/unparseable value sorts as epoch 0. */
  createdAt: string;
  /** The assistant turn's grounding jsonb (may hold `sessionMarkers`). */
  grounding?: unknown;
}

/* ─────────────────────────────── derived state ──────────────────────────── */

export interface SessionState {
  /** The trailing < 30-min window of turns (oldest → newest within the session). */
  sessionTurns: SessionTurn[];
  /** True iff an assistant turn IN THIS SESSION carries the root-cause marker —
   *  i.e. the interjection was already OFFERED this session. */
  interjectionOffered: boolean;
  /** True iff the interjection was offered AND the next learner turn declined it
   *  (matched INTERJECTION_DECLINE_RE). Suppresses re-offering for the session. */
  interjectionDeclined: boolean;
}

/** Parse an ISO timestamp to epoch ms; unparseable → 0 (sorts oldest). */
function epoch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Read the `sessionMarkers` string[] off a turn's grounding jsonb (defensive —
 *  any non-array / non-string content yields no markers). */
export function sessionMarkersOf(turn: SessionTurn): string[] {
  const g = turn.grounding;
  if (!g || typeof g !== "object") return [];
  const raw = (g as Record<string, unknown>).sessionMarkers;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

/**
 * Derive the current session's state from the FULL thread history (oldest →
 * newest, as the loop replays it) at wall-clock `nowIso`.
 *
 * The window walks newest → oldest, breaking at the FIRST gap ≥ SESSION_GAP_MS.
 * `nowIso` bounds the newest side: if the newest turn is itself ≥ 30 min old,
 * the current session is EMPTY (the learner has been silent past the threshold —
 * this turn, not yet in the array, opens a fresh session). That keeps a
 * once-per-session behavior firing again after a long silence even before the
 * new turn is persisted.
 */
export function deriveSessionState(turns: SessionTurn[], nowIso: string): SessionState {
  // Defensive stable sort oldest → newest by timestamp (ties keep input order).
  const sorted = [...turns]
    .map((t, i) => ({ t, i, ms: epoch(t.createdAt) }))
    .sort((a, b) => a.ms - b.ms || a.i - b.i)
    .map((x) => x.t);

  const now = epoch(nowIso);

  // Empty thread → empty session.
  if (sorted.length === 0) {
    return { sessionTurns: [], interjectionOffered: false, interjectionDeclined: false };
  }

  // If the newest turn is already ≥ 30 min behind `now`, the current session is
  // empty (a long silence; the upcoming turn opens a new session).
  const newest = sorted[sorted.length - 1];
  if (now - epoch(newest.createdAt) >= SESSION_GAP_MS) {
    return { sessionTurns: [], interjectionOffered: false, interjectionDeclined: false };
  }

  // Walk newest → oldest; stop at the first gap ≥ SESSION_GAP_MS.
  let start = sorted.length - 1;
  for (let i = sorted.length - 1; i > 0; i -= 1) {
    const gap = epoch(sorted[i].createdAt) - epoch(sorted[i - 1].createdAt);
    if (gap >= SESSION_GAP_MS) {
      start = i;
      break;
    }
    start = i - 1;
  }
  const sessionTurns = sorted.slice(start);

  // interjectionOffered: any assistant turn in-session carries the marker.
  let offeredIndex = -1;
  for (let i = 0; i < sessionTurns.length; i += 1) {
    const turn = sessionTurns[i];
    if (turn.role === "assistant" && sessionMarkersOf(turn).includes(ROOT_CAUSE_INTERJECTION_MARKER)) {
      offeredIndex = i;
      break;
    }
  }
  const interjectionOffered = offeredIndex >= 0;

  // interjectionDeclined: the FIRST learner turn AFTER the offer matches the
  // decline regex. (If they engaged instead, it's not declined.)
  let interjectionDeclined = false;
  if (offeredIndex >= 0) {
    for (let i = offeredIndex + 1; i < sessionTurns.length; i += 1) {
      if (sessionTurns[i].role === "learner") {
        interjectionDeclined = INTERJECTION_DECLINE_RE.test(sessionTurns[i].content);
        break;
      }
    }
  }

  return { sessionTurns, interjectionOffered, interjectionDeclined };
}

/* ─────────────────────────── interjection decision ──────────────────────── */

/**
 * Should THIS turn offer the root-cause interjection? (AC-T3.7 — fires EXACTLY
 * once per session; a decline suppresses it for the rest of the session.)
 *
 * True iff:
 *   • a root cause exists (rootCauseNodeId non-null), AND
 *   • the root cause is a REAL upstream gap distinct from the surface lesson
 *     (it isn't itself one of this lesson's own anchored nodes — offering to
 *     "check X first" only makes sense when X is upstream), AND
 *   • no interjection was offered this session, AND
 *   • it wasn't declined this session.
 *
 * The `lessonNodeIds` guard means a root cause that IS the current lesson's
 * concept never triggers the "check upstream first" offer (there's nothing
 * upstream to check).
 */
export function shouldInterjectRootCause(args: {
  sessionState: SessionState;
  rootCauseNodeId: string | null;
  lessonNodeIds: string[];
}): boolean {
  const { sessionState, rootCauseNodeId, lessonNodeIds } = args;
  if (!rootCauseNodeId) return false;
  if (lessonNodeIds.includes(rootCauseNodeId)) return false;
  if (sessionState.interjectionOffered) return false;
  if (sessionState.interjectionDeclined) return false;
  return true;
}
