"use client";

/**
 * Learner-runtime error boundary (/learn/*). Renders inside the minimal
 * public learn shell. Friendly recovery card; the raw message stays behind
 * a <details> for debugging.
 */

import { useEffect } from "react";
import Link from "next/link";
import { CloudOff } from "lucide-react";
import { Button } from "@/components/ui/Button";

export default function LearnError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[learn] route error", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col items-center justify-center px-6 py-16">
      <div className="w-full rounded-2xl border border-stone-200/80 bg-white p-8 text-center shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-amber-50 text-amber-600">
          <CloudOff className="size-6" aria-hidden />
        </span>
        <p className="mt-5 font-mono text-[11px] uppercase tracking-wider text-stone-400">
          Unexpected error
        </p>
        <h1 className="mt-2 text-2xl [font-family:var(--font-display)] font-light text-stone-900">
          Something went sideways
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-stone-500">
          This lesson page hit a snag while loading. Your progress is saved —
          trying again usually clears it.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={reset}>Try again</Button>
          <Link
            href="/"
            className="inline-flex h-9 items-center rounded-full border border-stone-300/80 bg-white px-4 text-sm font-medium text-stone-700 transition-colors hover:border-stone-400 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            Go home
          </Link>
        </div>
        <details className="mt-6 text-left">
          <summary className="cursor-pointer text-xs text-stone-400 hover:text-stone-600">
            Technical details
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-xl bg-stone-50 p-3 text-left font-mono text-[11px] leading-relaxed text-stone-500">
            {error.digest ? `digest: ${error.digest}\n` : ""}
            {error.message || "No error message available."}
          </pre>
        </details>
      </div>
    </div>
  );
}
