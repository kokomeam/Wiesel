"use client";

/**
 * The intentional "processing" state for an imported deck: filename + a calm
 * shimmer skeleton of the slide-to-be + a "Preparing preview…" line. Reads as a
 * deliberate course object, not a spinner-in-a-box.
 */

import { FileText, Loader2 } from "lucide-react";
import { formatBytes } from "@/lib/course/imports/deckImportValidation";

export function ImportedDeckProcessingCard({
  fileName,
  fileSize,
  message = "Preparing preview…",
}: {
  fileName: string;
  fileSize?: number;
  message?: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200/80 bg-white" data-ai-deck-status="processing">
      <div className="flex items-center gap-3 border-b border-stone-100 px-4 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600">
          <FileText className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-stone-800">{fileName}</p>
          <p className="flex items-center gap-1.5 text-xs text-stone-400">
            <Loader2 className="size-3 animate-spin text-brand-500" />
            {message}
            {fileSize ? ` · ${formatBytes(fileSize)}` : ""}
          </p>
        </div>
      </div>

      {/* Slide skeleton — a 16:9 shimmer with placeholder content blocks. */}
      <div className="p-4">
        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-stone-100">
          <div className="absolute inset-0 animate-pulse">
            <div className="flex h-full flex-col gap-3 p-6">
              <div className="h-5 w-2/5 rounded bg-stone-200" />
              <div className="h-3 w-3/5 rounded bg-stone-200/80" />
              <div className="mt-auto flex gap-3">
                <div className="h-16 flex-1 rounded bg-stone-200/70" />
                <div className="h-16 flex-1 rounded bg-stone-200/70" />
                <div className="h-16 flex-1 rounded bg-stone-200/70" />
              </div>
            </div>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 flex-1 animate-pulse rounded-md bg-stone-100" />
          ))}
        </div>
      </div>
    </div>
  );
}
