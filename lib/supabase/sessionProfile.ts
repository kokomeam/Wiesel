/**
 * Request-deduped session profile (PERF-1 C1). The (app) and (student) shells
 * each fetched `profiles` for the SAME signed-in user right after their own
 * `auth.getUser()`, and pages repeated the read — layout + page paid it twice
 * per navigation. One cache()d helper = one profiles round trip per request.
 *
 * Deliberately narrow (display_name/role/avatar_url — the shell chrome's
 * needs). Page-level `profiles.select("*")` reads (settings, dashboard) stay
 * separate: they need the migration-tolerant wide row.
 */

import { cache } from "react";
import { createClient, getSessionUser } from "@/lib/supabase/server";

export interface SessionProfile {
  displayName: string | null;
  role: string | null;
  avatarUrl: string | null;
}

/** The signed-in user's profile summary, or null when signed out. */
export const getSessionProfile = cache(async (): Promise<SessionProfile | null> => {
  const user = await getSessionUser();
  if (!user) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("display_name, role, avatar_url")
    .eq("id", user.id)
    .maybeSingle();
  if (!error) {
    return {
      displayName: data?.display_name ?? null,
      role: data?.role ?? null,
      avatarUrl: data?.avatar_url ?? null,
    };
  }
  // Pre-migration DBs miss role/avatar_url (42703 on the named select) —
  // retry with the column every environment has.
  const { data: narrow } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();
  return { displayName: narrow?.display_name ?? null, role: null, avatarUrl: null };
});
