/**
 * /api/video/[id] — operate on a single video asset by its `video_assets` row id.
 *
 *   DELETE — remove the Mux asset (best-effort) + the row. Called when a video
 *            block is deleted or replaced. Auth + ownership enforced.
 *
 * Status polling lives at POST /api/video/mux/asset-status (per the video API
 * surface); this route is intentionally just the resource-level cleanup.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { requireVideoAssetAccess } from "@/lib/video/videoAccess";
import { deleteVideoAsset } from "@/lib/video/videoService";
import { getVideoProvider } from "@/lib/video/provider";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const supabase = await createClient();

  const access = await requireVideoAssetAccess(supabase, id);
  if (!access.ok) return new Response(access.message, { status: access.status });

  const provider = getVideoProvider();
  const err = await deleteVideoAsset(supabase, provider, access.row);
  if (err) {
    console.log(JSON.stringify({ tag: "video_delete_error", message: err }));
    return new Response("We couldn't delete that video.", { status: 500 });
  }
  return new Response(null, { status: 204 });
}
