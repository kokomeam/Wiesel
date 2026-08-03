/**
 * Intent-driven route prefetch coordinator (PERF-1 B4). PURE — no React, no
 * next/navigation, no window access at module scope; the clock, timers, and
 * the prefetch effect are all injectable so the semantics are unit-testable.
 *
 * Semantics:
 *   hoverStart(href)   — schedule a prefetch after `delayMs` (debounce: a
 *                        hoverEnd before the delay cancels it, so sweeping the
 *                        pointer across a list of links doesn't storm the
 *                        server with one prefetch per row).
 *   hoverEnd(href)     — cancel a still-pending hover schedule for that href.
 *   touchOrFocus(href) — prefetch immediately (touch has no hover phase and a
 *                        keyboard focus is deliberate intent).
 *
 * Each href is prefetched at most once per `ttlMs` — the stamp is taken when
 * the request is admitted (not when it settles) so a second hover while the
 * prefetch is queued/in-flight can't double-queue it, and a failed prefetch
 * deliberately does NOT retry until the TTL lapses (router.prefetch is
 * best-effort; Next's viewport prefetch remains the fallback). At most
 * `maxConcurrent` prefetches run at once; extras queue FIFO and drain as
 * in-flight ones settle (resolve, reject, or throw synchronously).
 */

export interface IntentPrefetcherOptions {
  /** The actual prefetch effect (e.g. router.prefetch). Sync or async. */
  prefetch: (href: string) => void | Promise<void>;
  /** Injectable clock in ms. Defaults to Date.now. */
  now?: () => number;
  /** Hover dwell before prefetching. */
  delayMs?: number;
  /** Max prefetches in flight at once; extras queue FIFO. */
  maxConcurrent?: number;
  /** An href is prefetched at most once per this window. */
  ttlMs?: number;
  /** Injectable timers for tests. Default: global setTimeout/clearTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface IntentPrefetcher {
  hoverStart(href: string): void;
  hoverEnd(href: string): void;
  touchOrFocus(href: string): void;
}

export function createIntentPrefetcher(options: IntentPrefetcherOptions): IntentPrefetcher {
  const {
    prefetch,
    now = () => Date.now(),
    delayMs = 80,
    maxConcurrent = 3,
    ttlMs = 30_000,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  /** href → pending hover timer handle. */
  const pendingHover = new Map<string, unknown>();
  /** href → clock stamp of the last admitted prefetch request. */
  const lastRequested = new Map<string, number>();
  const queue: string[] = [];
  let inFlight = 0;

  const fresh = (href: string): boolean => {
    const at = lastRequested.get(href);
    return at !== undefined && now() - at < ttlMs;
  };

  const drain = () => {
    while (inFlight < maxConcurrent && queue.length > 0) {
      const href = queue.shift()!;
      inFlight += 1;
      let settled = false;
      const release = () => {
        if (settled) return;
        settled = true;
        inFlight -= 1;
        drain();
      };
      try {
        Promise.resolve(prefetch(href)).then(release, release);
      } catch {
        // Synchronous throw from prefetch — still free the slot.
        release();
      }
    }
  };

  const request = (href: string) => {
    if (fresh(href)) return;
    lastRequested.set(href, now());
    queue.push(href);
    drain();
  };

  const hoverEnd = (href: string) => {
    if (!pendingHover.has(href)) return;
    const handle = pendingHover.get(href);
    pendingHover.delete(href);
    cancel(handle);
  };

  return {
    hoverStart(href: string) {
      if (pendingHover.has(href) || fresh(href)) return;
      const handle = schedule(() => {
        pendingHover.delete(href);
        request(href);
      }, delayMs);
      pendingHover.set(href, handle);
    },
    hoverEnd,
    touchOrFocus(href: string) {
      hoverEnd(href);
      request(href);
    },
  };
}
