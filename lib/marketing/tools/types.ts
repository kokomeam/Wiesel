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
import type { MarketingServices } from "../services/types";
import type { Reversibility } from "../types";

export type DB = SupabaseClient<Database>;

/** Entities the gate can snapshot + restore (see lib/marketing/entities.ts). */
export type EntityKind =
  | "campaign"
  | "landing_page"
  | "email_sequence"
  | "subscriber"
  | "sequence_enrollment";

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
  /** Who initiated this call — recorded on the gate ledger row. */
  requestedBy: "user" | "agent";
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
