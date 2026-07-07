/** POST /api/marketing/social-posts/[id]/revise — free-form AI revision
 *  (versioned; 409 on a stale expectedVersion). */

import { runSocialPostTool } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runSocialPostTool(req, "revise_social_post", (body) => ({
    postId: id,
    expectedVersion: body.expectedVersion,
    instruction: body.instruction,
  }));
}
