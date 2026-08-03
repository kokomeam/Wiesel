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
 *   - providerErrors.spec        — structured 4xx detail stringified (no
 *     "[object Object]"), permanent-vs-transient flags, permanent poll
 *     rejection FAILS the job + cleans the temp precut (2026-07-15 live
 *     fixes: a leaked fake-ref job 422'd silently on every tick forever)
 *   - staticGuard.spec           — frozen-source detection (byte-identical
 *     span thumbnails) blocks camera-bearing renders, exempts screen_only
 *
 * Run: `npx tsx scripts/verify-clips-render.ts`
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { CLIP_TEXT_FONTS, CLIP_TEXT_STYLES } from "@/lib/marketing/clips/textStyles";
import { buildClipTextTrack, type ClipTextTrackSpec } from "@/lib/marketing/clips/textTrack";
import { assertClipFontsResolvable, parseTtfFamilies } from "@/lib/marketing/clips/textFonts";
import { buildBurnArgs, buildSubtitlesFilter, burnClipText } from "@/lib/marketing/clips/render/burn";
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
    "getJob: output from get-project-clips (CLEAN preferred — H-6), NEVER urls.videoFile",
    view.outputUrl === "https://cdn/clean.mp4" &&
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

async function packagingLayoutSpec() {
  console.log("# packaging.layout.spec (M-C: presets × layouts are ORTHOGONAL)");
  const { CLIP_PACKAGING_PRESETS, CLIP_PRESET_META, ResolvedPackagingSchema, resolvePackaging } =
    await import("@/lib/marketing/clips/presets");
  const { CLIP_LAYOUTS } = await import("@/lib/marketing/clips/constants");
  check("3 presets with complete meta", CLIP_PACKAGING_PRESETS.every((p) => CLIP_PRESET_META[p].captionsPresetId.startsWith("system_")));
  let all = true;
  for (const preset of CLIP_PACKAGING_PRESETS) {
    for (const layout of CLIP_LAYOUTS) {
      const r = resolvePackaging(preset, layout);
      if (!ResolvedPackagingSchema.safeParse(r).success || r.layout !== layout) all = false;
      if (r.creatorBrandOverrides !== undefined) all = false; // [FWD], MVP undefined
    }
  }
  check("every preset resolves in EVERY layout (bofu_preview slide_short, tofu_hook stacked_split, …) — no superRefine coupling", all);
  check(
    "layout membership enforced",
    !ResolvedPackagingSchema.safeParse({ presetId: "tofu_hook", layout: "portrait", captionsPresetId: "system_hype" }).success
  );
  check(
    "brand rides D-1 tokens (one source)",
    resolvePackaging("tofu_hook", "face_track").brand.colors.brand === BRAND_TOKENS.colors.brand
  );
}

async function postingKitSpec() {
  console.log("# postingKit.spec (M-D: disclosure code-inserted, codes, keywords)");
  const { disclosureLine, generateShortCode, normalizeKeyword, SHORT_CODE_LENGTH } = await import(
    "@/lib/marketing/clips/postingKit"
  );
  check(
    "disclosure line is deterministic code (never model output)",
    disclosureLine('SQL Perf') === 'From my course "SQL Perf" — full lesson inside.'
  );
  const codes = new Set(Array.from({ length: 200 }, () => generateShortCode()));
  check(
    `short codes: ${SHORT_CODE_LENGTH} chars, unambiguous alphabet, no dupes in 200`,
    codes.size === 200 && [...codes].every((c) => c.length === SHORT_CODE_LENGTH && /^[a-z2-9]+$/.test(c) && !/[01ol]/.test(c))
  );
  const KEYWORDS: [string, string | null][] = [
    ["learn", "LEARN"],
    ["  bst! ", "BST"],
    ["INDEXING", "INDEXING"],
    ["ab", null], // too short
    ["THISKEYWORDISWAYTOOLONG", null],
    ["123", null],
  ];
  for (const [raw, want] of KEYWORDS) {
    check(`keyword "${raw}" → ${want ?? "rejected"}`, normalizeKeyword(raw) === want);
  }

  // Answer-key invariant grep (the /preview surface can never touch
  // assessment tables).
  const previewSrc = readFileSync(join(ROOT, "app", "preview", "[code]", "page.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, ""); // comments may NAME the invariant; code may not touch the tables
  check(
    "preview page table surface = short_link/posting_kit/social_post + storage ONLY (answer-key invariant)",
    !/quiz_answer_keys|from\("blocks"\)|course_publications|quiz_attempts|question_responses/.test(previewSrc)
  );
  const linkSrc = readFileSync(join(ROOT, "app", "l", "[code]", "route.ts"), "utf8");
  check(
    "short-link route re-resolves the destination at CLICK time (publishing upgrades old links)",
    linkSrc.includes("coursePreviewPath") && linkSrc.includes('searchParams.set("ref"')
  );
  check(
    "enroll route threads refCode → clip attribution (best-effort)",
    readFileSync(join(ROOT, "app", "api", "learn", "enroll", "route.ts"), "utf8").includes("recordClipEnrollment")
  );
}

async function clipsUiSpec() {
  console.log("# momentPicker.layoutChips.spec + clipCard.audiogramCaveat.spec (M-E, FR-9)");
  const view = readFileSync(join(ROOT, "components", "marketing", "clips", "ClipsView.tsx"), "utf8");
  check(
    "layout chips IMPORT CLIP_LAYOUT_LABELS (never copy the human copy)",
    view.includes("CLIP_LAYOUT_LABELS") && !view.includes('"Split screen + camera"')
  );
  check(
    "audiogram caveat IMPORTS CLIP_AUDIOGRAM_CAVEAT and renders it visibly",
    view.includes("CLIP_AUDIOGRAM_CAVEAT") && view.includes('c.layout === "audiogram"')
  );
  check("ManualPublishNotice is REUSED (the one language component)", view.includes("ManualPublishNotice"));
  const { BANNED_UI_PHRASES } = await import("@/lib/marketing/clips/constants");
  const uiFiles = [
    view,
    readFileSync(join(ROOT, "app", "(app)", "marketing", "clips", "page.tsx"), "utf8"),
    readFileSync(join(ROOT, "app", "preview", "[code]", "page.tsx"), "utf8"),
  ];
  check(
    "no banned publish-language anywhere in the clips UI",
    uiFiles.every((src) => BANNED_UI_PHRASES.every((p) => !src.toLowerCase().includes(p)))
  );
  check(
    "usage meter renders both quotas (jobs/day + minutes/month)",
    view.includes("jobsPerDay") && view.includes("minutesPerMonth")
  );
  check(
    "every mutation rides the REST surface (fetch → gate), no direct supabase writes in the view",
    !/supabase|createClient/.test(view)
  );
  check(
    "slide_short candidates render like every other layout (the M-F provider is live)",
    !view.includes("Slide-short rendering is coming next")
  );
  // 2026-07-15: the page SSRs client components — a bare `window` in the kit
  // full text threw "window is not defined" the moment a persisted kit
  // loaded. The origin must ride useSyncExternalStore (server snapshot "")
  // and window may appear ONLY inside its client snapshot getter.
  const windowUses = view.match(/window\./g) ?? [];
  check(
    "kit text is SSR-safe: origin via useSyncExternalStore, no other window access",
    view.includes("useSyncExternalStore") &&
      windowUses.length === 1 &&
      view.includes("() => window.location.origin")
  );
}

async function chaosAndWerSpec() {
  console.log("# reconciliation.chaos.spec (M-G: the poll-first path survives provider chaos)");
  const { advanceRenderJob } = await import("@/lib/marketing/clips/render/service");
  const baseJob = {
    id: "job-chaos",
    creatorId: "c1",
    courseId: "co1",
    lessonId: "l1",
    candidateId: "cand1",
    layout: "face_track" as const,
    provider: "reap" as const,
    preset: "tofu_hook",
    status: "submitted" as const,
    source: {
      videoAssetRowId: "v1",
      sourceMuxAssetId: "m1",
      playbackId: "p1",
      startMs: 0,
      endMs: 40_000,
      recordingFormat: "camera_only" as const,
    },
    precut: { muxAssetId: "pre1", mp4Url: "https://media/pre.mp4" },
    providerRef: "proj-1",
    uploadRef: "up-1",
    cropProvenance: null,
    output: null,
    costMinutes: 1,
    error: null,
    attempts: 0,
    idempotencyKey: null,
    submittedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const explodingDb = new Proxy({}, { get() { throw new Error("DB must not be touched on a chaos noop"); } });
  const chaosDeps = {
    supabase: explodingDb as never,
    precut: { start: async () => ({ muxAssetId: "x" }), check: async () => ({ status: "preparing" as const, playbackId: null, mp4Url: null, error: null }), cleanup: async () => {} },
    nowIso: new Date().toISOString(),
  };
  // provider poll THROWS (network chaos) → the step swallows, job untouched
  const threw = await advanceRenderJob(
    { ...chaosDeps, provider: { id: "reap", submit: async () => { throw new Error("x"); }, getJob: async () => { throw new Error("provider 503"); }, cancel: async () => {} } },
    baseJob as never
  );
  check("provider poll throwing → noop (job left for the next tick, no DB write)", threw === "noop");
  // provider returns garbage-but-processing → noop
  const processing = await advanceRenderJob(
    { ...chaosDeps, provider: { id: "reap", submit: async () => { throw new Error("x"); }, getJob: async () => ({ status: "processing" as const, providerStatus: "queued", outputUrl: null, cleanOutputUrl: null, output: null, costMinutes: null, error: null }), cancel: async () => {} } },
    baseJob as never
  );
  check("provider still processing → noop (poll-first patience)", processing === "noop");
  // no provider configured → noop, never a crash
  const noProvider = await advanceRenderJob(chaosDeps as never, baseJob as never);
  check("provider unconfigured → noop (a held job, not a crash)", noProvider === "noop");

  console.log("# providerErrors.spec (permanent 4xx → terminal fail + precut cleanup)");
  const { ReapError } = await import("@/lib/marketing/clips/provider/reapClient");
  const { isPermanentProviderError } = await import("@/lib/marketing/clips/provider/types");
  check(
    "reap-api 4xx is PERMANENT; 408/429/upload-put/5xx are transient",
    new ReapError("get-project-status", 422, "x").permanent === true &&
      new ReapError("get-project-status", 404, "x").permanent === true &&
      new ReapError("get-project-status", 408, "x").permanent === false &&
      new ReapError("get-project-status", 429, "x").permanent === false &&
      new ReapError("upload-put", 403, "x").permanent === false &&
      new ReapError("get-project-status", 500, "x").permanent === false
  );
  check(
    "isPermanentProviderError: duck-typed, adapter-agnostic",
    isPermanentProviderError(new ReapError("get-project-status", 422, "x")) &&
      !isPermanentProviderError(new ReapError("get-project-status", 500, "x")) &&
      !isPermanentProviderError(new Error("plain")) &&
      !isPermanentProviderError({ permanent: true })
  );
  const { createReapProvider: mkReap } = await import("@/lib/marketing/clips/provider/reapClient");
  const objDetailFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ detail: { msg: "Invalid projectId", loc: ["query", "projectId"] } }), { status: 422 });
  let polled: unknown = null;
  try {
    await mkReap({ apiKey: "k", fetchImpl: objDetailFetch }).getJob("bad-ref");
  } catch (err) {
    polled = err;
  }
  check(
    "structured 4xx detail is STRINGIFIED into the message (no [object Object])",
    polled instanceof Error &&
      polled.message.includes("Invalid projectId") &&
      !polled.message.includes("[object Object]")
  );

  // Permanent rejection on the submitted poll → the job FAILS (terminal) and
  // the temp precut asset is cleaned — never an eternal silent noop.
  const snakeBase = {
    id: baseJob.id, creator_id: baseJob.creatorId, course_id: baseJob.courseId,
    lesson_id: baseJob.lessonId, candidate_id: baseJob.candidateId, layout: baseJob.layout,
    provider: baseJob.provider, preset: baseJob.preset, status: baseJob.status,
    source: baseJob.source, precut: baseJob.precut, provider_ref: baseJob.providerRef,
    upload_ref: baseJob.uploadRef, crop_provenance: null, output: null, cost_minutes: 1,
    error: null, attempts: 0, idempotency_key: null, submitted_at: baseJob.submittedAt,
    created_at: baseJob.createdAt, updated_at: baseJob.updatedAt,
  };
  const writes: Record<string, unknown>[] = [];
  const chainResolving = (result: unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "not", "order", "in", "limit"]) c[m] = () => c;
    c.maybeSingle = async () => result;
    c.single = async () => result;
    (c as { then: (res: (v: unknown) => void) => void }).then = (res) => res(result);
    return c;
  };
  const failDb = {
    from: (table: string) => ({
      update: (u: Record<string, unknown>) => {
        writes.push({ table, ...u });
        return chainResolving({ data: { ...snakeBase, ...u }, error: null });
      },
      insert: (row: Record<string, unknown>) => {
        writes.push({ table, ...row });
        return chainResolving({ data: row, error: null });
      },
      select: () => chainResolving({ data: [], count: 0, error: null }),
    }),
  };
  const cleaned: string[] = [];
  const permanentErr = Object.assign(
    new Error('reap get-project-status [422]: {"msg":"Invalid projectId"}'),
    { permanent: true }
  );
  const permanentOutcome = await advanceRenderJob(
    {
      supabase: failDb as never,
      precut: {
        start: async () => ({ muxAssetId: "x" }),
        check: async () => ({ status: "preparing" as const, playbackId: null, mp4Url: null, error: null }),
        cleanup: async (id: string) => { cleaned.push(id); },
      },
      nowIso: new Date().toISOString(),
      provider: {
        id: "reap" as const,
        submit: async () => { throw new Error("unused"); },
        getJob: async () => { throw permanentErr; },
        cancel: async () => {},
      },
    },
    baseJob as never
  );
  check(
    "permanent provider rejection → job FAILED with the diagnosable message",
    permanentOutcome === "failed" &&
      writes.some((w) => w.table === "clip_render_job" && w.status === "failed" && String(w.error).includes("[422]"))
  );
  check("failJob cleans the temp precut asset (the leak fix)", cleaned.includes("pre1"));

  console.log("# staticGuard.spec (frozen-source detection — the rAF-freeze incident)");
  const { detectStaticSpan } = await import("@/lib/marketing/clips/render/service");
  const frozenFetch: typeof fetch = async () => new Response(Buffer.from("same-frame-bytes"), { status: 200 });
  check(
    "byte-identical span thumbnails → frozen",
    (await detectStaticSpan({ playbackId: "pb", startMs: 0, endMs: 60_000, fetchImpl: frozenFetch })) === true
  );
  const movingFetch: typeof fetch = async (input) =>
    new Response(Buffer.from(`frame-at-${new URL(String(input)).searchParams.get("time")}`), { status: 200 });
  check(
    "differing thumbnails → not frozen",
    (await detectStaticSpan({ playbackId: "pb", startMs: 0, endMs: 60_000, fetchImpl: movingFetch })) === false
  );
  const brokenFetch: typeof fetch = async () => new Response("nope", { status: 500 });
  check(
    "thumbnail fetch failure → guard SKIPS (never blocks a render on a hiccup)",
    (await detectStaticSpan({ playbackId: "pb", startMs: 0, endMs: 60_000, fetchImpl: brokenFetch })) === false
  );
  const svc = readFileSync(join(ROOT, "lib", "marketing", "clips", "render", "service.ts"), "utf8");
  check(
    "createClipRenderJob wires the guard with the screen_only exemption + static_video code",
    svc.includes('recordingFormat !== "screen_only"') &&
      svc.includes("detectStaticSpan(") &&
      svc.includes('"static_video"')
  );

  console.log("# wer.spec (M-G: transcription quality measure through the adapter seam)");
  const { wordErrorRate } = await import("@/lib/marketing/clips/transcripts");
  check("identical → 0", wordErrorRate("an index is a sorted copy", "an index is a sorted copy") === 0);
  check("punctuation/case-insensitive", wordErrorRate("An index, is a SORTED copy.", "an index is a sorted copy") === 0);
  check("one substitution in five words → 0.2", wordErrorRate("one two three four five", "one two tree four five") === 0.2);
  check("empty hypothesis → 1", wordErrorRate("a b c", "") === 1);
  check("insertions counted", Math.abs(wordErrorRate("a b c", "a x b c") - 1 / 3) < 1e-9);
}

/* ══════════ Hook Overlay + Karaoke Caption Burn — REAL-render halves ═══════
 * textBurn.fonts.spec (T-1) · textBurn.real.spec (H-2 semantic frames) ·
 * textBurn.goldens.spec (T-6 golden frames) · textBurn.divergence.spec
 * (H-4 shared constants + the H-6 clean-variant pick).                     */

function burnFixtureWords() {
  return [
    { w: "the", startMs: 500, endMs: 700 },
    { w: "reason", startMs: 700, endMs: 1_100 },
    { w: "your", startMs: 1_100, endMs: 1_350 },
    { w: "code", startMs: 1_350, endMs: 1_700 },
    { w: "is", startMs: 1_900, endMs: 2_050 },
    { w: "slow", startMs: 2_050, endMs: 2_500 },
    { w: "is", startMs: 2_500, endMs: 2_650 },
    { w: "hiding", startMs: 2_650, endMs: 3_100 },
    { w: "in", startMs: 3_100, endMs: 3_250 },
    { w: "this", startMs: 3_250, endMs: 3_500 },
    { w: "loop", startMs: 3_500, endMs: 3_900 },
  ];
}

function burnSpecFixture(over: Partial<ClipTextTrackSpec> = {}): ClipTextTrackSpec {
  return {
    platform: "tiktok",
    preset: "tofu_hook",
    videoWidth: 720,
    videoHeight: 1280,
    clipDurationMs: 10_000,
    hook: { text: "This is why Theta(N) actually matters" },
    captionsEnabled: true,
    captionStyle: null,
    captionWords: burnFixtureWords(),
    ...over,
  };
}

/** Synthesize the deterministic burn input: flat dark canvas + tone. */
async function makeBurnInput(dir: string): Promise<string> {
  const input = join(dir, "burn-input.mp4");
  await runFfmpeg([
    "-y",
    "-f", "lavfi", "-i", "color=c=0x404040:s=720x1280:r=30:d=10",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=10",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-pix_fmt", "yuv420p",
    input,
  ]);
  return input;
}

/** Decode ONE frame (or a PNG) to raw RGB24 for pixel math. */
async function rawFrame(src: string, atSeconds: number | null, w: number, h: number, dir: string): Promise<Buffer> {
  const out = join(dir, `frame-${Math.random().toString(36).slice(2)}.rgb`);
  const seek = atSeconds === null ? [] : ["-ss", atSeconds.toFixed(3)];
  await runFfmpeg(["-y", ...seek, "-i", src, "-frames:v", "1", "-s", `${w}x${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
  return readFileSync(out);
}

/** Fraction of pixels differing by >8/255 in any channel + the diff's row range. */
function pixelDiff(a: Buffer, b: Buffer, w: number): { frac: number; minRow: number; maxRow: number } {
  const pixels = Math.min(a.length, b.length) / 3;
  let diff = 0,
    minRow = Infinity,
    maxRow = -1;
  for (let p = 0; p < pixels; p++) {
    const i = p * 3;
    if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8) {
      diff++;
      const row = Math.floor(p / w);
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }
  }
  return { frac: diff / pixels, minRow, maxRow };
}

async function textBurnFontsSpec() {
  console.log("# textBurn.fonts.spec (T-1: bundled OFL fonts resolve — no silent DejaVu)");
  const { dir: fontsDir } = assertClipFontsResolvable();
  check("assertClipFontsResolvable: files + name tables + OFL licenses verified", existsSync(fontsDir));
  const hookFamilies = parseTtfFamilies(readFileSync(join(fontsDir, CLIP_TEXT_FONTS.hook.file)));
  const capFamilies = parseTtfFamilies(readFileSync(join(fontsDir, CLIP_TEXT_FONTS.caption.file)));
  check(
    "name tables carry the exact families the ASS styles reference",
    hookFamilies.includes(CLIP_TEXT_FONTS.hook.family) && capFamilies.includes(CLIP_TEXT_FONTS.caption.family)
  );

  const dir = mkdtempSync(join(tmpdir(), "wisesel-burn-fonts-"));
  try {
    const input = await makeBurnInput(dir);
    // Rendered-frame fallback detection: the SAME hook with the real family
    // vs. a nonsense family MUST render differently — identical frames mean
    // the real family didn't resolve and the fallback took both (T-1
    // release blocker).
    const track = buildClipTextTrack(burnSpecFixture({ captionsEnabled: false }));
    const realAss = join(dir, "real.ass");
    const fakeAss = join(dir, "fake.ass");
    writeFileSync(realAss, track.ass);
    writeFileSync(fakeAss, track.ass.replaceAll(CLIP_TEXT_FONTS.hook.family, "WiseselNoSuchFont"));
    const realOut = join(dir, "real.mp4");
    const fakeOut = join(dir, "fake.mp4");
    await runFfmpeg(buildBurnArgs({ inputPath: input, assPath: realAss, fontsDir, outputPath: realOut }));
    await runFfmpeg(buildBurnArgs({ inputPath: input, assPath: fakeAss, fontsDir, outputPath: fakeOut }));
    const fReal = await rawFrame(realOut, 1.0, 720, 1280, dir);
    const fFake = await rawFrame(fakeOut, 1.0, 720, 1280, dir);
    check(
      "fallback detector: real family renders differently from a nonsense family",
      pixelDiff(fReal, fFake, 720).frac > 0.001
    );

    // avgCharWidthFrac provenance: re-measure the real ink width and assert
    // the constants still hold their safety margin (drift trips here).
    const measure = async (family: string, bold: boolean, text: string): Promise<number> => {
      const W = 2400, H = 300, FS = 100;
      const ass = [
        "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 2", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        `Style: M,${family},${FS},&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00000000,${bold ? -1 : 0},0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        `Dialogue: 0,0:00:00.00,0:00:02.00,M,,0,0,0,,{\\an5\\pos(${W / 2},${H / 2})}${text}`,
      ].join("\n");
      const assPath = join(dir, `measure-${family.replace(/\W/g, "")}.ass`);
      writeFileSync(assPath, ass);
      const raw = join(dir, `measure-${family.replace(/\W/g, "")}.rgb`);
      await runFfmpeg([
        "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:d=1:r=1`,
        "-vf", buildSubtitlesFilter(assPath, fontsDir),
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw,
      ]);
      const buf = readFileSync(raw);
      let minX = W, maxX = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (buf[(y * W + x) * 3] > 40) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }
      return (maxX - minX + 1) / text.length / FS;
    };
    const upper = await measure(CLIP_TEXT_FONTS.hook.family, false, "THIS IS WHY THETA(N) ACTUALLY MATTERS FOR YOU");
    const title = await measure(CLIP_TEXT_FONTS.hook.family, false, "This Is Why Theta(N) Actually Matters For You");
    const caption = await measure(CLIP_TEXT_FONTS.caption.family, true, "the reason your code is slow is hiding in this loop");
    const frac = CLIP_TEXT_STYLES.avgCharWidthFrac;
    check(
      `avgCharWidthFrac still bounds real ink (upper ${upper.toFixed(3)}≤${frac.hookUpper}, title ${title.toFixed(3)}≤${frac.hookTitle}, caption ${caption.toFixed(3)}≤${frac.caption})`,
      upper <= frac.hookUpper && title <= frac.hookTitle && caption <= frac.caption
    );
    check(
      "…and isn't overly conservative (constants within +0.12 of measured)",
      frac.hookUpper - upper <= 0.12 && frac.hookTitle - title <= 0.12 && frac.caption - caption <= 0.12
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function textBurnRealSpec() {
  console.log("# textBurn.real.spec (H-2: REAL burn — semantic frame checks)");
  const { dir: fontsDir } = assertClipFontsResolvable();
  void fontsDir;
  const dir = mkdtempSync(join(tmpdir(), "wisesel-burn-real-"));
  try {
    const input = await makeBurnInput(dir);
    const W = 720, H = 1280;

    const burned = join(dir, "burned.mp4");
    const meta = await burnClipText({ inputPath: input, outputPath: burned, spec: burnSpecFixture() });
    check(
      "burn ran: provenance carries burned=true + a sha256 assHash + the style version",
      meta.burned === true && /^[0-9a-f]{64}$/.test(meta.assHash ?? "") && meta.styleVersion === "clip-text-v1"
    );

    const captionsOnly = join(dir, "captions-only.mp4");
    await burnClipText({ inputPath: input, outputPath: captionsOnly, spec: burnSpecFixture({ hook: null }) });

    // Hook present in the early window, absent after the fade window.
    const hookWindowEnd = (280 + 2_500 + 240) / 1000;
    const early = { a: await rawFrame(burned, 1.0, W, H, dir), b: await rawFrame(captionsOnly, 1.0, W, H, dir) };
    const late = { a: await rawFrame(burned, hookWindowEnd + 1, W, H, dir), b: await rawFrame(captionsOnly, hookWindowEnd + 1, W, H, dir) };
    const earlyDiff = pixelDiff(early.a, early.b, W);
    // Compare the HOOK REGION only (upper 55%) at the late timestamp —
    // x264 inter-frame drift from the differing earlier content can leave
    // sub-visible ringing elsewhere; the semantic claim is about the hook.
    const topRows = Math.floor(0.55 * H) * W * 3;
    const lateDiff = pixelDiff(late.a.subarray(0, topRows), late.b.subarray(0, topRows), W);
    check("hook text present in the early frames (differs from a captions-only burn)", earlyDiff.frac > 0.002);
    check(
      "hook ABSENT after the slide_in_fade window (hook region converges to captions-only)",
      lateDiff.frac < 0.002
    );
    check(
      "the hook's pixels sit in the UPPER region (safe-area anchor, not mid-frame)",
      earlyDiff.minRow >= 0.1 * H && earlyDiff.maxRow <= 0.55 * H
    );

    // Captions mid-clip in the lower third — and ONLY there (the H-6
    // double-caption blocker's visual half: exactly one caption band).
    const inputFrame = await rawFrame(input, 3.3, W, H, dir);
    const capFrame = await rawFrame(captionsOnly, 3.3, W, H, dir);
    const capDiff = pixelDiff(inputFrame, capFrame, W);
    check("captions present mid-clip (differ from the clean master)", capDiff.frac > 0.002);
    check(
      "caption band appears exactly ONCE, inside the lower third",
      capDiff.minRow >= (2 / 3) * H - 40 && capDiff.maxRow <= H - 40
    );

    // Parity probe: same resolution, h264, audio COPIED (aac survives).
    const bin = ffmpegBinaryPath()!;
    const probe = spawnSync(bin, ["-i", burned], { encoding: "utf8" }).stderr;
    check("re-encode parity: 720×1280 h264 + the aac audio stream (copied)", probe.includes("720x1280") && probe.includes("h264") && /Audio: aac/.test(probe));

    // Clean-master reuse: a re-burn from the SAME clean input with a new
    // hook produces a different artifact; the master itself is untouched.
    const masterHash = createHash("sha256").update(readFileSync(input)).digest("hex");
    const reburned = join(dir, "reburned.mp4");
    await burnClipText({ inputPath: input, outputPath: reburned, spec: burnSpecFixture({ hook: { text: "A different hook entirely" } }) });
    check(
      "re-burn from the clean master: new artifact differs, master byte-identical",
      !readFileSync(reburned).equals(readFileSync(burned)) &&
        createHash("sha256").update(readFileSync(input)).digest("hex") === masterHash
    );

    // Degrades, never strands: an unfittable hook burns captions-only with
    // the finding; nothing-to-draw copies the master through.
    const degraded = join(dir, "degraded.mp4");
    const degradedMeta = await burnClipText({
      inputPath: input,
      outputPath: degraded,
      spec: burnSpecFixture({
        hook: { text: "incomprehensibilities counterrevolutionaries institutionalization intercontinentalism telecommunications" },
      }),
    });
    check(
      "unfittable hook → captions-only burn + hook_omitted_unfit finding (job never strands)",
      degradedMeta.burned === true &&
        degradedMeta.hookText === null &&
        degradedMeta.findings.some((f) => f.kind === "hook_omitted_unfit")
    );
    const passthrough = join(dir, "passthrough.mp4");
    const ptMeta = await burnClipText({
      inputPath: input,
      outputPath: passthrough,
      spec: burnSpecFixture({ hook: null, captionsEnabled: false }),
    });
    check(
      "nothing to draw → master copied through (burned=false, byte-identical)",
      ptMeta.burned === false && readFileSync(passthrough).equals(readFileSync(input))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function textBurnGoldensSpec() {
  console.log("# textBurn.goldens.spec (T-6: golden frames, pixel drift ≤1.5%)");
  const { dir: fontsDir } = assertClipFontsResolvable();
  void fontsDir;
  const goldensDir = join(ROOT, "lib", "marketing", "clips", "fixtures", "goldens");
  const record = process.env.CLIP_TEXT_GOLDENS_RECORD === "1";
  if (record) mkdirSync(goldensDir, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "wisesel-burn-goldens-"));
  try {
    const input = await makeBurnInput(dir);
    const W = 720, H = 1280;
    const cases: { name: string; spec: ClipTextTrackSpec; atSeconds: number }[] = [
      // hook layer × animation (captions off isolates the layer)
      ...(["slide_in_fade", "fade_in_out", "slide_across", "persistent"] as const).map((animation) => ({
        name: `hook-${animation}-tiktok`,
        spec: burnSpecFixture({ captionsEnabled: false, hook: { text: "This is why Theta(N) actually matters", animation } }),
        atSeconds: 1.0,
      })),
      // caption layer × style × platform (hook off isolates the layer)
      ...(["beam", "block", "minimal"] as const).flatMap((style) =>
        (["tiktok", "youtube_shorts"] as const).map((platform) => ({
          name: `captions-${style}-${platform}`,
          spec: burnSpecFixture({ hook: null, captionStyle: style, platform }),
          atSeconds: 3.3,
        }))
      ),
    ];
    check("golden matrix covers layer × style preset × platform (4 hook + 6 caption frames)", cases.length === 10);
    let allWithin = true;
    const failures: string[] = [];
    for (const c of cases) {
      const out = join(dir, `${c.name}.mp4`);
      await burnClipText({ inputPath: input, outputPath: out, spec: c.spec });
      const framePng = join(dir, `${c.name}.png`);
      await runFfmpeg(["-y", "-ss", c.atSeconds.toFixed(3), "-i", out, "-frames:v", "1", framePng]);
      const goldenPath = join(goldensDir, `${c.name}.png`);
      if (record) {
        copyFileSync(framePng, goldenPath);
        continue;
      }
      if (!existsSync(goldenPath)) {
        allWithin = false;
        failures.push(`${c.name} (golden missing)`);
        continue;
      }
      const current = await rawFrame(framePng, null, W, H, dir);
      const golden = await rawFrame(goldenPath, null, W, H, dir);
      const d = pixelDiff(current, golden, W);
      if (d.frac > 0.015) {
        allWithin = false;
        failures.push(`${c.name} (${(d.frac * 100).toFixed(2)}%)`);
      }
    }
    if (record) {
      console.log(`  … recorded ${cases.length} golden frames → ${goldensDir}`);
      check("goldens recorded (re-run without CLIP_TEXT_GOLDENS_RECORD to verify)", true);
    } else {
      check(
        "every burned frame matches its committed golden within 1.5% (styling change ⇒ regenerate goldens in the same PR)",
        allWithin,
        failures.join(", ")
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function textBurnDivergenceSpec() {
  console.log("# textBurn.divergence.spec (H-4 one style source · H-6 clean-variant pick)");
  const composition = readFileSync(
    join(ROOT, "lib", "marketing", "clips", "render", "slideShort", "SlideShortComposition.tsx"),
    "utf8"
  );
  check(
    "SlideShortComposition consumes CLIP_TEXT_STYLES + the shared karaoke grouping (H-4)",
    composition.includes("CLIP_TEXT_STYLES") &&
      composition.includes("groupCaptionWords") &&
      composition.includes("CLIP_CAPTION_STYLE_SPECS") &&
      composition.includes("hookAnchor")
  );
  check(
    "…and defines no ad-hoc caption/hook type sizes (the old text-5xl/6xl classes are gone)",
    !/text-[56]xl/.test(composition)
  );
  const styleCss = readFileSync(join(ROOT, "lib", "marketing", "clips", "render", "slideShort", "style.css"), "utf8");
  check(
    "the composition bundles the SAME OFL font files libass burns with (T-1/H-4)",
    styleCss.includes("assets/clip-fonts/ArchivoBlack-Regular.ttf") && styleCss.includes("assets/clip-fonts/Inter-Bold.ttf")
  );

  // H-6: the adapter serves the CLEAN render first; the captioned variant is
  // fallback-only — so a double-caption output is impossible by construction.
  const fetchImpl: typeof fetch = async (input) => {
    const u = String(input);
    if (u.includes("get-project-status")) return Response.json({ status: "completed" });
    if (u.includes("get-project-details")) return Response.json({ billedDuration: 1 });
    if (u.includes("get-project-clips"))
      return Response.json({
        clips: [{ clipUrl: "https://cdn/clean.mp4", clipWithCaptionsUrl: "https://cdn/captioned.mp4", metadata: { width: 1080, height: 1920, duration: 40 } }],
      });
    throw new Error(`unexpected ${u}`);
  };
  const provider = createReapProvider({ apiKey: "k", fetchImpl });
  const view = await provider.getJob("proj-1");
  check(
    "reap adapter: outputUrl AND cleanOutputUrl are the CLEAN clipUrl (H-6)",
    view.outputUrl === "https://cdn/clean.mp4" && view.cleanOutputUrl === "https://cdn/clean.mp4"
  );
  const grepBurn = readFileSync(join(ROOT, "lib", "marketing", "clips", "render", "service.ts"), "utf8");
  check(
    "the completion step downloads cleanOutputUrl ?? outputUrl (never the captioned URL)",
    grepBurn.includes("view.cleanOutputUrl ?? view.outputUrl")
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
  await packagingLayoutSpec();
  await postingKitSpec();
  await clipsUiSpec();
  await chaosAndWerSpec();
  await textBurnFontsSpec();
  await textBurnRealSpec();
  await textBurnGoldensSpec();
  await textBurnDivergenceSpec();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
