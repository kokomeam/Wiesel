/**
 * POST /api/marketing/social-posts/[id]/track — export/copy telemetry
 * (social_post_copied / social_post_downloaded). The Phase-1 proxy for
 * "which drafts were actually used"; costs nothing, feeds the save-without-
 * rewrite success metric.
 */

import { NextResponse } from "next/server";
import { emitSocialEvent } from "@/lib/marketing/social/events";
import { getSocialPost } from "@/lib/marketing/social/repository";
import { socialErrorResponse, socialRouteAuth } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { what?: string; format?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const auth = await socialRouteAuth(null);
  if (auth instanceof NextResponse) return auth;
  try {
    const post = await getSocialPost(auth.ctx.supabase, id);
    if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (body.what === "copied") {
      await emitSocialEvent(auth.ctx.supabase, auth.ctx.courseId, "social_post_copied", {
        postId: id,
        what: body.format === "hashtags" ? "hashtags" : "body",
      });
    } else if (body.what === "downloaded") {
      await emitSocialEvent(auth.ctx.supabase, auth.ctx.courseId, "social_post_downloaded", {
        postId: id,
        format: body.format ?? "txt",
      });
    } else {
      return NextResponse.json({ error: "what must be 'copied' or 'downloaded'" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return socialErrorResponse(err);
  }
}
