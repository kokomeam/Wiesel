/**
 * /api/marketing/clips/jobs (M-E surface over the M-B tools)
 *   POST — queue a render for a candidate (generate_lesson_clips via the
 *          gate; body {candidateId, preset?, courseId?})
 *   GET  — list a lesson's render jobs (?lessonId=)
 * Logic-free: every mutation flows executeMarketingTool → the gate.
 */

import { NextResponse } from "next/server";
import { executeMarketingTool } from "@/lib/marketing/tools";
import { socialRouteAuth } from "@/lib/marketing/social/routeHelpers";
import { clipErrorResponse } from "@/lib/marketing/clips/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  const auth = await socialRouteAuth((body.courseId as string | undefined) ?? null);
  if (auth instanceof NextResponse) return auth;
  try {
    const outcome = await executeMarketingTool(
      "generate_lesson_clips",
      { candidateId: body.candidateId, preset: body.preset ?? null },
      auth.ctx
    );
    return NextResponse.json({ summary: outcome.summary, data: outcome.data ?? null, actionId: outcome.actionId });
  } catch (err) {
    return clipErrorResponse(err);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lessonId = url.searchParams.get("lessonId");
  if (!lessonId) return NextResponse.json({ error: "lessonId required" }, { status: 400 });
  const auth = await socialRouteAuth(url.searchParams.get("courseId"));
  if (auth instanceof NextResponse) return auth;
  try {
    const outcome = await executeMarketingTool("list_clip_jobs", { lessonId }, auth.ctx);
    return NextResponse.json({ data: outcome.data ?? null });
  } catch (err) {
    return clipErrorResponse(err);
  }
}
