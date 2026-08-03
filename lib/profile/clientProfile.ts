/**
 * Client-side profile persistence shared by the Settings editor
 * (components/settings/ProfileSettings) and the dashboard identity band
 * (components/dashboard/CreatorIdentityHeader) — ONE implementation of the
 * avatar upload and the pre-migration-tolerant profile save, so the two
 * surfaces can't drift. Browser-only (supabase browser client); no React.
 */

import { IMMUTABLE_ASSET_CACHE_SECONDS } from "@/lib/images/cacheControl";
import { downscaleImageFile } from "@/lib/images/clientResize";
import {
  AVATAR_MAX_PX,
  MAX_UPLOAD_BYTES,
  avatarStoragePath,
  extForMime,
} from "@/lib/images/resize";
// Lazy supabase import (PERF-1 D1): every caller is an async save/upload
// handler, so the ~55 KB gz supabase-js chunk loads on FIRST EDIT instead of
// riding the initial /dashboard and /settings bundles.
const supabaseClient = async () =>
  (await import("@/lib/supabase/client")).createClient();

export interface ProfileSaveFields {
  displayName: string;
  headline: string | null;
  bio: string | null;
  avatarUrl: string | null;
}

/** PostgREST's missing-column signature (PGRST204, or the column name quoted
 *  in the message) — how the pre-migration DB rejects headline/bio/role. */
export function isMissingColumnError(
  error: { code?: string; message?: string } | null,
  columns: string[]
): boolean {
  if (!error) return false;
  if (error.code === "PGRST204") return true;
  const msg = error.message ?? "";
  return columns.some((c) => msg.includes(`'${c}'`) || msg.includes(`"${c}"`));
}

/**
 * Validate → downscale (512 square) → upload to the caller's OWN
 * {uid}/avatar/ folder. The uid comes from auth.getUser() at upload time,
 * never from arguments. Throws Error with a user-facing message.
 */
export async function uploadAvatarImage(
  file: File
): Promise<{ publicUrl: string; storagePath: string }> {
  const ext = extForMime(file.type);
  if (!ext) throw new Error("Use a PNG, JPEG, or WebP image.");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("That image is over 8 MB — pick a smaller one.");
  }
  const supabase = await supabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Your session expired — sign in again.");
  const scaled = await downscaleImageFile(file, {
    maxW: AVATAR_MAX_PX,
    maxH: AVATAR_MAX_PX,
    square: true,
  });
  const storagePath = avatarStoragePath(user.id, crypto.randomUUID(), scaled.ext);
  const { error } = await supabase.storage
    .from("course-assets")
    .upload(storagePath, scaled.blob, {
      cacheControl: IMMUTABLE_ASSET_CACHE_SECONDS,
      upsert: false,
    });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from("course-assets").getPublicUrl(storagePath);
  return { publicUrl: data.publicUrl, storagePath };
}

/** Best-effort object removal — an orphan is better than blocking the user. */
export function removeCourseAsset(path: string): void {
  void supabaseClient()
    .then((c) => c.storage.from("course-assets").remove([path]))
    .catch(() => {});
}

/**
 * Update the caller's profiles row (self RLS). Pre-migration tolerance: a
 * missing headline/bio column retries with just {display_name, avatar_url}
 * and reports savedLegacyOnly=true so the UI can show the unlock notice.
 * Throws Error on real failures.
 */
export async function saveProfileFields(
  userId: string,
  fields: ProfileSaveFields
): Promise<{ savedLegacyOnly: boolean }> {
  const supabase = await supabaseClient();
  const full = {
    display_name: fields.displayName,
    avatar_url: fields.avatarUrl,
    headline: fields.headline,
    bio: fields.bio,
  };
  const { error } = await supabase.from("profiles").update(full).eq("id", userId);
  if (!error) return { savedLegacyOnly: false };
  if (!isMissingColumnError(error, ["headline", "bio"])) {
    throw new Error(error.message);
  }
  const { error: retryError } = await supabase
    .from("profiles")
    .update({ display_name: full.display_name, avatar_url: full.avatar_url })
    .eq("id", userId);
  if (retryError) throw new Error(retryError.message);
  return { savedLegacyOnly: true };
}

/** Avatar-only save — the column has existed since 0001, no tolerance dance.
 *  Used by the dashboard band's immediate photo save. */
export async function saveAvatarUrl(userId: string, avatarUrl: string | null): Promise<void> {
  const { error } = await (await supabaseClient())
    .from("profiles")
    .update({ avatar_url: avatarUrl })
    .eq("id", userId);
  if (error) throw new Error(error.message);
}
