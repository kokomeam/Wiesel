/**
 * Browser-side image downscaler (canvas — no React, no Supabase). Pairs with
 * the pure sizing math in lib/images/resize.ts. Falls back to the ORIGINAL
 * bytes on any failure (decode error, canvas unavailable, toBlob null) so an
 * odd-but-valid image still uploads rather than dead-ending the flow.
 */

import { centerCrop, extForMime, fitWithin } from "./resize";

export async function downscaleImageFile(
  file: File,
  opts: { maxW: number; maxH: number; square?: boolean; quality?: number }
): Promise<{ blob: Blob; ext: "jpg" | "png" | "webp" }> {
  const fallbackExt = extForMime(file.type) ?? "jpg";
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const crop = opts.square
        ? centerCrop(bitmap.width, bitmap.height, 1)
        : { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height };
      const { width, height } = fitWithin(crop.sw, crop.sh, opts.maxW, opts.maxH);
      if (width <= 0 || height <= 0) return { blob: file, ext: fallbackExt };

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { blob: file, ext: fallbackExt };
      ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);

      // PNG keeps transparency; everything else re-encodes as JPEG.
      const outMime =
        file.type === "image/png"
          ? "image/png"
          : file.type === "image/webp"
            ? "image/webp"
            : "image/jpeg";
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, outMime, opts.quality ?? 0.85)
      );
      if (!blob) return { blob: file, ext: fallbackExt };
      return { blob, ext: extForMime(outMime) ?? fallbackExt };
    } finally {
      bitmap.close();
    }
  } catch {
    return { blob: file, ext: fallbackExt };
  }
}
