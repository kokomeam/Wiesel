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
 *  - SEND: appends the learner turn OPTIMISTICALLY, flips status→thinking, POSTs,
 *    reads res.body.getReader() with the SAME `\n\n` buffer mechanics as the
 *    editor's consumeStream (mirrored, NOT imported — that one fans into the
 *    agent store). `queued`→status queued; `turn`→append an assistant turn built
 *    from the payload; `error`→status error (the optimistic learner turn STAYS,
 *    so retry() can re-send); `done`→idle.
 *  - TTFT: performance.now() captured before the fetch; on the FIRST frame read
 *    the emitter fires ONCE per send (the tutor time-to-first-frame vital).
 *  - ABORT: one AbortController per send; abort() cancels + returns to idle. NO
 *    auto-reconnect — a dropped stream is an error the learner can retry.
 *
 * ZOD-FREE by house rule (learn route bundle): react + the client tutor types +
 * the browser supabase factory + the zod-free TTFT emitter only.
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

/* ─────────────────────────────── public API ──────────────────────────────── */

/** One rendered transcript turn. Extends the history row with the live payload
 *  (present on assistant turns produced this session; history rows have none). */
export interface TutorChatTurn extends TutorHistoryTurn {
  payload?: TutorTurnPayload | null;
}

export type TutorStreamStatus =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "queued"; position: number }
  | { kind: "error"; message: string };

/** The ambient lesson context a send carries (mirrors the route's turn body). */
export interface TutorSendAmbient {
  lessonId: string | null;
  blockId: string | null;
  slideId: string | null;
  quizActive: boolean;
}

export interface UseTutorStreamOptions {
  userId: string;
  courseId: string;
  publicationId: string;
  version: number;
  slug: string;
}

export interface UseTutorStreamResult {
  turns: TutorChatTurn[];
  status: TutorStreamStatus;
  historyLoaded: boolean;
  send: (message: string, ambient: TutorSendAmbient) => void;
  retry: () => void;
  abort: () => void;
}

/* ─────────────────────────────── internals ──────────────────────────────── */

const IDLE: TutorStreamStatus = { kind: "idle" };

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
    },
    payload,
  };
}

/* ──────────────────────────────── the hook ──────────────────────────────── */

export function useTutorStream(
  opts: UseTutorStreamOptions
): UseTutorStreamResult {
  const { userId, courseId, publicationId, version } = opts;

  const [turns, setTurns] = useState<TutorChatTurn[]>([]);
  const [status, setStatus] = useState<TutorStreamStatus>(IDLE);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // The in-flight send's abort controller (one send at a time).
  const controllerRef = useRef<AbortController | null>(null);
  // The last learner send (message + ambient) so retry() can re-fire it.
  const lastSendRef = useRef<{ message: string; ambient: TutorSendAmbient } | null>(
    null
  );

  /* ── history: load once on mount ── */
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    loadTutorHistory(supabase, userId, courseId)
      .then((history) => {
        if (cancelled) return;
        // History rows have no live payload; render them as chat turns as-is.
        setTurns(history.map((row): TutorChatTurn => ({ ...row, payload: null })));
      })
      .finally(() => {
        if (!cancelled) setHistoryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, courseId]);

  /* ── the core send: optimistic learner turn → POST → consume the stream ── */
  const runSend = useCallback(
    async (message: string, ambient: TutorSendAmbient): Promise<void> => {
      const trimmed = message.trim();
      if (!trimmed) return;

      // Cancel any in-flight send before starting a new one.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      lastSendRef.current = { message: trimmed, ambient };

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
      setStatus({ kind: "thinking" });

      // TTFT: mark the outgoing edge; fire the vital ONCE on the first frame.
      const startedAt =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      let ttftFired = false;
      const markFirstFrame = () => {
        if (ttftFired) return;
        ttftFired = true;
        const now =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        emitTutorTtft(now - startedAt);
      };

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
          }),
          signal: controller.signal,
        });
      } catch {
        controllerRef.current = null;
        // A deliberate abort isn't an error to surface.
        if (controller.signal.aborted) return;
        setStatus({ kind: "error", message: "Couldn't reach the tutor — check your connection." });
        return;
      }

      if (!res.ok || !res.body) {
        controllerRef.current = null;
        setStatus({ kind: "error", message: `The tutor returned an error (${res.status}).` });
        return;
      }

      // Consume the SSE body with the house `\n\n` frame-split mechanics
      // (mirrored from components/editor/agent/useAgentStream.ts consumeStream).
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          markFirstFrame(); // first bytes off the wire = time-to-first-frame
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const ev = decodeTutorFrame(frame);
            if (!ev) continue;
            switch (ev.type) {
              case "queued":
                setStatus({ kind: "queued", position: ev.position });
                break;
              case "turn":
                setTurns((prev) => [...prev, assistantTurnFromPayload(ev.payload)]);
                break;
              case "error":
                // Keep the optimistic learner turn so retry() can re-send.
                setStatus({ kind: "error", message: ev.message });
                break;
              case "done":
                setStatus(IDLE);
                break;
            }
          }
        }
      } catch {
        // Abort is silent (abort() already settled the UI); a genuine drop errors.
        if (!controller.signal.aborted) {
          setStatus({ kind: "error", message: "The tutor stream was interrupted." });
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [courseId, publicationId, version]
  );

  const send = useCallback(
    (message: string, ambient: TutorSendAmbient) => {
      void runSend(message, ambient);
    },
    [runSend]
  );

  /** Re-send the last learner message + ambient (after an error). No-op if
   *  nothing has been sent yet. The failed learner turn already sits in the
   *  transcript, so retry does NOT append a second copy — it re-runs the send
   *  loop against the existing optimistic turn. */
  const retry = useCallback(() => {
    const last = lastSendRef.current;
    if (!last) return;
    // Drop the last optimistic learner turn (runSend re-appends it) so a retry
    // never doubles the learner's message in the transcript.
    setTurns((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === "learner") return [...prev.slice(0, i), ...prev.slice(i + 1)];
      }
      return prev;
    });
    void runSend(last.message, last.ambient);
  }, [runSend]);

  /** Cancel the in-flight send and return to idle. No auto-reconnect. */
  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus(IDLE);
  }, []);

  // Abort any in-flight send on unmount so a settle can't fire post-teardown.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  return { turns, status, historyLoaded, send, retry, abort };
}
