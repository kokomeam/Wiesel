/**
 * FFmpeg execution for the in-house layouts (M-B). The ONLY file that spawns
 * ffmpeg; the args come from the PURE builders in ffmpegArgs.ts.
 *
 * Binary: `ffmpeg-static` (a real dependency — the continuation directive's
 * T0 ruling: "add it as a proper dependency with install docs, not a system
 * assumption"). `npm install` fetches the platform binary; nothing reads a
 * system ffmpeg. Deploy note (docs/clips.md § render infrastructure): the
 * binary is ~75 MB — on serverless targets route the render tick to a
 * Node runtime with the file included (Vercel: `outputFileTracingIncludes`)
 * or run ticks from a worker box; the local dev tick works out of the box.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

let cachedPath: string | null | undefined;

/** Resolve the bundled ffmpeg binary (null when the platform package is
 *  missing — callers surface a typed, creator-readable error). */
export function ffmpegBinaryPath(): string | null {
  if (cachedPath !== undefined) return cachedPath;
  try {
    // variable-specifier createRequire so bundlers never inline the binary
    // (the undici devDependency precedent in providers/openai.ts).
    const specifier = "ffmpeg-static";
    const req = createRequire(import.meta.url);
    const resolved = req(specifier) as string | null;
    cachedPath = typeof resolved === "string" && resolved.length > 0 ? resolved : null;
  } catch {
    cachedPath = null;
  }
  return cachedPath;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

/** Run one ffmpeg invocation to completion. Rejects with FfmpegError carrying
 *  the stderr tail (ffmpeg's diagnostics live there). */
export function runFfmpeg(
  args: string[],
  opts: { timeoutMs?: number; binaryPath?: string } = {}
): Promise<void> {
  const bin = opts.binaryPath ?? ffmpegBinaryPath();
  if (!bin) {
    return Promise.reject(
      new FfmpegError(
        "ffmpeg binary unavailable — run `npm install` (ffmpeg-static provides it; see docs/clips.md § render infrastructure)",
        null,
        ""
      )
    );
  }
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new FfmpegError(`ffmpeg timed out after ${timeoutMs}ms`, null, stderr));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new FfmpegError(`ffmpeg spawn failed: ${err.message}`, null, stderr));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new FfmpegError(`ffmpeg exited ${code}`, code, stderr));
    });
  });
}
