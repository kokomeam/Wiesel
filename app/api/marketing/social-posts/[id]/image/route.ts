/**
 * /api/marketing/social-posts/[id]/image
 *   POST   — finalize an upload: validate magic bytes + size + dimensions
 *            (soft platform-norm warning), attach the reference
 *   DELETE — detach the reference (the object is retained)
 */

import { runSocialPostTool } from "@/lib/marketing/social/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runSocialPostTool(req, "attach_social_post_image", (body) => ({
    postId: id,
    storagePath: body.storagePath,
    altText: body.altText ?? null,
  }));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return runSocialPostTool(req, "remove_social_post_image", () => ({ postId: id }), {
    requireBody: false,
  });
}
