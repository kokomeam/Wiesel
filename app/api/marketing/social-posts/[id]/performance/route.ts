/** POST /api/marketing/social-posts/[id]/performance — manual metrics and/or
 *  one-tap qualitative rating on a posted_manual post. */

import { runSocialPostTool } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runSocialPostTool(req, "log_social_post_performance", (body) => ({
    postId: id,
    impressions: body.impressions ?? null,
    likes: body.likes ?? null,
    comments: body.comments ?? null,
    shares: body.shares ?? null,
    clicks: body.clicks ?? null,
    qualitative: body.qualitative ?? null,
  }));
}
