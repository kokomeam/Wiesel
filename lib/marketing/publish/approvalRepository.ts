/**
 * social_publish_approval repository — EVERY read/write of the approvals
 * table lives here (the manifestRepository precedent; grep-fenced).
 *
 * Lifecycle: requested (row exists) → minted (token_hash + expires_at set at
 * CARD RENDER — re-render re-mints, invalidating the prior token) →
 * consumed | declined | voided. `consumeByTokenHash` is the ONE consuming
 * write and is atomic: `where token_hash=… and consumed_at/declined_at/
 * voided_at are null and expires_at > now` — replay, decline-race, void-race
 * and expiry all lose in the same guarded UPDATE.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { PublishPlatform } from "./provider/types";

type DB = SupabaseClient<Database>;
type ApprovalRow = Database["public"]["Tables"]["social_publish_approval"]["Row"];

export interface PublishApproval {
  id: string;
  creatorId: string;
  socialPostId: string;
  socialAccountId: string;
  platform: PublishPlatform;
  kind: "card" | "retry";
  requestedBy: "creator" | "agent";
  proposedScheduledFor: string | null;
  contentHash: string;
  mintedAt: string | null;
  expiresAt: string | null;
  consumedAt: string | null;
  declinedAt: string | null;
  voidedAt: string | null;
  parentApprovalId: string | null;
  /** Marketing agent conversation that filed this card (M-AG; null = filed
   *  from the review page / queue / editor). Follow-up resume only. */
  conversationId: string | null;
  createdAt: string;
}

export function rowToApproval(row: ApprovalRow): PublishApproval {
  return {
    id: row.id,
    creatorId: row.creator_id,
    socialPostId: row.social_post_id,
    socialAccountId: row.social_account_id,
    platform: row.platform as PublishPlatform,
    kind: row.kind as PublishApproval["kind"],
    requestedBy: row.requested_by as PublishApproval["requestedBy"],
    proposedScheduledFor: row.proposed_scheduled_for,
    contentHash: row.content_hash,
    mintedAt: row.minted_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    declinedAt: row.declined_at,
    voidedAt: row.voided_at,
    parentApprovalId: row.parent_approval_id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
  };
}

export async function getApproval(supabase: DB, id: string): Promise<PublishApproval | null> {
  const { data, error } = await supabase
    .from("social_publish_approval")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`approval read: ${error.message}`);
  return data ? rowToApproval(data) : null;
}

/** Open (undecided, unvoided, unconsumed) approvals for the review surface. */
export async function listOpenApprovals(supabase: DB, creatorId: string): Promise<PublishApproval[]> {
  const { data, error } = await supabase
    .from("social_publish_approval")
    .select("*")
    .eq("creator_id", creatorId)
    .is("consumed_at", null)
    .is("declined_at", null)
    .is("voided_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`approval open list: ${error.message}`);
  return (data ?? []).map(rowToApproval);
}

/** ALL approvals for a post (consumed/declined/voided included) — the
 *  manifest history drawer's lineage read. */
export async function listApprovalsForPost(
  supabase: DB,
  socialPostId: string
): Promise<PublishApproval[]> {
  const { data, error } = await supabase
    .from("social_publish_approval")
    .select("*")
    .eq("social_post_id", socialPostId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`approval post list: ${error.message}`);
  return (data ?? []).map(rowToApproval);
}

export interface CreateApprovalInput {
  creatorId: string;
  socialPostId: string;
  socialAccountId: string;
  platform: PublishPlatform;
  contentHash: string;
  kind?: "card" | "retry";
  requestedBy?: "creator" | "agent";
  proposedScheduledFor?: string | null;
  parentApprovalId?: string | null;
  /** RETRY clones only (amendment: transient retry never re-cards): born
   *  consumed, chained to the human card approval via parentApprovalId. */
  consumedAt?: string | null;
  /** Chat-filed cards only (M-AG): the conversation to resume after decide. */
  conversationId?: string | null;
}

export async function createApprovalRequest(
  supabase: DB,
  input: CreateApprovalInput
): Promise<PublishApproval> {
  const { data, error } = await supabase
    .from("social_publish_approval")
    .insert({
      creator_id: input.creatorId,
      social_post_id: input.socialPostId,
      social_account_id: input.socialAccountId,
      platform: input.platform,
      content_hash: input.contentHash,
      kind: input.kind ?? "card",
      requested_by: input.requestedBy ?? "creator",
      proposed_scheduled_for: input.proposedScheduledFor ?? null,
      parent_approval_id: input.parentApprovalId ?? null,
      consumed_at: input.consumedAt ?? null,
      conversation_id: input.conversationId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`approval insert: ${error?.message}`);
  return rowToApproval(data);
}

/** Stamp a freshly minted token (at card render). Refuses decided rows; a
 *  re-render overwrites the prior token (single ACTIVE token per approval). */
export async function stampMintedToken(
  supabase: DB,
  approvalId: string,
  tokenHash: string,
  mintedAt: string,
  expiresAt: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("social_publish_approval")
    .update({ token_hash: tokenHash, minted_at: mintedAt, expires_at: expiresAt, updated_at: mintedAt })
    .eq("id", approvalId)
    .is("consumed_at", null)
    .is("declined_at", null)
    .is("voided_at", null)
    .select("id");
  if (error) throw new Error(`approval mint: ${error.message}`);
  return (data ?? []).length === 1;
}

/** THE atomic consume — see the module docblock. Null = the token is
 *  invalid, already used, expired, declined, or voided (indistinguishable
 *  on purpose: the caller re-renders a fresh card either way). */
export async function consumeByTokenHash(
  supabase: DB,
  tokenHash: string,
  nowIso: string
): Promise<PublishApproval | null> {
  const { data, error } = await supabase
    .from("social_publish_approval")
    .update({ consumed_at: nowIso, updated_at: nowIso })
    .eq("token_hash", tokenHash)
    .is("consumed_at", null)
    .is("declined_at", null)
    .is("voided_at", null)
    .gt("expires_at", nowIso)
    .select("*");
  if (error) throw new Error(`approval consume: ${error.message}`);
  return data && data.length === 1 ? rowToApproval(data[0]) : null;
}

export async function declineApproval(
  supabase: DB,
  approvalId: string,
  nowIso: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("social_publish_approval")
    .update({ declined_at: nowIso, updated_at: nowIso })
    .eq("id", approvalId)
    .is("consumed_at", null)
    .is("declined_at", null)
    .is("voided_at", null)
    .select("id");
  if (error) throw new Error(`approval decline: ${error.message}`);
  return (data ?? []).length === 1;
}

/** Void every OPEN approval for a post (the edit-voids hook + staleness).
 *  Consumed approvals are history — their manifests void separately. */
export async function voidOpenApprovalsForPost(
  supabase: DB,
  socialPostId: string,
  nowIso: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("social_publish_approval")
    .update({ voided_at: nowIso, updated_at: nowIso })
    .eq("social_post_id", socialPostId)
    .is("consumed_at", null)
    .is("declined_at", null)
    .is("voided_at", null)
    .select("id");
  if (error) throw new Error(`approval void: ${error.message}`);
  return (data ?? []).map((r) => r.id);
}
