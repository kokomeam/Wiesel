/**
 * Video-lesson checks (pure, no key / no DB / no browser).
 * Run: `npx tsx scripts/verify-video.ts`
 *
 * Covers the whole non-UI surface of the video feature: the block schema +
 * persistence round-trip, the validated UPDATE_VIDEO_LESSON patch reducer, the
 * factory, the pure status state machine + Mux reconciliation, trim validation,
 * playback-URL derivation, the row→view mapping, the recorder config/geometry,
 * and the Mux adapter (createUpload/getUpload/getAsset/delete) + webhook signature
 * verification driven by a mocked fetch.
 */

import { applyCoursePatch, CoursePatchSchema, type CoursePatch } from "@/lib/course/patches";
import { updateVideoLessonPatch } from "@/lib/course/commands";
import { createBlock, createVideoLessonBlock, createLesson, createModule } from "@/lib/course/factories";
import { LessonBlockSchema, CourseDocumentSchema } from "@/lib/course/schemas";
import { courseDocFromRows, courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import type { CourseDocument, VideoLessonBlock } from "@/lib/course/types";
import {
  canTransitionVideo,
  deriveCaptionFields,
  effectiveTrim,
  hasTrim,
  isActiveVideoStatus,
  MIN_TRIM_DURATION_SECONDS,
  reconcileMuxState,
  trimmedDurationSeconds,
  validateTrim,
} from "@/lib/video/videoStatus";
import { activeCaption, parseVtt, plainTextFromVtt } from "@/lib/video/captions";
import { animatedThumbnailUrl, captionVttUrl, hlsUrl, thumbnailUrl } from "@/lib/video/playbackUrls";
import { buildVideoAssetView, syncVideoAssetFromMux } from "@/lib/video/videoService";
import { captionsFromView, rowStatus, snapshotFromView, type VideoAssetRow } from "@/lib/video/videoTypes";
import {
  bubbleRect,
  formatDuration,
  formatVideoBytes,
  layoutForMode,
  modeMeta,
  RECORDING_MODES,
  validateVideoFile,
} from "@/lib/video/recorderConfig";
import type { ProviderAssetInfo, ProviderUploadInfo, VideoProvider } from "@/lib/video/provider/types";
import { createHmac } from "node:crypto";

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${n}`);
  } else {
    fail++;
    console.log(`  ✗ ${n} ${d}`);
  }
};

const NOW = "2026-07-01T00:00:00.000Z";

function docWithVideo(): { doc: CourseDocument; blockId: string; lessonId: string } {
  const mod = createModule("M", 0);
  const lesson = createLesson("L", 0);
  const block = createVideoLessonBlock(0);
  lesson.blocks = [block];
  mod.lessons = [lesson];
  const doc: CourseDocument = {
    id: "course-1",
    title: "Course",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: { createdAt: NOW, updatedAt: NOW, aiReadableVersion: "1.0" },
  };
  return { doc, blockId: block.id, lessonId: lesson.id };
}

function fakeRow(overrides: Partial<VideoAssetRow> = {}): VideoAssetRow {
  return {
    id: "vid-1",
    owner_id: "owner-1",
    course_id: "course-1",
    lesson_id: "lesson-1",
    block_id: "block-1",
    provider: "mux",
    mux_upload_id: "upl_1",
    mux_asset_id: "asset_1",
    mux_playback_id: "pb_1",
    playback_policy: "public",
    status: "ready",
    duration_seconds: 42,
    aspect_ratio: "16:9",
    mp4_url: "https://stream.mux.com/pb_1/highest.mp4",
    mp4_status: "ready",
    thumbnail_time: 0,
    error: null,
    caption_status: "none",
    caption_track_id: null,
    caption_track_name: null,
    caption_language_code: null,
    caption_source: null,
    caption_error: null,
    transcript: null,
    transcript_vtt: null,
    transcript_updated_at: null,
    metadata: {},
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function getVideoBlock(doc: CourseDocument): VideoLessonBlock {
  return doc.modules[0].lessons[0].blocks[0] as VideoLessonBlock;
}

const applyOk = (doc: CourseDocument, patch: CoursePatch): CourseDocument => {
  const r = applyCoursePatch(doc, patch, NOW);
  if (!r.ok) throw new Error(`patch failed: ${r.error}`);
  return r.doc;
};

async function main() {
  /* ── 1. factory + schema ── */
  console.log("\nFactory + schema");
  {
    const block = createVideoLessonBlock(2, "Intro");
    check("factory: type=video, status=empty", block.type === "video" && block.asset.status === "empty");
    check("factory: mux provider + default settings", block.asset.provider === "mux" && block.settings.showControls === true && block.settings.allowDownload === false);
    check("factory: includeMic default on", block.recording.includeMic === true);
    check("factory: order applied", block.order === 2 && block.title === "Intro");

    const viaCreate = createBlock("video", 0);
    check("createBlock('video') yields a valid empty video block", viaCreate.type === "video" && (viaCreate as VideoLessonBlock).asset.status === "empty");

    const parsed = LessonBlockSchema.safeParse(block);
    check("LessonBlockSchema parses a video block", parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues[0]));

    // a fully-populated ready block also validates
    const ready: VideoLessonBlock = {
      ...block,
      description: "A lesson",
      asset: {
        provider: "mux",
        status: "ready",
        videoAssetId: "vid-1",
        uploadId: "upl_1",
        assetId: "asset_1",
        playbackId: "pb_1",
        durationSeconds: 42,
        aspectRatio: "16:9",
        thumbnailUrl: "https://image.mux.com/pb_1/thumbnail.jpg",
        createdAt: NOW,
        updatedAt: NOW,
      },
      recording: { mode: "screen_camera", layout: "screen_with_camera_bubble", cameraBubblePosition: "bottom-left", includeMic: true },
      edit: { trimStartSeconds: 2, trimEndSeconds: 40 },
    };
    check("LessonBlockSchema parses a fully-populated ready block", LessonBlockSchema.safeParse(ready).success);
  }

  /* ── 2. persistence round-trip ── */
  console.log("\nPersistence round-trip");
  {
    const { doc } = docWithVideo();
    // set the block to a ready-ish state to exercise the payload
    const withReady = applyOk(doc, updateVideoLessonPatch(getVideoBlock(doc).id, {
      asset: { status: "ready", videoAssetId: "vid-9", playbackId: "pb_9", durationSeconds: 30 },
      edit: { trimStartSeconds: 1, trimEndSeconds: 25 },
      description: "Persisted",
    }));
    const rows = courseDocToRows(withReady, "owner-1");
    // courseDocFromRows expects DB Rows (with timestamps); the Insert shape omits
    // them — supply them so the reconstructed doc's metadata validates.
    const courseRow = { ...rows.course, created_at: NOW, updated_at: NOW };
    const back = courseDocFromRows(courseRow as never, rows.modules as never, rows.lessons as never, rows.blocks as never);
    const b = getVideoBlock(back);
    check("round-trip: type preserved", b.type === "video");
    check("round-trip: asset snapshot preserved", b.asset.playbackId === "pb_9" && b.asset.status === "ready" && b.asset.durationSeconds === 30);
    check("round-trip: trim preserved", b.edit.trimStartSeconds === 1 && b.edit.trimEndSeconds === 25);
    check("round-trip: description preserved", b.description === "Persisted");
    check("round-trip: whole doc validates", CourseDocumentSchema.safeParse(back).success);
  }

  /* ── 3. UPDATE_VIDEO_LESSON patch reducer ── */
  console.log("\nUPDATE_VIDEO_LESSON reducer");
  {
    const patch = updateVideoLessonPatch("b", { asset: { status: "processing" } });
    check("CoursePatchSchema parses UPDATE_VIDEO_LESSON", CoursePatchSchema.safeParse(patch).success);

    let { doc } = docWithVideo();
    const id = getVideoBlock(doc).id;

    doc = applyOk(doc, updateVideoLessonPatch(id, { asset: { status: "uploading", videoAssetId: "vid-1", uploadId: "upl_1" } }));
    check("reducer: sets asset fields", getVideoBlock(doc).asset.status === "uploading" && getVideoBlock(doc).asset.videoAssetId === "vid-1");

    doc = applyOk(doc, updateVideoLessonPatch(id, { asset: { status: "ready", playbackId: "pb_1", durationSeconds: 12 } }));
    const a = getVideoBlock(doc).asset;
    check("reducer: partial asset merge keeps prior ids", a.videoAssetId === "vid-1" && a.uploadId === "upl_1" && a.playbackId === "pb_1" && a.status === "ready");

    doc = applyOk(doc, updateVideoLessonPatch(id, { asset: { errorMessage: null }, edit: { trimStartSeconds: 3, trimEndSeconds: 10 } }));
    check("reducer: trim set", getVideoBlock(doc).edit.trimStartSeconds === 3 && getVideoBlock(doc).edit.trimEndSeconds === 10);

    doc = applyOk(doc, updateVideoLessonPatch(id, { edit: { trimStartSeconds: null } }));
    check("reducer: null clears an optional field", getVideoBlock(doc).edit.trimStartSeconds === undefined && getVideoBlock(doc).edit.trimEndSeconds === 10);

    doc = applyOk(doc, updateVideoLessonPatch(id, { settings: { allowDownload: true } }));
    check("reducer: settings merge (others untouched)", getVideoBlock(doc).settings.allowDownload === true && getVideoBlock(doc).settings.showControls === true);

    doc = applyOk(doc, updateVideoLessonPatch(id, { recording: { mode: "camera_only", includeMic: false } }));
    check("reducer: recording config", getVideoBlock(doc).recording.mode === "camera_only" && getVideoBlock(doc).recording.includeMic === false);

    doc = applyOk(doc, updateVideoLessonPatch(id, { description: "Hi" }));
    check("reducer: description set", getVideoBlock(doc).description === "Hi");
    doc = applyOk(doc, updateVideoLessonPatch(id, { description: null }));
    check("reducer: description cleared", getVideoBlock(doc).description === undefined);

    // apply to a non-existent block → fail cleanly
    const { doc: d2 } = docWithVideo();
    const r = applyCoursePatch(d2, updateVideoLessonPatch("nope", { asset: { status: "ready" } }), NOW);
    check("reducer: unknown block id fails cleanly", !r.ok);
  }

  /* ── 4. status state machine ── */
  console.log("\nStatus state machine");
  {
    check("transition uploading→processing ok", canTransitionVideo("uploading", "processing"));
    check("transition processing→ready ok", canTransitionVideo("processing", "ready"));
    check("transition ready→uploading (replace) ok", canTransitionVideo("ready", "uploading"));
    check("self-transition ok", canTransitionVideo("ready", "ready"));
    check("active while processing", isActiveVideoStatus("processing", null));
    check("active while ready+mp4 preparing", isActiveVideoStatus("ready", "preparing"));
    check("inactive when ready+mp4 ready", !isActiveVideoStatus("ready", "ready"));
    check("inactive when failed", !isActiveVideoStatus("failed", null));
  }

  /* ── 5. reconcileMuxState ── */
  console.log("\nreconcileMuxState");
  {
    const errored: ProviderAssetInfo = { assetId: "a", status: "errored", error: "bad" };
    check("errored asset → failed", reconcileMuxState({ asset: errored }).status === "failed");

    const readyMp4: ProviderAssetInfo = { assetId: "a", status: "ready", playbackId: "pb", durationSeconds: 5, aspectRatio: "16:9", mp4Url: "u", mp4Status: "ready" };
    const r1 = reconcileMuxState({ asset: readyMp4 });
    check("ready asset + mp4 ready → ready", r1.status === "ready" && r1.mux_playback_id === "pb" && r1.mp4_url === "u");

    const readyNoMp4: ProviderAssetInfo = { assetId: "a", status: "ready", playbackId: "pb", mp4Status: "preparing" };
    const rNoMp4 = reconcileMuxState({ asset: readyNoMp4 });
    check("ready asset + mp4 preparing → ready (mp4 fills in later)", rNoMp4.status === "ready" && rNoMp4.mp4_status === "preparing");

    const readyDisabled: ProviderAssetInfo = { assetId: "a", status: "ready", playbackId: "pb", mp4Status: "disabled" };
    check("ready asset + mp4 disabled → ready", reconcileMuxState({ asset: readyDisabled }).status === "ready");

    const preparing: ProviderAssetInfo = { assetId: "a", status: "preparing" };
    check("preparing asset → processing", reconcileMuxState({ asset: preparing }).status === "processing");

    const upCreated: ProviderUploadInfo = { uploadId: "u", status: "asset_created", assetId: "a" };
    const ru = reconcileMuxState({ upload: upCreated });
    check("upload asset_created → processing + asset id", ru.status === "processing" && ru.mux_asset_id === "a");

    const upTimeout: ProviderUploadInfo = { uploadId: "u", status: "timed_out" };
    check("upload timed_out → failed", reconcileMuxState({ upload: upTimeout }).status === "failed");

    const upWaiting: ProviderUploadInfo = { uploadId: "u", status: "waiting" };
    check("upload waiting → uploading", reconcileMuxState({ upload: upWaiting }).status === "uploading");
  }

  /* ── 6. trim validation ── */
  console.log("\nTrim validation");
  {
    check("valid trim ok", validateTrim({ trimStartSeconds: 2, trimEndSeconds: 8, durationSeconds: 10 }).ok);
    check("start>=end rejected", !validateTrim({ trimStartSeconds: 8, trimEndSeconds: 8, durationSeconds: 10 }).ok);
    check("end>duration rejected", !validateTrim({ trimEndSeconds: 12, durationSeconds: 10 }).ok);
    check("negative start rejected", !validateTrim({ trimStartSeconds: -1, durationSeconds: 10 }).ok);
    check("too-short window rejected", !validateTrim({ trimStartSeconds: 5, trimEndSeconds: 5 + MIN_TRIM_DURATION_SECONDS / 2, durationSeconds: 10 }).ok);
    check("undefined bounds ok (whole video)", validateTrim({ durationSeconds: 10 }).ok);
    const clamped = validateTrim({ trimEndSeconds: 10.02, durationSeconds: 10 });
    check("end clamped to duration", clamped.ok && (clamped.trimEndSeconds ?? 0) <= 10);

    const eff = effectiveTrim({ trimStartSeconds: 3, durationSeconds: 20 });
    check("effectiveTrim end falls back to duration", eff.start === 3 && eff.end === 20);
    const eff2 = effectiveTrim({ trimEndSeconds: 5, durationSeconds: 20 });
    check("effectiveTrim start defaults to 0", eff2.start === 0 && eff2.end === 5);

    // Trimmed length = end − start (what the UI shows once a trim is set).
    check("trimmedDuration full when no trim", trimmedDurationSeconds({ durationSeconds: 20 }) === 20);
    check("trimmedDuration start+end", trimmedDurationSeconds({ trimStartSeconds: 4, trimEndSeconds: 13, durationSeconds: 20 }) === 9);
    check("trimmedDuration end-only", trimmedDurationSeconds({ trimEndSeconds: 6, durationSeconds: 20 }) === 6);
    check("trimmedDuration start-only", trimmedDurationSeconds({ trimStartSeconds: 5, durationSeconds: 20 }) === 15);
    check("hasTrim detects a moved bound", hasTrim({ trimEndSeconds: 6 }) && hasTrim({ trimStartSeconds: 2 }));
    check("hasTrim false for natural edges", !hasTrim({ trimStartSeconds: 0 }) && !hasTrim({}));
  }

  /* ── 7. playback URLs ── */
  console.log("\nPlayback URLs");
  {
    check("hlsUrl shape", hlsUrl("pb_1") === "https://stream.mux.com/pb_1.m3u8");
    const t = thumbnailUrl("pb_1", { time: 3, width: 640, fitMode: "smartcrop" });
    check("thumbnailUrl shape", t.startsWith("https://image.mux.com/pb_1/thumbnail.jpg?") && t.includes("time=3") && t.includes("width=640") && t.includes("fit_mode=smartcrop"));
    check("thumbnailUrl no-opts", thumbnailUrl("pb_1") === "https://image.mux.com/pb_1/thumbnail.jpg");
    check("animatedThumbnailUrl shape", animatedThumbnailUrl("pb_1", { start: 1, end: 4 }).includes("animated.gif?"));
  }

  /* ── 8. row → view + snapshot ── */
  console.log("\nrow → view + snapshot");
  {
    const view = buildVideoAssetView(fakeRow());
    check("view: status coerced", view.status === "ready" && rowStatus(fakeRow()) === "ready");
    check("view: derives HLS URL", view.hlsUrl === "https://stream.mux.com/pb_1.m3u8");
    check("view: derives thumbnail URL", (view.thumbnailUrl ?? "").startsWith("https://image.mux.com/pb_1/thumbnail.jpg"));
    check("view: mp4 fields carried", view.mp4Url?.includes("highest.mp4") === true && view.mp4Status === "ready");
    check("view: null playback → null urls", buildVideoAssetView(fakeRow({ mux_playback_id: null })).hlsUrl === null);

    const snap = snapshotFromView(view);
    check("snapshot: maps view→block snapshot", snap.videoAssetId === "vid-1" && snap.playbackId === "pb_1" && snap.status === "ready" && snap.durationSeconds === 42);
    check("snapshot: provider mux", snap.provider === "mux");
  }

  /* ── 9. recorder config + geometry ── */
  console.log("\nRecorder config + geometry");
  {
    check("exactly three recording modes", RECORDING_MODES.length === 3);
    check("mode ids are the three expected", RECORDING_MODES.map((m) => m.id).join(",") === "screen_camera,camera_only,screen_only");
    check("screen_camera needs camera+screen", modeMeta("screen_camera").needsCamera && modeMeta("screen_camera").needsScreen);
    check("camera_only needs camera not screen", modeMeta("camera_only").needsCamera && !modeMeta("camera_only").needsScreen);
    check("screen_only needs screen not camera", !modeMeta("screen_only").needsCamera && modeMeta("screen_only").needsScreen);
    check("layoutForMode maps", layoutForMode("screen_camera") === "screen_with_camera_bubble" && layoutForMode("camera_only") === "camera_full" && layoutForMode("screen_only") === "screen_full");

    const br = bubbleRect(1280, 720, 16 / 9, "bottom-right");
    check("bubble bottom-right inside canvas", br.x + br.w <= 1280 && br.y + br.h <= 720 && br.x > 640 && br.y > 360);
    const bl = bubbleRect(1280, 720, 16 / 9, "top-left");
    check("bubble top-left near origin", bl.x < 100 && bl.y < 100);

    check("formatDuration mm:ss", formatDuration(75) === "1:15");
    check("formatDuration h:mm:ss", formatDuration(3661) === "1:01:01");
    check("formatVideoBytes MB", formatVideoBytes(5 * 1024 * 1024) === "5.0 MB");
    check("validateVideoFile ok mp4", validateVideoFile({ name: "a.mp4", type: "video/mp4", size: 1000 }).ok);
    check("validateVideoFile rejects non-video", !validateVideoFile({ name: "a.txt", type: "text/plain", size: 1000 }).ok);
    check("validateVideoFile rejects huge file", !validateVideoFile({ name: "a.mp4", type: "video/mp4", size: 5 * 1024 * 1024 * 1024 }).ok);
    check("validateVideoFile accepts blank-mime .mov", validateVideoFile({ name: "a.mov", type: "", size: 1000 }).ok);
  }

  /* ── 10. Mux adapter (mocked fetch) ── */
  console.log("\nMux adapter (mocked fetch)");
  {
    process.env.MUX_TOKEN_ID = "test_id";
    process.env.MUX_TOKEN_SECRET = "test_secret";
    const { muxProvider } = await import("@/lib/video/provider/muxClient");

    const realFetch = globalThis.fetch;
    const calls: { url: string; method: string; auth: string | null; body: string | null }[] = [];
    function res(body: unknown, status = 200): Response {
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        text: async () => (body === undefined ? "" : JSON.stringify(body)),
      } as unknown as Response;
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, auth: headers.Authorization ?? null, body: (init?.body as string) ?? null });
      if (url.endsWith("/video/v1/uploads") && method === "POST") {
        return res({ data: { id: "upl_1", url: "https://storage.mux.example/PUT-here" } });
      }
      if (url.includes("/video/v1/uploads/upl_1")) {
        return res({ data: { id: "upl_1", status: "asset_created", asset_id: "asset_1" } });
      }
      // Add-a-rendition (self-heal). `asset_dupe` → an already-present rendition
      // (Mux 400 "already exists") which must be swallowed; `asset_badres` → a
      // different 400 (invalid resolution) which must be RE-THROWN (no retry loop).
      if (url.includes("/static-renditions") && method === "POST") {
        if (url.includes("asset_dupe")) {
          return res({ error: { messages: ["A static rendition for this resolution already exists"] } }, 400);
        }
        if (url.includes("asset_badres")) {
          return res({ error: { messages: ["Invalid static rendition resolution: capped-1080p"] } }, 400);
        }
        return res({ data: { id: "sr_new", resolution: "highest", status: "preparing" } });
      }
      if (url.includes("/video/v1/assets/asset_1") && method === "DELETE") {
        return res(undefined, 204);
      }
      if (url.includes("/video/v1/assets/asset_1")) {
        // MODERN shape: the static_renditions array API reports mp4_support:"none"
        // even though a ready `highest.mp4` exists. resolveMp4 must NOT be fooled by
        // mp4_support — it must read the files and surface the ready rendition.
        return res({
          data: {
            id: "asset_1",
            status: "ready",
            duration: 42.5,
            aspect_ratio: "1024:513",
            playback_ids: [{ id: "pb_1", policy: "public" }],
            mp4_support: "none",
            static_renditions: {
              files: [
                { name: "audio.m4a", ext: "m4a", resolution: "audio-only", status: "ready" },
                { name: "highest.mp4", ext: "mp4", resolution: "highest", resolution_tier: "1080p", height: 962, width: 1920, status: "ready" },
              ],
            },
          },
        });
      }
      // A resolution-specific rendition SKIPPED because it's larger than the source
      // (the 720p-on-a-513px bug). No usable MP4 → mp4Status must be "disabled",
      // never a forever "preparing".
      if (url.includes("/video/v1/assets/asset_skip")) {
        return res({
          data: {
            id: "asset_skip",
            status: "ready",
            duration: 12.6,
            aspect_ratio: "1024:513",
            playback_ids: [{ id: "pb_skip", policy: "public" }],
            static_renditions: {
              status: "skipped",
              files: [{ name: "720p.mp4", ext: "mp4", resolution_tier: "720p", height: 720, status: "skipped" }],
            },
          },
        });
      }
      // A rendition still generating (per-file status "preparing") → keep polling.
      if (url.includes("/video/v1/assets/asset_prep")) {
        return res({
          data: {
            id: "asset_prep",
            status: "ready",
            duration: 30,
            aspect_ratio: "16:9",
            playback_ids: [{ id: "pb_prep", policy: "public" }],
            static_renditions: {
              files: [{ name: "capped-1080p.mp4", ext: "mp4", height: 1080, status: "preparing" }],
            },
          },
        });
      }
      return res({ error: { messages: ["not found"] } }, 404);
    }) as typeof fetch;

    try {
      check("isConfigured true with creds", muxProvider.isConfigured());

      const up = await muxProvider.createDirectUpload({ corsOrigin: "https://app.example", passthrough: "row_1" });
      check("createDirectUpload returns id+url", up.uploadId === "upl_1" && up.uploadUrl.includes("PUT-here"));
      check("createDirectUpload uses Basic auth", calls[0].auth?.startsWith("Basic ") === true);
      // The default rendition must be the ADAPTIVE `highest` (valid on every tier,
      // never upscale-skipped), not a fixed resolution — the root-cause fix. (Mux
      // rejects `capped-1080p` as an invalid resolution input.)
      check(
        "createDirectUpload requests adaptive highest rendition",
        (calls[0].body ?? "").includes('"resolution":"highest"')
      );

      const info = await muxProvider.getUpload("upl_1");
      check("getUpload normalizes asset_created", info.status === "asset_created" && info.assetId === "asset_1");

      const asset = await muxProvider.getAsset("asset_1");
      check("getAsset status ready + playbackId", asset.status === "ready" && asset.playbackId === "pb_1");
      check("getAsset duration + aspect", asset.durationSeconds === 42.5 && asset.aspectRatio === "1024:513");
      // THE regression guard: mp4_support:"none" + a ready highest.mp4 → resolves to
      // ready (NOT disabled). This is the bug that stuck the preview forever.
      check(
        "getAsset resolves ready highest.mp4 despite mp4_support:none",
        asset.mp4Url === "https://stream.mux.com/pb_1/highest.mp4" && asset.mp4Status === "ready"
      );
      check("getAsset flags adaptiveMp4Present", asset.adaptiveMp4Present === true);

      // Skipped rendition (fixed resolution larger than source) → definitively
      // "disabled", NOT a forever "preparing"; and no adaptive rendition present.
      const skipAsset = await muxProvider.getAsset("asset_skip");
      check("getAsset skipped rendition → mp4 disabled", skipAsset.mp4Status === "disabled" && !skipAsset.mp4Url);
      check("getAsset skipped → adaptiveMp4Present false", skipAsset.adaptiveMp4Present === false);
      // Per-file "preparing" → keep polling.
      const prepAsset = await muxProvider.getAsset("asset_prep");
      check("getAsset preparing rendition → mp4 preparing", prepAsset.mp4Status === "preparing" && !prepAsset.mp4Url);

      // addMp4Rendition (self-heal): POSTs a `highest` rendition; a 400 that says
      // "already exists" is swallowed, but any OTHER 400 (invalid resolution) is
      // re-thrown so the caller doesn't loop.
      await muxProvider.addMp4Rendition?.("asset_1");
      const postCall = calls.find((c) => c.method === "POST" && c.url.includes("asset_1/static-renditions"));
      check("addMp4Rendition POSTs highest", (postCall?.body ?? "").includes('"resolution":"highest"'));
      let dupeThrew = false;
      try {
        await muxProvider.addMp4Rendition?.("asset_dupe");
      } catch {
        dupeThrew = true;
      }
      check("addMp4Rendition swallows 'already exists' 400", !dupeThrew);
      let badResThrew = false;
      try {
        await muxProvider.addMp4Rendition?.("asset_badres");
      } catch {
        badResThrew = true;
      }
      check("addMp4Rendition re-throws a non-'already exists' 400", badResThrew);

      await muxProvider.deleteAsset("asset_1");
      check("deleteAsset issues DELETE", calls.some((c) => c.method === "DELETE" && c.url.includes("asset_1")));

      // error mapping
      let threw = false;
      try {
        await muxProvider.getAsset("missing");
      } catch {
        threw = true;
      }
      check("getAsset throws on 404", threw);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /* ── 10b. self-heal: a ready video with no MP4 re-requests an adaptive rendition ── */
  console.log("\nSelf-heal (syncVideoAssetFromMux)");
  {
    type SyncDb = Parameters<typeof syncVideoAssetFromMux>[0];
    const healed: string[] = [];
    function healProvider(asset: ProviderAssetInfo): VideoProvider {
      return {
        id: "mux",
        isConfigured: () => true,
        createDirectUpload: async () => ({ uploadId: "u", uploadUrl: "x" }),
        getUpload: async () => ({ uploadId: "u", status: "asset_created", assetId: asset.assetId }),
        getAsset: async () => asset,
        deleteAsset: async () => {},
        verifyWebhookSignature: () => true,
        parseWebhookEvent: () => null,
        addMp4Rendition: async (id) => {
          healed.push(id);
        },
      };
    }
    function fakeDb(baseRow: VideoAssetRow): SyncDb {
      return {
        from: () => ({
          update: (patch: Partial<VideoAssetRow>) => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: { ...baseRow, ...patch }, error: null }),
              }),
            }),
          }),
        }),
      } as unknown as SyncDb;
    }

    // A ready VIDEO asset whose fixed rendition got skipped (disabled) and has NO
    // adaptive rendition yet → heal fires + reports preparing so the client keeps
    // polling until the new `highest` rendition lands.
    const disabledVideo: ProviderAssetInfo = { assetId: "asset_heal", status: "ready", playbackId: "pb", aspectRatio: "1024:513", mp4Status: "disabled", adaptiveMp4Present: false };
    const row1 = fakeRow({ id: "r1", mux_asset_id: "asset_heal", status: "ready", mp4_status: "disabled", mp4_url: null, mux_playback_id: "pb" });
    const view1 = await syncVideoAssetFromMux(fakeDb(row1), healProvider(disabledVideo), row1);
    check("self-heal: ready video w/ no MP4 requests a rendition", healed.includes("asset_heal"));
    check("self-heal: reports preparing so the poll resumes", view1.mp4Status === "preparing");

    // An audio-only asset (no aspect ratio) legitimately has no MP4 → do NOT keep
    // re-requesting one on every load.
    const disabledAudio: ProviderAssetInfo = { assetId: "asset_audio", status: "ready", playbackId: "pb", mp4Status: "disabled" };
    const row2 = fakeRow({ id: "r2", mux_asset_id: "asset_audio", status: "ready", mp4_status: "disabled", mp4_url: null, aspect_ratio: null });
    const before = healed.length;
    const view2 = await syncVideoAssetFromMux(fakeDb(row2), healProvider(disabledAudio), row2);
    check("self-heal: audio-only (no video) is NOT re-requested", healed.length === before);
    check("self-heal: audio-only stays disabled", view2.mp4Status === "disabled");

    // A video asset that ALREADY has an adaptive rendition but it's still unusable
    // (disabled) → do NOT re-request (would loop): leave it disabled.
    const disabledHasAdaptive: ProviderAssetInfo = { assetId: "asset_hasadaptive", status: "ready", playbackId: "pb", aspectRatio: "16:9", mp4Status: "disabled", adaptiveMp4Present: true };
    const row3 = fakeRow({ id: "r3", mux_asset_id: "asset_hasadaptive", status: "ready", mp4_status: "disabled", mp4_url: null });
    const before3 = healed.length;
    const view3 = await syncVideoAssetFromMux(fakeDb(row3), healProvider(disabledHasAdaptive), row3);
    check("self-heal: does NOT loop when an adaptive rendition already exists", healed.length === before3);
    check("self-heal: adaptive-present-but-disabled stays disabled", view3.mp4Status === "disabled");
  }

  /* ── 11. webhook signature + event parsing ── */
  console.log("\nWebhook signature + parsing");
  {
    const { muxProvider } = await import("@/lib/video/provider/muxClient");
    const body = JSON.stringify({ type: "video.asset.ready", data: { id: "asset_1", passthrough: "row_1" } });
    const secret = "whsec_test";
    process.env.MUX_WEBHOOK_SIGNING_SECRET = secret;
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    check("valid signature accepted", muxProvider.verifyWebhookSignature(body, `t=${t},v1=${sig}`));
    check("tampered body rejected", !muxProvider.verifyWebhookSignature(body + "x", `t=${t},v1=${sig}`));
    check("wrong signature rejected", !muxProvider.verifyWebhookSignature(body, `t=${t},v1=${"0".repeat(64)}`));
    check("missing header rejected", !muxProvider.verifyWebhookSignature(body, null));
    const staleT = t - 10000;
    const staleSig = createHmac("sha256", secret).update(`${staleT}.${body}`).digest("hex");
    check("stale timestamp rejected", !muxProvider.verifyWebhookSignature(body, `t=${staleT},v1=${staleSig}`));

    delete process.env.MUX_WEBHOOK_SIGNING_SECRET;
    check("no secret configured → opt-out accepts", muxProvider.verifyWebhookSignature(body, null));

    const assetEvt = muxProvider.parseWebhookEvent(body);
    check("parse asset event", assetEvt?.assetId === "asset_1" && assetEvt?.passthrough === "row_1" && assetEvt?.uploadId === null);
    const uploadEvt = muxProvider.parseWebhookEvent(JSON.stringify({ type: "video.upload.asset_created", data: { id: "upl_1", asset_id: "asset_1" } }));
    check("parse upload event", uploadEvt?.uploadId === "upl_1" && uploadEvt?.assetId === "asset_1");
    check("parse garbage → null", muxProvider.parseWebhookEvent("not json") === null);
  }

  /* ── 12. captions: block schema + patch + round-trip ── */
  console.log("\nCaptions — block schema + patch + round-trip");
  {
    const block = createVideoLessonBlock(0);
    const withCaptions: VideoLessonBlock = {
      ...block,
      captions: {
        status: "ready",
        trackId: "trk_1",
        trackName: "English (auto)",
        languageCode: "en",
        source: "generated",
        updatedAt: NOW,
      },
    };
    check("schema parses a block with captions", LessonBlockSchema.safeParse(withCaptions).success);
    // transcript text is NOT a block field (kept on the row) — an unknown key is stripped/ignored
    check("captions default absent is valid", LessonBlockSchema.safeParse(block).success);

    let { doc } = docWithVideo();
    const id = getVideoBlock(doc).id;
    doc = applyOk(doc, updateVideoLessonPatch(id, { captions: { status: "generating", languageCode: "en", source: "generated" } }));
    check("reducer: creates captions from nothing", getVideoBlock(doc).captions?.status === "generating" && getVideoBlock(doc).captions?.languageCode === "en");
    doc = applyOk(doc, updateVideoLessonPatch(id, { captions: { status: "ready", trackId: "trk_9", trackName: "English (auto)" } }));
    const caps = getVideoBlock(doc).captions;
    check("reducer: merges captions (keeps prior lang)", caps?.status === "ready" && caps?.trackId === "trk_9" && caps?.languageCode === "en");
    doc = applyOk(doc, updateVideoLessonPatch(id, { captions: { error: null } }));
    check("reducer: null clears a caption field", getVideoBlock(doc).captions?.error === undefined && getVideoBlock(doc).captions?.status === "ready");

    // round-trip through persistence
    const rows = courseDocToRows(doc, "owner-1");
    const courseRow = { ...rows.course, created_at: NOW, updated_at: NOW };
    const back = courseDocFromRows(courseRow as never, rows.modules as never, rows.lessons as never, rows.blocks as never);
    check("round-trip: captions preserved", getVideoBlock(back).captions?.trackId === "trk_9" && getVideoBlock(back).captions?.status === "ready");
  }

  /* ── 13. captions: pure VTT parsing ── */
  console.log("\nCaptions — VTT parsing");
  {
    const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:02.500
Hello and welcome

2
00:00:02.500 --> 00:00:05.000 line:80%
to the <b>lesson</b>

00:00:05.000 --> 00:00:07.000
to the lesson`;
    const cues = parseVtt(vtt);
    check("parseVtt finds 3 cues", cues.length === 3);
    check("parseVtt parses timestamps", cues[0].start === 0 && cues[0].end === 2.5);
    check("parseVtt strips inline tags + cue settings", cues[1].text === "to the lesson" && cues[1].end === 5);
    check("parseVtt tolerates null/garbage", parseVtt(null).length === 0 && parseVtt("not vtt").length === 0);

    const plain = plainTextFromVtt(vtt);
    check("plainTextFromVtt joins + dedupes consecutive", plain === "Hello and welcome to the lesson");

    check("activeCaption at 1s", activeCaption(cues, 1) === "Hello and welcome");
    check("activeCaption at 6s", activeCaption(cues, 6) === "to the lesson");
    check("activeCaption before/after → null", activeCaption(cues, 100) === null);

    // MM:SS (no hours) timestamps also parse
    const noHours = parseVtt("WEBVTT\n\n01:05.000 --> 01:07.000\nlate cue");
    check("parseVtt handles MM:SS.mmm", noHours.length === 1 && noHours[0].start === 65);
  }

  /* ── 14. captions: deriveCaptionFields + reconcile + active ── */
  console.log("\nCaptions — derive + reconcile");
  {
    check("deriveCaptionFields: no tracks → null", deriveCaptionFields([]) === null && deriveCaptionFields(undefined) === null);
    const gen = deriveCaptionFields([{ id: "t1", status: "ready", source: "generated", languageCode: "en", name: "English (auto)" }]);
    check("deriveCaptionFields: ready generated → ready", gen?.caption_status === "ready" && gen?.caption_track_id === "t1" && gen?.caption_source === "generated");
    const prep = deriveCaptionFields([{ id: "t1", status: "preparing", source: "generated" }]);
    check("deriveCaptionFields: preparing → generating", prep?.caption_status === "generating");
    const err = deriveCaptionFields([{ id: "t1", status: "errored", source: "generated" }]);
    check("deriveCaptionFields: errored → failed + error", err?.caption_status === "failed" && Boolean(err?.caption_error));
    const best = deriveCaptionFields([
      { id: "t1", status: "errored", source: "generated" },
      { id: "t2", status: "ready", source: "uploaded" },
    ]);
    check("deriveCaptionFields: prefers a ready track", best?.caption_track_id === "t2" && best?.caption_status === "ready");

    // reconcileMuxState surfaces caption fields when a track is present, and none otherwise
    const withCap: ProviderAssetInfo = { assetId: "a", status: "ready", playbackId: "pb", mp4Status: "ready", captions: [{ id: "t1", status: "preparing", source: "generated", languageCode: "en" }] };
    const rc = reconcileMuxState({ asset: withCap });
    check("reconcile: ready asset carries caption fields", rc.caption_status === "generating" && rc.caption_track_id === "t1");
    const noCap: ProviderAssetInfo = { assetId: "a", status: "ready", playbackId: "pb", mp4Status: "ready", captions: [] };
    check("reconcile: no caption track → caption fields absent", reconcileMuxState({ asset: noCap }).caption_status === undefined);

    check("isActiveVideoStatus: ready + caption generating stays active", isActiveVideoStatus("ready", "ready", "generating"));
    check("isActiveVideoStatus: ready + caption ready is inactive", !isActiveVideoStatus("ready", "ready", "ready"));
  }

  /* ── 15. captions: view mapping + URLs ── */
  console.log("\nCaptions — view + URLs");
  {
    check("captionVttUrl shape", captionVttUrl("pb_1", "trk_1") === "https://stream.mux.com/pb_1/text/trk_1.vtt");
    const row = fakeRow({ caption_status: "ready", caption_track_id: "trk_1", caption_track_name: "English (auto)", caption_language_code: "en", caption_source: "generated", transcript: "hello world", transcript_vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi" });
    const view = buildVideoAssetView(row);
    check("view: caption fields mapped", view.captionStatus === "ready" && view.captionTrackId === "trk_1" && view.captionLanguageCode === "en");
    check("view: transcript + vtt carried", view.transcript === "hello world" && (view.transcriptVtt ?? "").startsWith("WEBVTT"));
    check("view: derives caption vtt url", view.captionVttUrl === "https://stream.mux.com/pb_1/text/trk_1.vtt");
    check("view: no track → null vtt url", buildVideoAssetView(fakeRow({ caption_track_id: null })).captionVttUrl === null);

    const capsMeta = captionsFromView(view);
    check("captionsFromView: metadata only (no transcript)", capsMeta.status === "ready" && capsMeta.trackId === "trk_1" && !("transcript" in capsMeta));
    check("captionsFromView: source mapped", capsMeta.source === "generated");
  }

  /* ── 16. Mux adapter — captions (mocked fetch) ── */
  console.log("\nMux adapter — captions (mocked fetch)");
  {
    process.env.MUX_TOKEN_ID = "test_id";
    process.env.MUX_TOKEN_SECRET = "test_secret";
    const { muxProvider } = await import("@/lib/video/provider/muxClient");
    const realFetch = globalThis.fetch;
    const calls: { url: string; method: string; body: string | null }[] = [];
    function res(body: unknown, status = 200, textBody?: string): Response {
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: "",
        text: async () => (textBody !== undefined ? textBody : body === undefined ? "" : JSON.stringify(body)),
      } as unknown as Response;
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: (init?.body as string) ?? null });
      if (url.endsWith("/video/v1/uploads") && method === "POST") {
        return res({ data: { id: "upl_c", url: "https://storage.mux.example/PUT" } });
      }
      if (url.includes("/generate-subtitles") && method === "POST") {
        return res({ data: { id: "trk_new" } });
      }
      if (url.includes("/video/v1/assets/asset_cap")) {
        return res({
          data: {
            id: "asset_cap",
            status: "ready",
            duration: 30,
            aspect_ratio: "16:9",
            playback_ids: [{ id: "pb_cap", policy: "public" }],
            static_renditions: { files: [{ name: "highest.mp4", resolution: "highest", height: 720, status: "ready" }] },
            tracks: [
              { id: "audio_1", type: "audio", primary: true },
              { id: "text_1", type: "text", text_type: "subtitles", text_source: "generated_vod", status: "ready", language_code: "en", name: "English (auto)" },
            ],
          },
        });
      }
      // WebVTT fetch from the public stream host
      if (url.startsWith("https://stream.mux.com/") && url.endsWith(".vtt")) {
        return res(undefined, 200, "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world");
      }
      return res({ error: { messages: ["not found"] } }, 404);
    }) as typeof fetch;

    try {
      await muxProvider.createDirectUpload({ corsOrigin: "*", passthrough: "row_c", generateSubtitles: { languageCode: "en", name: "English (auto)" } });
      const uploadBody = calls.find((c) => c.url.endsWith("/video/v1/uploads"))?.body ?? "";
      check("createDirectUpload requests generated_subtitles", uploadBody.includes('"generated_subtitles"') && uploadBody.includes('"language_code":"en"'));
      check("createDirectUpload puts subtitles under inputs (url omitted)", uploadBody.includes('"inputs"') && !uploadBody.includes('"url"'));

      // The upload fallback (captions rejected) must produce a CLEAN request with no
      // generated_subtitles/inputs — proving captions can never block the upload.
      await muxProvider.createDirectUpload({ corsOrigin: "*", passthrough: "row_c2" });
      const plainBody = [...calls].reverse().find((c) => c.url.endsWith("/video/v1/uploads"))?.body ?? "";
      check("createDirectUpload without opt omits generated_subtitles", !plainBody.includes("generated_subtitles") && !plainBody.includes('"inputs"'));

      const asset = await muxProvider.getAsset("asset_cap");
      check("getAsset normalizes a generated caption track", (asset.captions ?? []).some((c) => c.id === "text_1" && c.status === "ready" && c.source === "generated" && c.languageCode === "en"));
      check("getAsset finds the primary audio track id", asset.audioTrackId === "audio_1");

      await muxProvider.requestGeneratedSubtitles?.("asset_cap", "audio_1", { languageCode: "en", name: "English (auto)" });
      const genCall = calls.find((c) => c.method === "POST" && c.url.includes("/assets/asset_cap/tracks/audio_1/generate-subtitles"));
      check("requestGeneratedSubtitles POSTs the right path", Boolean(genCall));
      check("requestGeneratedSubtitles sends generated_subtitles body", (genCall?.body ?? "").includes('"language_code":"en"'));

      const vtt = await muxProvider.fetchCaptionVtt?.("pb_cap", "text_1");
      check("fetchCaptionVtt returns the VTT text", (vtt ?? "").startsWith("WEBVTT"));

      // webhook: a track.ready event routes by data.asset_id (NOT data.id = track id)
      const trackEvt = muxProvider.parseWebhookEvent(JSON.stringify({ type: "video.asset.track.ready", data: { id: "text_1", asset_id: "asset_cap", text_source: "generated_vod" } }));
      check("parse track.ready: assetId from asset_id, not track id", trackEvt?.assetId === "asset_cap" && trackEvt?.objectId === "text_1");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /* ── 17. syncVideoAssetFromMux — caption + transcript fetch ── */
  console.log("\nCaption sync + transcript fetch (syncVideoAssetFromMux)");
  {
    type SyncDb = Parameters<typeof syncVideoAssetFromMux>[0];
    function fakeDb(baseRow: VideoAssetRow): SyncDb {
      return {
        from: () => ({
          update: (patch: Partial<VideoAssetRow>) => ({
            eq: () => ({ select: () => ({ single: async () => ({ data: { ...baseRow, ...patch }, error: null }) }) }),
          }),
        }),
      } as unknown as SyncDb;
    }
    const readyCaption: ProviderAssetInfo = {
      assetId: "asset_tc",
      status: "ready",
      playbackId: "pb_tc",
      aspectRatio: "16:9",
      mp4Status: "ready",
      mp4Url: "https://stream.mux.com/pb_tc/highest.mp4",
      captions: [{ id: "text_1", status: "ready", source: "generated", languageCode: "en", name: "English (auto)" }],
    };
    let vttFetched = 0;
    const provider: VideoProvider = {
      id: "mux",
      isConfigured: () => true,
      createDirectUpload: async () => ({ uploadId: "u", uploadUrl: "x" }),
      getUpload: async () => ({ uploadId: "u", status: "asset_created", assetId: "asset_tc" }),
      getAsset: async () => readyCaption,
      deleteAsset: async () => {},
      verifyWebhookSignature: () => true,
      parseWebhookEvent: () => null,
      fetchCaptionVtt: async () => {
        vttFetched += 1;
        return "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world";
      },
    };
    // A ready asset whose captions were "generating" and has no transcript yet →
    // NOT short-circuited; reconcile marks caption ready + fetches the transcript.
    const row = fakeRow({ id: "rtc", mux_asset_id: "asset_tc", mux_playback_id: "pb_tc", status: "ready", mp4_status: "ready", mp4_url: "https://stream.mux.com/pb_tc/highest.mp4", caption_status: "generating", transcript: null });
    const view = await syncVideoAssetFromMux(fakeDb(row), provider, row);
    check("sync: caption reaches ready", view.captionStatus === "ready" && view.captionTrackId === "text_1");
    check("sync: transcript fetched + stored", vttFetched === 1 && view.transcript === "Hello world" && (view.transcriptVtt ?? "").startsWith("WEBVTT"));

    // A fully-settled row (caption ready + transcript present + mp4 ready) short-circuits: no VTT re-fetch.
    const settled = fakeRow({ id: "rst", mux_asset_id: "asset_tc", mux_playback_id: "pb_tc", status: "ready", mp4_status: "ready", caption_status: "ready", caption_track_id: "text_1", transcript: "Hello world" });
    const before = vttFetched;
    await syncVideoAssetFromMux(fakeDb(settled), provider, settled);
    check("sync: settled captions short-circuit (no re-fetch)", vttFetched === before);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
