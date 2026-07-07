/** POST /api/marketing/social-posts/[id]/alt-text — draft alt text as a
 *  SUGGESTION (applied only via an explicit PATCH). */

import { runSocialPostTool } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runSocialPostTool(req, "draft_image_alt_text", () => ({ postId: id }), {
    requireBody: false,
  });
}
