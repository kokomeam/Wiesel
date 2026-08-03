/**
 * Creator profile form contract (PURE). The same limits are CHECK-enforced in
 * the DB (migration 20260711000000: headline ≤120, bio ≤2000) — keep them in
 * lockstep. All three fields are PUBLIC creator-card data (profiles is
 * world-readable by design).
 */

import { z } from "zod";
// Caps live in limits.ts (zod-free — counters render from them in initial
// bundles, PERF-1 D1); re-exported here so save-time importers are unchanged.
export { PROFILE_LIMITS } from "./limits";
import { PROFILE_LIMITS } from "./limits";

export const CreatorProfileFormSchema = z.object({
  displayName: z.string().trim().min(1).max(PROFILE_LIMITS.displayName),
  headline: z.string().max(PROFILE_LIMITS.headline).nullable(),
  bio: z.string().max(PROFILE_LIMITS.bio).nullable(),
});
export type CreatorProfileForm = z.infer<typeof CreatorProfileFormSchema>;

export type ProfileMissingPiece = "photo" | "headline" | "bio";

/** What the "complete your instructor profile" nudge keys off. Empty/blank
 *  strings count as missing, not just NULLs. */
export function profileCompleteness(profile: {
  avatar_url: string | null;
  headline: string | null;
  bio: string | null;
}): { complete: boolean; missing: ProfileMissingPiece[] } {
  const missing: ProfileMissingPiece[] = [];
  if (!profile.avatar_url?.trim()) missing.push("photo");
  if (!profile.headline?.trim()) missing.push("headline");
  if (!profile.bio?.trim()) missing.push("bio");
  return { complete: missing.length === 0, missing };
}
