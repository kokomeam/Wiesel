"use client";

/**
 * The "Import existing deck" upload surface: drag-or-browse a .ppt/.pptx/.pdf,
 * validate it client-side (the server re-validates authoritatively), upload with
 * a real progress bar, then insert an imported-deck block referencing the new
 * deck import. The block id is generated up-front and sent to the route so the
 * `deck_imports.block_id` reference matches.
 */

import { useRef, useState } from "react";
import { AlertCircle, FileText, Loader2, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { addImportedDeckBlockPatch } from "@/lib/course/commands";
import { useEditorStore } from "@/lib/course/store";
import type { DeckImportView } from "@/lib/course/imports/deckImportTypes";
import {
  ACCEPTED_EXTENSIONS,
  DECK_ACCEPT_ATTR,
  formatBytes,
  validateUpload,
} from "@/lib/course/imports/deckImportValidation";

interface XhrResult {
  ok: boolean;
  status: number;
  body: string;
}

function uploadWithProgress(
  url: string,
  form: FormData,
  onProgress: (pct: number) => void,
  signal?: { current: XMLHttpRequest | null }
): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (signal) signal.current = xhr;
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(form);
  });
}

export function DeckUploadButton({
  lessonId,
  atIndex,
  onDone,
  onBack,
}: {
  lessonId: string;
  atIndex?: number;
  onDone: () => void;
  onBack?: () => void;
}) {
  const apply = useEditorStore((s) => s.apply);
  const courseId = useEditorStore((s) => s.courseId);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  function pick(next: File | undefined) {
    if (!next) return;
    const v = validateUpload({ fileName: next.name, mimeType: next.type, size: next.size });
    if (!v.ok) {
      setError(v.error);
      setFile(null);
      return;
    }
    setError(null);
    setFile(next);
  }

  async function submit() {
    if (!file || !courseId || uploading) return;
    setUploading(true);
    setProgress(0);
    setError(null);

    const blockId = crypto.randomUUID();
    const form = new FormData();
    form.append("file", file);
    form.append("courseId", courseId);
    form.append("lessonId", lessonId);
    form.append("blockId", blockId);

    try {
      const res = await uploadWithProgress("/api/deck-imports/upload", form, setProgress, xhrRef);
      if (!res.ok) {
        setError(res.body || "We couldn't upload that deck. Please try again.");
        setUploading(false);
        return;
      }
      const { deckImport } = JSON.parse(res.body) as { deckImport: DeckImportView };
      apply(
        addImportedDeckBlockPatch(
          lessonId,
          {
            id: blockId,
            deckImportId: deckImport.id,
            title: deckImport.title,
            sourceType: deckImport.sourceType,
            originalFileName: deckImport.originalFileName,
            originalMimeType: deckImport.originalMimeType,
            originalFileSize: deckImport.originalFileSize,
            status: deckImport.status,
            createdAt: deckImport.createdAt,
            updatedAt: deckImport.updatedAt,
          },
          atIndex
        ),
        "human"
      );
      onDone();
    } catch (err) {
      if ((err as Error).message !== "aborted") {
        setError("We couldn't upload that deck. Please try again.");
      }
      setUploading(false);
    }
  }

  return (
    <div className="space-y-4">
      <input
        ref={inputRef}
        type="file"
        accept={DECK_ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />

      {!file ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            pick(e.dataTransfer.files?.[0]);
          }}
          className={cn(
            "flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors",
            dragOver
              ? "border-brand-400 bg-brand-50/60"
              : "border-stone-300 bg-stone-50/50 hover:border-brand-300 hover:bg-brand-50/30"
          )}
        >
          <span className="grid size-12 place-items-center rounded-2xl bg-white text-brand-600 shadow-sm ring-1 ring-stone-200/70">
            <UploadCloud className="size-6" />
          </span>
          <span className="space-y-1">
            <span className="block text-sm font-medium text-stone-800">
              Drag a deck here, or <span className="text-brand-600">browse</span>
            </span>
            <span className="block text-xs text-stone-400">
              PowerPoint or PDF · {ACCEPTED_EXTENSIONS.join(", ")} · up to 100 MB
            </span>
          </span>
        </button>
      ) : (
        <div className="rounded-2xl border border-stone-200/80 bg-white p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
              <FileText className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-stone-800">{file.name}</p>
              <p className="text-xs text-stone-400">{formatBytes(file.size)}</p>
            </div>
            {!uploading && (
              <button
                type="button"
                aria-label="Remove file"
                onClick={() => {
                  setFile(null);
                  setProgress(0);
                }}
                className="grid size-7 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          {uploading && (
            <div className="mt-3">
              <div className="h-1.5 overflow-hidden rounded-full bg-stone-100">
                <div
                  className="h-full rounded-full bg-brand-500 transition-[width] duration-200"
                  style={{ width: `${Math.max(5, progress)}%` }}
                />
              </div>
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-stone-400">
                <Loader2 className="size-3 animate-spin" />
                {progress < 100 ? `Uploading… ${progress}%` : "Finishing up…"}
              </p>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="flex items-start gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-600 ring-1 ring-inset ring-rose-100">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        {onBack ? (
          <Button variant="ghost" size="sm" onClick={onBack} disabled={uploading}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button size="sm" onClick={submit} disabled={!file || !courseId || uploading}>
          {uploading ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Importing…
            </>
          ) : (
            "Import deck"
          )}
        </Button>
      </div>
    </div>
  );
}
