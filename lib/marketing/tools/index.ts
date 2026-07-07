/**
 * Marketing tool registry + the ONE shared entrypoint.
 *
 * `executeMarketingTool` is the single seam behind all three surfaces (the
 * "Generate Kit" button, the tool cards, and the agent loop). It never runs a
 * tool directly — it always goes through the gate. `approveMarketingAction` /
 * `rejectMarketingAction` / `acceptMarketingAction` resolve gated actions.
 *
 * Per-phase tool sets (mirroring the studio's AUTHORING/GENERATE sets) let the
 * agent be restricted to reads + reversible generation during a "Generate Kit"
 * run, and the full set only when it should be able to request irreversible
 * actions.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { toStrictJsonSchema } from "@/lib/ai/schema";
import type { ToolDefinition } from "@/lib/ai/modelClient";
import {
  acceptAction,
  loadAction,
  markActionExecuted,
  rejectAction,
  runThroughGate,
  type GateOutcome,
} from "../gate";
import { recordSegmentSend } from "../autonomyStore";
import type { MarketingServices } from "../services/types";
import { analyticsTools } from "./analytics";
import { askTools } from "./ask";
import { campaignTools } from "./campaign";
import { campaignLifecycleTools } from "./campaignLifecycle";
import { complianceTools } from "./compliance";
import { emailTools } from "./email";
import { landingTools } from "./landing";
import { leadTools } from "./leads";
import { readTools } from "./read";
import { senderIdentityTools } from "./senderIdentity";
import { socialPostTools } from "./socialPosts";
import { voiceTools } from "./voice";
import {
  MarketingToolError,
  type EntityRef,
  type MarketingTool,
  type MarketingToolContext,
  type MarketingToolResult,
} from "./types";

type DB = SupabaseClient<Database>;

const allReadTools = [
  ...readTools,
  ...analyticsTools,
  ...leadTools.filter((t) => t.reversibility === "read"),
  ...campaignLifecycleTools.filter((t) => t.reversibility === "read"),
  ...senderIdentityTools.filter((t) => t.reversibility === "read"),
  ...voiceTools.filter((t) => t.reversibility === "read"),
  ...socialPostTools.filter((t) => t.reversibility === "read"),
];
const mutatingTools = [
  ...campaignTools,
  ...landingTools,
  ...emailTools,
  ...complianceTools,
  ...leadTools.filter((t) => t.reversibility !== "read"),
  ...campaignLifecycleTools.filter((t) => t.reversibility !== "read"),
  ...senderIdentityTools.filter((t) => t.reversibility !== "read"),
  ...voiceTools.filter((t) => t.reversibility !== "read"),
  // Social Post Generator (Phase 1): ALL writes are reversible by design —
  // no approval cards anywhere in the feature (the autonomy-redesign rule).
  ...socialPostTools.filter((t) => t.reversibility !== "read"),
];

const reversibleTools = mutatingTools.filter((t) => t.reversibility === "reversible");

// ask_creator: the clarifying-question interaction tool — pauses the loop, so
// it belongs to the AGENT sets (generate + action), never the plain read set.
export const ALL_MARKETING_TOOLS: MarketingTool[] = [...allReadTools, ...mutatingTools, ...askTools];

const TOOL_BY_NAME = new Map(ALL_MARKETING_TOOLS.map((t) => [t.name, t]));

/** Reads only — the observe surface (context + analytics). */
export const MARKETING_READ_TOOLS: ReadonlySet<string> = new Set(allReadTools.map((t) => t.name));

/** Reads + reversible generation — the "Generate Kit" / generation phase. The
 *  agent CANNOT publish or send from this set (no irreversible tools). */
export const MARKETING_GENERATE_TOOLS: ReadonlySet<string> = new Set([
  ...allReadTools.map((t) => t.name),
  ...reversibleTools.map((t) => t.name),
  ...askTools.map((t) => t.name),
]);

/** Everything, including irreversible actions (which still pause for approval at
 *  the gate). The full agent set. */
export const MARKETING_ACTION_TOOLS: ReadonlySet<string> = new Set(
  ALL_MARKETING_TOOLS.map((t) => t.name)
);

export function getMarketingTool(name: string): MarketingTool | undefined {
  return TOOL_BY_NAME.get(name);
}

/** Strict, model-facing tool definitions (cached). Optionally filtered to a set
 *  (e.g. MARKETING_GENERATE_TOOLS) for a given agent phase. */
let cachedDefs: ToolDefinition[] | null = null;
export function getMarketingToolDefinitions(only?: ReadonlySet<string>): ToolDefinition[] {
  if (!cachedDefs) {
    cachedDefs = ALL_MARKETING_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toStrictJsonSchema(t.params),
    }));
  }
  return only ? cachedDefs.filter((d) => only.has(d.name)) : cachedDefs;
}

/**
 * THE shared entrypoint. Validates + routes the call through the gate:
 *   read tool        → executes, returns { status:'read' }
 *   reversible tool  → executes + stages, returns { status:'staged', actionId }
 *   irreversible tool→ records pending, returns { status:'pending_approval', actionId }
 */
export async function executeMarketingTool(
  name: string,
  args: unknown,
  ctx: MarketingToolContext
): Promise<GateOutcome> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new MarketingToolError(`Unknown marketing tool: ${name}`);
  return runThroughGate(tool, args, ctx);
}

/** What approve() needs to re-run the deferred tool (the rest is on the action
 *  row). */
export interface MarketingExecContext {
  supabase: DB;
  ownerId: string;
  services: MarketingServices;
  requestedBy?: "user" | "agent";
}

/**
 * Approve a pending IRREVERSIBLE action: atomically CLAIM the row
 * (pending → 'approved' — the one-click card makes double-clicks likely, and
 * the loser of the race must see "already resolved", never a duplicate send),
 * re-run the tool with `approved:true` (this time it performs the real
 * effect), then mark it executed. A failed execute releases the claim back to
 * 'pending' so the approval stays retryable (provider hiccups must not strand
 * the action).
 */
export async function approveMarketingAction(
  actionId: string,
  exec: MarketingExecContext
): Promise<MarketingToolResult> {
  const action = await loadAction(exec.supabase, actionId);
  if (!action) throw new MarketingToolError("Action not found");
  if (action.status !== "pending") throw new MarketingToolError(`Action is not pending (${action.status})`);
  if (action.reversibility !== "irreversible")
    throw new MarketingToolError("Only irreversible actions need approval");

  const tool = TOOL_BY_NAME.get(action.toolName);
  if (!tool) throw new MarketingToolError(`Unknown tool on action: ${action.toolName}`);

  const parsed = tool.params.safeParse(action.params);
  if (!parsed.success)
    throw new MarketingToolError(`Stored action params invalid: ${parsed.error.message}`);

  // Atomic claim — exactly one caller can move pending → approved.
  const { data: claimed, error: claimError } = await exec.supabase
    .from("marketing_action")
    .update({ status: "approved" })
    .eq("id", actionId)
    .eq("status", "pending")
    .select("id");
  if (claimError) throw new MarketingToolError(`approve: ${claimError.message}`);
  if (!claimed || claimed.length === 0)
    throw new MarketingToolError("Action was already resolved (someone else approved or denied it).");

  const ctx: MarketingToolContext = {
    supabase: exec.supabase,
    courseId: action.courseId,
    campaignId: action.campaignId,
    ownerId: exec.ownerId,
    services: exec.services,
    requestedBy: exec.requestedBy ?? action.requestedBy,
    approved: true,
  };
  let outcome: MarketingToolResult;
  try {
    outcome = await tool.execute(parsed.data, ctx);
  } catch (err) {
    // Release the claim — the action stays pending and retryable.
    await exec.supabase
      .from("marketing_action")
      .update({ status: "pending" })
      .eq("id", actionId)
      .eq("status", "approved");
    throw err;
  }
  await markActionExecuted(exec.supabase, actionId, (outcome.target as EntityRef | undefined) ?? null);

  // Human-approved segment sends also teach the first-send-to-new-segment
  // guardrail — the history is about what the COURSE has sent, not who
  // approved it.
  const segmentKey = tool.segmentKey ? tool.segmentKey(parsed.data) : null;
  if (segmentKey) {
    await recordSegmentSend(exec.supabase, {
      courseId: action.courseId,
      campaignId: action.campaignId,
      segmentKey,
      nowIso: exec.services.clock.now(),
    });
  }
  return outcome;
}

/**
 * Re-run a pending action's side-effect-FREE preview (the approvalPreview is
 * never persisted — it must stay truthful to CURRENT state, e.g. audience
 * counts move between request and review). Returns null when the preview
 * can't be built (unknown tool / stale params) — the card degrades to the
 * stored summary.
 */
export async function previewMarketingAction(
  action: { toolName: string; params: Record<string, unknown>; courseId: string; campaignId: string | null },
  exec: MarketingExecContext
): Promise<Record<string, unknown> | null> {
  try {
    const tool = TOOL_BY_NAME.get(action.toolName);
    if (!tool) return null;
    const parsed = tool.params.safeParse(action.params);
    if (!parsed.success) return null;
    const outcome = await tool.execute(parsed.data, {
      supabase: exec.supabase,
      courseId: action.courseId,
      campaignId: action.campaignId,
      ownerId: exec.ownerId,
      services: exec.services,
      requestedBy: exec.requestedBy ?? "user",
      approved: false,
    });
    return outcome.approvalPreview ?? null;
  } catch {
    return null;
  }
}

/** Deny a pending action (no effect) or revert a staged reversible one. */
export async function rejectMarketingAction(
  supabase: DB,
  actionId: string,
  opts: { nowIso?: string } = {}
): Promise<void> {
  await rejectAction(supabase, actionId, opts);
}

/** Keep a staged reversible change (clear the staging flag). */
export async function acceptMarketingAction(supabase: DB, actionId: string): Promise<void> {
  await acceptAction(supabase, actionId);
}

export { MarketingToolError } from "./types";
export type { MarketingTool, MarketingToolContext, MarketingToolResult } from "./types";
export type { GateOutcome } from "../gate";
