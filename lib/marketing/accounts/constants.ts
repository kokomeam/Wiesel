/**
 * Connected-accounts constants — imported by BOTH sides (server checks + UI
 * copy) and by the verify suite; never copied (the social/constants.ts
 * precedent). M-A LANGUAGE RULE: this is a connected-account surface —
 * "Connect" and account-health wording only. No publish/schedule copy exists
 * anywhere on the M-A surface (grep-enforced in verify-accounts.ts §language
 * over string literals + JSX text; M-C/M-D cards introduce that vocabulary).
 */

import type { PublishPlatform } from "@/lib/marketing/publish/provider/types";
import { PUBLISH_PLATFORMS } from "@/lib/marketing/publish/provider/types";

export { PUBLISH_PLATFORMS };
export type { PublishPlatform };

export const ACCOUNT_HEALTH_STATES = ["linked", "expired", "revoked"] as const;
export type AccountHealth = (typeof ACCOUNT_HEALTH_STATES)[number];

export const PLATFORM_LABELS: Record<PublishPlatform, string> = {
  linkedin: "LinkedIn",
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
};

/** Platform-prerequisite explainers (plan §9 content). Rendered verbatim on
 *  the account cards — keep them factual and connection-scoped. */
export const PLATFORM_PREREQS: Partial<Record<PublishPlatform, string>> = {
  instagram:
    "Instagram connects through a Business or Creator account that is linked to a Facebook Page. Personal Instagram accounts can't be connected.",
  facebook:
    "Facebook connects at the Page level — the profile you sign in with must manage at least one Facebook Page.",
};

/** Health-state copy shown under the badge on each card. */
export const HEALTH_COPY: Record<AccountHealth, string> = {
  linked: "Connected and healthy.",
  expired: "The connection needs re-authentication — re-link to refresh access.",
  revoked: "This account was disconnected from WiseSel.",
};

/** D5 (checkpoint-approved): there is no per-platform provider-side
 *  disconnect API — disconnecting here revokes the account inside WiseSel;
 *  provider-side access is managed on the secure linking page. */
/** One of the three canonical trust-copy locations (UI-1 W3.8; the others:
 *  the social section notice and the Activity first-run hint). Worded to
 *  respect this surface's banned-copy fence. */
export const ACCOUNTS_TRUST_NOTE =
  "WiseSel never posts anywhere on its own — every outward post waits for your explicit approval.";

export const DISCONNECT_NOTE =
  "Disconnecting removes this account from WiseSel. To also withdraw access on the provider side, open the secure linking page and remove it there.";

/** Self-tracked monthly upload allowance (there is no provider quota-read
 *  endpoint — Task 0a): counted on the social_publish_ledger. Free tier is
 *  10/month; production plans override via env. */
function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const SOCIAL_UPLOADS_PER_MONTH_DEFAULT = 10;
export const SOCIAL_UPLOADS_WARN_AT_DEFAULT = 8;

export function accountsUsageConfig(): { uploadsPerMonth: number; warnAt: number } {
  return {
    uploadsPerMonth: envInt("SOCIAL_UPLOADS_PER_MONTH", SOCIAL_UPLOADS_PER_MONTH_DEFAULT),
    warnAt: envInt("SOCIAL_UPLOADS_WARN_AT", SOCIAL_UPLOADS_WARN_AT_DEFAULT),
  };
}

export type UsageLevel = "ok" | "warning" | "exceeded";

/** Per-account monthly usage view-model (client-safe — the server service
 *  computes it; components render it). */
export interface AccountUsage {
  accountId: string;
  platform: PublishPlatform;
  count: number;
  uploadsPerMonth: number;
  warnAt: number;
  level: UsageLevel;
}

/** Pure threshold logic (unit-tested): warning at warnAt, exceeded at the
 *  monthly allowance. */
export function usageLevel(count: number, uploadsPerMonth: number, warnAt: number): UsageLevel {
  if (count >= uploadsPerMonth) return "exceeded";
  if (count >= warnAt) return "warning";
  return "ok";
}

/** The return-redirect marker appended to the accounts page URL by the
 *  hosted linking flow (`?linked=1` triggers the server-side reconcile). */
export const LINK_RETURN_PARAM = "linked";

/** Words that must never appear in M-A surface copy (grep-enforced). */
export const BANNED_ACCOUNTS_COPY = ["publish", "schedule"] as const;
