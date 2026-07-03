/**
 * Access control for video assets. Every route funnels through these so the
 * ownership rule lives in ONE place. RLS already gates the `video_assets` table;
 * these add explicit, auditable checks (defense in depth) and give routes clean
 * nulls to turn into 401/403/404 without leaking which case occurred. Mirrors
 * lib/course/imports/deckImportAccess.ts (kept separate so the video feature is
 * self-contained).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { VideoAssetRow } from "./videoTypes";

type DB = SupabaseClient<Database>;

export interface AuthedUser {
  id: string;
  email: string | null;
}

export async function getAuthedUser(supabase: DB): Promise<AuthedUser | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { id: user.id, email: user.email ?? null };
}

/** True iff `userId` is the AUTHOR of the course (not a public reader). */
export async function userOwnsCourse(supabase: DB, userId: string, courseId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("courses")
    .select("author_id")
    .eq("id", courseId)
    .maybeSingle();
  if (error || !data) return false;
  return data.author_id === userId;
}

export async function loadOwnedVideoAsset(supabase: DB, videoAssetId: string): Promise<VideoAssetRow | null> {
  const { data, error } = await supabase
    .from("video_assets")
    .select("*")
    .eq("id", videoAssetId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

export type VideoAssetAccess =
  | { ok: true; user: AuthedUser; row: VideoAssetRow }
  | { ok: false; status: 401 | 404; message: string };

/** One-shot guard for routes acting on an existing video asset: authenticate,
 *  load (RLS-gated), and confirm the authed user matches the row owner. */
export async function requireVideoAssetAccess(
  supabase: DB,
  videoAssetId: string
): Promise<VideoAssetAccess> {
  const user = await getAuthedUser(supabase);
  if (!user) return { ok: false, status: 401, message: "Sign in to continue." };
  const row = await loadOwnedVideoAsset(supabase, videoAssetId);
  if (!row || row.owner_id !== user.id) {
    return { ok: false, status: 404, message: "Video not found." };
  }
  return { ok: true, user, row };
}
