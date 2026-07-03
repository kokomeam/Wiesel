/**
 * POST /api/video/mux/create-upload — issue a Mux direct-upload URL for a lesson
 * video, and register a `video_assets` row (status=uploading). The browser then
 * PUTs the recorded/selected file straight to Mux (never through our server).
 *
 * JSON body: { courseId, lessonId?, blockId? }.
 * Returns { videoAssetId, uploadId, uploadUrl } — uploadUrl is one-time and NOT
 * persisted. Auth + course-ownership enforced; Mux secrets stay server-side.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, userOwnsCourse } from "@/lib/video/videoAccess";
import {
  createVideoAsset,
  DEFAULT_CAPTION_LANGUAGE,
  DEFAULT_CAPTION_NAME,
} from "@/lib/video/videoService";
import { getVideoProvider, VideoProviderError } from "@/lib/video/provider";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export async function POST(req: Request): Promise<Response> {
  const supabase = await createClient();

  const user = await getAuthedUser(supabase);
  if (!user) return new Response("Sign in to continue.", { status: 401 });

  let body: { courseId?: unknown; lessonId?: unknown; blockId?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response("Expected a JSON body.", { status: 400 });
  }

  const { courseId, lessonId, blockId } = body;
  if (!isUuid(courseId)) return new Response("Missing or invalid courseId.", { status: 400 });
  if (lessonId != null && lessonId !== "" && !isUuid(lessonId)) {
    return new Response("Invalid lessonId.", { status: 400 });
  }
  if (blockId != null && blockId !== "" && !isUuid(blockId)) {
    return new Response("Invalid blockId.", { status: 400 });
  }

  if (!(await userOwnsCourse(supabase, user.id, courseId))) {
    return new Response("You don't have access to this course.", { status: 403 });
  }

  const provider = getVideoProvider();
  if (!provider.isConfigured()) {
    return new Response(
      "Video hosting isn't configured. Set MUX_TOKEN_ID and MUX_TOKEN_SECRET.",
      { status: 503 }
    );
  }

  // 1) create the row first, so its id becomes the Mux passthrough token (lets
  //    webhooks route straight back to this row).
  const created = await createVideoAsset(supabase, {
    ownerId: user.id,
    courseId,
    lessonId: typeof lessonId === "string" && lessonId ? lessonId : null,
    blockId: typeof blockId === "string" && blockId ? blockId : null,
    // filled in below once we have the Mux upload id (two-step so passthrough=id)
    muxUploadId: "",
    // Auto-generate English captions by default (asynchronous — never blocks
    // playback). Seeds the row as caption_status="generating".
    requestCaptions: true,
    captionLanguageCode: DEFAULT_CAPTION_LANGUAGE,
  });
  if ("error" in created) {
    console.log(JSON.stringify({ tag: "video_create_row_error", message: created.error }));
    return new Response("We couldn't start the upload. Please try again.", { status: 500 });
  }
  const row = created.row;

  // 2) create the Mux direct upload with the row id as passthrough.
  const origin = req.headers.get("origin") ?? "*";
  try {
    let upload;
    try {
      upload = await provider.createDirectUpload({
        corsOrigin: origin,
        passthrough: row.id,
        generateSubtitles: { languageCode: DEFAULT_CAPTION_LANGUAGE, name: DEFAULT_CAPTION_NAME },
      });
    } catch (capErr) {
      // A caption request must NEVER block the upload (a Mux tier/version could reject
      // the generated_subtitles shape — we learned the hard way that an unverified
      // create-time field 502s uploads). Retry once WITHOUT subtitles and mark captions
      // not-requested; the on-demand "Generate captions" path still works post-ready.
      if (!(capErr instanceof VideoProviderError)) throw capErr;
      console.log(
        JSON.stringify({ tag: "video_caption_upload_fallback", message: (capErr as Error).message })
      );
      upload = await provider.createDirectUpload({ corsOrigin: origin, passthrough: row.id });
      await supabase
        .from("video_assets")
        .update({ caption_status: "none", caption_source: null, caption_language_code: null })
        .eq("id", row.id);
    }
    // 3) record the upload id on the row.
    const { error: updErr } = await supabase
      .from("video_assets")
      .update({ mux_upload_id: upload.uploadId })
      .eq("id", row.id);
    if (updErr) {
      console.log(JSON.stringify({ tag: "video_set_upload_id_error", message: updErr.message }));
    }
    return Response.json({
      videoAssetId: row.id,
      uploadId: upload.uploadId,
      uploadUrl: upload.uploadUrl,
    });
  } catch (err) {
    // roll back the row so a failed Mux call doesn't orphan a stuck record
    await supabase.from("video_assets").delete().eq("id", row.id);
    const status = err instanceof VideoProviderError ? err.status : 502;
    console.log(JSON.stringify({ tag: "video_create_upload_error", status, message: (err as Error).message }));
    return new Response("We couldn't reach the video service. Please try again.", { status: 502 });
  }
}
