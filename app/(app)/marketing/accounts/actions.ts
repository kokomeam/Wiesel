"use server";

/**
 * Server actions for the connected-accounts surface. Author-scoped (the
 * server client carries the session; RLS authorizes every row). All provider
 * traffic happens HERE — the client only ever receives the hosted linking
 * URL and the reconciled account rows (never the API key, never a profile
 * ref, plain or encrypted).
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { selectCourseForAuthor } from "@/lib/marketing/persistence";
import {
  getSocialPublishProvider,
  isPublishProviderConfigured,
} from "@/lib/marketing/publish/provider";
import type { PublishPlatform } from "@/lib/marketing/publish/provider/types";
import { PUBLISH_PLATFORMS } from "@/lib/marketing/publish/provider/types";
import { isEncryptionConfigured } from "@/lib/marketing/accounts/crypto";
import { LINK_RETURN_PARAM } from "@/lib/marketing/accounts/constants";
import {
  applyImportSelection,
  beginLink,
  disconnectAccount,
  reconcileAccounts,
} from "@/lib/marketing/accounts/accountsService";

export interface AccountsActionResult {
  message: string;
  url?: string;
  error?: boolean;
}

async function authed() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const course = await selectCourseForAuthor(supabase, user.id, null);
  return { supabase, user, courseId: course?.id ?? null };
}

function configError(): AccountsActionResult | null {
  if (!isPublishProviderConfigured()) {
    return { message: "Account linking isn't configured — set UPLOAD_POST_API_KEY on the server.", error: true };
  }
  if (!isEncryptionConfigured()) {
    return {
      message: "Account linking isn't configured — set SOCIAL_ACCOUNTS_ENC_KEY on the server (openssl rand -base64 32).",
      error: true,
    };
  }
  return null;
}

function sanitizePlatforms(input: string[]): PublishPlatform[] {
  return input.filter((p): p is PublishPlatform =>
    (PUBLISH_PLATFORMS as readonly string[]).includes(p)
  );
}

/** Start the hosted linking flow — returns the secure linking URL; the
 *  client navigates to it and the flow returns to ?linked=1. */
export async function beginLinkAction(platforms: string[]): Promise<AccountsActionResult> {
  const ctx = await authed();
  if (!ctx) return { message: "Sign in to connect accounts.", error: true };
  const cfg = configError();
  if (cfg) return cfg;
  try {
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const redirectUrl = `${site.replace(/\/$/, "")}/marketing/accounts?${LINK_RETURN_PARAM}=1`;
    const { url } = await beginLink(ctx.supabase, ctx.user.id, sanitizePlatforms(platforms), redirectUrl, {
      provider: getSocialPublishProvider(),
    });
    return { message: "Opening the secure linking page…", url };
  } catch (err) {
    return { message: err instanceof Error ? err.message : "Linking failed.", error: true };
  }
}

/** Re-pull the provider's connection truth into our rows. */
export async function refreshAccountsAction(): Promise<AccountsActionResult> {
  const ctx = await authed();
  if (!ctx) return { message: "Sign in first.", error: true };
  const cfg = configError();
  if (cfg) return cfg;
  try {
    await reconcileAccounts(ctx.supabase, ctx.user.id, ctx.courseId, {
      provider: getSocialPublishProvider(),
    });
    revalidatePath("/marketing/accounts");
    return { message: "Accounts refreshed." };
  } catch (err) {
    return { message: err instanceof Error ? err.message : "Refresh failed.", error: true };
  }
}

/** Multi-account import: keep the selected platforms, revoke the rest of the
 *  newly linked set (our-side — see DISCONNECT_NOTE). */
export async function keepSelectionAction(
  keep: string[],
  candidates: string[]
): Promise<AccountsActionResult> {
  const ctx = await authed();
  if (!ctx) return { message: "Sign in first.", error: true };
  try {
    await applyImportSelection(
      ctx.supabase,
      ctx.user.id,
      ctx.courseId,
      sanitizePlatforms(keep),
      sanitizePlatforms(candidates)
    );
    revalidatePath("/marketing/accounts");
    return { message: "Selection saved." };
  } catch (err) {
    return { message: err instanceof Error ? err.message : "Saving the selection failed.", error: true };
  }
}

export async function disconnectAccountAction(accountId: string): Promise<AccountsActionResult> {
  const ctx = await authed();
  if (!ctx) return { message: "Sign in first.", error: true };
  try {
    await disconnectAccount(ctx.supabase, ctx.user.id, ctx.courseId, accountId);
    revalidatePath("/marketing/accounts");
    return { message: "Account disconnected from WiseSel." };
  } catch (err) {
    return { message: err instanceof Error ? err.message : "Disconnect failed.", error: true };
  }
}
