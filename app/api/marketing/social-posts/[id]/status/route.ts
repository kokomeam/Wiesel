/** POST /api/marketing/social-posts/[id]/status — lifecycle transition;
 *  posted_manual stamps postedManuallyAt. */

import { runSocialPostTool } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runSocialPostTool(req, "mark_social_post_status", (body) => ({
    postId: id,
    status: body.status,
  }));
}
