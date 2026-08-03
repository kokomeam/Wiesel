/**
 * Approval-content hash (M-C amendment 1) — the binding between what the
 * creator SAW on the card and what may publish. Covers every field that
 * reaches the platform: body, cta, hashtags, first_comment, and the media
 * identity (video_path — re-burns rotate it, so a re-burned clip is new
 * content; image_storage_path for image posts). Computed at card request,
 * stamped on the approval AND the manifest, and re-checked against the
 * CURRENT post row pre-submit — a mismatch voids (approval_stale), it never
 * publishes. Server-only (node:crypto); the pure domain stays client-safe.
 */

import { createHash } from "node:crypto";

export const CONTENT_HASH_VERSION = "ph1";

export interface HashablePostContent {
  body: string;
  cta: string | null;
  hashtags: string[];
  first_comment: string | null;
  video_path: string | null;
  image_storage_path: string | null;
}

export function contentHashForPost(post: HashablePostContent): string {
  const canonical = JSON.stringify([
    CONTENT_HASH_VERSION,
    post.body,
    post.cta ?? "",
    post.hashtags,
    post.first_comment ?? "",
    post.video_path ?? "",
    post.image_storage_path ?? "",
  ]);
  return `${CONTENT_HASH_VERSION}:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
