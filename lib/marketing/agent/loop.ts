/**
 * The Marketing Agent loop — reason → act → observe, built on the provider-
 * agnostic ModelClient (same seam as the studio's content agent).
 *
 *   observe → inject the funnel + current assets as a leading developer message
 *   reason  → stream a model turn with the marketing tool definitions
 *   act     → route EVERY tool call through the gate (executeMarketingTool):
 *               read       → execute, feed result back
 *               reversible → executes + logs (revertable for a window), feed
 *                            result back
 *               irreversible → routed by the autonomy engine: a policy-granted
 *                            auto-execution feeds back like any result; a
 *                            pending approval OR a clarifying question PAUSES
 *                            the run (ONE blocked branch for both shapes)
 *
 * The loop itself never executes an irreversible action — the gate does, and
 * only under the creator's per-action approval or their explicit auto-mode
 * policy. On approval/answer the run resumes out-of-band (agent/resume.ts).
 */

import type { ModelClient, ModelInputItem } from "@/lib/ai/modelClient";
import { loadHistory, saveAssistantMessage, saveToolMessage, saveUserMessage } from "@/lib/ai/conversations";
import type { MarketingServices } from "../services/types";
import {
  executeMarketingTool,
  MARKETING_ACTION_TOOLS,
  getMarketingToolDefinitions,
} from "../tools";
import type { MarketingToolContext } from "../tools/types";
import { getOrCreateMarketingConversation } from "./conversation";
import type { MarketingAgentEvent } from "./events";
import { buildMarketingSystemPrompt, buildObservation, observationSummary } from "./prompt";

export interface MarketingAgentParams {
  supabase: MarketingToolContext["supabase"];
  model: ModelClient;
  courseId: string;
  campaignId: string | null;
  ownerId: string;
  /** The creator's email — powers the send_test_email owner auto-log guard. */
  ownerEmail?: string | null;
  conversationId?: string | null;
  userMessage: string;
  services: MarketingServices;
  emit: (e: MarketingAgentEvent) => void;
  toolNames?: ReadonlySet<string>;
  maxTurns?: number;
  signal?: AbortSignal;
  /** When set, the agent is focused on editing this landing page (split view). */
  pageId?: string | null;
}

export async function runMarketingAgentTurn(
  p: MarketingAgentParams
): Promise<{ paused: boolean; conversationId: string }> {
  const { emit } = p;
  const conversationId = await getOrCreateMarketingConversation(p.supabase, p.courseId, p.conversationId);
  emit({ type: "conversation", conversationId });
  await saveUserMessage(p.supabase, conversationId, p.courseId, p.userMessage);

  const system = buildMarketingSystemPrompt();
  const observation = await buildObservation(p.supabase, p.courseId, p.campaignId, p.pageId ?? null);
  emit({ type: "observation", summary: observationSummary(observation) });

  const history = await loadHistory(p.supabase, conversationId);
  const input: ModelInputItem[] = [{ role: "developer", content: observation }, ...history];

  const tools = getMarketingToolDefinitions(p.toolNames ?? MARKETING_ACTION_TOOLS);
  const ctx: MarketingToolContext = {
    supabase: p.supabase,
    courseId: p.courseId,
    campaignId: p.campaignId,
    ownerId: p.ownerId,
    ownerEmail: p.ownerEmail ?? null,
    services: p.services,
    // The agent's own model doubles as the generation tools' copywriter seam
    // (generate_email_sequence / regenerate_email_step run LLM-grounded).
    model: p.model,
    requestedBy: "agent",
  };

  const maxTurns = p.maxTurns ?? 6;
  let paused = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await p.model.runTurn(
      { system, input, tools, effort: "medium", signal: p.signal },
      (e) => {
        if (e.type === "text_delta") emit({ type: "assistant_delta", text: e.delta });
      }
    );

    await saveAssistantMessage(p.supabase, conversationId, p.courseId, {
      text: result.text,
      toolCalls: result.toolCalls,
    });
    if (result.text) input.push({ role: "assistant", content: result.text });

    if (result.toolCalls.length === 0) {
      if (result.text) emit({ type: "assistant_message", content: result.text });
      break;
    }

    let pausedThisTurn = false;
    for (const call of result.toolCalls) {
      emit({ type: "tool_start", toolCallId: call.callId, tool: call.name });
      input.push({ type: "function_call", callId: call.callId, name: call.name, arguments: call.arguments });

      let args: unknown = {};
      try {
        args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      } catch {
        args = {};
      }

      try {
        const outcome = await executeMarketingTool(call.name, args, {
          ...ctx,
          toolCallId: call.callId,
          conversationId,
        });
        // ONE blocked branch — a pending approval and a clarifying question
        // pause identically; only the payload differs.
        if (outcome.status === "pending_approval" || outcome.status === "needs_clarification") {
          const blockedOnApproval = outcome.status === "pending_approval";
          emit({
            type: "tool_result",
            toolCallId: call.callId,
            tool: call.name,
            ok: true,
            summary: outcome.summary,
            status: outcome.status,
            actionId: outcome.actionId,
          });
          emit({
            type: "agent_blocked",
            kind: blockedOnApproval ? "approval" : "question",
            tool: call.name,
            summary: outcome.summary,
            ...(blockedOnApproval
              ? { actionId: outcome.actionId!, preview: outcome.approvalPreview }
              : { questionId: outcome.questionId!, question: outcome.question }),
          });
          // Short on purpose — the original arguments already live in the
          // transcript's function_call; never re-embed bodies (4000-slice).
          const out = blockedOnApproval
            ? `Paused — awaiting the creator's approval: ${outcome.summary}`
            : `Paused — asked the creator: ${outcome.summary}`;
          await saveToolMessage(p.supabase, conversationId, p.courseId, { callId: call.callId, name: call.name, output: out });
          input.push({ type: "function_call_output", callId: call.callId, output: out });
          pausedThisTurn = true;
          break;
        }
        const status =
          outcome.status === "read" ? "read" : outcome.status === "executed" ? "executed" : "staged";
        emit({
          type: "tool_result",
          toolCallId: call.callId,
          tool: call.name,
          ok: true,
          summary: outcome.summary,
          status,
          actionId: outcome.actionId,
        });
        const out = JSON.stringify({ summary: outcome.summary, ...(outcome.data ? { data: outcome.data } : {}) }).slice(0, 4000);
        await saveToolMessage(p.supabase, conversationId, p.courseId, { callId: call.callId, name: call.name, output: out });
        input.push({ type: "function_call_output", callId: call.callId, output: out });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: "tool_result", toolCallId: call.callId, tool: call.name, ok: false, summary: msg, status: "error" });
        await saveToolMessage(p.supabase, conversationId, p.courseId, { callId: call.callId, name: call.name, output: `Error: ${msg}` });
        input.push({ type: "function_call_output", callId: call.callId, output: `Error: ${msg}` });
      }
    }

    if (pausedThisTurn) {
      paused = true;
      break;
    }
  }

  emit({ type: "done", paused });
  return { paused, conversationId };
}
