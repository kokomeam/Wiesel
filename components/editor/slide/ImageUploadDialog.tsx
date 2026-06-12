"use client";

/**
 * Image picker: drop/browse a local file (object URL for now — swap
 * URL.createObjectURL for a Supabase Storage upload later) or pick a bundled
 * sample. Alt text is REQUIRED — Insert stays disabled without it, because
 * both accessibility tooling and AI agents depend on it.
 *
 * Mounted once at the editor-shell level; opened from anywhere via
 * uiStore.openImageDialog (toolbar, canvas placeholders, background panel,
 * inspector).
 */

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import {
  insertImagePatch,
  replaceImagePatch,
  updateBackgroundPatch,
} from "@/lib/course/commands";
import { PLACEHOLDER_IMAGES } from "@/lib/course/slide/placeholderImages";
import { useEditorStore } from "@/lib/course/store";
import { useUIStore } from "@/lib/editor/uiStore";

export function GlobalImageDialog() {
  const request = useUIStore((s) => s.imageDialog);
  const close = useUIStore((s) => s.closeImageDialog);
  const apply = useEditorStore((s) => s.apply);
  const [src, setSrc] = useState<string | null>(null);
  const [alt, setAlt] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const open = request !== null;

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Reset draft state whenever a new request opens the dialog
  // (render-phase derived-state reset — no effects, no ref writes).
  const requestKey = request
    ? `${request.blockId}:${request.slideId}:${request.replaceElementId ?? ""}:${request.forBackground ?? ""}`
    : "";
  const [lastKey, setLastKey] = useState(requestKey);
  if (requestKey !== lastKey) {
    setLastKey(requestKey);
    setSrc(null);
    setAlt("");
  }

  if (!request) return null;

  function acceptFile(file: File | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    setSrc(URL.createObjectURL(file));
  }

  const forBackground = request.forBackground === true;
  const canSubmit = src !== null && (forBackground || alt.trim().length > 0);

  function submit() {
    if (!request || !src || !canSubmit) return;
    if (forBackground) {
      apply(
        updateBackgroundPatch(request.blockId, request.slideId, {
          type: "image",
          imageSrc: src,
          overlayColor: "#171717",
          overlayOpacity: 0.25,
        }),
        "human"
      );
    } else if (request.replaceElementId) {
      apply(
        replaceImagePatch(
          request.blockId,
          request.slideId,
          request.replaceElementId,
          src,
          alt.trim()
        ),
        "human"
      );
    } else {
      apply(
        insertImagePatch(
          request.blockId,
          request.slideId,
          { src, alt: alt.trim() },
          request.elementCount
        ),
        "human"
      );
    }
    close();
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-stone-950/30 p-6"
      onClick={close}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={forBackground ? "Set background image" : "Insert image"}
        data-ai-component="image-upload-dialog"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border border-stone-200/80 bg-white p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-900">
            {forBackground
              ? "Background image"
              : request.replaceElementId
                ? "Replace image"
                : "Insert image"}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="grid size-7 place-items-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          >
            <X className="size-4" />
          </button>
        </div>

        {src ? (
          <div className="relative overflow-hidden rounded-xl bg-stone-50 ring-1 ring-stone-200">
            {/* eslint-disable-next-line @next/next/no-img-element -- object URL preview */}
            <img src={src} alt="Preview of selected image" className="mx-auto max-h-52 object-contain" />
            <button
              type="button"
              onClick={() => setSrc(null)}
              className="absolute right-2 top-2 rounded-lg bg-white/90 px-2 py-1 text-xs font-medium text-stone-600 shadow-sm hover:text-stone-900"
            >
              Choose another
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                acceptFile(e.dataTransfer.files[0]);
              }}
              className={cn(
                "flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 transition-colors",
                dragOver
                  ? "border-brand-400 bg-brand-50/60 text-brand-600"
                  : "border-stone-300 text-stone-400 hover:border-brand-300 hover:text-brand-600"
              )}
            >
              <Upload className="size-6" />
              <span className="text-sm font-medium">Drop an image or click to browse</span>
              <span className="text-xs text-stone-400">PNG, JPG, SVG — stays local for now</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              aria-label="Upload image file"
              onChange={(e) => acceptFile(e.target.files?.[0])}
            />

            <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
              Or pick a sample
            </p>
            <div className="grid grid-cols-3 gap-2">
              {PLACEHOLDER_IMAGES.map((img) => (
                <button
                  key={img.name}
                  type="button"
                  title={img.name}
                  onClick={() => {
                    setSrc(img.src);
                    if (!alt) setAlt(img.alt);
                  }}
                  className="overflow-hidden rounded-lg ring-1 ring-stone-200 transition-shadow hover:ring-brand-300"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- data URI samples */}
                  <img src={img.src} alt={img.alt} className="aspect-video w-full object-cover" />
                </button>
              ))}
            </div>
          </>
        )}

        {!forBackground && (
          <div className="mt-4">
            <label
              htmlFor="image-alt-input"
              className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-stone-400"
            >
              Alt text <span className="font-normal normal-case text-stone-400">(required)</span>
            </label>
            <input
              id="image-alt-input"
              type="text"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              placeholder="Describe the image for screen readers and AI…"
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-800 outline-none placeholder:text-stone-300 focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
            />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={submit}
            data-ai-tool="confirm-image-insert"
            data-ai-action={forBackground ? "UPDATE_SLIDE_BACKGROUND" : "INSERT_IMAGE"}
          >
            <ImagePlus className="size-3.5" />
            {forBackground ? "Set background" : request.replaceElementId ? "Replace" : "Insert"}
          </Button>
        </div>
      </div>
    </div>
  );
}
