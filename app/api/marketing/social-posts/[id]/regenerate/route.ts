/** POST /api/marketing/social-posts/[id]/regenerate — fresh take with the
 *  post's stored parameters (versioned). */

import { runSocialPostTool } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runSocialPostTool(req, "regenerate_social_post", (body) => ({
    postId: id,
    expectedVersion: body.expectedVersion,
  }));
}
