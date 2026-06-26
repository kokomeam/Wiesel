/**
 * Marketing agent → browser event protocol (SSE). One vocabulary drives the
 * chat transcript AND the staging/approval surfaces — `tool_result.status`
 * distinguishes a read, an auto-staged reversible change, and a paused
 * irreversible action; `approval_request` drives the approval inbox + the pause.
 */

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
      /** read = executed, no ledger; staged = reversible, Reject-able;
       *  pending_approval = irreversible, paused for a human. */
      status: "read" | "staged" | "pending_approval" | "error";
      actionId?: string | null;
    }
  /** An irreversible action is awaiting approval — the loop PAUSES here. */
  | {
      type: "approval_request";
      actionId: string;
      tool: string;
      summary: string;
      preview?: Record<string, unknown>;
    }
  | { type: "assistant_message"; content: string }
  | { type: "error"; message: string }
  /** Terminal. `paused` = stopped at an approval gate (not a clean finish). */
  | { type: "done"; paused: boolean };

export type MarketingAgentEventType = MarketingAgentEvent["type"];

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
