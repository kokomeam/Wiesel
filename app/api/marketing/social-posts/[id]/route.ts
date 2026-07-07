/**
 * /api/marketing/social-posts/[id]
 *   GET    — the full post (image display URL re-signed on view)
 *   PATCH  — versioned field patch (requires expectedVersion → 409 on stale)
 *   DELETE — SOFT delete (archived + recoverable)
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSocialPost } from "@/lib/marketing/social/repository";
import { signImageUrl } from "@/lib/marketing/social/images";
import { executeMarketingTool } from "@/lib/marketing/tools";
import { socialErrorResponse, socialRouteAuth } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const post = await getSocialPost(supabase, id);
    if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const imageUrl = post.imageStoragePath ? await signImageUrl(supabase, post.imageStoragePath) : null;
    return NextResponse.json({ post: { ...post, imageUrl: imageUrl ?? post.imageUrl } });
  } catch (err) {
    return socialErrorResponse(err);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.expectedVersion !== "number") {
    return NextResponse.json({ error: "expectedVersion is required" }, { status: 400 });
  }
  const auth = await socialRouteAuth(null);
  if (auth instanceof NextResponse) return auth;
  try {
    const out = await executeMarketingTool(
      "update_social_post",
      {
        postId: id,
        expectedVersion: body.expectedVersion,
        body: body.body ?? null,
        cta: body.cta ?? null,
        hashtags: body.hashtags ?? null,
        imageAltText: body.imageAltText ?? null,
        audience: body.audience ?? null,
        funnelStage: body.funnelStage ?? null,
        goal: body.goal ?? null,
        tone: body.tone ?? null,
        suggestedImageIdea: body.suggestedImageIdea ?? null,
        plannedPostAt: body.plannedPostAt ?? null,
        clearNulls: body.clearNulls ?? null,
      },
      auth.ctx
    );
    return NextResponse.json({ summary: out.summary, post: out.data, actionId: out.actionId });
  } catch (err) {
    return socialErrorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await socialRouteAuth(null);
  if (auth instanceof NextResponse) return auth;
  try {
    const out = await executeMarketingTool("delete_social_post", { postId: id }, auth.ctx);
    return NextResponse.json({ summary: out.summary, actionId: out.actionId });
  } catch (err) {
    return socialErrorResponse(err);
  }
}
