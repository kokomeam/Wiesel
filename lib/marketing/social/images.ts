/**
 * Image attachment (PRD §15) — upload only, never generated. The client
 * uploads directly to the private `social-post-images` bucket (own-folder RLS,
 * path {creatorId}/social/{postId}/{uuid}.{ext}), then calls finalize. The
 * server re-validates by MAGIC BYTES (never the client's content-type header),
 * checks size, reads dimensions, and attaches the reference with a signed
 * display URL (short TTL — regenerate on view). Dimension mismatch is a SOFT
 * warning, never a block. Removing detaches the reference; the object is
 * retained (revert-friendly) until a later retention purge.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  IMAGE_MAX_BYTES,
  IMAGE_SIGNED_URL_TTL_SECONDS,
  PLATFORM_LIMITS,
  SOCIAL_IMAGES_BUCKET,
} from "./constants";
import { emitSocialEvent } from "./events";
import { imageNormWarning, parseImageMeta } from "./imageMeta";
import { clearPostImage, setPostImage } from "./repository";
import type { SocialPost } from "./schemas";

type DB = SupabaseClient<Database>;

export class SocialImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialImageError";
  }
}

export interface FinalizeImageDeps {
  supabase: DB;
  ownerId: string;
  courseIdForEvents: string;
}

export interface FinalizeImageResult {
  post: SocialPost;
  /** Soft dimension warning (PRD: never a block) — or null. */
  warning: string | null;
  meta: { mime: string; width: number; height: number; bytes: number };
}

/** Attach an already-uploaded storage object to a post, with validation. */
export async function finalizeImageAttachment(
  deps: FinalizeImageDeps,
  args: { post: SocialPost; storagePath: string; altText: string | null }
): Promise<FinalizeImageResult> {
  const expectedPrefix = `${deps.ownerId}/social/${args.post.id}/`;
  if (!args.storagePath.startsWith(expectedPrefix)) {
    throw new SocialImageError(
      `storagePath must live under ${expectedPrefix} (own folder, per post)`
    );
  }

  const { data: blob, error: dlError } = await deps.supabase.storage
    .from(SOCIAL_IMAGES_BUCKET)
    .download(args.storagePath);
  if (dlError || !blob) {
    throw new SocialImageError(`upload not found at ${args.storagePath} — upload first, then finalize`);
  }
  if (blob.size > IMAGE_MAX_BYTES) {
    throw new SocialImageError(`image is ${Math.round(blob.size / 1024 / 1024)}MB — the limit is 10MB`);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const meta = parseImageMeta(bytes);
  if (!meta) {
    throw new SocialImageError("not a supported image — use JPEG, PNG, or WebP");
  }

  const { data: signed, error: signError } = await deps.supabase.storage
    .from(SOCIAL_IMAGES_BUCKET)
    .createSignedUrl(args.storagePath, IMAGE_SIGNED_URL_TTL_SECONDS);
  if (signError || !signed) {
    throw new SocialImageError(`could not sign a display URL: ${signError?.message}`);
  }

  const post = await setPostImage(deps.supabase, args.post.id, {
    url: signed.signedUrl,
    storagePath: args.storagePath,
    altText: args.altText,
    meta: { mime: meta.mime, width: meta.width, height: meta.height, bytes: blob.size },
  });

  const norm = PLATFORM_LIMITS[args.post.platform].imageNorm;
  const warning = imageNormWarning(meta, norm, PLATFORM_LIMITS[args.post.platform].label);

  await emitSocialEvent(deps.supabase, deps.courseIdForEvents, "social_post_image_attached", {
    postId: post.id,
    mime: meta.mime,
    width: meta.width,
    height: meta.height,
  });

  return { post, warning, meta: { ...meta, bytes: blob.size } };
}

/** Detach the image reference (object retained). */
export async function removeImageAttachment(
  deps: FinalizeImageDeps,
  postId: string
): Promise<SocialPost> {
  const post = await clearPostImage(deps.supabase, postId);
  await emitSocialEvent(deps.supabase, deps.courseIdForEvents, "social_post_image_removed", {
    postId,
  });
  return post;
}

/** A fresh short-TTL signed URL for display/download (regenerated on view). */
export async function signImageUrl(supabase: DB, storagePath: string): Promise<string | null> {
  const { data } = await supabase.storage
    .from(SOCIAL_IMAGES_BUCKET)
    .createSignedUrl(storagePath, IMAGE_SIGNED_URL_TTL_SECONDS);
  return data?.signedUrl ?? null;
}
