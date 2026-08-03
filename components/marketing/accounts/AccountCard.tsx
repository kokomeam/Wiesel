"use client";

import Image from "next/image";
import { useTransition } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { SocialAccount } from "@/lib/marketing/accounts/accountsRepository";
import {
  type AccountUsage,
  HEALTH_COPY,
  PLATFORM_LABELS,
  PLATFORM_PREREQS,
  type AccountHealth,
  type PublishPlatform,
} from "@/lib/marketing/accounts/constants";
import { disconnectAccountAction } from "@/app/(app)/marketing/accounts/actions";

const HEALTH_TONE: Record<AccountHealth, "green" | "amber" | "slate"> = {
  linked: "green",
  expired: "amber",
  revoked: "slate",
};

const HEALTH_LABEL: Record<AccountHealth, string> = {
  linked: "Linked",
  expired: "Needs re-link",
  revoked: "Disconnected",
};

export function AccountCard({
  platform,
  account,
  usage,
  configured,
  busy,
  onConnect,
  onNotice,
}: {
  platform: PublishPlatform;
  account: SocialAccount | null;
  usage: AccountUsage | null;
  configured: boolean;
  busy: boolean;
  onConnect: () => void;
  onNotice: (text: string, error: boolean) => void;
}) {
  const [pending, startTransition] = useTransition();
  const prereq = PLATFORM_PREREQS[platform];
  const disabled = busy || pending || !configured;

  function disconnect() {
    if (!account) return;
    startTransition(async () => {
      const res = await disconnectAccountAction(account.id);
      onNotice(res.message, Boolean(res.error));
    });
  }

  return (
    <div className="rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {account?.avatarUrl ? (
            <Image
              src={account.avatarUrl}
              alt=""
              width={40}
              height={40}
              unoptimized
              className="size-10 rounded-full border border-stone-200 object-cover"
            />
          ) : (
            <div className="flex size-10 items-center justify-center rounded-full bg-stone-100 text-sm font-semibold text-stone-500">
              {PLATFORM_LABELS[platform].slice(0, 2)}
            </div>
          )}
          <div>
            <p className="text-sm font-semibold text-stone-900">{PLATFORM_LABELS[platform]}</p>
            {account ? (
              <p className="text-xs text-stone-500">
                {account.displayName ?? account.handle ?? "Connected account"}
                {account.handle && account.displayName ? ` · ${account.handle}` : ""}
              </p>
            ) : (
              <p className="text-xs text-stone-400">Not connected</p>
            )}
          </div>
        </div>
        {account && (
          <Badge tone={HEALTH_TONE[account.status]} dot>
            {HEALTH_LABEL[account.status]}
          </Badge>
        )}
      </div>

      {account && <p className="mt-3 text-xs text-stone-500">{HEALTH_COPY[account.status]}</p>}
      {!account && prereq && <p className="mt-3 text-xs leading-relaxed text-stone-500">{prereq}</p>}

      {account && usage && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-stone-500">Uploads this month</span>
            <span
              className={
                usage.level === "exceeded"
                  ? "font-semibold text-rose-600"
                  : usage.level === "warning"
                    ? "font-semibold text-amber-600"
                    : "text-stone-600"
              }
            >
              {usage.count} of {usage.uploadsPerMonth}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-stone-100">
            <div
              className={
                usage.level === "exceeded"
                  ? "h-full rounded-full bg-rose-500"
                  : usage.level === "warning"
                    ? "h-full rounded-full bg-amber-500"
                    : "h-full rounded-full bg-emerald-500"
              }
              style={{ width: `${Math.min(100, (usage.count / usage.uploadsPerMonth) * 100)}%` }}
            />
          </div>
          {usage.level === "warning" && (
            <p className="mt-1.5 text-[11px] text-amber-700">
              Approaching this month&apos;s upload allowance ({usage.warnAt}+ of {usage.uploadsPerMonth} used).
            </p>
          )}
          {usage.level === "exceeded" && (
            <p className="mt-1.5 text-[11px] text-rose-700">
              This month&apos;s upload allowance is used up — it resets at the start of next month.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {!account || account.status === "revoked" ? (
          <Button size="sm" onClick={onConnect} disabled={disabled}>
            {account ? "Connect again" : "Connect"}
          </Button>
        ) : (
          <>
            {account.status === "expired" && (
              <Button size="sm" onClick={onConnect} disabled={disabled}>
                Re-link
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={disconnect} disabled={disabled}>
              Disconnect
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
