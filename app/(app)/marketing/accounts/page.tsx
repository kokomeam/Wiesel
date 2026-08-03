/**
 * Connected accounts (M-A) — the creator's social account linking surface:
 * per-platform cards (health: linked / expired / revoked), the hosted
 * linking flow, the multi-account import selection, and the self-tracked
 * monthly usage meter. Accounts are CREATOR-level: unlike the other
 * /marketing pages this one renders without a course (the course context is
 * only used for event telemetry).
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { selectCourseForAuthor } from "@/lib/marketing/persistence";
import {
  getSocialPublishProvider,
  isPublishProviderConfigured,
} from "@/lib/marketing/publish/provider";
import { isEncryptionConfigured } from "@/lib/marketing/accounts/crypto";
import { LINK_RETURN_PARAM } from "@/lib/marketing/accounts/constants";
import { listAccounts, type SocialAccount } from "@/lib/marketing/accounts/accountsRepository";
import {
  accountsUsage,
  reconcileAccounts,
  type AccountUsage,
} from "@/lib/marketing/accounts/accountsService";
import { AccountsView } from "@/components/marketing/accounts/AccountsView";

export const dynamic = "force-dynamic";

export default async function ConnectedAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ [LINK_RETURN_PARAM]?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null; // the (app) layout redirects signed-out visitors

  const params = await searchParams;
  const course = await selectCourseForAuthor(supabase, user.id, null);
  const configured = isPublishProviderConfigured() && isEncryptionConfigured();

  let accounts: SocialAccount[] = [];
  let newlyLinked: string[] = [];
  let reconcileError: string | null = null;

  if (params[LINK_RETURN_PARAM] === "1" && configured) {
    // Returning from the hosted linking flow — pull the provider's truth.
    try {
      const result = await reconcileAccounts(supabase, user.id, course?.id ?? null, {
        provider: getSocialPublishProvider(),
      });
      accounts = result.accounts;
      newlyLinked = result.newlyLinked;
    } catch (err) {
      reconcileError = err instanceof Error ? err.message : "Syncing accounts failed.";
      accounts = await listAccounts(supabase, user.id);
    }
  } else {
    accounts = await listAccounts(supabase, user.id);
  }

  let usage: AccountUsage[] = [];
  try {
    usage = await accountsUsage(supabase, user.id, accounts, new Date().toISOString());
  } catch {
    // usage is decorative on this surface — the cards still render
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/marketing"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-stone-500 hover:text-stone-800"
        >
          <ArrowLeft className="size-3.5" /> Marketing
        </Link>
      </div>
      <PageHeader
        title="Connected accounts"
        description="Link the social accounts WiseSel works with. Connections are per-platform and you stay in control of each one."
      />
      <div className="mt-6">
        <AccountsView
          accounts={accounts}
          usage={usage}
          newlyLinked={newlyLinked}
          configured={configured}
          reconcileError={reconcileError}
        />
      </div>
    </div>
  );
}
