"use client";

/**
 * PERF-1 D3 — the ONE image pattern for slide surfaces (structured image
 * layouts + the positioned image element), used identically in the editor
 * canvas, the filmstrip thumbnails, and the read-only learner SlideView
 * (no store imports — SlideView must stay editor-store-free).
 *
 * Branch rule (same as the avatar/cover sites): browser-local sources
 * (blob:/data: object-URL uploads, inline SVG placeholders) render a plain
 * <img> — next/image cannot optimize them; http(s) sources go through
 * next/image ONLY when the host is one we've allowed in next.config
 * remotePatterns (this project's Supabase storage or image.mux.com) — an
 * unlisted host would make next/image THROW at render time and take the
 * whole slide down, so anything else falls back to the plain <img> too.
 *
 * Rendered with `fill` inside the caller's fixed-aspect positioned box, so
 * the caller passes a `sizes` hint scaled to the box's fraction of the
 * 1280×720 logical canvas.
 */

import Image from "next/image";

function isOptimizableSrc(src: string): boolean {
  if (!src.startsWith("https://")) return false;
  try {
    const url = new URL(src);
    if (url.hostname === "image.mux.com") return true;
    const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL
      ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname
      : null;
    const hostAllowed =
      url.hostname === supabaseHost || url.hostname.endsWith(".supabase.co");
    return hostAllowed && url.pathname.startsWith("/storage/v1/object/public/");
  } catch {
    return false;
  }
}

export function SlideImage({
  src,
  alt,
  sizes,
  objectFit = "cover",
  draggable,
  className,
}: {
  src: string;
  alt: string;
  /** Responsive hint matched to the box's share of the logical canvas. */
  sizes: string;
  objectFit?: "cover" | "contain";
  draggable?: boolean;
  className?: string;
}) {
  if (!isOptimizableSrc(src)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- browser-local or non-allowlisted source (see header comment)
      <img
        src={src}
        alt={alt}
        draggable={draggable}
        className={className}
        style={{ width: "100%", height: "100%", objectFit, display: "block" }}
      />
    );
  }
  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      draggable={draggable}
      className={className}
      style={{ objectFit }}
    />
  );
}
