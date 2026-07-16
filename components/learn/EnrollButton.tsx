"use client";

/**
 * One-click enrollment. POSTs /api/learn/enroll then refreshes the server
 * component tree so the landing (or marketplace) re-renders enrolled state.
 */

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";

export function EnrollButton({
  courseId,
  className,
  label = "Enroll — it's free",
  onEnrolled,
}: {
  courseId: string;
  className?: string;
  label?: string;
  onEnrolled?: () => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enroll() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/learn/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // M-D: thread the clip short-link ref (if this visit came from one)
        // so enrollment attribution can trace the clip.
        body: JSON.stringify({ courseId, refCode: searchParams.get("ref") ?? undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Enrollment failed — please try again.");
      }
      onEnrolled?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enrollment failed — please try again.");
      setBusy(false);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => void enroll()}
        disabled={busy}
        data-ai-tool="learn-enroll"
        className={cn(
          "brand-gradient flex h-10 w-full items-center justify-center rounded-full text-sm font-medium text-white shadow-sm shadow-brand-600/25 transition-opacity hover:opacity-95",
          busy && "pointer-events-none opacity-60"
        )}
      >
        {busy ? "Enrolling…" : label}
      </button>
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
