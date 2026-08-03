/**
 * Repository — EVERY read/write of social_provider_profile / social_account /
 * social_publish_ledger lives here (the social/repository.ts precedent;
 * verify-accounts.ts greps the repo to keep it that way).
 *
 * THE VERSIONED-UPDATE RULE: the only legal social_account mutation is
 * `versionedUpdateSocialAccount` —
 *   update … set …, version = version + 1
 *     where id = $1 and version = $2 returning *;
 * Zero rows ⇒ AccountVersionConflictError. The ledger is append-only (no
 * update path exists at all — spend can't be unspent).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { AccountHealth, PublishPlatform } from "./constants";
import { AccountVersionConflictError } from "./errors";

type DB = SupabaseClient<Database>;
type ProfileRow = Database["public"]["Tables"]["social_provider_profile"]["Row"];
type AccountRow = Database["public"]["Tables"]["social_account"]["Row"];
type LedgerInsert = Database["public"]["Tables"]["social_publish_ledger"]["Insert"];

/* ────────────────────────────── mapping ─────────────────────────────── */

export interface ProviderProfile {
  id: string;
  creatorId: string;
  provider: string;
  profileRefEnc: string;
  version: number;
  createdAt: string;
}

export interface SocialAccount {
  id: string;
  creatorId: string;
  provider: string;
  platform: PublishPlatform;
  status: AccountHealth;
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  lastSyncedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function rowToProviderProfile(row: ProfileRow): ProviderProfile {
  return {
    id: row.id,
    creatorId: row.creator_id,
    provider: row.provider,
    profileRefEnc: row.profile_ref_enc,
    version: row.version,
    createdAt: row.created_at,
  };
}

export function rowToSocialAccount(row: AccountRow): SocialAccount {
  return {
    id: row.id,
    creatorId: row.creator_id,
    provider: row.provider,
    platform: row.platform as PublishPlatform,
    status: row.status as AccountHealth,
    displayName: row.display_name,
    handle: row.handle,
    avatarUrl: row.avatar_url,
    lastSyncedAt: row.last_synced_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/* ────────────────────────────── reads ───────────────────────────────── */

export async function getProviderProfile(
  supabase: DB,
  creatorId: string,
  provider: string
): Promise<ProviderProfile | null> {
  const { data, error } = await supabase
    .from("social_provider_profile")
    .select("*")
    .eq("creator_id", creatorId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new Error(`getProviderProfile: ${error.message}`);
  return data ? rowToProviderProfile(data) : null;
}

export async function listAccounts(supabase: DB, creatorId: string): Promise<SocialAccount[]> {
  const { data, error } = await supabase
    .from("social_account")
    .select("*")
    .eq("creator_id", creatorId)
    .order("platform");
  if (error) throw new Error(`listAccounts: ${error.message}`);
  return (data ?? []).map(rowToSocialAccount);
}

/** Ledger rows per account since the start of the CURRENT month (UTC) — the
 *  self-tracked monthly usage (no provider quota-read endpoint exists). */
export async function countUploadsThisMonth(
  supabase: DB,
  creatorId: string,
  nowIso: string
): Promise<Map<string, number>> {
  const monthStart = `${nowIso.slice(0, 7)}-01T00:00:00.000Z`;
  const { data, error } = await supabase
    .from("social_publish_ledger")
    .select("social_account_id")
    .eq("creator_id", creatorId)
    .gte("created_at", monthStart);
  if (error) throw new Error(`countUploadsThisMonth: ${error.message}`);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    counts.set(row.social_account_id, (counts.get(row.social_account_id) ?? 0) + 1);
  }
  return counts;
}

/** Whether a ledger row already exists for a clientRef (the manifest id) —
 *  M-B's ledger write is made idempotent by this check-before-insert (the
 *  table is append-only; a crash between insert and the status transition
 *  must not double-count on replay). */
export async function ledgerRowExistsForClientRef(
  supabase: DB,
  creatorId: string,
  clientRef: string
): Promise<boolean> {
  const { count, error } = await supabase
    .from("social_publish_ledger")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", creatorId)
    .eq("client_ref", clientRef);
  if (error) throw new Error(`ledgerRowExistsForClientRef: ${error.message}`);
  return (count ?? 0) > 0;
}

/* ────────────────────────────── writes ──────────────────────────────── */

export async function insertProviderProfile(
  supabase: DB,
  creatorId: string,
  provider: string,
  profileRefEnc: string
): Promise<ProviderProfile> {
  const { data, error } = await supabase
    .from("social_provider_profile")
    .insert({ creator_id: creatorId, provider, profile_ref_enc: profileRefEnc })
    .select("*")
    .single();
  if (error || !data) throw new Error(`insertProviderProfile: ${error?.message}`);
  return rowToProviderProfile(data);
}

export async function insertAccount(
  supabase: DB,
  creatorId: string,
  input: {
    provider: string;
    platform: PublishPlatform;
    status: AccountHealth;
    displayName: string | null;
    handle: string | null;
    avatarUrl: string | null;
    lastSyncedAt: string;
  }
): Promise<SocialAccount> {
  const { data, error } = await supabase
    .from("social_account")
    .insert({
      creator_id: creatorId,
      provider: input.provider,
      platform: input.platform,
      status: input.status,
      display_name: input.displayName,
      handle: input.handle,
      avatar_url: input.avatarUrl,
      last_synced_at: input.lastSyncedAt,
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`insertAccount: ${error?.message}`);
  return rowToSocialAccount(data);
}

/** THE versioned account update (see the module docblock). */
export async function versionedUpdateSocialAccount(
  supabase: DB,
  id: string,
  expectedVersion: number,
  set: Partial<
    Pick<AccountRow, "status" | "display_name" | "handle" | "avatar_url" | "last_synced_at">
  >
): Promise<SocialAccount> {
  const { data, error } = await supabase
    .from("social_account")
    .update({ ...set, version: expectedVersion + 1, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("version", expectedVersion)
    .select("*");
  if (error) throw new Error(`versionedUpdateSocialAccount: ${error.message}`);
  if (!data || data.length === 0) throw new AccountVersionConflictError(id);
  return rowToSocialAccount(data[0]);
}

/** Append-only usage ledger — M-B's publish path writes here the moment the
 *  provider ACCEPTS an upload (client_ref = the manifest id). M-B decision 4
 *  (2026-07-29, binding): SKIP the row when the response carries a
 *  platformError — mirrors the vendor's proven quota semantics. An
 *  accepted-then-platform-failed upload may over-count by one; that drift is
 *  accepted — no provider quota-read endpoint exists to reconcile against,
 *  and over-counting errs toward warning the creator early (the safe
 *  direction). */
export async function insertLedgerRow(
  supabase: DB,
  input: Omit<LedgerInsert, "id">
): Promise<string> {
  const { data, error } = await supabase
    .from("social_publish_ledger")
    .insert(input)
    .select("id")
    .single();
  if (error || !data) throw new Error(`insertLedgerRow: ${error?.message}`);
  return data.id;
}
