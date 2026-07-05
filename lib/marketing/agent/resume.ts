/**
 * Agent auto-resume — ALL THREE ways a blocked run continues:
 *   approve  → "✓ Approved & executed: …"  (resumeAgentAfterResolution)
 *   deny     → "✕ Denied: … — reason: …"   (resumeAgentAfterResolution)
 *   answered → "✎ Answered: … → …"          (resumeAgentAfterAnswer)
 * Resolving the blocker re-triggers the loop ONCE with the outcome injected as
 * the turn's message, so the agent can confirm, finish its plan, or adjust.
 *
 * Constraints preserved by construction:
 *   - only fires for blockers the AGENT raised (a human clicking "Send" from
 *     a card wasn't mid-conversation; nothing to resume);
 *   - runs the SAME runMarketingAgentTurn — the turn cap applies, and the loop
 *     still cannot execute anything irreversible itself (it would pause again);
 *   - the resume message is persisted into the conversation, so even a
 *     headless resume (approved from the hub, chat closed) shows up when the
 *     creator next opens the agent;
 *   - resume messages are SHORT (they reference the paused tool call, whose
 *     full arguments already live in the transcript) — 4000-slice safe.
 */

import type { ModelClient } from "@/lib/ai/modelClient";
import type { MarketingQuestionRow, QuestionAnswer } from "../questions";
import type { MarketingActionRow } from "../types";
import type { MarketingServices } from "../services/types";
import type { MarketingToolContext } from "../tools/types";
import type { MarketingAgentEvent } from "./events";
import { runMarketingAgentTurn } from "./loop";

export interface ResumeParams {
  supabase: MarketingToolContext["supabase"];
  model: ModelClient;
  services: MarketingServices;
  ownerId: string;
  action: MarketingActionRow;
  decision: "approved" | "denied";
  /** Optional free-text from the creator on a denial — flows into the
   *  observation so the agent can adjust, not just retry. */
  denialReason?: string | null;
  emit?: (e: MarketingAgentEvent) => void;
  signal?: AbortSignal;
}

/** Build the outcome message the resumed turn receives. Exported for tests. */
export function resumeMessage(action: MarketingActionRow, decision: "approved" | "denied", denialReason?: string | null): string {
  if (decision === "approved") {
    return `✓ Approved & executed: ${action.toolName} — ${action.summary ?? "done"}. Continue with anything that was waiting on it, then close with your end-of-run wrap-up: what was done, what's true now, and what happens next WITH timing (queued emails send during the send window — the summary above states when).`;
  }
  return `✕ Denied: ${action.toolName} — ${action.summary ?? ""}${denialReason ? ` Reason: ${denialReason}` : ""} Do not retry the same action; adjust the plan or ask what to change.`;
}

/**
 * Run the one resume turn. No-op (returns null) when the action wasn't
 * agent-requested. Never throws — a resume failure must never break the
 * approval itself (the approval already happened).
 */
export async function resumeAgentAfterResolution(
  p: ResumeParams
): Promise<{ paused: boolean; conversationId: string } | null> {
  if (p.action.requestedBy !== "agent") return null;
  try {
    return await runMarketingAgentTurn({
      supabase: p.supabase,
      model: p.model,
      courseId: p.action.courseId,
      campaignId: p.action.campaignId,
      ownerId: p.ownerId,
      userMessage: resumeMessage(p.action, p.decision, p.denialReason),
      services: p.services,
      emit: p.emit ?? (() => {}),
      signal: p.signal,
    });
  } catch (err) {
    console.warn("[marketing/agent] auto-resume failed (approval itself succeeded):", err instanceof Error ? err.message : err);
    return null;
  }
}

/* ─────────────────── the third path: a question was answered ─────────────── */

export interface ResumeAfterAnswerParams {
  supabase: MarketingToolContext["supabase"];
  model: ModelClient;
  services: MarketingServices;
  ownerId: string;
  question: MarketingQuestionRow;
  answer: QuestionAnswer;
  emit?: (e: MarketingAgentEvent) => void;
  signal?: AbortSignal;
}

/** Build the message the resumed turn receives. Exported for tests.
 *  Gate-raised questions tell the agent to RETRY the paused tool with the
 *  ambiguous field resolved; model-raised ones just hand the answer back.
 *  "__other__" = the creator typed their OWN answer (maybe redirecting the
 *  plan entirely) — hand the text over verbatim, never a phantom option value. */
export function answeredMessage(q: MarketingQuestionRow, answer: QuestionAnswer): string {
  if (answer.value === "__other__") {
    const text = answer.freeText ?? answer.label;
    if (q.source === "gate" && q.toolName) {
      return `✎ The creator answered your blocked ${q.toolName} call in their own words — "${q.question}" → "${text}". Act on THAT: if it names one of the offered choices, retry ${q.toolName} with it; otherwise adjust your plan to what they asked for. Never invent an option they didn't pick.`;
    }
    return `✎ The creator answered in their own words: "${q.question}" → "${text}". Act on that — it may change your plan; do not force it into one of your original options.`;
  }
  const chosen = `"${answer.label}" (${answer.value})`;
  const extra = answer.freeText ? ` They added: ${answer.freeText}` : "";
  if (q.source === "gate" && q.toolName) {
    const paramKey =
      (q.toolParams && typeof q.toolParams.paramKey === "string" ? q.toolParams.paramKey : null) ?? "the ambiguous field";
    return `✎ The creator answered your blocked ${q.toolName} call — "${q.question}" → ${chosen}.${extra} Retry ${q.toolName} now with ${paramKey} set to ${JSON.stringify(answer.value)}, keeping your other arguments from the original call.`;
  }
  return `✎ The creator answered: "${q.question}" → ${chosen}.${extra} Continue.`;
}

/**
 * Run the one resume turn after a clarifying question is answered. No-op
 * (returns null) when the question wasn't agent-raised. Never throws — a
 * resume failure must never break the answer itself (it's already recorded).
 */
export async function resumeAgentAfterAnswer(
  p: ResumeAfterAnswerParams
): Promise<{ paused: boolean; conversationId: string } | null> {
  if (p.question.requestedBy !== "agent") return null;
  try {
    return await runMarketingAgentTurn({
      supabase: p.supabase,
      model: p.model,
      courseId: p.question.courseId,
      campaignId: p.question.campaignId,
      ownerId: p.ownerId,
      // Resume the SAME conversation the question paused (stored on the row).
      conversationId: p.question.conversationId,
      userMessage: answeredMessage(p.question, p.answer),
      services: p.services,
      emit: p.emit ?? (() => {}),
      signal: p.signal,
    });
  } catch (err) {
    console.warn("[marketing/agent] answer-resume failed (answer itself was recorded):", err instanceof Error ? err.message : err);
    return null;
  }
}
