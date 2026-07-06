"use client";

/**
 * Friendly failed-conversion state. Reassuring headline, the technical reason
 * kept subtle, and clear recovery actions: retry, replace the file, or download
 * the original. Never alarming red walls.
 */

import { useRef, useState } from "react";
import { Download, RefreshCw, TriangleAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DECK_ACCEPT_ATTR } from "@/lib/course/imports/deckImportValidation";

export function ImportedDeckFailedCard({
  fileName,
  error,
  busy,
  onRetry,
  onReplace,
  onDownload,
}: {
  fileName: string;
  error?: string | null;
  busy?: boolean;
  onRetry: () => void;
  onReplace: (file: File) => void;
  onDownload: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  return (
    <div
      className="overflow-hidden rounded-xl border border-amber-200/80 bg-amber-50/40"
      data-ai-deck-status="failed"
    >
      <input
        ref={inputRef}
        type="file"
        accept={DECK_ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onReplace(f);
          e.target.value = "";
        }}
      />
      <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
        <span className="grid size-11 place-items-center rounded-2xl bg-amber-100 text-amber-600">
          <TriangleAlert className="size-5.5" />
        </span>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-stone-800">
            We couldn&apos;t prepare a preview for this deck.
          </p>
          <p className="mx-auto max-w-sm text-xs text-stone-500">
            <span className="font-medium text-stone-600">{fileName}</span>
            {error ? ` — ${error}` : ""} You can try again, swap in a different
            file, or download the original.
          </p>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              setBusyAction("retry");
              onRetry();
            }}
            disabled={busy}
          >
            <RefreshCw className={busy && busyAction === "retry" ? "size-3.5 animate-spin" : "size-3.5"} />
            Try again
          </Button>
          <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            <Upload className="size-3.5" />
            Replace file
          </Button>
          <Button variant="ghost" size="sm" onClick={onDownload} disabled={busy}>
            <Download className="size-3.5" />
            Download original
          </Button>
        </div>
      </div>
    </div>
  );
}
