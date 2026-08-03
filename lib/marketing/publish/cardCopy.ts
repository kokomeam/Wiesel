/**
 * Card + unpublish copy (client-safe, no node imports) — the honest-refusal
 * guidance for the unpublish valve (Task 0a: no provider deletion API; the
 * platform copy remains live until removed by hand) and shared card strings.
 */

import type { PublishPlatform } from "./provider/types";

export const MANUAL_DELETE_GUIDANCE: Record<PublishPlatform, string> = {
  linkedin:
    "open the post on LinkedIn (use the link above) → the ⋯ menu on the post → Delete post.",
  youtube:
    "open YouTube Studio → Content → find the video → ⋮ menu → Delete forever (or set Visibility to Private to hide it without deleting).",
  tiktok: "open the post on TikTok → ⋯ → Delete.",
  instagram: "open the post on Instagram → ⋯ → Delete.",
  facebook: "open the post on your Facebook Page → ⋯ → Move to trash.",
};

/** The unpublish card's honest-state sentence — rendered verbatim. */
export const UNPUBLISH_HONESTY =
  "This removes the post from WiseSel's records only. The copy already on the platform REMAINS LIVE — no deletion API exists, so removing it there is a manual step.";
