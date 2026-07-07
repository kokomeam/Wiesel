/** POST /api/marketing/social-posts/[id]/rewrite — native rewrite for the
 *  other platform as a NEW draft (parentPostId links back). */

import { runSocialPostTool } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runSocialPostTool(req, "rewrite_for_platform", (body) => ({
    postId: id,
    targetPlatform: body.targetPlatform,
  }));
}
