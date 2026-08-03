"use client";

/**
 * Multi-account import selection — the hosted linking flow can bring back
 * MORE platforms than the creator set out to connect. When several arrive at
 * once, the creator chooses which to keep; the rest are revoked our-side
 * (see DISCONNECT_NOTE — the provider has no per-platform disconnect API).
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { PLATFORM_LABELS, type PublishPlatform } from "@/lib/marketing/accounts/constants";
import { keepSelectionAction } from "@/app/(app)/marketing/accounts/actions";

export function MultiImportDialog({
  candidates,
  onDone,
}: {
  candidates: PublishPlatform[];
  onDone: () => void;
}) {
  const [keep, setKeep] = useState<Set<PublishPlatform>>(new Set(candidates));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle(platform: PublishPlatform) {
    setKeep((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  }

  function confirm() {
    startTransition(async () => {
      const res = await keepSelectionAction([...keep], candidates);
      if (res.error) {
        setError(res.message);
        return;
      }
      onDone();
      window.location.assign("/marketing/accounts");
    });
  }

  return (
    <div className="rounded-2xl border border-brand-200 bg-brand-50/60 p-5">
      <p className="text-sm font-semibold text-stone-900">
        {candidates.length} accounts came back from the linking page
      </p>
      <p className="mt-1 text-xs text-stone-600">
        Keep the ones you want WiseSel to work with — anything you leave unchecked is disconnected
        from WiseSel.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        {candidates.map((platform) => (
          <label
            key={platform}
            className="flex cursor-pointer items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-800"
          >
            <input
              type="checkbox"
              checked={keep.has(platform)}
              onChange={() => toggle(platform)}
              className="accent-orange-600"
            />
            {PLATFORM_LABELS[platform]}
          </label>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
      <div className="mt-4 flex gap-2">
        <Button size="sm" onClick={confirm} disabled={pending || keep.size === 0}>
          Keep {keep.size} {keep.size === 1 ? "account" : "accounts"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={pending}>
          Keep all
        </Button>
      </div>
    </div>
  );
}
