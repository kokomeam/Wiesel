/**
 * Access control for imported decks. Every route funnels through these so the
 * ownership rule lives in ONE place. RLS already gates the tables/bucket; these
 * add explicit, auditable checks (defense in depth) and give routes clean
 * `null`s to turn into 401/403/404 without leaking which case occurred.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { DeckImportRow } from "./deckImportTypes";

type DB = SupabaseClient<Database>;

export interface AuthedUser {
  id: string;
  email: string | null;
}

/** The signed-in user, or null. */
export async function getAuthedUser(supabase: DB): Promise<AuthedUser | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return { id: user.id, email: user.email ?? null };
}

/**
 * True iff `userId` is the AUTHOR of the course (not merely a public reader).
 * RLS would expose published+public courses on select, so we compare author_id
 * explicitly — a collaborator model would extend exactly here.
 */
export async function userOwnsCourse(supabase: DB, userId: string, courseId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("courses")
    .select("author_id")
    .eq("id", courseId)
    .maybeSingle();
  if (error || !data) return false;
  return data.author_id === userId;
}

/**
 * Load a deck-import row the caller is allowed to see (RLS already restricts to
 * the author). Returns null when missing or not owned — callers map to 404.
 */
export async function loadOwnedDeckImport(supabase: DB, deckImportId: string): Promise<DeckImportRow | null> {
  const { data, error } = await supabase
    .from("deck_imports")
    .select("*")
    .eq("id", deckImportId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

export type DeckImportAccess =
  | { ok: true; user: AuthedUser; row: DeckImportRow }
  | { ok: false; status: 401 | 404; message: string };

/**
 * One-shot guard for routes that act on an existing deck import: authenticate,
 * load (RLS-gated), and confirm the authed user matches the row owner. Returns a
 * tagged result the route turns directly into a Response.
 */
export async function requireDeckImportAccess(
  supabase: DB,
  deckImportId: string
): Promise<DeckImportAccess> {
  const user = await getAuthedUser(supabase);
  if (!user) return { ok: false, status: 401, message: "Sign in to continue." };
  const row = await loadOwnedDeckImport(supabase, deckImportId);
  if (!row || row.owner_id !== user.id) {
    return { ok: false, status: 404, message: "Deck not found." };
  }
  return { ok: true, user, row };
}
