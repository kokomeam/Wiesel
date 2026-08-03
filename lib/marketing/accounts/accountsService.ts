/**
 * Connected-accounts service — orchestrates the provider seam + repository +
 * events. SERVER ONLY (decrypts profile refs). Provider and clock are
 * injected for the int suite (the clips render-service `deps` precedent);
 * production callers use `getSocialPublishProvider()`.
 *
 * Health mapping (checkpoint-approved): provider `reauth_required` →
 * `expired`; connected → `linked`; absent-after-linked OR deselected in the
 * multi-account import OR manual disconnect → `revoked` (OUR-side revoke —
 * the provider has no per-platform disconnect API; the hosted linking page
 * is where provider-side access is withdrawn).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type {
  ProviderConnectedAccount,
  PublishPlatform,
  SocialPublishProvider,
} from "@/lib/marketing/publish/provider/types";
import { accountsUsageConfig, usageLevel, type AccountUsage } from "./constants";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "./crypto";
import { emitAccountEvent } from "./events";
import { AccountsNotConfiguredError } from "./errors";
import {
  countUploadsThisMonth,
  getProviderProfile,
  insertAccount,
  insertProviderProfile,
  listAccounts,
  versionedUpdateSocialAccount,
  type SocialAccount,
} from "./accountsRepository";

type DB = SupabaseClient<Database>;

export interface AccountsDeps {
  provider: SocialPublishProvider;
  /** Injected clock (never Date.now() in render paths — repo rule). */
  nowIso?: () => string;
}

const now = () => new Date().toISOString();

/** Mint a provider-side username for a creator. Provider usernames are plain
 *  slugs; the creator id never leaves our side in readable form. */
function mintProfileRef(): string {
  return `ws_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export interface EnsuredProfile {
  rowId: string;
  profileRef: string;
  created: boolean;
}

/** Idempotent per creator: one provider profile, encrypted at rest. A 409
 *  (already exists) from the provider is success. */
export async function ensureProviderProfile(
  supabase: DB,
  creatorId: string,
  deps: AccountsDeps
): Promise<EnsuredProfile> {
  if (!isEncryptionConfigured()) throw new AccountsNotConfiguredError("encryption");
  const existing = await getProviderProfile(supabase, creatorId, deps.provider.id);
  if (existing) {
    return { rowId: existing.id, profileRef: decryptSecret(existing.profileRefEnc), created: false };
  }
  const profileRef = mintProfileRef();
  const result = await deps.provider.createCreatorProfile(profileRef);
  const row = await insertProviderProfile(
    supabase,
    creatorId,
    deps.provider.id,
    encryptSecret(result.profileRef)
  );
  return { rowId: row.id, profileRef: result.profileRef, created: true };
}

/** The hosted linking page URL for this creator (JWT flow, ~48 h validity). */
export async function beginLink(
  supabase: DB,
  creatorId: string,
  platforms: PublishPlatform[],
  redirectUrl: string,
  deps: AccountsDeps
): Promise<{ url: string; expiresInHours: number | null }> {
  const profile = await ensureProviderProfile(supabase, creatorId, deps);
  return deps.provider.getLinkUrl(profile.profileRef, platforms, redirectUrl);
}

export interface ReconcileResult {
  accounts: SocialAccount[];
  /** Platforms that appeared as linked in THIS reconcile (drives the
   *  multi-account keep/revoke selection when more than one arrives). */
  newlyLinked: PublishPlatform[];
}

/**
 * Pull the provider's connected-accounts truth and reconcile our rows:
 * new platform → insert linked (+event) · reauth_required → expired (+event,
 * transition only) · absent-after-linked → revoked (+event, transition only)
 * · reappeared → linked again (+event).
 */
export async function reconcileAccounts(
  supabase: DB,
  creatorId: string,
  courseId: string | null,
  deps: AccountsDeps
): Promise<ReconcileResult> {
  const profile = await ensureProviderProfile(supabase, creatorId, deps);
  const remote = await deps.provider.listConnectedAccounts(profile.profileRef);
  const remoteByPlatform = new Map<PublishPlatform, ProviderConnectedAccount>(
    remote.map((r) => [r.platform, r])
  );
  const local = await listAccounts(supabase, creatorId);
  const localByPlatform = new Map(local.map((a) => [a.platform, a]));
  const syncedAt = (deps.nowIso ?? now)();
  const newlyLinked: PublishPlatform[] = [];

  for (const [platform, r] of remoteByPlatform) {
    const targetStatus = r.reauthRequired ? "expired" : "linked";
    const existing = localByPlatform.get(platform);
    if (!existing) {
      await insertAccount(supabase, creatorId, {
        provider: deps.provider.id,
        platform,
        status: targetStatus,
        displayName: r.displayName,
        handle: r.handle,
        avatarUrl: r.avatarUrl,
        lastSyncedAt: syncedAt,
      });
      if (targetStatus === "linked") {
        newlyLinked.push(platform);
        await emitAccountEvent(supabase, courseId, "social_account_linked", { platform });
      } else {
        await emitAccountEvent(supabase, courseId, "social_account_expired", { platform });
      }
      continue;
    }
    const transitioned = existing.status !== targetStatus;
    await versionedUpdateSocialAccount(supabase, existing.id, existing.version, {
      status: targetStatus,
      display_name: r.displayName,
      handle: r.handle,
      avatar_url: r.avatarUrl,
      last_synced_at: syncedAt,
    });
    if (transitioned) {
      if (targetStatus === "linked") {
        newlyLinked.push(platform);
        await emitAccountEvent(supabase, courseId, "social_account_linked", { platform, relink: true });
      } else {
        await emitAccountEvent(supabase, courseId, "social_account_expired", { platform });
      }
    }
  }

  for (const account of local) {
    if (remoteByPlatform.has(account.platform)) continue;
    if (account.status === "revoked") continue;
    await versionedUpdateSocialAccount(supabase, account.id, account.version, {
      status: "revoked",
      last_synced_at: syncedAt,
    });
    await emitAccountEvent(supabase, courseId, "social_account_revoked", {
      platform: account.platform,
      reason: "absent_at_provider",
    });
  }

  return { accounts: await listAccounts(supabase, creatorId), newlyLinked };
}

/** Multi-account import selection: platforms NOT kept are revoked our-side
 *  (D5 — no per-platform provider disconnect API exists). */
export async function applyImportSelection(
  supabase: DB,
  creatorId: string,
  courseId: string | null,
  keep: PublishPlatform[],
  candidates: PublishPlatform[]
): Promise<SocialAccount[]> {
  const keepSet = new Set(keep);
  const local = await listAccounts(supabase, creatorId);
  for (const account of local) {
    if (!candidates.includes(account.platform)) continue;
    if (keepSet.has(account.platform) || account.status !== "linked") continue;
    await versionedUpdateSocialAccount(supabase, account.id, account.version, { status: "revoked" });
    await emitAccountEvent(supabase, courseId, "social_account_revoked", {
      platform: account.platform,
      reason: "deselected_on_import",
    });
  }
  return listAccounts(supabase, creatorId);
}

/** Manual disconnect — our-side revoke (see DISCONNECT_NOTE). */
export async function disconnectAccount(
  supabase: DB,
  creatorId: string,
  courseId: string | null,
  accountId: string
): Promise<SocialAccount[]> {
  const local = await listAccounts(supabase, creatorId);
  const account = local.find((a) => a.id === accountId);
  if (account && account.status !== "revoked") {
    await versionedUpdateSocialAccount(supabase, account.id, account.version, { status: "revoked" });
    await emitAccountEvent(supabase, courseId, "social_account_revoked", {
      platform: account.platform,
      reason: "manual_disconnect",
    });
  }
  return listAccounts(supabase, creatorId);
}

export type { AccountUsage };

/** Per-account monthly usage from the self-tracked ledger. */
export async function accountsUsage(
  supabase: DB,
  creatorId: string,
  accounts: SocialAccount[],
  nowIso: string
): Promise<AccountUsage[]> {
  const cfg = accountsUsageConfig();
  const counts = await countUploadsThisMonth(supabase, creatorId, nowIso);
  return accounts.map((a) => {
    const count = counts.get(a.id) ?? 0;
    return {
      accountId: a.id,
      platform: a.platform,
      count,
      uploadsPerMonth: cfg.uploadsPerMonth,
      warnAt: cfg.warnAt,
      level: usageLevel(count, cfg.uploadsPerMonth, cfg.warnAt),
    };
  });
}
