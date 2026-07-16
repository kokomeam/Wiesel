/**
 * POST /api/marketing/clips/posts/[postId]/kit (M-E) — build/rebuild the
 * posting kit for a rendered clip (generate_posting_kit via the gate).
 */

import { NextResponse } from "next/server";
import { executeMarketingTool } from "@/lib/marketing/tools";
import { socialRouteAuth } from "@/lib/marketing/social/routeHelpers";
import { clipErrorResponse } from "@/lib/marketing/clips/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ postId: string }> }) {
  const { postId } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // platform defaults to the post's own
  }
  const auth = await socialRouteAuth((body.courseId as string | undefined) ?? null);
  if (auth instanceof NextResponse) return auth;
  try {
    const outcome = await executeMarketingTool(
      "generate_posting_kit",
      { postId, platform: body.platform ?? null },
      auth.ctx
    );
    return NextResponse.json({ summary: outcome.summary, data: outcome.data ?? null });
  } catch (err) {
    return clipErrorResponse(err);
  }
}
