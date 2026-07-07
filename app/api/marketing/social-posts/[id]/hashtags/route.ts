/** POST /api/marketing/social-posts/[id]/hashtags — suggestions only (the
 *  creator applies them explicitly via PATCH). */

import { runSocialPostTool } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runSocialPostTool(
    req,
    "suggest_hashtags",
    () => ({ postId: id, text: null, platform: null }),
    { requireBody: false }
  );
}
