/**
 * Generate ONE educational image and store it — the shared gen → (reference) verify
 * → one regen → store flow, extracted so BOTH the (now off-critical-path) generation
 * endpoint and any server caller reuse the same logic + the same proxied client.
 *
 * Returns the stored asset (public URL + path) or null when generation failed, the
 * image returned nothing, or a reference image failed verification after one regen
 * (the caller then prose-degrades). Pure given an injected ModelClient + Supabase.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { ImageBackground, ImageQuality, ImageSize, ModelClient } from "../modelClient";
import { AI_VISUALS } from "./config";
import { verifyReferenceImage } from "./imageIntent";
import { storeGeneratedImage, type StoredImage } from "./storeImage";

export interface GenerateAndStoreParams {
  model: ModelClient;
  supabase: SupabaseClient<Database>;
  ownerId: string;
  courseId: string;
  /** The FULL gpt-image prompt (already built by buildImagePrompt). */
  prompt: string;
  size: ImageSize;
  background: ImageBackground;
  quality?: ImageQuality;
  thinking?: boolean;
  /** Reference images only: the required labels to vision-verify (regen once on fail). */
  verify?: { requiredLabels: string[] };
  signal?: AbortSignal;
}

function aspectFor(size: ImageSize): string {
  return size === "1024x1024" ? "1:1" : size === "1024x1536" ? "3:4" : "3:2";
}

export async function generateAndStoreImage(p: GenerateAndStoreParams): Promise<StoredImage | null> {
  const generate = p.model.generateImage?.bind(p.model);
  if (!generate) return null;
  const aspectRatio = aspectFor(p.size);
  const gen = (prompt: string) =>
    generate({ prompt, size: p.size, background: p.background, quality: p.quality, thinking: p.thinking, aspectRatio, signal: p.signal });

  let img = await gen(p.prompt);
  if (!img) return null;

  const wantVerify =
    !!p.verify && AI_VISUALS.verifyReferenceImages && !!p.model.inspectImage && p.verify.requiredLabels.length > 0;
  if (wantVerify && p.verify) {
    const inspector = { inspectImage: p.model.inspectImage!.bind(p.model) };
    let ok = await verifyReferenceImage(inspector, img, p.verify.requiredLabels, p.signal);
    if (!ok) {
      const strict = `${p.prompt}\n\nIMPORTANT: render EVERY required label exactly and legibly; include ALL listed labels; add no other text.`;
      const retry = await gen(strict);
      if (!retry) return null;
      img = retry;
      ok = await verifyReferenceImage(inspector, img, p.verify.requiredLabels, p.signal);
      if (!ok) {
        console.log(JSON.stringify({ tag: "ai_visual_verify", outcome: "failed_after_retry", labels: p.verify.requiredLabels.length }));
        return null;
      }
    }
  }

  return storeGeneratedImage(p.supabase, { ownerId: p.ownerId, courseId: p.courseId, image: img });
}
