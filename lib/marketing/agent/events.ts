/**
 * Marketing agent → browser event protocol (SSE). One vocabulary drives the
 * chat transcript AND the staging/approval surfaces — `tool_result.status`
 * distinguishes a read, an auto-logged reversible change, a policy-executed
 * irreversible action, and the two blocked shapes; `agent_blocked` drives the
 * pause (approval card OR clarifying question — the loop treats them as ONE
 * "waiting on a human" state).
 */

import type { QuestionSpec } from "../questions";

export type MarketingAgentEvent =
  | { type: "conversation"; conversationId: string }
  /** What the agent observed at the start of the turn (funnel one-liner). */
  | { type: "observation"; summary: string }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; tool: string }
  | {
      type: "tool_result";
      toolCallId: string;
      tool: string;
      ok: boolean;
      summary: string;
      /** read = executed, no ledger; staged = reversible, quiet log entry w/
       *  time-boxed Revert; executed = irreversible, auto-executed under the
       *  creator's policy (audited); pending_approval / needs_clarification =
       *  the two blocked shapes — the loop PAUSES on either. */
      status: "read" | "staged" | "executed" | "pending_approval" | "needs_clarification" | "error";
      actionId?: string | null;
    }
  /**
   * The run is blocked on a human — the ONE pause event. kind "approval"
   * carries the pending action (+ its inline preview); kind "question"
   * carries the clarifying question (model-asked or gate-raised alike).
   */
  | {
      type: "agent_blocked";
      kind: "approval" | "question";
      tool: string;
      summary: string;
      actionId?: string;
      preview?: Record<string, unknown>;
      questionId?: string;
      question?: QuestionSpec;
    }
  | { type: "assistant_message"; content: string }
  | { type: "error"; message: string }
  /** Terminal. `paused` = stopped blocked on a human (not a clean finish). */
  | { type: "done"; paused: boolean };

export type MarketingAgentEventType = MarketingAgentEvent["type"];

/* ───────────────── follow-up (the resumed run, replayable) ─────────────────
 * Approving/denying/answering from ANY surface resumes the agent server-side
 * inside the server action. That resume used to be headless — the wrap-up the
 * prompt demands ("what executed, what happens next, with timing") was
 * persisted but never SHOWN. The server action now captures the resume's
 * events, folds them into this compact, serializable shape, and returns it;
 * the chat panel replays it as transcript items (and it rides the
 * cross-surface sync so an approval from the hub still narrates in the open
 * chat). */

export type AgentFollowUpItem =
  | { kind: "observation"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; tool: string; summary: string; status: string }
  | { kind: "approval"; actionId: string; tool: string; summary: string; preview: Record<string, unknown> | null }
  | { kind: "question"; questionId: string; question: QuestionSpec }
  | { kind: "error"; text: string };

export interface AgentFollowUp {
  conversationId: string | null;
  /** True when the resumed run blocked again (a new approval/question). */
  paused: boolean;
  items: AgentFollowUpItem[];
}

/** Fold a captured event stream into the replayable follow-up. Pure. Deltas
 *  accumulate into one assistant item per contiguous text segment;
 *  `assistant_message` is only used when NO deltas streamed for that text
 *  (some model clients emit one, not the other — never both as duplicates). */
export function followUpFromEvents(events: MarketingAgentEvent[]): AgentFollowUp {
  const items: AgentFollowUpItem[] = [];
  let conversationId: string | null = null;
  let paused = false;
  let textBuf = "";
  let flushedText = ""; // all assistant text already flushed (dupe guard)
  const flush = () => {
    if (textBuf.trim()) {
      items.push({ kind: "assistant", text: textBuf.trim() });
      flushedText += textBuf;
    }
    textBuf = "";
  };
  for (const ev of events) {
    switch (ev.type) {
      case "conversation":
        conversationId = ev.conversationId;
        break;
      case "observation":
        flush();
        items.push({ kind: "observation", text: ev.summary });
        break;
      case "assistant_delta":
        textBuf += ev.text;
        break;
      case "assistant_message":
        // Deltas already carried this text → skip; otherwise it's the only copy.
        if (!(textBuf + flushedText).includes(ev.content.trim().slice(0, 200))) {
          flush();
          items.push({ kind: "assistant", text: ev.content.trim() });
          flushedText += ev.content;
        }
        break;
      case "tool_result":
        flush();
        items.push({ kind: "tool", tool: ev.tool, summary: ev.summary, status: ev.status });
        break;
      case "agent_blocked":
        flush();
        if (ev.kind === "approval" && ev.actionId) {
          items.push({ kind: "approval", actionId: ev.actionId, tool: ev.tool, summary: ev.summary, preview: ev.preview ?? null });
        } else if (ev.kind === "question" && ev.questionId && ev.question) {
          items.push({ kind: "question", questionId: ev.questionId, question: ev.question });
        }
        break;
      case "error":
        flush();
        items.push({ kind: "error", text: ev.message });
        break;
      case "done":
        paused = ev.paused;
        break;
      default:
        break; // tool_start carries nothing the replay needs
    }
  }
  flush();
  return { conversationId, paused, items };
}

export function encodeSSE(event: MarketingAgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function decodeSSE(line: string): MarketingAgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  try {
    return JSON.parse(trimmed.slice(5).trim()) as MarketingAgentEvent;
  } catch {
    return null;
  }
}
