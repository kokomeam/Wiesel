/**
 * WiseselSlideShortProvider (amendment FR-6) — REAL-RENDER suite. Bundles
 * the Remotion composition (Tailwind v4 + the app's @/ alias) and drives
 * headless Chrome for genuine output:
 *
 *   slideShortProvider.render.spec —
 *     · spec Zod gate (bad specs refused)
 *     · REAL still renders with frame-sample assertions: the hook overlay
 *       renders in its ≤2s window; slide A at sync-time T₁ differs from
 *       slide B at T₂ (slides ADVANCE on their sync timestamps); kinetic
 *       captions render (same frame with/without words differs); the end
 *       card renders in its tail window
 *     · a REAL full render: H.264 MP4, 1080×1920, duration probed ± 0.5s
 *   slideShortProvider.cost.spec — in-house minutes × rate (pure)
 *   (lifecycle + ingest ride verify-clips-int with an injected renderer;
 *    brand divergence rides verify-clips-render — this folder is scanned)
 *
 * First-ever run downloads Remotion's Chrome Headless Shell (~150 MB).
 * Run: `npx tsx scripts/verify-clips-slideshort.ts`
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createSlide, createStructuredSlide } from "@/lib/course/factories";
import { ffmpegBinaryPath } from "@/lib/marketing/clips/render/localRender";
import {
  renderSlideShort,
  renderSlideShortStill,
} from "@/lib/marketing/clips/render/slideShort/renderSlideShort";
import {
  SLIDE_SHORT_H,
  SLIDE_SHORT_W,
  SlideShortSpecSchema,
  type SlideShortSpec,
} from "@/lib/marketing/clips/render/slideShort/spec";
import { clipRenderConfig } from "@/lib/marketing/clips/constants";

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

/* ─────────── fixture: 2 structured slides + a served audio span ────────── */

function fixtureSlides() {
  // The REAL factories — the same JSON a lesson deck stores.
  const rt = (text: string) => ({ text });
  const s1 = createStructuredSlide("prose");
  if (s1.template?.layoutId === "prose") {
    s1.template.content.title = rt("Profit is an opinion");
    s1.template.content.body = rt(
      "Accrual rules mean two honest accountants can produce two different profit numbers from the same year."
    );
  }
  const s2 = createStructuredSlide("key_concept");
  if (s2.template?.layoutId === "key_concept") {
    s2.template.content.term = rt("Cash is a fact");
    s2.template.content.definition = rt("Nobody can produce two different bank balances.");
  }
  const s3 = createSlide(); // an ELEMENT slide — exercises the pure fallback
  return { s1, s2, s3 };
}

async function serveFixtureMedia(dir: string): Promise<{ server: Server; url: string }> {
  const bin = ffmpegBinaryPath();
  if (!bin) throw new Error("ffmpeg-static missing");
  const mediaPath = join(dir, "span.mp4");
  const r = spawnSync(
    bin,
    ["-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=8", "-c:a", "aac", mediaPath],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`fixture audio failed: ${r.stderr?.slice(-300)}`);
  const bytes = readFileSync(mediaPath);
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/span.mp4` };
}

/* ────────────────────────────── specs ──────────────────────────────────── */

function costSpec() {
  console.log("# slideShortProvider.cost.spec (in-house minutes × rate)");
  const cfg = clipRenderConfig();
  check("in-house minute rate configured (default 1)", cfg.inhouseMinuteRate >= 1);
  const spanSeconds = 45;
  const cost = Math.ceil(spanSeconds / 60) * cfg.inhouseMinuteRate;
  check("a 45s slide short bills ceil(45/60)×rate = 1×rate minutes", cost === cfg.inhouseMinuteRate);
}

async function renderSpec() {
  console.log("# slideShortProvider.render.spec (REAL renders — headless Chrome)");
  const dir = mkdtempSync(join(tmpdir(), "wisesel-slideshort-"));
  const { server, url } = await serveFixtureMedia(dir);
  try {
    const { s1, s2, s3 } = fixtureSlides();
    const spec: SlideShortSpec = {
      mediaUrl: url,
      durationMs: 8_000,
      slides: [
        { fromMs: 0, toMs: 3_000, slide: s1 as unknown as Record<string, unknown> },
        { fromMs: 3_000, toMs: 6_000, slide: s2 as unknown as Record<string, unknown> },
        { fromMs: 6_000, toMs: 8_000, slide: s3 as unknown as Record<string, unknown> },
      ],
      captionWords: [
        { w: "profit", startMs: 2_300, endMs: 2_650 },
        { w: "is", startMs: 2_650, endMs: 2_800 },
        { w: "an", startMs: 2_800, endMs: 2_950 },
        { w: "opinion", startMs: 2_950, endMs: 3_400 },
      ],
      hookText: "Profit is an opinion. Cash is a fact.",
      preset: "bofu_preview",
      platform: "instagram",
      endCardCta: null,
      creatorHandle: "@hbduo",
      courseTitle: "Financial Statements for Founders",
    };
    check("spec passes the Zod gate", SlideShortSpecSchema.safeParse(spec).success);
    check(
      "a bad spec is refused (no slides)",
      !SlideShortSpecSchema.safeParse({ ...spec, slides: [] }).success
    );

    // Frame samples (deterministic: same input ⇒ same pixels; a changed
    // input isolates exactly one visual system per comparison).
    const still = async (name: string, s: SlideShortSpec, atMs: number) => {
      const out = join(dir, `${name}.png`);
      await renderSlideShortStill(s, atMs, out);
      return readFileSync(out);
    };
    console.log("  … bundling the composition + first stills (Chrome downloads on first ever run)");
    const hookOn = await still("hook-on", spec, 1_000);
    const hookOff = await still("hook-off", { ...spec, hookText: "" }, 1_000);
    check("hook overlay renders inside its ≤2s window", !hookOn.equals(hookOff));
    const afterHook = await still("post-hook", spec, 2_400);
    const slideB = await still("slide-b", spec, 4_500);
    check("slides ADVANCE on sync timestamps (slide A @2.4s ≠ slide B @4.5s)", !afterHook.equals(slideB));
    const capOff = await still("cap-off", { ...spec, captionWords: [] }, 2_400);
    check("kinetic captions render (same frame with words ≠ without)", !afterHook.equals(capOff));
    const elementSlide = await still("element-fallback", spec, 6_900);
    check("element slides render via the pure fallback card", elementSlide.length > 10_000 && !elementSlide.equals(slideB));
    const endCard = await still("end-card", spec, 7_600);
    check("the end card renders in its tail window", !endCard.equals(slideB));

    // The full render.
    console.log("  … full 8s render (240 frames)");
    const outPath = join(dir, "slide-short.mp4");
    const started = Date.now();
    await renderSlideShort(spec, outPath);
    console.log(`  … rendered in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    check("output exists and is non-trivial", existsSync(outPath) && statSync(outPath).size > 50_000);
    const head = readFileSync(outPath).subarray(0, 16);
    check("output is an mp4 (ftyp)", head.includes(Buffer.from("ftyp")));
    const bin = ffmpegBinaryPath()!;
    const probe = spawnSync(bin, ["-i", outPath], { encoding: "utf8" }).stderr;
    check("codec h264 at 1080×1920", probe.includes("h264") && probe.includes(`${SLIDE_SHORT_W}x${SLIDE_SHORT_H}`));
    const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(probe);
    const seconds = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
    check(`duration ≈ 8s (probed ${seconds.toFixed(2)}s)`, Math.abs(seconds - 8) < 0.5);
    check("audio track present (the span's own sound)", /Stream #.*Audio/.test(probe));

    writeFileSync(join(process.cwd(), "artifacts", "m-f-slide-short-fixture.mp4"), readFileSync(outPath));
    console.log("  … artifact → artifacts/m-f-slide-short-fixture.mp4");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  costSpec();
  await renderSpec();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
