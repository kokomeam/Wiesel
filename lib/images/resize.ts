/**
 * Image sizing + storage-path math (PURE — no DOM, no canvas, no Supabase).
 * Shared by the browser downscaler (lib/images/clientResize.ts), the upload
 * actions, and the verify suite. All uploads land in the public
 * `course-assets` bucket under the uploader's OWN {uid}/ prefix — the existing
 * per-user storage policies are the write gate, so the path builders here pin
 * that first segment.
 */

export const AVATAR_MAX_PX = 512;
export const COVER_MAX_W = 1600;
export const COVER_MAX_H = 900;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MiB

/** Largest size that fits inside maxW×maxH preserving aspect. NEVER upscales
 *  (a source already inside the box comes back unchanged). */
export function fitWithin(
  w: number,
  h: number,
  maxW: number,
  maxH: number
): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const scale = Math.min(maxW / w, maxH / h, 1);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/** Source-space crop rect (sx/sy/sw/sh, the drawImage source args) that
 *  center-crops the source to `targetAspect` (width / height). */
export function centerCrop(
  srcW: number,
  srcH: number,
  targetAspect: number
): { sx: number; sy: number; sw: number; sh: number } {
  if (srcW <= 0 || srcH <= 0 || targetAspect <= 0) {
    return { sx: 0, sy: 0, sw: Math.max(srcW, 0), sh: Math.max(srcH, 0) };
  }
  const srcAspect = srcW / srcH;
  if (srcAspect > targetAspect) {
    // Wider than the target: trim the sides.
    const sw = Math.round(srcH * targetAspect);
    return { sx: Math.round((srcW - sw) / 2), sy: 0, sw, sh: srcH };
  }
  if (srcAspect < targetAspect) {
    // Taller than the target: trim top and bottom.
    const sh = Math.round(srcW / targetAspect);
    return { sx: 0, sy: Math.round((srcH - sh) / 2), sw: srcW, sh };
  }
  return { sx: 0, sy: 0, sw: srcW, sh: srcH };
}

/**
 * Accepted upload formats → storage extension. Deliberately narrow:
 * - NO image/svg+xml — SVG can carry scripts and the bucket serves public
 *   URLs, so it's an XSS vector, not an image format here.
 * - NO image/gif — the canvas downscaler would flatten animation anyway;
 *   re-encode as one of the raster formats instead.
 */
export function extForMime(mime: string): "jpg" | "png" | "webp" | null {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

/** {uid}/covers/{courseId}/{fileId}.{ext} — uid FIRST (the storage policy key). */
export function coverStoragePath(
  uid: string,
  courseId: string,
  fileId: string,
  ext: string
): string {
  return `${uid}/covers/${courseId}/${fileId}.${ext}`;
}

/** {uid}/avatar/{fileId}.{ext} — uid FIRST (the storage policy key). */
export function avatarStoragePath(uid: string, fileId: string, ext: string): string {
  return `${uid}/avatar/${fileId}.${ext}`;
}

/**
 * Bucket-relative object path from a course-assets PUBLIC URL, or null for
 * anything else (external/legacy URLs must never be touched by cleanup).
 * Anchored to the full Supabase storage prefix so an unrelated URL that
 * merely contains "course-assets" can't be mis-parsed into a delete target.
 */
export function storagePathFromPublicUrl(url: string): string | null {
  const marker = "/storage/v1/object/public/course-assets/";
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const path = url.slice(idx + marker.length).split("?")[0].split("#")[0];
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}
