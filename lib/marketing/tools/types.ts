/**
 * Marketing tool framework — ONE typed contract behind all three surfaces
 * (the "Generate Kit" batch button, the individual tool cards, and the agent
 * chat all call the same tools through `executeMarketingTool` → the gate).
 *
 * Mirrors lib/ai/tools/types.ts, extended with the one field the GOVERNANCE
 * GATE routes on: `reversibility`.
 *   - read        → executes immediately, never staged, never gated.
 *   - reversible  → executes immediately; the gate captures a before-snapshot
 *                   and stages it Reject-able (atomic rollback).
 *   - irreversible→ the gate does NOT execute; it records a pending action and
 *                   surfaces an approval request. On approve, the SAME execute
 *                   runs; on deny, nothing happened.
 *
 * Tools are async functions over Supabase + the service bundle. They own their
 * own persistence (unlike the course tools, marketing entities live in many
 * tables with no single document), but EVERY mutation flows through the gate —
 * a tool is never called directly, only via `executeMarketingTool`.
 */

import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { ModelClient } from "@/lib/ai/modelClient";
import type { QuestionSpec } from "../questions";
import type { MarketingServices } from "../services/types";
import type { Reversibility } from "../types";

export type DB = SupabaseClient<Database>;

/** Entities the gate can snapshot + restore (see lib/marketing/entities.ts). */
export type EntityKind =
  | "campaign"
  | "landing_page"
  | "email_sequence"
  | "subscriber"
  | "sequence_enrollment"
  | "lead_list"
  | "sender_identity"
  | "follow_up_rule"
  | "voice_profile"
  | "social_post"
  | "social_post_batch"
  | "social_voice_profile"
  | "clip_moment_candidate"
  | "clip_moment_set";

export interface EntityRef {
  entity: EntityKind;
  id: string;
}

export interface MarketingToolContext {
  supabase: DB;
  courseId: string;
  /** The active campaign (most tools operate within one). Null only before a
   *  campaign exists (e.g. the first `create_campaign`). */
  campaignId: string | null;
  /** The signed-in author (for audit + any owner-scoped writes). */
  ownerId: string;
  services: MarketingServices;
  /**
   * Optional model seam for LLM-grounded generation (generate_email_sequence,
   * regenerate_email_step, generate_email_variants). Undefined when
   * OPENAI_API_KEY isn't configured OR the caller didn't wire one — every
   * generation tool falls back to the deterministic template generator in that
   * case (mock-first stays intact; nothing REQUIRES a model to function).
   */
  model?: ModelClient;
  /** Who initiated this call — recorded on the gate ledger row. */
  requestedBy: "user" | "agent";
  /**
   * The signed-in creator's email, when the caller knows it. Powers exactly
   * one privilege: send_test_email addressed HERE may auto-log under
   * assisted/auto mode (it reaches nobody but the creator). Absent → the gate
   * falls back to auth.getUser(); if that also misses, the test email stays
   * on the approval path (fail closed, never open).
   */
  ownerEmail?: string | null;
  /** Set by the agent loop per tool call — stored on gate-raised clarifying
   *  questions so the answer can be tied back to the paused call. */
  toolCallId?: string | null;
  /** Set by the agent loop — clarifying questions raised mid-run store it so
   *  the answer resumes the SAME conversation. Null on user-surface calls. */
  conversationId?: string | null;
  /**
   * Optional per-request progress sink (ADDITIVE — the repo's loop-hook
   * convention). The social generate tool reports each validated draft
   * through it so the SSE route can stream queue cards incrementally;
   * absent everywhere else.
   */
  progress?: (event: { type: string; data?: unknown }) => void;
  /**
   * Set by the gate for IRREVERSIBLE tools only:
   *   false/undefined → return a side-effect-FREE preview (audience size, etc.)
   *                     for the approval card; perform NO outward action.
   *   true            → the human approved; perform the real effect (send/publish).
   * read + reversible tools ignore this (they always execute).
   */
  approved?: boolean;
}

export interface MarketingToolResult {
  summary: string;
  data?: unknown;
  /**
   * For mutating tools: the entity this call created or updated. The gate uses
   * it to stage (reversible) or to scope the audit row (irreversible). A create
   * has no before-snapshot → Reject deletes `target`; an update is snapshotted
   * before execute → Reject restores it.
   */
  target?: EntityRef;
  /** Side-channel data an irreversible action wants surfaced in its approval
   *  card (e.g. audience size, subject) BEFORE it executes. */
  approvalPreview?: Record<string, unknown>;
}

export interface MarketingTool<P extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** Zod schema = single source of truth: validates args AND generates the
   *  strict, model-facing JSON schema. */
  params: P;
  reversibility: Reversibility;
  /** Short semantic label for the gate ledger + approval card. Defaults to the
   *  tool name. */
  actionKind?: string;
  /**
   * "question" marks an INTERACTION tool (ask_creator): the gate intercepts it
   * before grade routing, records a marketing_question, and pauses the loop —
   * `execute` never runs. Leave unset on every normal tool.
   */
  interaction?: "question";
  /**
   * IRREVERSIBLE tools only, optional: return a QuestionSpec when the call's
   * targeting is ambiguous (e.g. a broadcast with no segment over a mixed
   * audience) and null when it's unambiguous. Under assisted/auto mode the
   * gate turns a returned spec into a clarifying question INSTEAD of a
   * half-specified approval card; manual mode skips the hook entirely.
   */
  clarifyTargeting?(
    args: z.infer<P>,
    ctx: MarketingToolContext
  ): QuestionSpec | null | Promise<QuestionSpec | null>;
  /**
   * IRREVERSIBLE segment-send tools only, PURE: the segment identity this call
   * targets (e.g. "status:engaged"). Drives the first-send-to-new-segment
   * guardrail + the segment send history. Null = not a segment send.
   */
  segmentKey?(args: z.infer<P>): string | null;
  /** Param names the approval card lets the creator edit in place before
   *  approving. Omit → the card shows no Edit action. */
  editableParams?: string[];
  /**
   * For a REVERSIBLE tool that edits an EXISTING entity, return its ref so the
   * gate can snapshot it BEFORE `execute` mutates. Return null for a create
   * (no prior state → Reject deletes whatever `execute` returns as `target`).
   * Omitted entirely on read/irreversible tools.
   */
  existingTarget?(
    args: z.infer<P>,
    ctx: MarketingToolContext
  ): EntityRef | null | Promise<EntityRef | null>;
  execute(
    args: z.infer<P>,
    ctx: MarketingToolContext
  ): MarketingToolResult | Promise<MarketingToolResult>;
}

/** Thrown for clearly-invalid input; the gate/loop reports it back to the
 *  caller (the model can retry). */
export class MarketingToolError extends Error {}

export function defineMarketingTool<P extends z.ZodTypeAny>(
  tool: MarketingTool<P>
): MarketingTool<P> {
  return tool;
}
