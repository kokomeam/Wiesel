/**
 * POST /api/video/mux/asset-status — the client poll. Given a videoAssetId, pull
 * Mux's authoritative state, reconcile it into the row, and return the client-safe
 * view (status, playbackId, duration, aspect ratio, MP4 + HLS + thumbnail URLs).
 *
 * JSON body: { videoAssetId }. Auth + ownership enforced (RLS + explicit check).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { requireVideoAssetAccess } from "@/lib/video/videoAccess";
import { syncVideoAssetFromMux } from "@/lib/video/videoService";
import { getVideoProvider } from "@/lib/video/provider";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();

  let body: { videoAssetId?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("Expected a JSON body.", { status: 400 });
  }
  const { videoAssetId } = body;
  if (typeof videoAssetId !== "string" || !UUID_RE.test(videoAssetId)) {
    return new Response("Missing or invalid videoAssetId.", { status: 400 });
  }

  const access = await requireVideoAssetAccess(supabase, videoAssetId);
  if (!access.ok) return new Response(access.message, { status: access.status });

  const provider = getVideoProvider();
  const view = await syncVideoAssetFromMux(supabase, provider, access.row);
  return Response.json(view);
}
