"use client";

/**
 * Creator identity band — the top of /dashboard. The creator's public
 * teaching identity (photo · name · headline · bio) is editable IN PLACE:
 * the avatar uploads and saves immediately (hover the photo → Change), and
 * "Edit profile" swaps the text block for a compact inline form. Missing
 * pieces render as dashed ghost prompts instead of blank space, so the band
 * doubles as the profile-completion nudge (the AttentionRail row this
 * replaced is gone).
 *
 * Persistence goes through lib/profile/clientProfile (shared with Settings):
 * pre-migration, a headline/bio save falls back to {display_name, avatar_url}
 * and the band KEEPS THE EDITOR OPEN with the amber unlock notice — closing
 * it would display values that never persisted.
 */

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Camera, Check, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { storagePathFromPublicUrl } from "@/lib/images/resize";
import {
  removeCourseAsset,
  saveAvatarUrl,
  saveProfileFields,
  uploadAvatarImage,
} from "@/lib/profile/clientProfile";
// PROFILE_LIMITS renders counters (zod-free); the zod form schema is
// lazy-imported inside save() so it never rides the initial bundle (D1).
import { PROFILE_LIMITS } from "@/lib/profile/limits";

interface IdentityFields {
  displayName: string;
  headline: string;
  bio: string;
  avatarUrl: string | null;
}

function FieldCounter({ value, max }: { value: number; max: number }) {
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

export function CreatorIdentityHeader({
  userId,
  initial,
  displayNameFallback,
  actions,
}: {
  userId: string;
  /** RAW row values — displayName may be "" (a null row value); the editor
   *  must start blank then so a derived fallback is never silently persisted
   *  into world-readable profiles.display_name. */
  initial: IdentityFields;
  /** Display-only fallback for the h1/avatar initial (e.g. email prefix). */
  displayNameFallback: string;
  /** Page-level actions (Open studio / New Course) — rendered top-right. */
  actions?: React.ReactNode;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<IdentityFields>(initial);
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [headline, setHeadline] = useState(initial.headline);
  const [bio, setBio] = useState(initial.bio);

  const [uploading, setUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [legacyNotice, setLegacyNotice] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Rapid re-picks: only the newest upload may save; stale ones remove their
  // own object (same discipline as the Settings editor).
  const uploadSeqRef = useRef(0);
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

  const openEditor = () => {
    setDisplayName(saved.displayName);
    setHeadline(saved.headline);
    setBio(saved.bio);
    setFieldErrors({});
    setSaveError(null);
    setEditing(true);
  };

  /** Immediate save: upload → profiles.avatar_url (column exists since 0001)
   *  → remove the previous object. A failed row-update removes the upload. */
  const pickAvatar = async (file: File) => {
    setAvatarError(null);
    const seq = ++uploadSeqRef.current;
    setUploading(true);
    try {
      const { publicUrl, storagePath } = await uploadAvatarImage(file);
      if (seq !== uploadSeqRef.current) {
        removeCourseAsset(storagePath);
        return;
      }
      try {
        await saveAvatarUrl(userId, publicUrl);
      } catch (err) {
        removeCourseAsset(storagePath);
        throw err;
      }
      const oldPath = saved.avatarUrl ? storagePathFromPublicUrl(saved.avatarUrl) : null;
      if (oldPath) removeCourseAsset(oldPath);
      setSaved((prev) => ({ ...prev, avatarUrl: publicUrl }));
      router.refresh();
    } catch (err) {
      if (seq === uploadSeqRef.current) {
        setAvatarError(err instanceof Error ? err.message : "Upload failed — try again.");
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
        avatarUrl: saved.avatarUrl,
      });
      // A legacy save only "loses" something if the user actually TYPED a
      // headline/bio — a name-only save is a full success pre-migration too
      // (nothing typed failed to persist), so close + flash without a notice.
      const lostTypedFields = savedLegacyOnly && Boolean(parsed.data.headline || parsed.data.bio);
      setLegacyNotice(lostTypedFields);
      setSaved((prev) => ({
        ...prev,
        displayName: parsed.data.displayName,
        headline: savedLegacyOnly ? prev.headline : (parsed.data.headline ?? ""),
        bio: savedLegacyOnly ? prev.bio : (parsed.data.bio ?? ""),
      }));
      if (lostTypedFields) {
        // Keep the editor open: headline/bio did NOT persist — closing would
        // show text learners will never see. The notice explains.
        setDisplayName(parsed.data.displayName);
      } else {
        setEditing(false);
        flashSaved();
      }
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Saving failed — try again.");
    } finally {
      setSaving(false);
    }
  };

  const shownName = saved.displayName.trim() || displayNameFallback;
  const initialLetter = (shownName.trim().charAt(0) || "W").toUpperCase();
  const inputClass =
    "mt-1.5 h-10 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/15";

  return (
    <Card
      variant="elevated"
      className="relative overflow-hidden p-6 sm:p-8"
      data-ai-tool="dashboard-identity"
    >
      {/* Quiet corner warmth — the band is the page's identity moment. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-20 -top-24 h-64 w-96 rounded-full bg-brand-100/50 blur-3xl"
      />

      <div className="relative flex flex-col gap-6 sm:flex-row sm:items-start">
        {/* Avatar with in-place upload */}
        <div className="shrink-0">
          {/* aria-disabled + guard (not hard `disabled`): a disabled button
              ejects keyboard focus to <body> right when the file dialog
              returns. Guarding `saving` too closes the cross-operation race
              where a text save in flight could persist a stale avatar URL. */}
          <button
            type="button"
            aria-label="Change profile photo"
            aria-disabled={uploading || saving}
            onClick={() => {
              if (uploading || saving) return;
              fileInputRef.current?.click();
            }}
            className="group relative block rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          >
            {/* PERF-1 D3 pattern: blob:/data: preview URLs → plain <img>
                (next/image can't optimize browser-local sources); http(s)
                storage URLs → next/image. Same branch everywhere a src can
                be a local preview. */}
            {saved.avatarUrl && /^(blob|data):/.test(saved.avatarUrl) ? (
              // eslint-disable-next-line @next/next/no-img-element -- browser-local preview URL
              <img
                src={saved.avatarUrl}
                alt=""
                className="size-20 rounded-full object-cover shadow-[0_4px_16px_rgba(68,48,28,0.14)] ring-4 ring-white sm:size-24"
              />
            ) : saved.avatarUrl ? (
              <Image
                src={saved.avatarUrl}
                alt=""
                width={96}
                height={96}
                className="size-20 rounded-full object-cover shadow-[0_4px_16px_rgba(68,48,28,0.14)] ring-4 ring-white sm:size-24"
              />
            ) : (
              <span
                aria-hidden
                className="brand-gradient font-display grid size-20 place-items-center rounded-full text-3xl font-light text-white shadow-[0_4px_16px_rgba(68,48,28,0.14)] ring-4 ring-white sm:size-24"
              >
                {initialLetter}
              </span>
            )}
            <span
              className={cn(
                "absolute inset-0 grid place-items-center rounded-full bg-stone-900/45 text-white transition-opacity",
                uploading
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              )}
            >
              {uploading ? (
                <Loader2 className="size-5 animate-spin" aria-hidden />
              ) : (
                <span className="flex flex-col items-center gap-0.5">
                  <Camera className="size-5" aria-hidden />
                  <span className="text-[10px] font-medium">Change</span>
                </span>
              )}
            </span>
          </button>
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
          {/* Announce upload progress + errors to screen readers. */}
          <span role="status" className="sr-only">
            {uploading ? "Uploading photo…" : ""}
          </span>
          {avatarError ? (
            <p role="alert" className="mt-2 max-w-[8rem] text-xs leading-snug text-rose-600">
              {avatarError}
            </p>
          ) : null}
        </div>

        {/* Identity text / inline editor */}
        <div className="min-w-0 flex-1">
          {!editing ? (
            <>
              <p className="eyebrow text-brand-700">Welcome back</p>
              <h1 className="font-display mt-1 truncate text-3xl font-light text-stone-900 sm:text-4xl">
                {shownName}
              </h1>
              {saved.headline.trim() ? (
                <p className="mt-1.5 text-[15px] text-stone-600">{saved.headline}</p>
              ) : (
                <button
                  type="button"
                  onClick={openEditor}
                  className="mt-2 rounded-full border border-dashed border-stone-300 px-3 py-1 text-xs font-medium text-stone-500 transition-colors hover:border-brand-300 hover:text-brand-700"
                >
                  + Add a headline that sells your expertise
                </button>
              )}
              {saved.bio.trim() ? (
                <p className="mt-3 line-clamp-2 max-w-2xl whitespace-pre-line text-sm leading-relaxed text-stone-500">
                  {saved.bio}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={openEditor}
                  className="mt-3 block rounded-full border border-dashed border-stone-300 px-3 py-1 text-xs font-medium text-stone-500 transition-colors hover:border-brand-300 hover:text-brand-700"
                >
                  + Add a short bio — learners see it on every course page
                </button>
              )}
              {legacyNotice ? (
                <p className="mt-3 max-w-xl rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
                  Headline &amp; bio will unlock once the pending database migration
                  is applied — your name and photo were saved.
                </p>
              ) : null}
              <div className="mt-3 flex items-center gap-3">
                {savedFlash ? (
                  <span className="flex items-center gap-1 text-xs font-medium text-emerald-600">
                    <Check className="size-3.5" aria-hidden /> Saved
                  </span>
                ) : null}
                <p className="text-[11px] text-stone-400">
                  This is your instructor card — learners see it on every course
                  page.
                </p>
              </div>
            </>
          ) : (
            <div className="max-w-xl space-y-4">
              <label className="block">
                <span className="flex items-center justify-between text-sm font-medium text-stone-700">
                  Display name
                  <FieldCounter
                    value={displayName.length}
                    max={PROFILE_LIMITS.displayName}
                  />
                </span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className={inputClass}
                />
                {fieldErrors.displayName ? (
                  <p role="alert" className="mt-1 text-xs text-rose-600">{fieldErrors.displayName}</p>
                ) : null}
              </label>
              <label className="block">
                <span className="flex items-center justify-between text-sm font-medium text-stone-700">
                  Headline
                  <FieldCounter value={headline.length} max={PROFILE_LIMITS.headline} />
                </span>
                <input
                  value={headline}
                  onChange={(e) => setHeadline(e.target.value)}
                  placeholder="USACO coach · ex-Google"
                  className={inputClass}
                />
                {fieldErrors.headline ? (
                  <p role="alert" className="mt-1 text-xs text-rose-600">{fieldErrors.headline}</p>
                ) : null}
              </label>
              <label className="block">
                <span className="flex items-center justify-between text-sm font-medium text-stone-700">
                  Bio
                  <FieldCounter value={bio.length} max={PROFILE_LIMITS.bio} />
                </span>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={4}
                  placeholder="What you teach, who it's for, and why learners should trust you."
                  className="mt-1.5 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm leading-relaxed text-stone-800 placeholder:text-stone-400 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-500/15"
                />
                {fieldErrors.bio ? (
                  <p role="alert" className="mt-1 text-xs text-rose-600">{fieldErrors.bio}</p>
                ) : null}
              </label>
              {legacyNotice ? (
                <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
                  Headline &amp; bio will unlock once the pending database migration
                  is applied — your name and photo were saved.
                </p>
              ) : null}
              {saveError ? (
                <p role="alert" className="text-xs text-rose-600">
                  {saveError}
                </p>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={saving || uploading}
                  onClick={() => void save()}
                  data-ai-tool="identity-save"
                >
                  {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                  Save profile
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Page actions + edit toggle */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
          <div className="flex items-center gap-2">{actions}</div>
          {!editing ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={openEditor}
              data-ai-tool="identity-edit"
            >
              <Pencil className="size-3.5" aria-hidden />
              Edit profile
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
