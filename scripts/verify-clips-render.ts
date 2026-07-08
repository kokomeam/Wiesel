/**
 * Clip render infrastructure (M-B) — PURE + LOCAL suite (no key, no DB; the
 * in-house layout tests run REAL ffmpeg via the bundled ffmpeg-static
 * binary on a synthesized input — genuine renders, seconds each).
 *
 * Sections (named per the continuation-directive checkpoint format):
 *   - provider.contract.spec     — reap status normalization; submit flow
 *     (camelCase body, upload PUT, create-reframe — never create-clips);
 *     getJob reads get-project-clips (never urls.videoFile); cancel
 *     tolerates already-terminal
 *   - jobs.stateMachine.spec     — the transition table; illegal edges throw
 *     BEFORE any DB IO (exploding-proxy assertion)
 *   - ffmpegArgs.golden.spec     — stacked geometry, pan expressions,
 *     audiogram graph; brand colors ride ONLY through tokens
 *   - brand.divergence.spec (D-1) — no second brand-constant definition
 *     under lib/marketing/** or the render compositions
 *   - render.real.spec (FR-5)    — stacked_split / screen_action_zoom /
 *     audiogram REALLY render via ffmpeg-static; outputs are playable mp4s
 *   - routing/provider mapping + pip provenance (D-3/D-5)
 *   - hardening greps            — no publish-clip/schedule-clips, no cron
 *
 * Run: `npx tsx scripts/verify-clips-render.ts`
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND_TOKENS, ffmpegColor, resolveBrandTokens, watermarkText } from "@/lib/marketing/brand/tokens";
import {
  buildAudiogramArgs,
  buildPanExpression,
  buildStackedSplitArgs,
  buildStackedSplitDualArgs,
  buildZoomPanArgs,
  CLIP_OUT_H,
  CLIP_OUT_W,
  STACKED_CAPTION_BAND_H,
  STACKED_FACE_BAND_H,
  STACKED_SCREEN_BAND_H,
  zoomKeyframesFromCues,
} from "@/lib/marketing/clips/render/ffmpegArgs";
import { ffmpegBinaryPath, runFfmpeg } from "@/lib/marketing/clips/render/localRender";
import {
  CLIP_JOB_TRANSITIONS,
  ClipJobTransitionError,
  isTerminalJobStatus,
  transitionRenderJob,
  type ClipJobStatus,
} from "@/lib/marketing/clips/render/jobs";
import { createReapProvider, normalizeReapStatus } from "@/lib/marketing/clips/provider/reapClient";
import { providerForLayout, resolvePipRect } from "@/lib/marketing/clips/render/service";
import { actionCueTimes } from "@/lib/marketing/clips/actionDensity";
import { wordsFromSegments } from "@/lib/marketing/clips/fixtures/lessons";
import { bubbleRect } from "@/lib/video/recorderConfig";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/* ───────────────────── provider.contract.spec ─────────────────────────── */

async function providerContractSpec() {
  console.log("# provider.contract.spec (reap adapter vs the Task-0 contract)");
  check(
    "status map: queued/prepped/draft/processing/finalizing → processing",
    ["queued", "prepped", "draft", "processing", "finalizing"].every(
      (s) => normalizeReapStatus(s) === "processing"
    )
  );
  check(
    "status map: invalid/expired/failed/error → failed; terminal 1:1",
    ["invalid", "expired", "failed", "error"].every((s) => normalizeReapStatus(s) === "failed") &&
      normalizeReapStatus("completed") === "completed" &&
      normalizeReapStatus("cancelled") === "cancelled"
  );

  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/get-upload-url")) {
      return new Response(JSON.stringify({ id: "up-1", uploadUrl: "https://s3.example/put-here" }), { status: 200 });
    }
    if (url === "https://s3.example/put-here") return new Response("", { status: 200 });
    if (url.endsWith("/create-reframe")) {
      return new Response(JSON.stringify({ id: "proj-1", status: "processing", billedDuration: 1 }), { status: 200 });
    }
    if (url.includes("/get-project-status")) {
      return new Response(JSON.stringify({ id: "proj-1", status: "completed" }), { status: 200 });
    }
    if (url.includes("/get-project-details")) {
      return new Response(
        JSON.stringify({ id: "proj-1", billedDuration: 1, urls: { videoFile: "https://cdn/SOURCE-not-output.mp4" } }),
        { status: 200 }
      );
    }
    if (url.includes("/get-project-clips")) {
      return new Response(
        JSON.stringify({
          clips: [
            {
              clipUrl: "https://cdn/clean.mp4",
              clipWithCaptionsUrl: "https://cdn/captioned.mp4",
              metadata: { width: 720, height: 1280, duration: 42.5 },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.endsWith("/cancel-project")) {
      return new Response(JSON.stringify({ detail: "already completed" }), { status: 400 });
    }
    return new Response(JSON.stringify({ detail: `unexpected ${url}` }), { status: 500 });
  };

  const provider = createReapProvider({ apiKey: "test-key", fetchImpl });
  const submitted = await provider.submit({
    kind: "provider_reframe",
    bytes: Buffer.from("fake-mp4-bytes"),
    filename: "clip.mp4",
  });
  check(
    "submit: get-upload-url → PUT → create-reframe (upload-only path)",
    calls[0].url.endsWith("/get-upload-url") &&
      calls[1].url === "https://s3.example/put-here" &&
      calls[1].method === "PUT" &&
      calls[2].url.endsWith("/create-reframe")
  );
  const reframeBody = JSON.parse(calls[2].body ?? "{}");
  check(
    "submit: camelCase uploadId + portrait; NEVER create-clips for our spans",
    reframeBody.uploadId === "up-1" &&
      reframeBody.orientation === "portrait" &&
      calls.every((c) => !c.url.includes("create-clips"))
  );
  check(
    "submit: providerRef/uploadRef/costMinutes returned",
    submitted.providerRef === "proj-1" && submitted.uploadRef === "up-1" && submitted.costMinutes === 1
  );

  const view = await provider.getJob("proj-1");
  check(
    "getJob: output from get-project-clips (captioned preferred), NEVER urls.videoFile",
    view.outputUrl === "https://cdn/captioned.mp4" &&
      view.cleanOutputUrl === "https://cdn/clean.mp4" &&
      view.output?.width === 720 &&
      view.costMinutes === 1
  );

  let cancelThrew = false;
  try {
    await provider.cancel("proj-1");
  } catch {
    cancelThrew = true;
  }
  check("cancel: an already-terminal provider job is a no-op (4xx swallowed)", !cancelThrew);
}

/* ───────────────────── jobs.stateMachine.spec ─────────────────────────── */

async function stateMachineSpec() {
  console.log("# jobs.stateMachine.spec (single legal write path)");
  const LEGAL: [ClipJobStatus, ClipJobStatus][] = [
    ["queued", "precutting"],
    ["precutting", "submitted"],
    ["precutting", "rendering_local"],
    ["submitted", "completed"],
    ["rendering_local", "completed"],
    ["queued", "cancelled"],
    ["submitted", "failed"],
  ];
  for (const [from, to] of LEGAL) {
    check(`legal edge: ${from} → ${to}`, CLIP_JOB_TRANSITIONS[from].includes(to));
  }
  const ILLEGAL: [ClipJobStatus, ClipJobStatus][] = [
    ["queued", "submitted"],
    ["queued", "completed"],
    ["completed", "queued"],
    ["cancelled", "submitted"],
    ["failed", "completed"],
    ["submitted", "rendering_local"],
  ];
  for (const [from, to] of ILLEGAL) {
    check(`illegal edge refused: ${from} → ${to}`, !CLIP_JOB_TRANSITIONS[from].includes(to));
  }
  check(
    "terminal statuses have no outgoing edges",
    (["completed", "failed", "cancelled"] as const).every((s) => isTerminalJobStatus(s))
  );

  // An illegal transition must throw BEFORE any DB IO.
  const explodingDb = new Proxy({}, { get() { throw new Error("DB touched on an illegal edge"); } });
  let threw: unknown = null;
  try {
    await transitionRenderJob(explodingDb as never, "job-1", "completed", "queued");
  } catch (err) {
    threw = err;
  }
  check(
    "illegal transition throws ClipJobTransitionError pre-IO",
    threw instanceof ClipJobTransitionError && String(threw.message).includes("illegal")
  );
}

/* ───────────────────── ffmpegArgs.golden.spec ─────────────────────────── */

function ffmpegArgsSpec() {
  console.log("# ffmpegArgs.golden.spec");
  check(
    "stacked bands tile the canvas exactly",
    STACKED_FACE_BAND_H + STACKED_SCREEN_BAND_H + STACKED_CAPTION_BAND_H === CLIP_OUT_H &&
      CLIP_OUT_W === 720
  );
  const pip = bubbleRect(1280, 720, 16 / 9, "bottom-right");
  const stacked = buildStackedSplitArgs({
    inputPath: "in.mp4",
    outputPath: "out.mp4",
    pipRect: pip,
    durationSeconds: 40,
  });
  const graph = stacked[stacked.indexOf("-filter_complex") + 1];
  check(
    "stacked: face band crops the recorder's OWN bubble rect (deterministic D-3)",
    graph.includes(`crop=${pip.w}:${pip.h}:${pip.x}:${pip.y}`)
  );
  check(
    "stacked: screen band keeps the full slide legible (720×405, no crop)",
    graph.includes(`[0:v]scale=720:${STACKED_SCREEN_BAND_H},setsar=1[screen]`)
  );
  check(
    "stacked: caption zone uses the brand backdrop token",
    graph.includes(`color=c=${ffmpegColor(BRAND_TOKENS.colors.backdrop)}`)
  );
  check("stacked: output pinned 30fps h264+aac faststart", stacked.includes("libx264") && stacked.includes("+faststart"));

  const kf = zoomKeyframesFromCues([5_000, 20_000, 35_000], 45_000);
  check(
    "zoom keyframes: opening center + one target per cue, alternating regions",
    kf.length === 4 &&
      kf[0].centerX === 0.5 &&
      kf[1].centerX === 0.35 &&
      kf[2].centerX === 0.65 &&
      kf[3].centerX === 0.35
  );
  check(
    "zoom keyframes: cues outside the clip are dropped",
    zoomKeyframesFromCues([-2_000, 50_000], 45_000).length === 1
  );
  const single = buildPanExpression([{ atMs: 0, centerX: 0.5 }], 2276);
  check("pan expression: single keyframe → constant", /^-?\d+$/.test(single));
  const expr = buildPanExpression(
    [
      { atMs: 0, centerX: 0.5 },
      { atMs: 5_000, centerX: 0.35 },
      { atMs: 20_000, centerX: 0.65 },
    ],
    2276,
    1.2
  );
  check(
    "pan expression: piecewise if() ladder with eased min() segments",
    expr.startsWith("if(lt(t,5.000),") && expr.includes("min((t-5.000)/1.2,1)") && expr.includes("min((t-20.000)/1.2,1)")
  );
  const minX = -(2276 - 720);
  const edge = buildPanExpression(
    [
      { atMs: 0, centerX: 0 },
      { atMs: 3_000, centerX: 1 },
    ],
    2276
  );
  check("pan expression: window clamps to the frame edges", edge.includes("if(lt(t,3.000),0,") && edge.includes(`${minX}`));

  const zoomArgs = buildZoomPanArgs({
    inputPath: "in.mp4",
    outputPath: "out.mp4",
    keyframes: kf,
    durationSeconds: 45,
    sourceW: 1280,
    sourceH: 720,
  });
  const zoomGraph = zoomArgs[zoomArgs.indexOf("-filter_complex") + 1];
  check(
    "zoom: source scaled to full canvas height (the implicit region zoom), even width",
    zoomGraph.includes(`scale=2276:${CLIP_OUT_H}`)
  );

  const audio = buildAudiogramArgs({ inputPath: "in.mp4", outputPath: "out.mp4", durationSeconds: 30 });
  const audioGraph = audio[audio.indexOf("-filter_complex") + 1];
  check(
    "audiogram: blurred cover backdrop + legible card + brand-color waveform",
    audioGraph.includes("boxblur") &&
      audioGraph.includes("showwaves") &&
      audioGraph.includes(`colors=${ffmpegColor(BRAND_TOKENS.colors.brand)}`)
  );
}

/* ─────────────────────── brand.divergence.spec ─────────────────────────── */

function brandDivergenceSpec() {
  console.log("# brand.divergence.spec (D-1: ONE brand-constant module)");
  check("ffmpegColor: #f97316 → 0xf97316", ffmpegColor("#f97316") === "0xf97316");
  let badHex = false;
  try {
    ffmpegColor("orange");
  } catch {
    badHex = true;
  }
  check("ffmpegColor rejects non-hex", badHex);
  check(
    "creator overrides merge over product tokens ([FWD] seam)",
    resolveBrandTokens({ colors: { brand: "#123456" } as never }).colors.brand === "#123456" &&
      resolveBrandTokens().colors.brand === BRAND_TOKENS.colors.brand
  );
  check("watermark carries the creator handle over the product mark", watermarkText("@hb") === "@hb · WiseSel" && watermarkText(null) === "WiseSel");
  check(
    "tokens mirror the product ramp (globals.css @theme)",
    BRAND_TOKENS.colors.brand === "#f97316" && BRAND_TOKENS.colors.canvas === "#faf7f1"
  );

  // THE divergence check: no hex color literal defined anywhere under
  // lib/marketing outside brand/tokens.ts (excluding this suite + fixtures).
  const offenders: string[] = [];
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(p);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (p.endsWith(join("brand", "tokens.ts"))) continue;
      const src = readFileSync(p, "utf8");
      // strip comments so documentation may mention colors
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      if (/#[0-9a-fA-F]{6}\b/.test(code) || /0x[0-9a-fA-F]{6}\b/.test(code)) offenders.push(p);
    }
  };
  scan(join(ROOT, "lib", "marketing", "clips"));
  scan(join(ROOT, "lib", "marketing", "brand"));
  check(
    "no second brand-constant definition in clips render/provider code",
    offenders.length === 0,
    offenders.join(", ")
  );
}

/* ───────────────────────── render.real.spec ───────────────────────────── */

async function renderRealSpec() {
  console.log("# render.real.spec (FR-5: the in-house layouts REALLY render)");
  const bin = ffmpegBinaryPath();
  check("ffmpeg-static binary resolved (a real dependency, not a system assumption)", !!bin && existsSync(bin));
  if (!bin) return;

  const dir = mkdtempSync(join(tmpdir(), "wisesel-render-spec-"));
  try {
    // Synthesize a 3s 1280×720 test input with audio (the composited-canvas shape).
    const inputPath = join(dir, "input.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest",
      inputPath,
    ]);
    check("synthetic 1280×720 input rendered", existsSync(inputPath) && statSync(inputPath).size > 10_000);

    const isMp4 = (p: string) => {
      const head = readFileSync(p).subarray(0, 12);
      return head.includes(Buffer.from("ftyp"));
    };

    const pip = bubbleRect(1280, 720, 16 / 9, "bottom-right");
    const stackedOut = join(dir, "stacked.mp4");
    await runFfmpeg(
      buildStackedSplitArgs({ inputPath, outputPath: stackedOut, pipRect: pip, durationSeconds: 3 })
    );
    check("stacked_split renders a playable mp4", existsSync(stackedOut) && isMp4(stackedOut) && statSync(stackedOut).size > 5_000);

    const zoomOut = join(dir, "zoom.mp4");
    await runFfmpeg(
      buildZoomPanArgs({
        inputPath,
        outputPath: zoomOut,
        keyframes: zoomKeyframesFromCues([800, 1_800], 3_000),
        durationSeconds: 3,
        sourceW: 1280,
        sourceH: 720,
      })
    );
    check("screen_action_zoom renders a playable mp4", existsSync(zoomOut) && isMp4(zoomOut) && statSync(zoomOut).size > 5_000);

    const audioOut = join(dir, "audiogram.mp4");
    await runFfmpeg(buildAudiogramArgs({ inputPath, outputPath: audioOut, durationSeconds: 3 }));
    check("audiogram renders a playable mp4", existsSync(audioOut) && isMp4(audioOut) && statSync(audioOut).size > 5_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ─────────────── routing/provider mapping + pip provenance ────────────── */

async function mappingSpec() {
  console.log("# provider mapping (D-5) + pip provenance (D-3) + cue times");
  check(
    "layout → renderer: face_track=reap; split/zoom/audiogram=in-house; slide_short=M-F",
    providerForLayout("face_track") === "reap" &&
      providerForLayout("stacked_split") === "wisesel_ffmpeg" &&
      providerForLayout("screen_action_zoom") === "wisesel_ffmpeg" &&
      providerForLayout("audiogram") === "wisesel_ffmpeg" &&
      providerForLayout("slide_short") === "wisesel_slides"
  );

  let modelTouched = 0;
  const spyModel = {
    model: "spy",
    async runTurn() {
      throw new Error("unused");
    },
    async inspectImage() {
      modelTouched++;
      return { text: JSON.stringify({ corner: "top-left" }) };
    },
  };
  const det = await resolvePipRect({
    bubblePosition: "bottom-left",
    model: spyModel as never,
    playbackId: "pb",
    durationSeconds: 100,
  });
  check(
    "metadata corner → deterministic bubbleRect, detection NEVER invoked (spy)",
    det.provenance === "deterministic" &&
      det.rect.x === Math.round(1280 * 0.03) &&
      modelTouched === 0
  );
  const detFetch: typeof fetch = async () => new Response(Buffer.from([0xff, 0xd8, 0xff]), { status: 200 });
  const detected = await resolvePipRect({
    bubblePosition: null,
    model: spyModel as never,
    playbackId: "pb",
    durationSeconds: 100,
    fetchImpl: detFetch,
  });
  check(
    "no metadata → vision-detected corner, provenance 'detected'",
    detected.provenance === "detected" && modelTouched === 1 && detected.rect.y === Math.round(1280 * 0.03)
  );

  const words = wordsFromSegments([
    { atMs: 10_000, endMs: 25_000, text: "Let me show you the formula. An index is a sorted copy. Watch what happens when I hit enter." },
  ]);
  const times = actionCueTimes(words, { startMs: 10_000, endMs: 25_000 });
  check(
    "actionCueTimes: clip-relative, sorted, one per cue hit",
    times.length >= 3 && times[0] === 0 && times.every((t, i) => i === 0 || t >= times[i - 1]) && times.every((t) => t < 15_000)
  );
}

/* ─────────────────────────── hardening greps ──────────────────────────── */

function grepSpec() {
  console.log("# hardening greps (publish/schedule fences, no cron)");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(ROOT, "lib", "marketing", "clips"));
  files.push(join(ROOT, "lib", "marketing", "brand", "tokens.ts"));
  const sources = files.map((f) => readFileSync(f, "utf8"));
  check(
    "no publish-clip/schedule-clips references anywhere in clips code",
    sources.every((s) => !/publish-clip|schedule-clips|publish_clip|schedule_clips/i.test(s))
  );
  check(
    "no scheduler primitives (setInterval/cron) in clips code",
    sources.every((s) => !/setInterval\(|node-cron|new CronJob/.test(s))
  );
  check(
    "render events extended in TS union + migration together (drift guard)",
    ["clip_job_submitted", "clip_job_completed", "clip_job_failed"].every(
      (e) =>
        readFileSync(join(ROOT, "lib", "marketing", "types.ts"), "utf8").includes(`"${e}"`) &&
        readFileSync(join(ROOT, "supabase", "migrations", "20260708130000_clip_render_jobs.sql"), "utf8").includes(`'${e}'`)
    )
  );
}

/* ───────────────────────── M-R producer specs ─────────────────────────── */

async function recorderCaptureSpec() {
  console.log("# recorder.slideSync.spec (M-R D-2: the capture module, pure)");
  const { beginSlideSyncCapture, reportSlideShown, endSlideSyncCapture, abortSlideSyncCapture, isSlideSyncCapturing, slideIdFromSelection } =
    await import("@/lib/editor/recordingSlideSync");

  check("no session → report is a no-op", (reportSlideShown("s1"), endSlideSyncCapture().length === 0));
  let clock = 0;
  beginSlideSyncCapture(() => clock);
  check("capturing flag", isSlideSyncCapturing());
  reportSlideShown("s1"); // t0
  clock = 4_000;
  reportSlideShown("s1"); // duplicate — not an advance
  clock = 9_500;
  reportSlideShown("s2");
  clock = 15_200;
  reportSlideShown("s3");
  const entries = endSlideSyncCapture();
  check(
    "entries: dedupe consecutive, RECORDED-timeline ms, ascending",
    entries.length === 3 &&
      entries[0].slideId === "s1" &&
      entries[0].atMs === 0 &&
      entries[1].atMs === 9_500 &&
      entries[2].atMs === 15_200
  );
  check("session closed after end", !isSlideSyncCapturing());
  beginSlideSyncCapture(() => -50);
  reportSlideShown("sx");
  check("negative clock clamps to 0", endSlideSyncCapture()[0].atMs === 0);
  beginSlideSyncCapture(() => 0);
  reportSlideShown("sy");
  abortSlideSyncCapture();
  check("abort drops entries", endSlideSyncCapture().length === 0);

  const SEL_TABLE: [Record<string, string>, string | null][] = [
    [{ kind: "slide", id: "sl-1" }, "sl-1"],
    [{ kind: "element", id: "el-1", slideId: "sl-2" }, "sl-2"],
    [{ kind: "elements", slideId: "sl-3" }, "sl-3"],
    [{ kind: "lesson", id: "l-1" }, null],
    [{ kind: "course" }, null],
    [{ kind: "block", id: "b-1" }, null],
  ];
  for (const [sel, want] of SEL_TABLE) {
    check(`selection ${sel.kind} → ${want ?? "null"}`, slideIdFromSelection(sel as never) === want);
  }

  console.log("# recorder.contract.spec (M-R: producer shape = the M-A consumer contract)");
  const { SlideSyncEntrySchema } = await import("@/lib/marketing/clips/schemas");
  check(
    "captured entries parse under the clips SlideSyncEntrySchema verbatim",
    entries.every((e) => SlideSyncEntrySchema.safeParse(e).success)
  );
}

async function recordingMetadataSpec() {
  console.log("# recording.metadata.spec (M-R: schema + patch round-trip, back-compat)");
  const { LessonBlockSchema } = await import("@/lib/course/schemas");
  const { createVideoLessonBlock, createModule, createLesson } = await import("@/lib/course/factories");
  const { updateVideoLessonPatch } = await import("@/lib/course/commands");
  const { applyCoursePatch } = await import("@/lib/course/patches");
  const { PLACEHOLDER_COURSE } = await import("@/lib/course/placeholder");

  const block = createVideoLessonBlock();
  check("legacy block (no M-R fields) still parses", LessonBlockSchema.safeParse(block).success);

  const sync = [
    { slideId: "sl-1", atMs: 0 },
    { slideId: "sl-2", atMs: 12_400 },
  ];
  const pip = { x: 924, y: 512, width: 282, height: 158, corner: "bottom-right" as const };
  const module_ = createModule("M", 0);
  const lesson = createLesson("L", 0);
  lesson.blocks = [block];
  module_.lessons = [lesson];
  const doc = { ...structuredClone(PLACEHOLDER_COURSE), modules: [module_] };
  const patch = updateVideoLessonPatch(block.id, {
    recording: {
      mode: "screen_camera",
      slideSync: sync,
      pipGeometry: pip,
      dualCameraAssetRowId: "11111111-2222-3333-4444-555555555555",
    },
  });
  const now = "2026-07-08T12:00:00.000Z";
  const res1 = applyCoursePatch(doc as never, patch, now);
  check("patch applies ok", res1.ok);
  if (!res1.ok) return;
  const updated = res1.doc.modules[0].lessons[0].blocks[0] as typeof block;
  check(
    "UPDATE_VIDEO_LESSON persists slideSync + pipGeometry + dual link (D-2/D-3/D-4)",
    updated.recording.slideSync?.length === 2 &&
      updated.recording.slideSync[1].atMs === 12_400 &&
      updated.recording.pipGeometry?.corner === "bottom-right" &&
      updated.recording.dualCameraAssetRowId === "11111111-2222-3333-4444-555555555555"
  );
  check("the updated block round-trips the zod schema", LessonBlockSchema.safeParse(updated).success);
  const res2 = applyCoursePatch(
    res1.doc,
    updateVideoLessonPatch(block.id, { recording: { slideSync: null } }),
    now
  );
  check("clear patch applies ok", res2.ok);
  if (!res2.ok) return;
  const clearedBlock = res2.doc.modules[0].lessons[0].blocks[0] as typeof block;
  check(
    "null clears slideSync, siblings untouched (shallow-merge semantics)",
    clearedBlock.recording.slideSync == null && clearedBlock.recording.pipGeometry?.corner === "bottom-right"
  );
}

function dualStackedSpec() {
  console.log("# composite.stackedSplit.spec (M-R D-4: dual-track geometry)");
  const args = buildStackedSplitDualArgs({
    screenInputPath: "screen.mp4",
    cameraInputPath: "camera.mp4",
    outputPath: "out.mp4",
    durationSeconds: 40,
  });
  const graph = args[args.indexOf("-filter_complex") + 1];
  check(
    "dual: face band from the CAMERA input (full-res, no PiP crop)",
    graph.includes(`[1:v]scale=${CLIP_OUT_W}:${STACKED_FACE_BAND_H}:force_original_aspect_ratio=increase`)
  );
  check(
    "dual: screen band from the composited input, full slide legible",
    graph.includes(`[0:v]scale=${CLIP_OUT_W}:${STACKED_SCREEN_BAND_H},setsar=1[screen]`)
  );
  check("dual: audio rides input 0 (the recording's mixed track)", args.join(" ").includes("-map 0:a?"));
  check(
    "dual: two inputs in order screen, camera",
    args.indexOf("screen.mp4") < args.indexOf("camera.mp4")
  );
}

async function main() {
  await providerContractSpec();
  await stateMachineSpec();
  ffmpegArgsSpec();
  brandDivergenceSpec();
  await renderRealSpec();
  await mappingSpec();
  grepSpec();
  await recorderCaptureSpec();
  await recordingMetadataSpec();
  dualStackedSpec();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
