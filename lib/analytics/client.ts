/**
 * Framework-agnostic analytics batching queue (Milestone 3). Everything
 * side-effectful is INJECTED (fetch, timers) so verify-analytics.ts drives it
 * headless; components/learn/AnalyticsProvider.tsx owns the real DOM wiring
 * (10s interval, visibilitychange→hidden flush, pagehide flush, heartbeat).
 *
 * Delivery model: at-least-once. A batch that fails (network, 5xx) is
 * re-queued and retried with exponential backoff; the ingest endpoint dedupes
 * by clientEventId (`on conflict do nothing`), so a false-negative re-send is
 * harmless. `keepalive: true` on every POST lets the final unload flush
 * survive the page teardown.
 */

import { MAX_BATCH_EVENTS, type AnalyticsEvent } from "./events";

export interface AnalyticsQueueOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  setTimeoutImpl?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutImpl?: (id: ReturnType<typeof setTimeout>) => void;
  /** Deterministic-jitter hook for tests. */
  randomImpl?: () => number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Oldest events beyond this are dropped (an offline tab can't grow forever). */
  maxQueued?: number;
}

export interface AnalyticsQueue {
  enqueue(event: AnalyticsEvent): void;
  /** Drain the queue now (chunked ≤ MAX_BATCH_EVENTS per POST). */
  flush(reason?: string): Promise<void>;
  pendingCount(): number;
  /** Cancel any scheduled retry (provider cleanup). */
  dispose(): void;
}

const DEFAULT_ENDPOINT = "/api/analytics/ingest";

export function createAnalyticsQueue(options: AnalyticsQueueOptions = {}): AnalyticsQueue {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  const randomImpl = options.randomImpl ?? Math.random;
  const backoffBaseMs = options.backoffBaseMs ?? 1_000;
  const backoffMaxMs = options.backoffMaxMs ?? 30_000;
  const maxQueued = options.maxQueued ?? 500;

  let queue: AnalyticsEvent[] = [];
  let inFlight = false;
  let consecutiveFailures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function scheduleRetry(): void {
    if (retryTimer !== null || disposed) return;
    const backoff = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (consecutiveFailures - 1));
    const jitter = 1 + 0.2 * randomImpl();
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      void flush("retry");
    }, Math.round(backoff * jitter));
  }

  async function flush(reason = "manual"): Promise<void> {
    void reason;
    if (inFlight || queue.length === 0 || disposed) return;
    inFlight = true;
    try {
      while (queue.length > 0) {
        const batch = queue.slice(0, MAX_BATCH_EVENTS);
        let ok = false;
        try {
          const res = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ events: batch }),
            // Survives page unload — this IS the flush-on-unload mechanism.
            keepalive: true,
          });
          // 4xx = the batch itself is bad (or we lost auth) — dropping beats
          // an infinite retry of a poisoned batch. 5xx/network = retry.
          if (res.ok || (res.status >= 400 && res.status < 500)) ok = true;
          if (!res.ok && res.status >= 400 && res.status < 500) {
            console.warn(`[analytics] batch rejected (${res.status}) — dropped`);
          }
        } catch {
          ok = false;
        }
        if (!ok) {
          consecutiveFailures += 1;
          scheduleRetry();
          return; // batch stays at the queue head for the retry
        }
        queue = queue.slice(batch.length);
        consecutiveFailures = 0;
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    enqueue(event: AnalyticsEvent): void {
      if (disposed) return;
      queue.push(event);
      if (queue.length > maxQueued) queue = queue.slice(queue.length - maxQueued);
    },
    flush,
    pendingCount: () => queue.length,
    dispose(): void {
      disposed = true;
      if (retryTimer !== null) {
        clearTimeoutImpl(retryTimer);
        retryTimer = null;
      }
    },
  };
}
