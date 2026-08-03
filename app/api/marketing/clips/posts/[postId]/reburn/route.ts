/**
 * POST /api/marketing/clips/posts/[postId]/reburn (directive H-3) — edit a
 * clip post's burned hook/captions and re-burn LOCALLY from its clean master
 * (update_clip_hook via the gate: reversible, versioned write, ledger-
 * counted daily budget, zero provider cost).
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
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const auth = await socialRouteAuth((body.courseId as string | undefined) ?? null);
  if (auth instanceof NextResponse) return auth;
  try {
    const outcome = await executeMarketingTool(
      "update_clip_hook",
      {
        postId,
        expectedVersion: body.expectedVersion,
        hookText: body.hookText ?? null,
        animation: body.animation ?? null,
        holdSeconds: body.holdSeconds ?? null,
        captionsEnabled: body.captionsEnabled ?? null,
        captionStyle: body.captionStyle ?? null,
      },
      auth.ctx
    );
    return NextResponse.json({ summary: outcome.summary, data: outcome.data ?? null });
  } catch (err) {
    return clipErrorResponse(err);
  }
}
