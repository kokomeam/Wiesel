"use client";

/**
 * Drives the docked agent: POST /api/ai/agent, parse the normalized SSE event
 * protocol, and fan it into the agentStore (chat transcript + tool cards +
 * pending-block highlights).
 *
 * Two cross-cutting behaviors wrap every run:
 *  - ABORT: each run carries an AbortController; `stop()` aborts the request. The
 *    server checks the connection signal between tool turns, flushes whatever it
 *    built (flush-on-exit), and returns — so a stopped run keeps its staged work.
 *  - LIVE RENDER: while a run streams, autosave pauses (`agentRunActive`) and the
 *    editor re-syncs from the DB on each mutating event (`scheduleLiveSync`), so
 *    the deck fills in as the agent authors it. The authoritative `router.refresh`
 *    runs once at the end.
 *
 * Also exposes accept/reject for a change-set.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { decodeSSE, type AgentEvent } from "@/lib/ai/events";
import { useEditorStore } from "@/lib/course/store";
import { useAgentStore } from "@/lib/editor/agentStore";
import { cancelLiveSync, scheduleLiveSync } from "@/lib/editor/liveSync";

/** Coalesce assistant_delta frames (PERF-1 D5, diagnosis A5 §2.2): tokens arrive
 *  far faster than paint, and each appendAssistant rebuilds the messages array —
 *  a full transcript render per token. Buffer deltas and flush at most once per
 *  animation frame (a 50ms timer backs it up — hidden tabs starve rAF, a known
 *  repo lesson) as ONE appendAssistant call. Every NON-delta event flushes
 *  synchronously first, so store ordering — settle semantics included — is
 *  identical to the unbatched protocol. One docked panel runs one stream at a
 *  time, so a module-level singleton is safe. */
const deltaBatch = {
  buf: "",
  raf: null as number | null,
  timer: null as ReturnType<typeof setTimeout> | null,
  push(text: string) {
    this.buf += text;
    if (this.raf !== null || this.timer !== null) return;
    this.raf = requestAnimationFrame(() => this.flush());
    this.timer = setTimeout(() => this.flush(), 50);
  },
  flush() {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buf) return;
    const text = this.buf;
    this.buf = "";
    const s = useAgentStore.getState();
    s.markEvent();
    s.appendAssistant(text);
  },
};

function dispatch(ev: AgentEvent): boolean {
  if (ev.type === "assistant_delta") {
    deltaBatch.push(ev.text);
    return false;
  }
  // Buffered text must land BEFORE any other event's effect (a settle that runs
  // ahead of its own deltas would strand them in a new streaming bubble).
  deltaBatch.flush();
  const s = useAgentStore.getState();
  // Heartbeat: stamp every event's arrival so the StatusStrip can soften its
  // copy during long SSE silences (non-streaming plan calls can be quiet 30s+).
  s.markEvent();
  switch (ev.type) {
    case "conversation":
      s.setConversation(ev.conversationId);
      return false;
    case "tool_start":
      s.addToolStart(ev.toolCallId, ev.tool);
      return false;
    case "tool_result":
      s.resolveTool(ev.toolCallId, ev.ok, ev.summary, ev.blockId);
      return true;
    case "phase":
      // `critique_skipped` is informational (legacy critique disabled) — clear the
      // indicator; the next assistant_message/done settles the run. `detail`
      // carries per-lesson progress ("Linked lists (2/4)") for the StatusStrip.
      if (ev.phase === "critique_skipped") s.setPhase(null);
      else s.setPhase(ev.phase, ev.detail ?? null);
      return false;
    case "validation":
      s.setValidation({ message: ev.message, ok: ev.ok, incomplete: ev.incomplete });
      return false;
    case "quality_report":
      s.setQualityReport({ warnings: ev.warnings, suggestions: ev.suggestions });
      return false;
    case "plan_outline":
      s.setPendingOutline(ev.plan);
      return false;
    case "confirmation_request":
      s.setPendingConfirmation({
        toolCallId: ev.toolCallId,
        toolMessageId: ev.toolMessageId,
        kind: ev.kind,
        label: ev.label,
        patch: ev.patch,
      });
      return false;
    case "change_set":
      s.registerChangeSet(ev.changeSetId, ev.count, ev.summary, ev.structuralCount, ev.evidence);
      return true;
    case "maintenance":
      s.setMaintenance({
        stage: ev.stage,
        detail: ev.detail,
        findings: ev.findings ?? useAgentStore.getState().maintenance?.findings ?? [],
      });
      return false;
    case "checkpoint":
      s.setCheckpoint(ev.reason);
      return false;
    case "assistant_message":
      // Settle the bubble text ONLY — a mid-run assistant_message (the structure
      // path emits its plan summary BEFORE executing) must not flip `thinking`
      // off while work continues. `done` is the ONE terminal that finishes the
      // turn (the plan-approval pause depends on that + the pendingOutline
      // guard inside finishTurn).
      s.settleAssistantMessage(ev.content);
      return false;
    case "error":
      s.setError(ev.message);
      return false;
    case "done":
      s.finishTurn("");
      return false;
  }
}

/** Read an SSE body to completion, fanning each event into the store. `onMutate`
 *  fires (debounced by the caller) whenever an event changed course content — it
 *  drives the live re-render. Returns whether any event mutated the course. A
 *  deliberate Stop (`signal.aborted`) is silent; a genuine drop surfaces an error. */
async function consumeStream(res: Response, onMutate?: () => void, signal?: AbortSignal): Promise<boolean> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let mutated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = decodeSSE(frame);
        if (ev && dispatch(ev)) {
          mutated = true;
          onMutate?.();
        }
      }
    }
    deltaBatch.flush(); // a stream that closes without `done` still lands its text
  } catch {
    deltaBatch.flush(); // before setError — its settle must include every token
    if (!signal?.aborted) useAgentStore.getState().setError("The agent stream was interrupted.");
  }
  return mutated;
}

export function useAgentStream() {
  const router = useRouter();
  // The in-flight run's abort controller (one run at a time in the docked panel).
  const controllerRef = useRef<AbortController | null>(null);
  // Post-Stop refresh timer — cleared on unmount so navigating away within
  // 1.5s of stopping can't fire a stray router.refresh() on another route.
  const stopRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Run one agent SSE request end-to-end with abort + live-render wiring. */
  const runStream = useCallback(
    async (url: string, body: unknown): Promise<void> => {
      const editor = useEditorStore.getState();
      const controller = new AbortController();
      controllerRef.current = controller;
      editor.setAgentRunActive(true); // pause autosave; enable live re-sync

      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        editor.setAgentRunActive(false);
        controllerRef.current = null;
        // A deliberate Stop aborts the fetch — that's not an error to surface.
        if (!controller.signal.aborted) {
          useAgentStore.getState().setError("Couldn't reach the agent — check your connection.");
        }
        return;
      }
      if (!res.ok || !res.body) {
        editor.setAgentRunActive(false);
        controllerRef.current = null;
        useAgentStore.getState().setError(`The agent returned an error (${res.status}).`);
        return;
      }

      const mutated = await consumeStream(res, () => scheduleLiveSync(), controller.signal);
      editor.setAgentRunActive(false);
      cancelLiveSync();
      controllerRef.current = null;
      // The agent's edits are in the DB — pull the authoritative state into the editor.
      if (mutated) router.refresh();
    },
    [router]
  );

  /** Stop the in-flight run. Aborting the fetch closes the connection, so the
   *  server's between-turns signal check fires: it flushes + stages whatever it
   *  built (flush-on-exit) and returns. We settle the UI immediately, then refresh
   *  once the server has had a moment to persist the flush, so the staged work
   *  shows up for Accept/Reject. */
  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    deltaBatch.flush(); // received tokens belong to the bubble finishTurn settles
    const store = useAgentStore.getState();
    store.finishTurn(""); // settle the streaming bubble; thinking → false
    store.setPhase(null);
    useEditorStore.getState().setAgentRunActive(false);
    cancelLiveSync();
    // Give the server a beat to finish its flush-on-exit, then pull the staged
    // work. Tracked so unmounting (navigating away) cancels the refresh.
    if (stopRefreshRef.current) clearTimeout(stopRefreshRef.current);
    stopRefreshRef.current = setTimeout(() => router.refresh(), 1500);
  }, [router]);

  useEffect(() => {
    return () => {
      if (stopRefreshRef.current) clearTimeout(stopRefreshRef.current);
    };
  }, []);

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      const { courseId, activeLessonId } = useEditorStore.getState();
      if (!courseId || !activeLessonId) {
        useAgentStore.getState().setError("Open a lesson before asking the agent.");
        return;
      }
      const store = useAgentStore.getState();
      store.startTurn(trimmed);
      await runStream("/api/ai/agent", {
        courseId,
        lessonId: activeLessonId,
        message: trimmed,
        conversationId: store.conversationId,
        autoApprove: store.autoApprovePlan,
      });
    },
    [runStream]
  );

  /** Resolve the agent's paused destructive action (confirm/cancel) and resume
   *  the run, streaming the continuation back into the same transcript. */
  const confirmAction = useCallback(
    async (decision: "confirm" | "cancel") => {
      const store = useAgentStore.getState();
      const pending = store.pendingConfirmation;
      if (!pending) return;
      const { courseId, activeLessonId } = useEditorStore.getState();
      store.resumeTurn(); // keeps the transcript; clears the pending confirmation
      await runStream("/api/ai/agent/confirm", {
        courseId,
        lessonId: activeLessonId,
        conversationId: store.conversationId,
        toolCallId: pending.toolCallId,
        toolMessageId: pending.toolMessageId,
        kind: pending.kind,
        label: pending.label,
        patch: pending.patch,
        decision,
      });
    },
    [runStream]
  );

  /** Resolve the agent's paused PLAN outline (approve → generate, or discard) and
   *  stream the continuation into the same transcript. */
  const approvePlan = useCallback(
    async (decision: "approve" | "discard") => {
      const store = useAgentStore.getState();
      const pending = store.pendingOutline;
      if (!pending) return;
      const { courseId, activeLessonId } = useEditorStore.getState();

      if (decision === "discard") {
        store.setPendingOutline(null);
        store.setPhase(null);
        store.finishTurn("");
        return;
      }

      store.resumeTurn(); // keeps the transcript; clears the pending outline
      await runStream("/api/ai/agent/plan", {
        courseId,
        lessonId: activeLessonId,
        conversationId: store.conversationId,
        plan: pending,
        decision,
      });
    },
    [runStream]
  );

  const resolve = useCallback(
    async (changeSetId: string, action: "accept" | "reject") => {
      const agent = useAgentStore.getState();
      const post = async (): Promise<boolean> => {
        try {
          const res = await fetch(`/api/ai/change-set/${changeSetId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          });
          return res.ok;
        } catch {
          return false; // network drop = same rollback path as a server error
        }
      };

      if (action === "accept") {
        // OPTIMISTIC accept (PERF-1 B3): the edits already live in the DB doc,
        // so clearing the pending chrome is locally predictable — do it NOW,
        // snapshot what was cleared, restore + toast if the POST fails. Accept
        // is a no-op revert — leave autosave alone.
        const snapshot = agent.beginAcceptChangeSet(changeSetId);
        if (!snapshot) return; // unknown id, or already resolving (double-fire)
        if (await post()) {
          useAgentStore.getState().confirmResolveChangeSet(changeSetId);
        } else {
          useAgentStore.getState().rollbackAcceptChangeSet(snapshot);
          useAgentStore.getState().showFlash("Couldn't accept the changes — they're back under review.");
        }
        return;
      }

      // REJECT: the doc revert is server-authoritative (inverse patches) — the
      // doc mutation is never faked. Optimistic part = the review chrome flips
      // to 'reverting' (disabled + dimmed) for instant feedback.
      if (!agent.beginRejectChangeSet(changeSetId)) return; // double-fire guard
      // Reject reverts the DB then refetches; pause + abort autosave FIRST so a
      // stale debounced flush can't race the revert (and re-save the un-reverted
      // doc). Resumed by hydrate() when the reverted doc lands.
      useEditorStore.getState().suspendAutosaveForReject();
      if (await post()) {
        useAgentStore.getState().confirmResolveChangeSet(changeSetId);
        // Reject mutates the DB doc (restore); pull it back into the editor.
        router.refresh();
      } else {
        useEditorStore.getState().resumeAutosave(); // no refetch → resume now
        useAgentStore.getState().rollbackRejectChangeSet(changeSetId);
        useAgentStore.getState().showFlash("Couldn't reject the changes — try again.");
      }
    },
    [router]
  );

  return { send, resolve, confirmAction, approvePlan, stop };
}
