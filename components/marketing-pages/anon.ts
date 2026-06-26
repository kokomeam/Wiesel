/**
 * Stable per-visitor anonymous id (client-only). Lets pre-lead pageviews be
 * linked to a subscriber when they later convert (Phase 2 does the linking).
 */

const KEY = "cg_anon_id";

export function getAnonymousId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return null; // private mode / storage blocked — degrade to anonymous-null
  }
}
