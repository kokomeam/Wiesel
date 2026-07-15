/**
 * A draw-loop ticker that keeps firing while the tab is HIDDEN.
 *
 * Why this exists (found on a real frozen lesson recording, 2026-07-15):
 * screen+camera recording composites onto a canvas, and the draw loop was
 * `requestAnimationFrame`-driven — but rAF is fully suspended in a
 * backgrounded tab, and recording another window/app is EXACTLY when the
 * studio tab is backgrounded. The canvas stopped repainting after the first
 * frames, so `canvas.captureStream()` had nothing new to capture and
 * MediaRecorder encoded one frozen frame with live audio for the whole
 * take (byte-identical Mux thumbnails from t=5s to t=370s).
 *
 * Main-thread timers are no fix either: hidden tabs clamp them to ≥1 Hz.
 * DEDICATED WORKER timers are exempt from visibility throttling, so the
 * ticker runs `setInterval` inside a tiny inline worker and forwards each
 * tick to the main thread (message handling isn't throttled). If the
 * worker can't be built (CSP, exotic browser), it falls back to rAF —
 * degraded (the pre-fix behavior) but never worse.
 */

export interface WorkerLike {
  onmessage: ((ev: unknown) => void) | null;
  terminate(): void;
}

export interface TickerDeps {
  /** Build the interval worker; return null to force the rAF fallback. */
  workerFactory?: (intervalMs: number) => WorkerLike | null;
  raf?: (cb: () => void) => number;
  caf?: (id: number) => void;
}

export interface TickerHandle {
  stop(): void;
  /** Which mechanism is driving ticks — the tests and logs read this. */
  readonly mechanism: "worker" | "raf";
}

/** The default factory: an inline Blob worker that posts on an interval. */
export function defaultTickerWorkerFactory(intervalMs: number): WorkerLike | null {
  try {
    if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
      return null;
    }
    const src = `setInterval(function(){postMessage(0)},${Math.max(1, Math.round(intervalMs))});`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const worker = new Worker(url);
    // The worker holds its own reference to the script; the URL can go.
    URL.revokeObjectURL(url);
    return worker as unknown as WorkerLike;
  } catch {
    return null;
  }
}

export function createBackgroundTicker(
  fps: number,
  onTick: () => void,
  deps: TickerDeps = {}
): TickerHandle {
  const intervalMs = 1000 / Math.max(1, fps);
  const factory = deps.workerFactory ?? defaultTickerWorkerFactory;
  const worker = factory(intervalMs);

  if (worker) {
    let stopped = false;
    worker.onmessage = () => {
      if (!stopped) onTick();
    };
    return {
      mechanism: "worker",
      stop() {
        stopped = true;
        worker.onmessage = null;
        worker.terminate();
      },
    };
  }

  // Fallback: rAF (suspends when hidden — the degraded pre-fix behavior).
  const raf = deps.raf ?? ((cb: () => void) => requestAnimationFrame(cb));
  const caf = deps.caf ?? ((id: number) => cancelAnimationFrame(id));
  let stopped = false;
  let rafId: number | null = null;
  const loop = () => {
    if (stopped) return;
    onTick();
    rafId = raf(loop);
  };
  rafId = raf(loop);
  return {
    mechanism: "raf",
    stop() {
      stopped = true;
      if (rafId != null) caf(rafId);
    },
  };
}
