/**
 * The slide-short RENDERER (FR-6) — bundles the composition once per process
 * (@remotion/bundler + the Tailwind-v4 webpack override + the app's `@/`
 * alias) and renders H.264 1080×1920 via @remotion/renderer's headless
 * Chrome.
 *
 * Concurrency: a render-worker semaphore sized `CLIP_RENDER_WORKERS`
 * (default 1) — DELIBERATELY not the LLM two-concurrent ceiling (renders
 * are outside it, the amendment rule). Footprint per render (documented in
 * docs/clips.md): headless Chrome ~400–800 MB RSS + one CPU-bound encode;
 * first-ever render downloads Remotion's Chrome Headless Shell (~150 MB).
 *
 * License note (FR-6, binding): **Remotion license trigger — 4th hire.**
 * Remotion is free for companies under 4 employees; The HB Duo qualifies
 * today. Revisit at the 4th hire (docs/clips.md carries the same note).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SlideShortSpec } from "./spec";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");

function workerCount(): number {
  const v = Number(process.env.CLIP_RENDER_WORKERS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

/** A tiny FIFO semaphore for the render pool (NOT the LLM semaphore). */
class RenderPool {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.size) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => this.release();
  }
  private release() {
    this.active--;
    this.queue.shift()?.();
  }
}

let pool: RenderPool | null = null;
let bundlePromise: Promise<string> | null = null;

async function getBundle(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const { bundle } = await import("@remotion/bundler");
      const { enableTailwind } = await import("@remotion/tailwind-v4");
      const entryPoint = path.join(HERE, "entry.ts");
      if (!existsSync(entryPoint)) throw new Error(`slide-short entry missing: ${entryPoint}`);
      return bundle({
        entryPoint,
        webpackOverride: (config) => {
          const withTw = enableTailwind(config);
          return {
            ...withTw,
            resolve: {
              ...withTw.resolve,
              alias: {
                ...(withTw.resolve?.alias as Record<string, string> | undefined),
                "@": REPO_ROOT,
              },
            },
          };
        },
      });
    })();
    bundlePromise.catch(() => {
      bundlePromise = null; // a failed bundle retries on the next job
    });
  }
  return bundlePromise;
}

/** Render one slide short to `outputPath`. Throws on any failure — the tick's
 *  attempts/stale machinery owns retries. */
export async function renderSlideShort(spec: SlideShortSpec, outputPath: string): Promise<void> {
  pool ??= new RenderPool(workerCount());
  const release = await pool.acquire();
  try {
    const [{ renderMedia, selectComposition }] = await Promise.all([import("@remotion/renderer")]);
    const serveUrl = await getBundle();
    const inputProps = spec as unknown as Record<string, unknown>;
    const composition = await selectComposition({ serveUrl, id: "slide-short", inputProps });
    await renderMedia({
      serveUrl,
      composition,
      codec: "h264",
      outputLocation: outputPath,
      inputProps,
      timeoutInMilliseconds: 8 * 60_000,
    });
  } finally {
    release();
  }
}

/** Render a single frame (the render spec's frame-sample assertions). */
export async function renderSlideShortStill(
  spec: SlideShortSpec,
  atMs: number,
  outputPath: string
): Promise<void> {
  const { renderStill, selectComposition } = await import("@remotion/renderer");
  const serveUrl = await getBundle();
  const inputProps = spec as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: "slide-short", inputProps });
  const frame = Math.min(
    composition.durationInFrames - 1,
    Math.max(0, Math.round((atMs / 1000) * composition.fps))
  );
  await renderStill({ serveUrl, composition, frame, output: outputPath, inputProps });
}
