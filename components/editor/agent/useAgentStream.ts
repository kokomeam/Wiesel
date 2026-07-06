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
import { useCallback, useRef } from "react";
import { decodeSSE, type AgentEvent } from "@/lib/ai/events";
import { useEditorStore } from "@/lib/course/store";
import { useAgentStore } from "@/lib/editor/agentStore";
import { cancelLiveSync, scheduleLiveSync } from "@/lib/editor/liveSync";

function dispatch(ev: AgentEvent): boolean {
  const s = useAgentStore.getState();
  switch (ev.type) {
    case "conversation":
      s.setConversation(ev.conversationId);
      return false;
    case "assistant_delta":
      s.appendAssistant(ev.text);
      return false;
    case "tool_start":
      s.addToolStart(ev.toolCallId, ev.tool);
      return false;
    case "tool_result":
      s.resolveTool(ev.toolCallId, ev.ok, ev.summary, ev.blockId);
      return true;
    case "phase":
      // `critique_skipped` is informational (legacy critique disabled) — clear the
      // indicator; the next assistant_message/done settles the run.
      s.setPhase(ev.phase === "critique_skipped" ? null : ev.phase);
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
      s.finishTurn(ev.content);
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
  } catch {
    if (!signal?.aborted) useAgentStore.getState().setError("The agent stream was interrupted.");
  }
  return mutated;
}

export function useAgentStream() {
  const router = useRouter();
  // The in-flight run's abort controller (one run at a time in the docked panel).
  const controllerRef = useRef<AbortController | null>(null);

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
    const store = useAgentStore.getState();
    store.finishTurn(""); // settle the streaming bubble; thinking → false
    store.setPhase(null);
    useEditorStore.getState().setAgentRunActive(false);
    cancelLiveSync();
    // Give the server a beat to finish its flush-on-exit, then pull the staged work.
    setTimeout(() => router.refresh(), 1500);
  }, [router]);

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
      // Reject reverts the DB then refetches; pause + abort autosave FIRST so a
      // stale debounced flush can't race the revert (and re-save the un-reverted
      // doc). resumed by hydrate() when the reverted doc lands. Accept is a
      // no-op revert (the edits already live in the DB) — leave autosave alone.
      if (action === "reject") useEditorStore.getState().suspendAutosaveForReject();
      const res = await fetch(`/api/ai/change-set/${changeSetId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        if (action === "reject") useEditorStore.getState().resumeAutosave(); // no refetch → resume now
        useAgentStore.getState().setError(`Couldn't ${action} the changes.`);
        return;
      }
      useAgentStore.getState().clearChangeSet(changeSetId);
      // Reject mutates the DB doc (restore); pull it back into the editor.
      if (action === "reject") router.refresh();
    },
    [router]
  );

  return { send, resolve, confirmAction, approvePlan, stop };
}
