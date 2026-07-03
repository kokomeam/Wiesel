"use client";

/**
 * Renders an imported-deck block. Reads LIVE status (+ signed page URLs) from
 * the server via useDeckImport, mirrors terminal status changes back into the
 * block snapshot so the persisted doc stays accurate, and shows the right
 * surface: processing card · failed card · rail viewer.
 *
 * Imported decks deliberately bypass the native slide pipeline (no SlideElement
 * materializer, no editable canvas) — they are asset-backed presentations.
 */

import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { deleteBlockPatch, updateImportedDeckPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { ImportedDeckBlock as ImportedDeckBlockType } from "@/lib/course/types";
import { ImportedDeckFailedCard } from "./ImportedDeckFailedCard";
import { ImportedDeckProcessingCard } from "./ImportedDeckProcessingCard";
import { ImportedDeckViewer } from "./ImportedDeckViewer";
import { useDeckImport } from "./useDeckImport";

export function ImportedDeckBlock({
  block,
  lessonId,
}: {
  block: ImportedDeckBlockType;
  lessonId: string;
}) {
  const apply = useEditorStore((s) => s.apply);
  const deck = useDeckImport(block.deckImportId, { initialStatus: block.status });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Mirror terminal/file changes from the live row into the block snapshot, so a
  // reload renders the right state instantly + the doc persists "ready".
  useEffect(() => {
    const v = deck.view;
    if (!v) return;
    const changed =
      v.status !== block.status ||
      v.originalFileName !== block.originalFileName ||
      (v.status === "ready" && (v.pageCount ?? undefined) !== block.pageCount);
    if (!changed) return;
    apply(
      updateImportedDeckPatch(block.id, {
        status: v.status,
        pageCount: v.pageCount,
        error: v.error,
        title: v.title,
        originalFileName: v.originalFileName,
        originalMimeType: v.originalMimeType,
        originalFileSize: v.originalFileSize,
        updatedAt: v.updatedAt,
      }),
      "human"
    );
  }, [deck.view, block.id, block.status, block.pageCount, block.originalFileName, apply]);

  async function handleRetry() {
    setBusy(true);
    setActionError(null);
    const ok = await deck.retry();
    if (!ok) setActionError("We couldn't start processing again. Please try again.");
    setBusy(false);
  }

  async function handleReplace(file: File) {
    setBusy(true);
    setActionError(null);
    const res = await deck.replace(file);
    if (!res) setActionError("We couldn't replace that deck — check the file type and size, then try again.");
    setBusy(false);
  }

  async function handleRemove() {
    const ok = await deck.remove();
    // Remove the block regardless — a failed asset cleanup is reaped later, and
    // leaving a broken block in the lesson is worse than an orphaned row.
    if (ok || true) apply(deleteBlockPatch(lessonId, block.id), "human");
  }

  // Hard error with nothing to show (e.g. the row was deleted elsewhere).
  if (deck.error && !deck.view) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-3">
        <p className="flex items-center gap-2 text-sm text-stone-500">
          <AlertCircle className="size-4 text-stone-400" />
          {deck.error}
        </p>
        <button onClick={() => void deck.refetch()} className="text-xs font-medium text-brand-600 hover:underline">
          Retry
        </button>
      </div>
    );
  }

  // First paint before the initial fetch resolves: use the block's snapshot.
  const status = deck.view?.status ?? block.status;
  const fileName = deck.view?.originalFileName ?? block.originalFileName;
  const fileSize = deck.view?.originalFileSize ?? block.originalFileSize;

  let surface: ReactNode;
  if (status === "uploaded" || status === "processing") {
    surface = <ImportedDeckProcessingCard fileName={fileName} fileSize={fileSize} />;
  } else if (status === "failed") {
    surface = (
      <ImportedDeckFailedCard
        fileName={fileName}
        error={deck.view?.error ?? block.error}
        busy={busy}
        onRetry={handleRetry}
        onReplace={handleReplace}
        onDownload={() => void deck.downloadOriginal()}
      />
    );
  } else if (!deck.view) {
    // ready snapshot but the view is still loading its pages.
    surface = <ImportedDeckProcessingCard fileName={fileName} fileSize={fileSize} message="Loading deck…" />;
  } else {
    surface = (
      <ImportedDeckViewer
        view={deck.view}
        onReplace={handleReplace}
        onDownload={() => void deck.downloadOriginal()}
        onRemove={() => void handleRemove()}
        onReloadUrls={() => void deck.refetch()}
      />
    );
  }

  return (
    <div className="space-y-2">
      {actionError && (
        <p className="flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-600 ring-1 ring-inset ring-rose-100">
          <AlertCircle className="size-3.5 shrink-0" />
          {actionError}
        </p>
      )}
      {surface}
    </div>
  );
}
