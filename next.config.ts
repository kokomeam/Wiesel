import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PERF-1 D3: the image pipeline. `next start` optimizes through Next's
  // bundled sharp (on-box AVIF/WebP resize); on Vercel the platform's image
  // optimizer takes over with this same config. remotePatterns require
  // LITERAL hostnames: the first entry is THIS project's Supabase storage
  // host (from NEXT_PUBLIC_SUPABASE_URL in .env.local); the `*.supabase.co`
  // wildcard keeps fresh environments working without a config edit.
  // image.mux.com serves video posters/filmstrip thumbnails.
  images: {
    formats: ["image/avif", "image/webp"],
    // Largest stored asset classes: covers ≤1600w, AI slide PNGs ≤1536w,
    // avatars ≤512 — no 2048/3840 sources exist, so cap the ladder at 1920.
    deviceSizes: [640, 828, 1080, 1200, 1600, 1920],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "mfqolkzocxssgogcmhzf.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
      { protocol: "https", hostname: "image.mux.com" },
    ],
  },
  experimental: {
    // PERF-1 B5: the Next Router Cache IS the client-side data cache (no
    // parallel query library — §9). Forward navigations within 30s reuse the
    // cached RSC payload and paint instantly; back/forward restores are
    // already instant. Server-side entity tiering (immutable publications vs
    // drafts vs analytics) lives in the data layer — see
    // docs/perf/caching-policy.md.
    staleTimes: {
      dynamic: 30,
      static: 300,
    },
  },
  // The clip render stack runs INSIDE API routes (the scheduler tick) but
  // must never be bundled by Next: Remotion's renderer/bundler resolve
  // platform binaries + their own webpack at runtime, and ffmpeg-static is
  // a real binary. Externalizing keeps them as plain runtime require()s.
  serverExternalPackages: [
    "@remotion/bundler",
    "@remotion/renderer",
    "@remotion/tailwind-v4",
    "remotion",
    "ffmpeg-static",
  ],
  // Serverless deploys need the traced files for the render tick (the
  // ffmpeg binary + the Remotion composition sources it bundles at runtime).
  outputFileTracingIncludes: {
    "/api/marketing/scheduler/tick": [
      "./node_modules/ffmpeg-static/ffmpeg*",
      "./lib/marketing/clips/render/slideShort/**",
      "./app/globals.css",
    ],
  },
};

export default nextConfig;
