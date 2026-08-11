"use client";

/**
 * TUTOR-1 — the learner tutor's SSE stream hook. Drives POST /api/learn/tutor
 * {action:'turn', …}, parses the `data: {json}\n\n` frame protocol, and exposes
 * a small transcript + status + send/retry/abort surface a sibling renders
 * against (components/learn/tutor/TutorBody.tsx builds on this — do not couple).
 *
 * Contract highlights:
 *  - HISTORY: loaded ONCE on mount via loadTutorHistory (the learner's own RLS
 *    through the browser client). `historyLoaded` flips true after the first
 *    load resolves (success or empty); a failure degrades to `[]`, never throws.
 *  - SEND: appends the learner turn OPTIMISTICALLY, flips status→sent, POSTs,
 *    reads res.body.getReader() with the SAME `\n\n` buffer mechanics as the
 *    editor's consumeStream (mirrored, NOT imported — that one fans into the
 *    agent store). The A2 streaming lifecycle drives the phases:
 *      send()          → "sent"       (the outgoing edge)
 *      model_started   → "thinking"   (reasoning begins)
 *      first text_delta→ "composing"  (prose is arriving; streamingText goes live)
 *      turn            → append the settled assistant turn + null streamingText
 *      queued          → "queued"     (waiting on the learner pool)
 *      error / aborted → "error"      (the optimistic learner turn STAYS → retry)
 *      done            → idle          (ONLY from a non-terminal phase — see below)
 *    All sent/thinking/composing applications go through ONE createPhaseFloor
 *    (reset per send) so each phase shows ≥PHASE_FLOOR_MS; queued/error/approval/
 *    idle apply IMMEDIATELY (an error must NEVER be held behind the floor).
 *  - STREAMING TEXT: text_delta frames accumulate into a buffer; `streamingText`
 *    becomes non-null (and grows) only ONCE the "composing" phase has APPLIED, so
 *    the indicator can't flicker away before the streaming bubble appears.
 *  - `done` AFTER `error`/`approval`: `done` returns to idle ONLY from a
 *    non-terminal phase (sent/thinking/composing/queued). A terminal error or
 *    approval status is PRESERVED across the trailing `done` (the route always
 *    emits `done` after `error`) — otherwise the error card would flash and
 *    vanish. (This is a live bug the pre-A2 hook had: `done` reset to idle
 *    unconditionally, wiping the just-set error.)
 *  - TTFT: performance.now() captured before the fetch; the vital fires ONCE per
 *    send on the FIRST `text_delta` (the learner-visible first token — the A2
 *    re-point; it used to fire on first bytes, which was vacuous).
 *  - RESUME: after history loads, a mount effect GETs /api/learn/tutor?courseId=…
 *    to rejoin a turn that completed server-side while disconnected (204 = nothing
 *    to resume). It consumes the SAME frame loop. A user send() aborts an in-flight
 *    resume (shared controllerRef).
 *  - ABORT: one AbortController per send/resume; abort() cancels + returns to idle.
 *    NO auto-reconnect — a dropped stream is an error the learner can retry.
 *
 * ZOD-FREE by house rule (learn route bundle): react + the client tutor types +
 * the browser supabase factory + the zod-free TTFT emitter + the pure phase floor.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  loadTutorHistory,
  type TutorHistoryTurn,
} from "@/lib/learn/tutorHistory";
import type {
  TutorSSEEvent,
  TutorTurnPayload,
} from "@/lib/learn/tutorClientTypes";
import { emitTutorTtft } from "@/lib/learn/tutorVitals";
import { createPhaseFloor, type PhaseFloor } from "@/lib/learn/phaseFloor";

/* ─────────────────────────────── public API ──────────────────────────────── */

/** One rendered transcript turn. Extends the history row with the live payload
 *  (present on assistant turns produced this session; history rows have none). */
export interface TutorChatTurn extends TutorHistoryTurn {
  payload?: TutorTurnPayload | null;
}

export type TutorStreamStatus =
  | { kind: "idle" }
  | { kind: "sent" }
  | { kind: "thinking" }
  | { kind: "composing" }
  | { kind: "queued"; position: number }
  | { kind: "approval"; toolName: string; message: string }
  | { kind: "error"; message: string };

/** The ambient lesson context a send carries (mirrors the route's turn body). */
export interface TutorSendAmbient {
  lessonId: string | null;
  blockId: string | null;
  slideId: string | null;
  quizActive: boolean;
}

/** A3 Wave 3 · the OPTIONAL provenance payload a send carries when — and ONLY
 *  when — the learner pressed an invitation button (deterministic; never
 *  inferred from typed text). All other sends omit the field entirely.
 *  Mirrors the route's `initiation` turn-body member. */
export interface TutorSendInitiation {
  kind: "invitation_accepted";
  toolName: string;
  nodeId: string;
}

export interface UseTutorStreamOptions {
  userId: string;
  courseId: string;
  publicationId: string;
  version: number;
  slug: string;
  /** A4 — the lesson the tutor is currently docked on (null on the course
   *  landing). Threads are lesson-scoped: history loads for THIS lesson's thread,
   *  and switching lessons reloads the new lesson's transcript (A4-2). */
  lessonId: string | null;
}

export interface UseTutorStreamResult {
  turns: TutorChatTurn[];
  status: TutorStreamStatus;
  /** The in-flight assistant answer text as it streams, or null when nothing is
   *  displayable (before "composing" applies, or after the turn settles/errors). */
  streamingText: string | null;
  historyLoaded: boolean;
  /** Send a learner message. `initiation` is present ONLY on an
   *  invitation-accept press (A3 Wave 3) — every other send omits it. */
  send: (
    message: string,
    ambient: TutorSendAmbient,
    initiation?: TutorSendInitiation,
  ) => void;
  retry: () => void;
  abort: () => void;
  /** A4-7 — "Start fresh": archive the current lesson thread (server-side, never
   *  deletes) and clear the transcript locally. The next send opens a new thread.
   *  This is the ONLY thread-reset path — it fires from an explicit control, never
   *  from navigation / refresh / tab lifecycle (A4-6). */
  startFresh: () => void;
}

/* ─────────────────────────────── internals ──────────────────────────────── */

const IDLE: TutorStreamStatus = { kind: "idle" };

/** The phases that flow through the display floor (the ≥400ms-dwell set). */
type FlooredPhase = "sent" | "thinking" | "composing";

/** Which status kinds are TERMINAL — a trailing `done` must never reset them to
 *  idle (the route emits `done` after `error`; approval must stay visible). */
function isTerminalStatus(status: TutorStreamStatus): boolean {
  return status.kind === "error" || status.kind === "approval";
}

/** A stable-enough client id for optimistic/assistant turns produced this
 *  session (history rows carry their DB row id). */
function localTurnId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Parse one `data: {json}\n\n` SSE frame into a TutorSSEEvent. The route emits
 *  `data: ` lines; a frame may also contain comment/heartbeat lines we ignore.
 *  Returns null for an unparseable / non-data frame (skipped, never thrown). */
function decodeTutorFrame(frame: string): TutorSSEEvent | null {
  const dataLines = frame
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (payload === "" || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as TutorSSEEvent;
  } catch {
    return null;
  }
}

/** Build the assistant transcript turn from a `turn` payload — content is the
 *  cleaned prose; grounding mirrors the history row's grounding shape so the
 *  renderer treats live and historical assistant turns identically. */
function assistantTurnFromPayload(payload: TutorTurnPayload): TutorChatTurn {
  return {
    id: localTurnId(),
    role: "assistant",
    content: payload.prose,
    createdAt: new Date().toISOString(),
    grounding: {
      citations: payload.citations,
      spans: payload.spans,
      flags: payload.flags,
      rung: payload.rung,
      // A3 Wave 3 — mirror the settled invitation onto the grounding shape so
      // live and history assistant turns render identically (`?? null` tolerates
      // a pre-A3 payload that doesn't carry the field yet).
      invitation: payload.invitation ?? null,
      // A3 Wave 4 — mirror the settled structures/assessments (like practiceItems)
      // so a live turn renders them; `?? []` tolerates a pre-A3-Wave-4 payload.
      structures: payload.structures ?? [],
      assessments: payload.assessments ?? [],
    },
    payload,
  };
}

/* ──────────────────────────── the pure frame reducer ─────────────────────── */

/**
 * The callbacks `processTutorFrame` fires — a small semantic surface the React
 * hook (and the pure suite) wire against. Keeping the switch pure + callback-based
 * means the SAME frame handling drives BOTH send and resume, and the suite can
 * script a frame sequence with no React at all.
 *
 * Phase governance lives OUTSIDE this reducer: `phase` proposes a floored phase
 * (sent/thinking/composing) through the caller's phase floor; `status` applies an
 * immediate (non-floored) status. This split is why an error can't be held behind
 * the display floor.
 */
export interface TutorFrameCallbacks {
  /** Propose a floored display phase (goes through the phase floor). */
  phase: (phase: FlooredPhase) => void;
  /** Apply an immediate status (queued/error/approval) — bypasses the floor. */
  status: (status: TutorStreamStatus) => void;
  /** Fire the TTFT vital ONCE per turn, on the first visible token. */
  markFirstToken: () => void;
  /** A text_delta arrived — append its delta to the streaming buffer. */
  appendText: (delta: string) => void;
  /** The settled `turn` frame — append the assistant turn + null streamingText. */
  settleTurn: (payload: TutorTurnPayload) => void;
  /** A terminal frame (turn_aborted, or the trailing bookkeeping after error) —
   *  null the streaming text (the error card / settled bubble takes over). */
  clearStreamingText: () => void;
  /** `done` — return to idle, but ONLY from a non-terminal phase (the caller
   *  guards this against a preceding error/approval). */
  finishIdle: () => void;
}

/**
 * Handle ONE decoded wire frame against the callback surface. Pure w.r.t. React —
 * every effect is a callback. Shared VERBATIM by send + resume so their frame
 * semantics can never drift.
 */
export function processTutorFrame(
  ev: TutorSSEEvent,
  cb: TutorFrameCallbacks,
): void {
  switch (ev.type) {
    case "turn_started":
      // The turn is open on the wire; the "sent" phase is already showing (send()
      // set it). Resume also lands here first — treat it as the "sent" phase.
      cb.phase("sent");
      break;
    case "model_started":
      // Reasoning has begun.
      cb.phase("thinking");
      break;
    case "first_token":
      // Server-stamped first-token marker. The learner-visible transition is the
      // first text_delta below; first_token alone advances the phase (a turn with
      // no prose deltas still shows "composing" briefly before it settles).
      cb.phase("composing");
      break;
    case "text_delta":
      // The FIRST visible token: fire TTFT + advance to "composing"; then buffer.
      cb.markFirstToken();
      cb.phase("composing");
      cb.appendText(ev.delta);
      break;
    case "queued":
      cb.status({ kind: "queued", position: ev.position });
      break;
    case "turn":
      cb.settleTurn(ev.payload);
      break;
    case "turn_completed":
      // Lifecycle bookkeeping — the `turn` frame already settled the bubble. No UI
      // change (usage is telemetry the client doesn't render here).
      break;
    case "turn_aborted":
      // The turn was cut short server-side; drop any partial streaming text (the
      // error frame that precedes it owns the message).
      cb.clearStreamingText();
      break;
    case "approval_required":
      cb.status({ kind: "approval", toolName: ev.toolName, message: ev.message });
      cb.clearStreamingText();
      break;
    case "error":
      // Keep the optimistic learner turn so retry() can re-send. Partial streamed
      // text is NOT kept — the completed turn persists server-side and lands in
      // history on resume/reload; the error card takes the screen.
      cb.status({ kind: "error", message: ev.message });
      cb.clearStreamingText();
      break;
    case "done":
      cb.finishIdle();
      break;
  }
}

/* ──────────────────────────────── the hook ──────────────────────────────── */

export function useTutorStream(
  opts: UseTutorStreamOptions
): UseTutorStreamResult {
  const { userId, courseId, publicationId, version, lessonId } = opts;

  const [turns, setTurns] = useState<TutorChatTurn[]>([]);
  const [status, setStatus] = useState<TutorStreamStatus>(IDLE);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // The in-flight send/resume abort controller (one stream at a time).
  const controllerRef = useRef<AbortController | null>(null);
  // The last learner send (message + ambient + any initiation) so retry() can
  // re-fire it faithfully (a retried invitation-accept stays an accept).
  const lastSendRef = useRef<{
    message: string;
    ambient: TutorSendAmbient;
    initiation?: TutorSendInitiation;
  } | null>(null);
  // The display-phase floor for the CURRENT stream (reset per send/resume).
  const floorRef = useRef<PhaseFloor<FlooredPhase> | null>(null);
  // The accumulated in-flight answer text (buffer). `composing` gates its DISPLAY.
  const textBufferRef = useRef<string>("");
  // Whether the "composing" phase has APPLIED yet — text is displayed only after.
  const composingAppliedRef = useRef<boolean>(false);
  // Guard: only ONE resume attempt per mount.
  const resumeTriedRef = useRef<boolean>(false);
  // The dangling-question re-load timer handle (cancelled on unmount/send).
  const danglingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── build the shared frame-callback surface for a stream run ──
   *
   * A fresh phase floor per run; `status` bypasses the floor; a floored phase
   * proposal flushes into setStatus AND (for composing) flips streamingText live.
   * `finishIdle` uses a status updater that respects the terminal-status guard.
   * `ttft` wires the vital ONCE per run on the first visible token (a resume passes
   * emit:false — its turn's TTFT was recorded on the original send). */
  const makeCallbacks = useCallback(
    (ttft: { emit: boolean; startedAt: number }): TutorFrameCallbacks => {
      const floor = createPhaseFloor<FlooredPhase>();
      floorRef.current = floor;
      textBufferRef.current = "";
      composingAppliedRef.current = false;
      let ttftFired = false;

      const applyFlooredPhase = (phase: FlooredPhase) => {
        // The floor governs WHEN a floored phase takes the screen. On "composing"
        // going live, mark it applied and reveal whatever text has buffered so far
        // (the buffer keeps accumulating meanwhile via appendText).
        setStatus({ kind: phase });
        if (phase === "composing") {
          composingAppliedRef.current = true;
          setStreamingText(textBufferRef.current.length > 0 ? textBufferRef.current : "");
        }
      };

      return {
        phase: (phase) => floor.propose(phase, applyFlooredPhase),
        status: (next) => {
          // An immediate status (queued/error/approval) wins the screen NOW —
          // cancel any held floored phase so a late thinking/composing flush can't
          // clobber an error the learner is reading.
          floor.reset();
          setStatus(next);
        },
        markFirstToken: () => {
          if (ttftFired || !ttft.emit) return;
          ttftFired = true;
          const now =
            typeof performance !== "undefined" ? performance.now() : Date.now();
          emitTutorTtft(now - ttft.startedAt);
        },
        appendText: (delta) => {
          textBufferRef.current += delta;
          // Only grow the DISPLAYED text once composing has applied; otherwise the
          // buffer accumulates silently until the floor releases composing.
          if (composingAppliedRef.current) {
            setStreamingText(textBufferRef.current);
          }
        },
        settleTurn: (payload) => {
          // Append the settled bubble AND null the streaming one in the same cycle
          // so there's no duplicate/flash (the settled turn replaces the streaming
          // one).
          floor.reset();
          setTurns((prev) => [...prev, assistantTurnFromPayload(payload)]);
          setStreamingText(null);
        },
        clearStreamingText: () => setStreamingText(null),
        finishIdle: () => {
          floor.reset();
          // `done` returns to idle ONLY from a non-terminal phase. A terminal error
          // / approval status set earlier in THIS stream must survive the trailing
          // `done` (the route always emits `done` after `error`).
          setStatus((prev) => (isTerminalStatus(prev) ? prev : IDLE));
        },
      };
    },
    []
  );

  /* ── consume an SSE body with the house `\n\n` frame-split mechanics ──
   *
   * Shared by send (POST body) and resume (GET body). TTFT fires on the first
   * text_delta via the callbacks' markFirstToken (per-run once-guard inside
   * makeCallbacks). */
  const consumeStream = useCallback(
    async (
      body: ReadableStream<Uint8Array>,
      controller: AbortController,
      opts2: { emitTtft: boolean; startedAt: number },
    ): Promise<void> => {
      const cb = makeCallbacks({ emit: opts2.emitTtft, startedAt: opts2.startedAt });

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const ev = decodeTutorFrame(frame);
            if (!ev) continue;
            processTutorFrame(ev, cb);
          }
        }
      } catch {
        // Abort is silent (abort() already settled the UI); a genuine drop errors.
        if (!controller.signal.aborted) {
          floorRef.current?.reset();
          setStatus({ kind: "error", message: "The tutor stream was interrupted." });
          setStreamingText(null);
        }
      }
    },
    [makeCallbacks]
  );

  /* ── history: load for the CURRENT lesson's thread (A4) ── */
  const loadHistory = useCallback(async (): Promise<TutorChatTurn[]> => {
    const supabase = createClient();
    const history = await loadTutorHistory(supabase, userId, courseId, lessonId);
    return history.map((row): TutorChatTurn => ({ ...row, payload: null }));
  }, [userId, courseId, lessonId]);

  // A4-2 — load history for the docked lesson, and RELOAD when the learner
  // switches lessons (the persistent mount survives navigation). A lesson switch
  // cancels any in-flight stream + clears transient state and shows the NEW
  // lesson's thread. This is NOT a thread reset — the old thread is untouched
  // (A4-6: navigation never archives/deletes a thread).
  const prevLessonRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const switched = prevLessonRef.current !== undefined && prevLessonRef.current !== lessonId;
    prevLessonRef.current = lessonId;
    if (switched) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      floorRef.current?.reset();
      setStreamingText(null);
      setStatus(IDLE);
      setHistoryLoaded(false);
    }
    loadHistory()
      .then((rows) => {
        if (!cancelled) setTurns(rows);
      })
      .catch(() => {
        /* degrade to whatever is already rendered (usually []) */
      })
      .finally(() => {
        if (!cancelled) setHistoryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadHistory, lessonId]);

  /* ── dangling-question fallback: schedule ONE delayed history re-load ──
   *
   * After a resume finds nothing (204) or errors, the LAST history turn may be a
   * learner question whose answer completed BETWEEN persistence and the resume
   * buffer's TTL (so there's no active stream to rejoin, but the answer IS in the
   * DB). Re-load history once, ~3s later, so that completed answer appears. */
  const scheduleDanglingReload = useCallback(() => {
    if (danglingTimerRef.current !== null) return;
    // The caller (maybeScheduleDangling) only invokes this when the tail is an
    // unanswered learner turn; here we just arm the one delayed re-load.
    danglingTimerRef.current = setTimeout(() => {
      danglingTimerRef.current = null;
      loadHistory()
        .then((rows) => setTurns(rows))
        .catch(() => {});
    }, 3000);
  }, [loadHistory]);

  /* ── resume: after history loads, rejoin a turn that ran on server-side ── */
  useEffect(() => {
    if (!historyLoaded || resumeTriedRef.current) return;
    resumeTriedRef.current = true;

    let disposed = false;
    const controller = new AbortController();
    // Only claim the shared controller if no send is already in flight.
    if (!controllerRef.current) controllerRef.current = controller;

    (async () => {
      let res: Response;
      try {
        res = await fetch(`/api/learn/tutor?courseId=${encodeURIComponent(courseId)}`, {
          method: "GET",
          signal: controller.signal,
        });
      } catch {
        if (!controller.signal.aborted && !disposed) maybeScheduleDangling();
        if (controllerRef.current === controller) controllerRef.current = null;
        return;
      }

      // 204 = nothing to resume; 401/403 = auth (nothing); any non-2xx → nothing.
      if (res.status === 204 || !res.ok || !res.body) {
        if (controllerRef.current === controller) controllerRef.current = null;
        if (!disposed) maybeScheduleDangling();
        return;
      }
      // A user send() may have started meanwhile — don't consume a stale resume.
      if (controllerRef.current !== controller) return;
      await consumeStream(res.body, controller, { emitTtft: false, startedAt: 0 });
      if (controllerRef.current === controller) controllerRef.current = null;
    })();

    /** Schedule the dangling re-load ONLY when the transcript tail is an
     *  unanswered learner turn (a question with no following assistant answer). */
    function maybeScheduleDangling() {
      setTurns((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "learner") scheduleDanglingReload();
        return prev;
      });
    }

    return () => {
      disposed = true;
    };
  }, [historyLoaded, courseId, consumeStream, scheduleDanglingReload]);

  /* ── the core send: optimistic learner turn → POST → consume the stream ── */
  const runSend = useCallback(
    async (
      message: string,
      ambient: TutorSendAmbient,
      initiation?: TutorSendInitiation,
    ): Promise<void> => {
      const trimmed = message.trim();
      if (!trimmed) return;

      // A send supersedes any in-flight resume/send AND any pending dangling reload.
      controllerRef.current?.abort();
      if (danglingTimerRef.current !== null) {
        clearTimeout(danglingTimerRef.current);
        danglingTimerRef.current = null;
      }
      const controller = new AbortController();
      controllerRef.current = controller;
      lastSendRef.current = { message: trimmed, ambient, initiation };

      // Optimistic learner turn — it STAYS on error (retry re-sends).
      const learnerTurn: TutorChatTurn = {
        id: localTurnId(),
        role: "learner",
        content: trimmed,
        createdAt: new Date().toISOString(),
        grounding: null,
        payload: null,
      };
      setTurns((prev) => [...prev, learnerTurn]);
      setStreamingText(null);
      // "sent" is the outgoing edge (goes through the fresh per-run floor inside
      // consumeStream via turn_started; set it here immediately so the UI reacts
      // the instant the learner hits send).
      setStatus({ kind: "sent" });

      // TTFT: mark the outgoing edge; the vital fires ONCE on the first text_delta.
      const startedAt =
        typeof performance !== "undefined" ? performance.now() : Date.now();

      let res: Response;
      try {
        res = await fetch("/api/learn/tutor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "turn",
            courseId,
            publicationId,
            version,
            lessonId: ambient.lessonId,
            blockId: ambient.blockId,
            slideId: ambient.slideId,
            message: trimmed,
            quizActive: ambient.quizActive,
            // A3 Wave 3 — the field rides ONLY on an invitation-accept press;
            // every other send omits it entirely (deterministic provenance).
            ...(initiation ? { initiation } : {}),
          }),
          signal: controller.signal,
        });
      } catch {
        if (controllerRef.current === controller) controllerRef.current = null;
        // A deliberate abort isn't an error to surface.
        if (controller.signal.aborted) return;
        setStatus({ kind: "error", message: "Couldn't reach the tutor — check your connection." });
        return;
      }

      if (!res.ok || !res.body) {
        if (controllerRef.current === controller) controllerRef.current = null;
        setStatus({ kind: "error", message: `The tutor returned an error (${res.status}).` });
        return;
      }

      await consumeStream(res.body, controller, { emitTtft: true, startedAt });
      if (controllerRef.current === controller) controllerRef.current = null;
    },
    [courseId, publicationId, version, consumeStream]
  );

  const send = useCallback(
    (message: string, ambient: TutorSendAmbient, initiation?: TutorSendInitiation) => {
      void runSend(message, ambient, initiation);
    },
    [runSend]
  );

  /** Re-send the last learner message + ambient (after an error). No-op if
   *  nothing has been sent yet. The failed learner turn already sits in the
   *  transcript, so retry does NOT append a second copy — it drops the last
   *  optimistic learner turn (runSend re-appends it) so a retry never doubles the
   *  learner's message in the transcript. */
  const retry = useCallback(() => {
    const last = lastSendRef.current;
    if (!last) return;
    setTurns((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === "learner") return [...prev.slice(0, i), ...prev.slice(i + 1)];
      }
      return prev;
    });
    void runSend(last.message, last.ambient, last.initiation);
  }, [runSend]);

  /** Cancel the in-flight send/resume and return to idle. No auto-reconnect. */
  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    floorRef.current?.reset();
    setStreamingText(null);
    setStatus(IDLE);
  }, []);

  /** A4-7 · "Start fresh": archive the current lesson thread server-side (never
   *  deletes — the archived thread stays queryable) and clear the transcript
   *  locally, so the next send opens a brand-new thread for this lesson. Cancels
   *  any in-flight stream + pending dangling reload first. Best-effort on the
   *  archive POST — even if it fails, the local reset stands and the next send
   *  still lands on the (unchanged) active thread. This fires ONLY from the
   *  explicit header control — never from navigation/refresh/tab lifecycle. */
  const startFresh = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (danglingTimerRef.current !== null) {
      clearTimeout(danglingTimerRef.current);
      danglingTimerRef.current = null;
    }
    floorRef.current?.reset();
    lastSendRef.current = null;
    setTurns([]);
    setStreamingText(null);
    setStatus(IDLE);
    void fetch("/api/learn/tutor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "archive_thread",
        courseId,
        publicationId,
        version,
        lessonId,
      }),
    }).catch(() => {
      /* best-effort — the local reset stands regardless */
    });
  }, [courseId, publicationId, version, lessonId]);

  // Abort any in-flight stream on unmount so a settle can't fire post-teardown,
  // and cancel the phase floor + the dangling reload timer.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      floorRef.current?.reset();
      if (danglingTimerRef.current !== null) {
        clearTimeout(danglingTimerRef.current);
        danglingTimerRef.current = null;
      }
    };
  }, []);

  return { turns, status, streamingText, historyLoaded, send, retry, abort, startFresh };
}
