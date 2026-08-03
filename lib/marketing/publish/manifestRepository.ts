/**
 * social_publish_manifest repository — EVERY read/write of the manifest
 * table lives here (the accountsRepository/clip jobs precedent; the publish
 * verify suite greps the repo to keep it that way).
 *
 * THE WRITE RULES:
 *   - `createPublishManifest` is the only insert.
 *   - `transitionPublishManifest` is the only STATUS write: legal-edge check
 *     against PUBLISH_MANIFEST_TRANSITIONS, then optimistic `eq(status,
 *     from)` — a concurrent tick racing the same manifest loses cleanly
 *     (ManifestTransitionError), never double-advances. Every write bumps
 *     `version` (the versioned-writes invariant).
 *   - `reschedulePublishManifest` is the only non-status content write:
 *     scheduled_for, optimistic on version, refused outside queued/held.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { PublishPlatform } from "./provider/types";
import {
  CANCELLABLE_MANIFEST_STATUSES,
  PUBLISH_MANIFEST_TRANSITIONS,
  type PublishManifestStatus,
  ACTIVE_MANIFEST_STATUSES,
} from "./manifest";

type DB = SupabaseClient<Database>;
type ManifestRow = Database["public"]["Tables"]["social_publish_manifest"]["Row"];

export class ManifestTransitionError extends Error {
  constructor(
    readonly manifestId: string,
    readonly from: PublishManifestStatus,
    readonly to: PublishManifestStatus,
    detail: string
  ) {
    super(`publish manifest ${manifestId}: ${from} → ${to} refused (${detail})`);
    this.name = "ManifestTransitionError";
  }
}

export interface PublishManifest {
  id: string;
  creatorId: string;
  socialPostId: string;
  socialAccountId: string;
  platform: PublishPlatform;
  status: PublishManifestStatus;
  approvalId: string;
  approvedVia: "card";
  contentHash: string;
  scheduledFor: string | null;
  holdReason: string | null;
  providerRequestId: string | null;
  platformPostId: string | null;
  postUrl: string | null;
  attempt: number;
  lastError: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function rowToPublishManifest(row: ManifestRow): PublishManifest {
  return {
    id: row.id,
    creatorId: row.creator_id,
    socialPostId: row.social_post_id,
    socialAccountId: row.social_account_id,
    platform: row.platform as PublishPlatform,
    status: row.status as PublishManifestStatus,
    approvalId: row.approval_id,
    approvedVia: row.approved_via as "card",
    contentHash: row.content_hash,
    scheduledFor: row.scheduled_for,
    holdReason: row.hold_reason,
    providerRequestId: row.provider_request_id,
    platformPostId: row.platform_post_id,
    postUrl: row.post_url,
    attempt: row.attempt,
    lastError: row.last_error,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ────────────────────────────── reads ─────────────────────────────────── */

export async function getPublishManifest(supabase: DB, id: string): Promise<PublishManifest | null> {
  const { data, error } = await supabase
    .from("social_publish_manifest")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`publish manifest read: ${error.message}`);
  return data ? rowToPublishManifest(data) : null;
}

export async function listActivePublishManifests(
  supabase: DB,
  limit: number,
  creatorId?: string
): Promise<PublishManifest[]> {
  let query = supabase
    .from("social_publish_manifest")
    .select("*")
    .in("status", [...ACTIVE_MANIFEST_STATUSES])
    .order("created_at", { ascending: true })
    .limit(limit);
  if (creatorId) query = query.eq("creator_id", creatorId);
  const { data, error } = await query;
  if (error) throw new Error(`publish manifest active list: ${error.message}`);
  return (data ?? []).map(rowToPublishManifest);
}

/** Recent manifests for the review surface (any status — the scheduled list
 *  + retry-able failures + terminal history all read from here). */
export async function listRecentPublishManifests(
  supabase: DB,
  creatorId: string,
  limit = 20
): Promise<PublishManifest[]> {
  const { data, error } = await supabase
    .from("social_publish_manifest")
    .select("*")
    .eq("creator_id", creatorId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`publish manifest recent list: ${error.message}`);
  return (data ?? []).map(rowToPublishManifest);
}

export async function listPublishManifestsForPost(
  supabase: DB,
  socialPostId: string
): Promise<PublishManifest[]> {
  const { data, error } = await supabase
    .from("social_publish_manifest")
    .select("*")
    .eq("social_post_id", socialPostId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`publish manifest post list: ${error.message}`);
  return (data ?? []).map(rowToPublishManifest);
}

/* ────────────────────────────── writes ────────────────────────────────── */

export interface CreatePublishManifestInput {
  creatorId: string;
  socialPostId: string;
  socialAccountId: string;
  platform: PublishPlatform;
  /** The CONSUMED card (or retry-clone) approval — the sole path in (M-C).
   *  NOT NULL + UNIQUE in the DB: one approval mints one manifest, ever. */
  approvalId: string;
  contentHash: string;
  scheduledFor?: string | null;
}

/** THE only insert. The returned row id is the provider clientRef — it
 *  exists durably BEFORE any provider call (M-B decision 2). M-C: refuses
 *  without an approval id (runtime assert; the DB FK backs it). */
export async function createPublishManifest(
  supabase: DB,
  input: CreatePublishManifestInput
): Promise<PublishManifest> {
  if (!input.approvalId || !input.contentHash) {
    throw new Error("createPublishManifest requires a consumed card approval (card-sole-path)");
  }
  const { data, error } = await supabase
    .from("social_publish_manifest")
    .insert({
      creator_id: input.creatorId,
      social_post_id: input.socialPostId,
      social_account_id: input.socialAccountId,
      platform: input.platform,
      approval_id: input.approvalId,
      content_hash: input.contentHash,
      approved_via: "card",
      scheduled_for: input.scheduledFor ?? null,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`publish manifest insert: ${error?.message}`);
  return rowToPublishManifest(data);
}

/** Void every live-but-unsent (queued/held) manifest for a post — the
 *  edit-voids invariant's manifest half. Runs through the single transition
 *  path; returns the voided manifests. */
export async function voidLiveManifestsForPost(
  supabase: DB,
  socialPostId: string,
  cause: "post_edited" | "approval_stale"
): Promise<PublishManifest[]> {
  const { data, error } = await supabase
    .from("social_publish_manifest")
    .select("*")
    .eq("social_post_id", socialPostId)
    .in("status", ["queued", "held"]);
  if (error) throw new Error(`publish manifest void list: ${error.message}`);
  const voided: PublishManifest[] = [];
  for (const row of data ?? []) {
    const m = rowToPublishManifest(row);
    try {
      voided.push(
        await transitionPublishManifest(supabase, m, m.status, "voided", {
          lastError: { message: `approval voided (${cause})` },
        })
      );
    } catch (err) {
      // A concurrent transition (e.g. the fire path racing into submitting)
      // wins the status lock — the pre-submit hash re-check still stops a
      // stale publish; nothing to do here.
      if (!(err instanceof ManifestTransitionError)) throw err;
    }
  }
  return voided;
}

export interface ManifestTransitionPatch {
  holdReason?: string | null;
  providerRequestId?: string | null;
  platformPostId?: string | null;
  postUrl?: string | null;
  lastError?: unknown;
  bumpAttempt?: boolean;
}

/** THE single status write path (see the module docblock). */
export async function transitionPublishManifest(
  supabase: DB,
  manifest: Pick<PublishManifest, "id" | "attempt">,
  from: PublishManifestStatus,
  to: PublishManifestStatus,
  patch: ManifestTransitionPatch = {}
): Promise<PublishManifest> {
  if (!PUBLISH_MANIFEST_TRANSITIONS[from]?.includes(to)) {
    throw new ManifestTransitionError(manifest.id, from, to, "illegal transition");
  }
  const update: Database["public"]["Tables"]["social_publish_manifest"]["Update"] = {
    status: to,
    updated_at: new Date().toISOString(),
  };
  if (patch.holdReason !== undefined) update.hold_reason = patch.holdReason;
  if (patch.providerRequestId !== undefined) update.provider_request_id = patch.providerRequestId;
  if (patch.platformPostId !== undefined) update.platform_post_id = patch.platformPostId;
  if (patch.postUrl !== undefined) update.post_url = patch.postUrl;
  if (patch.lastError !== undefined) update.last_error = patch.lastError as Json;
  if (patch.bumpAttempt) update.attempt = manifest.attempt + 1;

  const { data, error } = await supabase
    .from("social_publish_manifest")
    .update(update)
    .eq("id", manifest.id)
    .eq("status", from)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`publish manifest transition: ${error.message}`);
  if (!data) throw new ManifestTransitionError(manifest.id, from, to, "row moved (concurrent transition)");

  // Version bump rides separately so the optimistic guard stays on status
  // (the transition IS the lock); reschedule locks on version instead.
  const { data: bumped, error: bumpErr } = await supabase
    .from("social_publish_manifest")
    .update({ version: data.version + 1 })
    .eq("id", manifest.id)
    .eq("version", data.version)
    .select("*")
    .maybeSingle();
  if (bumpErr) throw new Error(`publish manifest version bump: ${bumpErr.message}`);
  return rowToPublishManifest(bumped ?? data);
}

/** Attempt-counter bump WITHOUT a status change (recovery/verify polling
 *  ticks that stay in place). Optimistic on the current status. */
export async function bumpManifestAttempt(
  supabase: DB,
  manifest: Pick<PublishManifest, "id" | "attempt" | "status">
): Promise<void> {
  const { error } = await supabase
    .from("social_publish_manifest")
    .update({ attempt: manifest.attempt + 1, updated_at: new Date().toISOString() })
    .eq("id", manifest.id)
    .eq("status", manifest.status);
  if (error) throw new Error(`publish manifest attempt bump: ${error.message}`);
}

/** THE only non-status content write: reschedule while queued/held,
 *  optimistic on version (AccountVersionConflict-style semantics). */
export async function reschedulePublishManifest(
  supabase: DB,
  manifest: Pick<PublishManifest, "id" | "version" | "status">,
  scheduledFor: string | null
): Promise<PublishManifest> {
  if (!CANCELLABLE_MANIFEST_STATUSES.includes(manifest.status)) {
    throw new ManifestTransitionError(
      manifest.id,
      manifest.status,
      manifest.status,
      "reschedule is only legal while queued or held"
    );
  }
  const { data, error } = await supabase
    .from("social_publish_manifest")
    .update({
      scheduled_for: scheduledFor,
      version: manifest.version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", manifest.id)
    .eq("version", manifest.version)
    .in("status", [...CANCELLABLE_MANIFEST_STATUSES])
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`publish manifest reschedule: ${error.message}`);
  if (!data) {
    throw new ManifestTransitionError(
      manifest.id,
      manifest.status,
      manifest.status,
      "row moved (version conflict or no longer reschedulable)"
    );
  }
  return rowToPublishManifest(data);
}
