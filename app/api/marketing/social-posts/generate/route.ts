/**
 * POST /api/marketing/social-posts/generate — SSE. Drafts stream into the
 * queue incrementally as each validates (never a monolithic spinner). Accepts
 * an Idempotency-Key header: a replay returns the original batch. Quality
 * over speed — the model call runs under the hard 3-minute ceiling; on any
 * failure NOTHING is persisted and the client keeps its parameters for Retry.
 */

import { NextResponse } from "next/server";
import { executeMarketingTool } from "@/lib/marketing/tools";
import { socialErrorResponse, socialRouteAuth } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const auth = await socialRouteAuth((body.courseId as string | undefined) ?? null);
  if (auth instanceof NextResponse) return auth;
  const idempotencyKey = req.headers.get("Idempotency-Key");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: { type: string; data?: unknown }) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        const outcome = await executeMarketingTool(
          "generate_social_post_drafts",
          {
            sourceType: body.sourceType,
            moduleId: body.moduleId ?? null,
            lessonId: body.lessonId ?? null,
            sourceText: body.sourceText ?? null,
            platform: body.platform,
            goal: body.goal ?? null,
            funnelMix: body.funnelMix ?? "pinned",
            tone: body.tone,
            count: body.count,
            timingPreset: body.timingPreset ?? "none",
            customTimes: body.customTimes ?? null,
            timeZone: body.timeZone ?? null,
            idempotencyKey: idempotencyKey ?? null,
          },
          { ...auth.ctx, progress: emit }
        );
        emit({
          type: "complete",
          data: {
            summary: outcome.summary,
            actionId: outcome.actionId,
            revertExpiresAt: outcome.revertExpiresAt ?? null,
            ...(outcome.data as Record<string, unknown>),
          },
        });
      } catch (err) {
        const res = socialErrorResponse(err);
        const payload = await res.json();
        emit({ type: "error", data: { status: res.status, ...payload } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
