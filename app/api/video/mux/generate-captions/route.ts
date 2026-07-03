/**
 * POST /api/video/mux/generate-captions — request Mux auto-generated captions for
 * an already-ready asset (the "Generate captions" button, a retry after failure,
 * or a video uploaded before captions-by-default). Idempotent: if a caption track
 * already exists it just re-syncs. Generation is ASYNCHRONOUS — this returns as
 * soon as the request is accepted; the client polls the caption status.
 *
 * JSON body: { videoAssetId, languageCode? }. Auth + ownership enforced.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { requireVideoAssetAccess } from "@/lib/video/videoAccess";
import {
  DEFAULT_CAPTION_LANGUAGE,
  DEFAULT_CAPTION_NAME,
  syncVideoAssetFromMux,
  updateVideoAsset,
} from "@/lib/video/videoService";
import { getVideoProvider, VideoProviderError } from "@/lib/video/provider";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANG_RE = /^[a-z]{2}(-[a-z]{2,})?$/i;

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();

  let body: { videoAssetId?: unknown; languageCode?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("Expected a JSON body.", { status: 400 });
  }
  const { videoAssetId, languageCode } = body;
  if (typeof videoAssetId !== "string" || !UUID_RE.test(videoAssetId)) {
    return new Response("Missing or invalid videoAssetId.", { status: 400 });
  }
  const lang =
    typeof languageCode === "string" && LANG_RE.test(languageCode)
      ? languageCode.toLowerCase()
      : DEFAULT_CAPTION_LANGUAGE;

  const access = await requireVideoAssetAccess(supabase, videoAssetId);
  if (!access.ok) return new Response(access.message, { status: access.status });
  const row = access.row;

  const provider = getVideoProvider();
  if (!provider.isConfigured() || typeof provider.requestGeneratedSubtitles !== "function") {
    return new Response("Caption generation isn't available.", { status: 503 });
  }
  if (!row.mux_asset_id) {
    return new Response("This video isn't ready for captions yet.", { status: 409 });
  }

  try {
    const asset = await provider.getAsset(row.mux_asset_id);
    // Already has a caption track? Just re-sync (picks up its current status +
    // fetches the transcript if it's ready) — don't create a duplicate.
    if ((asset.captions ?? []).length > 0) {
      const view = await syncVideoAssetFromMux(supabase, provider, row);
      return Response.json(view);
    }
    if (!asset.audioTrackId) {
      return new Response("This video has no audio track to transcribe.", { status: 409 });
    }

    await provider.requestGeneratedSubtitles(row.mux_asset_id, asset.audioTrackId, {
      languageCode: lang,
      name: DEFAULT_CAPTION_NAME,
    });

    // Mark the row generating so the client shows "Generating…" + keeps polling
    // (the track appears in `preparing` shortly, then `ready`).
    const upd = await updateVideoAsset(supabase, row.id, {
      caption_status: "generating",
      caption_language_code: lang,
      caption_source: "generated",
      caption_error: null,
    });
    if ("error" in upd) {
      console.log(JSON.stringify({ tag: "video_caption_request_update_error", message: upd.error }));
    }
    const view = await syncVideoAssetFromMux(supabase, provider, "error" in upd ? row : upd.row);
    return Response.json(view);
  } catch (err) {
    const status = err instanceof VideoProviderError ? err.status : 502;
    console.log(
      JSON.stringify({ tag: "video_caption_request_error", status, message: (err as Error).message })
    );
    return new Response("We couldn't start caption generation. Please try again.", { status: 502 });
  }
}
