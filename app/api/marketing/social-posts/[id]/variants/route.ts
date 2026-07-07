/** POST /api/marketing/social-posts/[id]/variants — up to 3 new-variant rows
 *  (the original untouched). */

import { runSocialPostTool } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runSocialPostTool(req, "create_social_post_variant", (body) => ({
    postId: id,
    n: body.n ?? 3,
  }));
}
