"use client";

/**
 * Connected-accounts client surface. LANGUAGE RULE (M-A): connected-account
 * wording only — "Connect", health states, usage. The publish/schedule
 * vocabulary arrives with the M-C/M-D cards; verify-accounts.ts greps every
 * string literal + JSX text on this surface to keep it that way.
 */

import { useMemo, useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { SocialAccount } from "@/lib/marketing/accounts/accountsRepository";
import {
  type AccountUsage,
  ACCOUNTS_TRUST_NOTE,
  DISCONNECT_NOTE,
  PLATFORM_LABELS,
  PUBLISH_PLATFORMS,
  type PublishPlatform,
} from "@/lib/marketing/accounts/constants";
import { beginLinkAction, refreshAccountsAction } from "@/app/(app)/marketing/accounts/actions";
import { AccountCard } from "./AccountCard";
import { MultiImportDialog } from "./MultiImportDialog";

export function AccountsView({
  accounts,
  usage,
  newlyLinked,
  configured,
  reconcileError,
}: {
  accounts: SocialAccount[];
  usage: AccountUsage[];
  newlyLinked: string[];
  configured: boolean;
  reconcileError: string | null;
}) {
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    reconcileError ? { text: reconcileError, error: true } : null
  );
  const [pending, startTransition] = useTransition();
  const [dialogDismissed, setDialogDismissed] = useState(false);

  const byPlatform = useMemo(() => new Map(accounts.map((a) => [a.platform, a])), [accounts]);
  const usageByAccount = useMemo(() => new Map(usage.map((u) => [u.accountId, u])), [usage]);
  const importCandidates = newlyLinked.filter((p): p is PublishPlatform =>
    (PUBLISH_PLATFORMS as readonly string[]).includes(p)
  );
  const showImportDialog = importCandidates.length > 1 && !dialogDismissed;

  function connect(platforms: PublishPlatform[]) {
    startTransition(async () => {
      const res = await beginLinkAction(platforms);
      if (res.url) {
        window.location.assign(res.url);
        return;
      }
      setNotice({ text: res.message, error: Boolean(res.error) });
    });
  }

  function refresh() {
    startTransition(async () => {
      const res = await refreshAccountsAction();
      setNotice(res.error ? { text: res.message, error: true } : null);
    });
  }

  const lastSynced = accounts
    .map((a) => a.lastSyncedAt)
    .filter(Boolean)
    .sort()
    .at(-1);

  return (
    <div className="space-y-6">
      {!configured && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Account linking isn&apos;t configured on this server yet — an administrator needs to set
          the provider API key and the encryption key. The cards below stay read-only until then.
        </div>
      )}
      {notice && (
        <div
          className={
            notice.error
              ? "rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
              : "rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          }
        >
          {notice.text}
        </div>
      )}

      {showImportDialog && (
        <MultiImportDialog
          candidates={importCandidates}
          onDone={() => setDialogDismissed(true)}
        />
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-stone-500">
          {lastSynced ? `Last synced ${new Date(lastSynced).toLocaleString()}` : "Not synced yet."}
        </p>
        <Button variant="outline" size="sm" onClick={refresh} disabled={pending || !configured}>
          <RefreshCw className={pending ? "size-3.5 animate-spin" : "size-3.5"} /> Refresh
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {PUBLISH_PLATFORMS.map((platform) => (
          <AccountCard
            key={platform}
            platform={platform}
            account={byPlatform.get(platform) ?? null}
            usage={
              byPlatform.get(platform)
                ? (usageByAccount.get(byPlatform.get(platform)!.id) ?? null)
                : null
            }
            configured={configured}
            busy={pending}
            onConnect={() => connect([platform])}
            onNotice={(text, error) => setNotice({ text, error })}
          />
        ))}
      </div>

      <p className="text-xs leading-relaxed text-stone-600" data-testid="accounts-trust-note">
        {ACCOUNTS_TRUST_NOTE}
      </p>
      <p className="text-xs leading-relaxed text-stone-500">{DISCONNECT_NOTE}</p>
      <p className="text-xs text-stone-400">
        Prefer one trip? Connect several platforms in a single visit:{" "}
        <button
          type="button"
          className="font-medium text-brand-700 hover:underline disabled:opacity-50"
          disabled={pending || !configured}
          onClick={() => connect([...PUBLISH_PLATFORMS])}
        >
          open the secure linking page for {PLATFORM_LABELS.linkedin}, {PLATFORM_LABELS.youtube} and
          more
        </button>
        .
      </p>
    </div>
  );
}
