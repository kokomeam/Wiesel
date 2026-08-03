"use client";

/**
 * Creator profile editor (Settings). Avatar uploads go to the public
 * course-assets bucket under the caller's OWN {uid}/avatar/ prefix — the uid
 * comes from auth.getUser() at upload time, never from props. The uploaded
 * URL is only PREVIEWED until Save; Cancel (or a superseding pick, or a pick
 * resolving after Cancel) best-effort REMOVES the object too, and a
 * successful save removes the previous avatar's object — no orphaned
 * public photos accumulate in the bucket.
 *
 * Pre-migration tolerance: profiles.headline/bio may not exist on the live DB
 * yet (migration 20260711*). A missing-column update error retries with just
 * {display_name, avatar_url} and shows a quiet amber notice.
 */

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Camera, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { storagePathFromPublicUrl } from "@/lib/images/resize";
import {
  removeCourseAsset,
  saveProfileFields,
  uploadAvatarImage,
} from "@/lib/profile/clientProfile";
// PROFILE_LIMITS renders counters (zod-free); the zod form schema is
// lazy-imported inside save() so it never rides the initial bundle (D1).
import { PROFILE_LIMITS } from "@/lib/profile/limits";

interface ProfileFields {
  displayName: string;
  headline: string;
  bio: string;
  avatarUrl: string | null;
}

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span
      className={cn(
        "font-mono text-[11px] tabular-nums",
        value > max ? "text-rose-600" : "text-stone-400"
      )}
    >
      {value} / {max}
    </span>
  );
}

function AvatarDisc({
  url,
  name,
  className,
}: {
  url: string | null;
  name: string;
  className?: string;
}) {
  if (url) {
    // PERF-1 D3 pattern: blob:/data: preview URLs → plain <img> (next/image
    // can't optimize browser-local sources); http(s) storage URLs →
    // next/image. Avatars are ≤512px sources shown in ≤80px discs.
    if (/^(blob|data):/.test(url)) {
      return (
        // eslint-disable-next-line @next/next/no-img-element -- browser-local preview URL
        <img
          src={url}
          alt=""
          className={cn("rounded-full object-cover", className)}
        />
      );
    }
    return (
      <Image
        src={url}
        alt=""
        width={96}
        height={96}
        className={cn("rounded-full object-cover", className)}
      />
    );
  }
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <div
      className={cn(
        "grid place-items-center rounded-full bg-stone-200 text-stone-500",
        className
      )}
    >
      {initial ? (
        <span className="text-xl font-semibold">{initial}</span>
      ) : (
        <Camera className="size-5" />
      )}
    </div>
  );
}

export function ProfileSettings({
  userId,
  initial,
}: {
  userId: string;
  initial: ProfileFields;
}) {
  const [baseline, setBaseline] = useState<ProfileFields>(initial);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [headline, setHeadline] = useState(initial.headline);
  const [bio, setBio] = useState(initial.bio);
  const [avatarUrl, setAvatarUrl] = useState(initial.avatarUrl);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [savedFlash, setSavedFlash] = useState(false);
  const [legacyNotice, setLegacyNotice] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Upload lifecycle: seq invalidates in-flight uploads on Cancel/supersede;
  // pendingUploadPath = uploaded-but-not-saved object, cleaned up on discard.
  const uploadSeqRef = useRef(0);
  const pendingUploadPathRef = useRef<string | null>(null);
  // Flash timer: kept in a ref so a re-arm clears the previous one (else an
  // earlier save's timer truncates a later flash) + cleared on unmount.
  const savedFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
    },
    []
  );
  const flashSaved = () => {
    if (savedFlashTimerRef.current) clearTimeout(savedFlashTimerRef.current);
    setSavedFlash(true);
    savedFlashTimerRef.current = setTimeout(() => setSavedFlash(false), 2500);
  };

  const dirty =
    displayName !== baseline.displayName ||
    headline !== baseline.headline ||
    bio !== baseline.bio ||
    avatarUrl !== baseline.avatarUrl;

  const pickAvatar = async (file: File) => {
    setUploadError(null);
    const seq = ++uploadSeqRef.current;
    setUploading(true);
    try {
      // Validation (type allowlist, 8 MB cap) lives in the shared helper —
      // it throws the user-facing message straight into the catch below.
      const { publicUrl, storagePath } = await uploadAvatarImage(file);
      if (seq !== uploadSeqRef.current) {
        // Cancel (or a newer pick) won while we were in flight — the user
        // already decided against this photo; don't resurrect it.
        removeCourseAsset(storagePath);
        return;
      }
      // A previously picked-but-unsaved photo is superseded — clean it up.
      if (pendingUploadPathRef.current) removeCourseAsset(pendingUploadPathRef.current);
      pendingUploadPathRef.current = storagePath;
      setAvatarUrl(publicUrl);
    } catch (err) {
      if (seq === uploadSeqRef.current) {
        setUploadError(err instanceof Error ? err.message : "Upload failed — try again.");
      }
    } finally {
      if (seq === uploadSeqRef.current) setUploading(false);
    }
  };

  const save = async () => {
    setSaveError(null);
    setFieldErrors({});
    const { CreatorProfileFormSchema } = await import("@/lib/profile/schema");
    const parsed = CreatorProfileFormSchema.safeParse({
      displayName,
      headline: headline.trim() ? headline.trim() : null,
      bio: bio.trim() ? bio.trim() : null,
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        if (!errs[key]) {
          errs[key] =
            key === "displayName" && displayName.trim().length === 0
              ? "Add a display name — learners see it on your courses."
              : "Too long — trim it to fit the limit.";
        }
      }
      setFieldErrors(errs);
      return;
    }
    setSaving(true);
    try {
      const { savedLegacyOnly } = await saveProfileFields(userId, {
        displayName: parsed.data.displayName,
        headline: parsed.data.headline,
        bio: parsed.data.bio,
        avatarUrl,
      });
      // Only a notice when something TYPED failed to persist — a name/photo
      // save with blank headline/bio is a full success pre-migration too.
      setLegacyNotice(savedLegacyOnly && Boolean(parsed.data.headline || parsed.data.bio));
      // The picked photo is now the saved avatar; the previous one (if it
      // lives in our bucket) is unreferenced — remove it.
      if (avatarUrl !== baseline.avatarUrl) {
        pendingUploadPathRef.current = null;
        const oldPath = baseline.avatarUrl
          ? storagePathFromPublicUrl(baseline.avatarUrl)
          : null;
        if (oldPath) removeCourseAsset(oldPath);
      }
      setBaseline({
        displayName: parsed.data.displayName,
        headline: savedLegacyOnly ? baseline.headline : (parsed.data.headline ?? ""),
        bio: savedLegacyOnly ? baseline.bio : (parsed.data.bio ?? ""),
        avatarUrl,
      });
      // Mirror the TRIMMED persisted values back into the fields so the form
      // reads clean (dirty=false) after save; a legacy-only save deliberately
      // leaves the unsaved headline/bio as typed (still dirty + noticed).
      setDisplayName(parsed.data.displayName);
      if (!savedLegacyOnly) {
        setHeadline(parsed.data.headline ?? "");
        setBio(parsed.data.bio ?? "");
      }
      flashSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Saving failed — try again.");
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    // Invalidate any in-flight upload and discard the picked-but-unsaved
    // photo's object (not just the preview URL).
    uploadSeqRef.current += 1;
    if (pendingUploadPathRef.current) {
      removeCourseAsset(pendingUploadPathRef.current);
      pendingUploadPathRef.current = null;
    }
    setUploading(false);
    setDisplayName(baseline.displayName);
    setHeadline(baseline.headline);
    setBio(baseline.bio);
    setAvatarUrl(baseline.avatarUrl);
    setFieldErrors({});
    setSaveError(null);
    setUploadError(null);
  };

  const previewName = displayName.trim() || "Your name";

  return (
    <div
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start"
      data-ai-tool="settings-profile-form"
    >
      <Card className="p-5 sm:p-6">
        {/* Avatar */}
        <div className="flex items-center gap-4">
          <AvatarDisc url={avatarUrl} name={displayName} className="size-20 shrink-0" />
          <div>
            {/* aria-disabled + guard (not hard disabled): a disabled control
                ejects keyboard focus right as the file dialog returns. */}
            <Button
              variant="outline"
              size="sm"
              aria-disabled={uploading}
              onClick={() => {
                if (uploading) return;
                fileInputRef.current?.click();
              }}
            >
              {uploading && <Loader2 className="size-3 animate-spin" />}
              {avatarUrl ? "Change photo" : "Add a photo"}
            </Button>
            <p className="mt-1.5 text-xs text-stone-400">
              PNG, JPEG, or WebP · up to 8 MB · square works best.
            </p>
            <span role="status" className="sr-only">
              {uploading ? "Uploading photo…" : ""}
            </span>
            {uploadError && <p role="alert" className="mt-1 text-xs text-rose-600">{uploadError}</p>}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void pickAvatar(file);
            }}
          />
        </div>

        {/* Fields */}
        <div className="mt-6 space-y-5">
          <label className="block">
            <span className="flex items-center justify-between text-sm font-medium text-stone-700">
              Display name
              <Counter value={displayName.length} max={PROFILE_LIMITS.displayName} />
            </span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1.5 h-10 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/15"
            />
            {fieldErrors.displayName && (
              <p role="alert" className="mt-1 text-xs text-rose-600">{fieldErrors.displayName}</p>
            )}
          </label>

          <label className="block">
            <span className="flex items-center justify-between text-sm font-medium text-stone-700">
              Headline
              <Counter value={headline.length} max={PROFILE_LIMITS.headline} />
            </span>
            <input
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="USACO coach · ex-Google"
              className="mt-1.5 h-10 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/15"
            />
            {fieldErrors.headline && (
              <p role="alert" className="mt-1 text-xs text-rose-600">{fieldErrors.headline}</p>
            )}
          </label>

          <label className="block">
            <span className="flex items-center justify-between text-sm font-medium text-stone-700">
              Bio
              <Counter value={bio.length} max={PROFILE_LIMITS.bio} />
            </span>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={6}
              placeholder="What you teach, who it's for, and why learners should trust you."
              className="mt-1.5 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm leading-relaxed text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/15"
            />
            <span className="mt-1 block text-xs text-stone-400">
              Line breaks are kept — learners see this exactly as typed.
            </span>
            {fieldErrors.bio && <p role="alert" className="mt-1 text-xs text-rose-600">{fieldErrors.bio}</p>}
          </label>
        </div>

        {legacyNotice && (
          <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            Headline &amp; bio will unlock once the pending database migration is
            applied — your name and photo were saved.
          </p>
        )}
        {saveError && <p role="alert" className="mt-4 text-xs text-rose-600">{saveError}</p>}

        <div className="mt-6 flex items-center justify-end gap-2 border-t border-stone-100 pt-4">
          {savedFlash && (
            <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 transition-opacity">
              <Check className="size-3.5" /> Saved
            </span>
          )}
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={cancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saving || uploading}
            onClick={() => void save()}
            data-ai-tool="settings-save"
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            Save changes
          </Button>
        </div>
      </Card>

      {/* Live "how learners see you" preview */}
      <Card variant="tinted" className="p-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-brand-700">
          How learners see you
        </p>
        <div className="mt-4 flex items-start gap-3">
          <AvatarDisc url={avatarUrl} name={displayName} className="size-12 shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-stone-900">{previewName}</p>
            {headline.trim() ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-stone-500">{headline.trim()}</p>
            ) : (
              <p className="mt-0.5 text-xs italic text-stone-400">Add a headline</p>
            )}
          </div>
        </div>
        {bio.trim() ? (
          <p className="mt-3 line-clamp-4 whitespace-pre-line text-xs leading-relaxed text-stone-600">
            {bio.trim()}
          </p>
        ) : (
          <p className="mt-3 text-xs italic text-stone-400">
            Your bio appears here, on every course page.
          </p>
        )}
        <p className="mt-4 border-t border-stone-200/70 pt-3 text-[11px] leading-relaxed text-stone-400">
          This instructor card sits on your course landing pages and marketplace
          listings.
        </p>
      </Card>
    </div>
  );
}
