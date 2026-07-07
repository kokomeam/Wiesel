/**
 * /api/marketing/lessons/:lessonId/clip-moments (Phase 1.5 PRD §14, M-A slice)
 *   POST — run the moment selection pipeline (§7); returns ranked candidates.
 *          Model-required; on any failure NOTHING is persisted and the client
 *          keeps its parameters for Retry (the Phase 1 error contract).
 *   GET  — list the lesson's existing candidates (?includeDismissed=1).
 *
 * Logic-free routes: auth + context via the shared marketing route helper;
 * every mutation flows through executeMarketingTool → the gate (revert-log
 * entries for REST calls too — the Phase 1 invariant).
 */

import { NextResponse } from "next/server";
import { executeMarketingTool } from "@/lib/marketing/tools";
import { socialRouteAuth } from "@/lib/marketing/social/routeHelpers";
import { clipErrorResponse } from "@/lib/marketing/clips/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // an empty body is fine — every parameter has a default
  }

  const auth = await socialRouteAuth((body.courseId as string | undefined) ?? null);
  if (auth instanceof NextResponse) return auth;

  try {
    const outcome = await executeMarketingTool(
      "select_clip_moments",
      {
        lessonId,
        stages: body.stages ?? null,
        targetPlatforms: body.targetPlatforms ?? null,
        count: body.count ?? null,
      },
      auth.ctx
    );
    return NextResponse.json({
      summary: outcome.summary,
      data: outcome.data ?? null,
      actionId: outcome.actionId,
      revertExpiresAt: outcome.revertExpiresAt ?? null,
    });
  } catch (err) {
    return clipErrorResponse(err);
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await ctx.params;
  const url = new URL(req.url);

  const auth = await socialRouteAuth(url.searchParams.get("courseId"));
  if (auth instanceof NextResponse) return auth;

  try {
    const outcome = await executeMarketingTool(
      "list_clip_moment_candidates",
      { lessonId, includeDismissed: url.searchParams.get("includeDismissed") === "1" },
      auth.ctx
    );
    return NextResponse.json({ summary: outcome.summary, data: outcome.data ?? null });
  } catch (err) {
    return clipErrorResponse(err);
  }
}
