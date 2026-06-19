"use client";

/**
 * Drives the docked agent: POST /api/ai/agent, parse the normalized SSE event
 * protocol, and fan it into the agentStore (chat transcript + tool cards +
 * pending-block highlights). After a turn that mutated content, router.refresh()
 * pulls the agent's new/changed blocks into the editor (client state survives
 * the soft refresh, so highlights persist). Also exposes accept/reject.
 */

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { decodeSSE, type AgentEvent } from "@/lib/ai/events";
import { useEditorStore } from "@/lib/course/store";
import { useAgentStore } from "@/lib/editor/agentStore";

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
      s.registerChangeSet(ev.changeSetId, ev.count, ev.summary);
      return true;
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

/** Read an SSE body to completion, fanning each event into the store. Returns
 *  whether any event mutated the course (→ caller refreshes the editor). */
async function consumeStream(res: Response): Promise<boolean> {
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
        if (ev && dispatch(ev)) mutated = true;
      }
    }
  } catch {
    useAgentStore.getState().setError("The agent stream was interrupted.");
  }
  return mutated;
}

export function useAgentStream() {
  const router = useRouter();

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

      let res: Response;
      try {
        res = await fetch("/api/ai/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            courseId,
            lessonId: activeLessonId,
            message: trimmed,
            conversationId: store.conversationId,
            autoApprove: store.autoApprovePlan,
          }),
        });
      } catch {
        useAgentStore.getState().setError("Couldn't reach the agent — check your connection.");
        return;
      }
      if (!res.ok || !res.body) {
        useAgentStore.getState().setError(`The agent returned an error (${res.status}).`);
        return;
      }

      const mutated = await consumeStream(res);
      if (mutated) router.refresh();
    },
    [router]
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

      let res: Response;
      try {
        res = await fetch("/api/ai/agent/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            courseId,
            lessonId: activeLessonId,
            conversationId: store.conversationId,
            toolCallId: pending.toolCallId,
            toolMessageId: pending.toolMessageId,
            kind: pending.kind,
            label: pending.label,
            patch: pending.patch,
            decision,
          }),
        });
      } catch {
        useAgentStore.getState().setError("Couldn't reach the agent — check your connection.");
        return;
      }
      if (!res.ok || !res.body) {
        useAgentStore.getState().setError(`The agent returned an error (${res.status}).`);
        return;
      }

      const mutated = await consumeStream(res);
      if (mutated) router.refresh();
    },
    [router]
  );

  /** Resolve the agent's paused PLAN outline (approve → generate+critique, or
   *  discard) and stream the continuation into the same transcript. */
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

      let res: Response;
      try {
        res = await fetch("/api/ai/agent/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            courseId,
            lessonId: activeLessonId,
            conversationId: store.conversationId,
            plan: pending,
            decision,
          }),
        });
      } catch {
        useAgentStore.getState().setError("Couldn't reach the agent — check your connection.");
        return;
      }
      if (!res.ok || !res.body) {
        useAgentStore.getState().setError(`The agent returned an error (${res.status}).`);
        return;
      }

      const mutated = await consumeStream(res);
      if (mutated) router.refresh();
    },
    [router]
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

  return { send, resolve, confirmAction, approvePlan };
}
