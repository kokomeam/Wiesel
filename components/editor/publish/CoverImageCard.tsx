"use client";

/**
 * Course cover uploader (Publish step). Saves IMMEDIATELY on upload — the
 * cover isn't part of the immutable snapshot, it's card/landing metadata on
 * the courses row. Pre-migration tolerance: courses.cover_image_url may not
 * exist on the live DB yet (20260711*), so a failed select renders a locked
 * info state and a failed update rolls the just-uploaded object back.
 */

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { IMMUTABLE_ASSET_CACHE_SECONDS } from "@/lib/images/cacheControl";
import { downscaleImageFile } from "@/lib/images/clientResize";
import {
  COVER_MAX_H,
  COVER_MAX_W,
  MAX_UPLOAD_BYTES,
  coverStoragePath,
  extForMime,
  storagePathFromPublicUrl,
} from "@/lib/images/resize";
import { createClient } from "@/lib/supabase/client";

const BUCKET = "course-assets";

async function removeStoredObject(url: string | null) {
  if (!url) return;
  const path = storagePathFromPublicUrl(url);
  if (!path) return;
  try {
    await createClient().storage.from(BUCKET).remove([path]);
  } catch {
    // Best-effort cleanup only — an orphaned object is harmless.
  }
}

function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = error.message ?? "";
  return error.code === "PGRST204" || msg.includes("cover_image_url");
}

function LockedNotice() {
  return (
    <div className="rounded-xl border border-dashed border-amber-300 bg-amber-50 px-4 py-6 text-center">
      <p className="text-xs leading-relaxed text-amber-800">
        Course covers unlock once the pending database migration is applied.
      </p>
    </div>
  );
}

export function CoverImageCard({ courseId }: { courseId: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "locked" | "error">(
    "loading"
  );
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the Retry button to re-run the initial select.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // No sync setState here (react-hooks/set-state-in-effect): the Retry
  // handler resets status to "loading" before bumping loadAttempt.
  useEffect(() => {
    let alive = true;
    createClient()
      .from("courses")
      .select("cover_image_url")
      .eq("id", courseId)
      .maybeSingle()
      .then(({ data, error: selectError }) => {
        if (!alive) return;
        if (selectError) {
          // Only a genuinely missing column means "migration pending" — a
          // transient network/RLS failure gets an honest error + Retry.
          setStatus(isMissingColumnError(selectError) ? "locked" : "error");
        } else {
          setCoverUrl(data?.cover_image_url ?? null);
          setStatus("ready");
        }
      });
    return () => {
      alive = false;
    };
  }, [courseId, loadAttempt]);

  const upload = async (file: File) => {
    setError(null);
    const mimeExt = extForMime(file.type);
    if (!mimeExt) {
      setError("Use a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("That image is over 8 MB — pick a smaller one.");
      return;
    }
    setBusy(true);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Your session expired — sign in again.");
      const scaled = await downscaleImageFile(file, {
        maxW: COVER_MAX_W,
        maxH: COVER_MAX_H,
      });
      const path = coverStoragePath(user.id, courseId, crypto.randomUUID(), scaled.ext);
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, scaled.blob, {
          cacheControl: IMMUTABLE_ASSET_CACHE_SECONDS,
          upsert: false,
        });
      if (uploadError) throw new Error(uploadError.message);
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);

      const { error: updateError } = await supabase
        .from("courses")
        .update({ cover_image_url: pub.publicUrl })
        .eq("id", courseId);
      if (updateError) {
        await removeStoredObject(pub.publicUrl);
        if (isMissingColumnError(updateError)) {
          setStatus("locked");
          return;
        }
        throw new Error(updateError.message);
      }
      const previous = coverUrl;
      setCoverUrl(pub.publicUrl);
      void removeStoredObject(previous);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed — try again.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!coverUrl) return;
    setError(null);
    setBusy(true);
    try {
      const { error: updateError } = await createClient()
        .from("courses")
        .update({ cover_image_url: null })
        .eq("id", courseId);
      if (updateError) throw new Error(updateError.message);
      void removeStoredObject(coverUrl);
      setCoverUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove the cover — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]"
      data-ai-tool="course-cover-upload"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-stone-400">
          Cover image
        </h2>
        {status === "ready" && coverUrl && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className="flex items-center gap-1 text-xs text-stone-400 transition-colors hover:text-rose-600 disabled:opacity-50"
          >
            <Trash2 className="size-3" /> Remove
          </button>
        )}
      </div>

      <div className="mt-3">
        {status === "loading" ? (
          <div className="grid aspect-video w-full place-items-center rounded-xl bg-stone-100">
            <Loader2 className="size-4 animate-spin text-stone-400" />
          </div>
        ) : status === "locked" ? (
          <LockedNotice />
        ) : status === "error" ? (
          <div className="grid aspect-video w-full place-items-center rounded-xl border border-dashed border-stone-300 bg-stone-50/60 px-6 text-center">
            <div>
              <p className="text-xs text-stone-500">
                Couldn&apos;t load the cover settings.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => {
                  setStatus("loading");
                  setLoadAttempt((n) => n + 1);
                }}
              >
                Retry
              </Button>
            </div>
          </div>
        ) : coverUrl ? (
          <div className="group relative overflow-hidden rounded-xl">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={coverUrl} alt="Course cover" className="aspect-video w-full object-cover" />
            <div className="absolute inset-x-0 bottom-0 flex justify-end bg-gradient-to-t from-stone-900/50 to-transparent p-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {busy && <Loader2 className="size-3 animate-spin" />}
                Replace
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            className="flex aspect-video w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 bg-stone-50/60 px-6 text-center transition-colors hover:border-brand-300 hover:bg-brand-50/30 disabled:cursor-default"
          >
            {busy ? (
              <Loader2 className="size-5 animate-spin text-stone-400" />
            ) : (
              <ImagePlus className="size-5 text-stone-400" />
            )}
            <span className="text-xs font-medium text-stone-600">
              Add a cover image — it appears on your course page and marketplace cards
            </span>
            <span className="text-[11px] text-stone-400">1280×720 or larger · PNG, JPEG, or WebP</span>
          </button>
        )}
      </div>

      {status === "ready" && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          data-ai-tool="course-cover-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />
      )}

      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

      {status === "ready" && (
        <p className="mt-3 border-t border-stone-100 pt-3 text-[11px] text-stone-400">
          Learners also see your instructor card —{" "}
          <Link href="/settings" className="text-brand-700 underline-offset-2 hover:underline">
            polish it in Settings
          </Link>
          .
        </p>
      )}
    </div>
  );
}
