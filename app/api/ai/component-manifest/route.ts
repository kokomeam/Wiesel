/**
 * Machine-readable component manifest endpoint.
 * AI agents GET this to learn the component types, their allowed children,
 * and the patch actions that may target them.
 */

import { NextResponse } from "next/server";
import { componentManifest } from "@/lib/course/manifest";

export function GET() {
  return NextResponse.json({
    aiReadableVersion: "1.0",
    patchEndpointNote:
      "Mutations are CoursePatch objects validated against CoursePatchSchema (lib/course/patches.ts). See data-ai-* DOM attributes for live node ids.",
    componentTypes: componentManifest,
  });
}
