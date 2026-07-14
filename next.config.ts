import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
