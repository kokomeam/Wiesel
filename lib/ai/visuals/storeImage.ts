/**
 * Persist a generated illustration to Supabase Storage.
 *
 * The image model returns raw bytes (base64); we upload them to the public
 * `course-assets` bucket under the OWNER's folder — `{ownerId}/ai-visuals/…` —
 * so the bucket's RLS insert policy (folder[0] === auth.uid()) passes, then
 * reference the resulting PUBLIC URL on the slide. A generated image NEVER lands
 * on a slide as a blob/data URL (those don't survive a reload or export).
 *
 * Returns null on any failure so the caller degrades gracefully (the add_image
 * tool surfaces a clear error and the model falls back to a diagram / prose).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { GeneratedImage } from "../modelClient";

const BUCKET = "course-assets";

export interface StoredImage {
  url: string;
  storagePath: string;
  width?: number;
  height?: number;
}

function extFor(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

export async function storeGeneratedImage(
  supabase: SupabaseClient<Database>,
  args: { ownerId: string; courseId: string; image: GeneratedImage }
): Promise<StoredImage | null> {
  const { ownerId, courseId, image } = args;

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(image.base64, "base64"));
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;

  const path = `${ownerId}/ai-visuals/${courseId}/${crypto.randomUUID()}.${extFor(image.mimeType)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: image.mimeType,
    upsert: false,
  });
  if (error) {
    console.log(JSON.stringify({ tag: "ai_visual_store_error", message: error.message }));
    return null;
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) return null;
  return { url: data.publicUrl, storagePath: path, width: image.width, height: image.height };
}
