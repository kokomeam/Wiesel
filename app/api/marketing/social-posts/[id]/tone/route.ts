/** POST /api/marketing/social-posts/[id]/tone — retone (updates copy AND the
 *  stored tone in one versioned write). */

import { runSocialPostTool } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runSocialPostTool(req, "change_post_tone", (body) => ({
    postId: id,
    expectedVersion: body.expectedVersion,
    targetTone: body.targetTone,
  }));
}
