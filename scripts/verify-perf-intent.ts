/**
 * PERF-1 B4 intent-prefetch PURE test suite — no key, no DB, no browser.
 * Run: `npx tsx scripts/verify-perf-intent.ts`
 *
 * Covers lib/perf/intentPrefetch.ts (the shared limiter behind IntentLink):
 *  - hover debounce (fires after delayMs; hoverEnd before the delay cancels;
 *    re-hover after a cancel schedules again; no double-schedule while pending)
 *  - touchOrFocus = immediate (and swallows a pending hover for the same href)
 *  - per-href TTL dedupe (one prefetch per ttlMs, stamped at ADMISSION — a
 *    failed prefetch does not retry until the TTL lapses)
 *  - concurrency cap + FIFO queue drain (resolve, reject, and sync throw all
 *    free the slot)
 *  - href independence (timers, TTL stamps, and cancellation are per-href)
 */

import { createIntentPrefetcher } from "@/lib/perf/intentPrefetch";

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

/* ────────────────────────────── Harness ─────────────────────────────────── */

/** Deterministic clock + timer wheel (the injectable schedule/cancel/now). */
class FakeTimers {
  now = 0;
  lastDelayMs: number | null = null;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  schedule = (fn: () => void, ms: number): unknown => {
    this.lastDelayMs = ms;
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  cancel = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  clock = (): number => this.now;

  /** Advance the clock, firing due timers in time order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Infinity;
      for (const [id, t] of this.timers) {
        if (t.at <= target && t.at < dueAt) {
          dueAt = t.at;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const timer = this.timers.get(dueId)!;
      this.timers.delete(dueId);
      this.now = timer.at;
      timer.fn();
    }
    this.now = target;
  }
}

/** Externally-settled promise, for holding prefetches in flight. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the drain's promise-settlement microtasks run (real macrotask hop). */
const flush = () => new Promise<void>((res) => setTimeout(res, 0));

function makeHarness(opts?: {
  delayMs?: number;
  maxConcurrent?: number;
  ttlMs?: number;
  prefetch?: (href: string) => void | Promise<void>;
}) {
  const timers = new FakeTimers();
  const calls: string[] = [];
  const prefetcher = createIntentPrefetcher({
    prefetch:
      opts?.prefetch ??
      ((href) => {
        calls.push(href);
      }),
    now: timers.clock,
    delayMs: opts?.delayMs,
    maxConcurrent: opts?.maxConcurrent,
    ttlMs: opts?.ttlMs,
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  return { timers, calls, prefetcher };
}

async function main() {
  /* ─────────────────────────── Hover debounce ─────────────────────────── */

  console.log("\nHover debounce");
  {
    const { timers, calls, prefetcher } = makeHarness();
    prefetcher.hoverStart("/a");
    check("default hover delay is 80ms", timers.lastDelayMs === 80);
    timers.advance(79);
    check("no prefetch before the delay elapses", calls.length === 0);
    timers.advance(1);
    check("debounce fires after the delay", calls.length === 1 && calls[0] === "/a");
  }
  {
    const { timers, calls, prefetcher } = makeHarness();
    prefetcher.hoverStart("/a");
    timers.advance(40);
    prefetcher.hoverEnd("/a");
    timers.advance(500);
    check("hoverEnd before the delay cancels the prefetch", calls.length === 0);
    prefetcher.hoverStart("/a");
    timers.advance(80);
    check("re-hover after a cancel schedules again", calls.length === 1 && calls[0] === "/a");
  }
  {
    const { timers, calls, prefetcher } = makeHarness();
    prefetcher.hoverStart("/a");
    timers.advance(40);
    prefetcher.hoverStart("/a"); // jitter re-enter while a schedule is pending
    timers.advance(40);
    check("hoverStart while pending doesn't double-schedule", calls.length === 1);
    timers.advance(200);
    check("…and no second timer fires later", calls.length === 1);
  }
  {
    const { calls, prefetcher } = makeHarness();
    prefetcher.hoverEnd("/never-hovered");
    check("hoverEnd on an unknown href is a no-op", calls.length === 0);
  }

  /* ─────────────────────────── touchOrFocus ───────────────────────────── */

  console.log("\ntouchOrFocus");
  {
    const { timers, calls, prefetcher } = makeHarness();
    prefetcher.touchOrFocus("/a");
    check("touchOrFocus prefetches immediately (no delay)", calls.length === 1 && calls[0] === "/a");
    timers.advance(1000);
    check("…and leaves no timer behind", calls.length === 1);
  }
  {
    const { timers, calls, prefetcher } = makeHarness();
    prefetcher.hoverStart("/a");
    timers.advance(40);
    prefetcher.touchOrFocus("/a"); // focus arrives mid-debounce
    check("touchOrFocus mid-debounce fires once, immediately", calls.length === 1);
    timers.advance(200);
    check("…and the pending hover timer was swallowed (no duplicate)", calls.length === 1);
  }

  /* ─────────────────────────── TTL dedupe ─────────────────────────────── */

  console.log("\nTTL dedupe");
  {
    const { timers, calls, prefetcher } = makeHarness({ ttlMs: 30_000 });
    prefetcher.touchOrFocus("/a");
    timers.advance(10_000);
    prefetcher.hoverStart("/a");
    timers.advance(80);
    prefetcher.touchOrFocus("/a");
    check("same href within the TTL = one prefetch", calls.length === 1);
    timers.advance(20_000); // 30_080 since the stamp — TTL lapsed
    prefetcher.hoverStart("/a");
    timers.advance(80);
    check("after the TTL lapses the href prefetches again", calls.length === 2);
  }
  {
    // Stamp at ADMISSION: a rejected prefetch must NOT retry until the TTL
    // lapses (router.prefetch is best-effort; viewport prefetch is the net).
    const held = deferred();
    const attempts: string[] = [];
    const { timers, prefetcher } = makeHarness({
      ttlMs: 1_000,
      prefetch: (href) => {
        attempts.push(href);
        return held.promise;
      },
    });
    prefetcher.touchOrFocus("/a");
    held.reject(new Error("offline"));
    await flush();
    prefetcher.touchOrFocus("/a");
    check("failed prefetch does not retry within the TTL", attempts.length === 1);
    timers.advance(1_001);
    prefetcher.touchOrFocus("/a");
    check("failed prefetch is retried after the TTL", attempts.length === 2);
  }

  /* ─────────────────── Concurrency cap + queue drain ──────────────────── */

  console.log("\nConcurrency cap + queue drain");
  {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const { prefetcher } = makeHarness({
      maxConcurrent: 2,
      prefetch: (href) => {
        started.push(href);
        const gate = deferred();
        gates.set(href, gate);
        return gate.promise;
      },
    });
    prefetcher.touchOrFocus("/1");
    prefetcher.touchOrFocus("/2");
    prefetcher.touchOrFocus("/3");
    prefetcher.touchOrFocus("/4");
    check("at most maxConcurrent prefetches start", started.length === 2);
    check("…and they start in request order", started[0] === "/1" && started[1] === "/2");

    gates.get("/1")!.resolve();
    await flush();
    check("a resolve frees the slot → queue drains FIFO", started.length === 3 && started[2] === "/3");

    gates.get("/2")!.reject(new Error("boom"));
    await flush();
    check("a rejection also frees the slot (no stuck queue)", started.length === 4 && started[3] === "/4");

    gates.get("/3")!.resolve();
    gates.get("/4")!.resolve();
    await flush();
    prefetcher.touchOrFocus("/5");
    check("slots recover fully after the burst settles", started.length === 5 && started[4] === "/5");
  }
  {
    // A synchronously-throwing prefetch must free its slot too.
    let threw = false;
    const started: string[] = [];
    const { prefetcher } = makeHarness({
      maxConcurrent: 1,
      prefetch: (href) => {
        started.push(href);
        if (!threw) {
          threw = true;
          throw new Error("sync boom");
        }
      },
    });
    prefetcher.touchOrFocus("/1");
    prefetcher.touchOrFocus("/2");
    await flush();
    check("a sync throw frees the slot → next href still runs", started.length === 2 && started[1] === "/2");
  }
  {
    // While a prefetch is queued/in flight, new intent for the SAME href is
    // already covered by its admission stamp — no double-queue.
    const started: string[] = [];
    const gate = deferred();
    const { timers, prefetcher } = makeHarness({
      maxConcurrent: 1,
      prefetch: (href) => {
        started.push(href);
        return gate.promise;
      },
    });
    prefetcher.touchOrFocus("/a");
    prefetcher.hoverStart("/a");
    timers.advance(80);
    prefetcher.touchOrFocus("/a");
    gate.resolve();
    await flush();
    check("intent while in flight never double-queues the href", started.length === 1);
  }

  /* ─────────────────────── Per-href independence ──────────────────────── */

  console.log("\nPer-href independence");
  {
    const { timers, calls, prefetcher } = makeHarness();
    prefetcher.hoverStart("/a");
    prefetcher.hoverStart("/b");
    prefetcher.hoverEnd("/a");
    timers.advance(80);
    check(
      "hoverEnd cancels only its own href's pending timer",
      calls.length === 1 && calls[0] === "/b"
    );
  }
  {
    const { timers, calls, prefetcher } = makeHarness({ ttlMs: 30_000 });
    prefetcher.touchOrFocus("/a");
    prefetcher.hoverStart("/b");
    timers.advance(80);
    check("one href's TTL stamp doesn't dedupe another href", calls.length === 2 && calls.includes("/a") && calls.includes("/b"));
  }
  {
    // Independent hrefs each get their own debounce window (a sweep across a
    // card grid schedules per row; only dwelled-on rows fire).
    const { timers, calls, prefetcher } = makeHarness();
    prefetcher.hoverStart("/row-1");
    timers.advance(30);
    prefetcher.hoverEnd("/row-1");
    prefetcher.hoverStart("/row-2");
    timers.advance(30);
    prefetcher.hoverEnd("/row-2");
    prefetcher.hoverStart("/row-3");
    timers.advance(80); // dwell on row 3
    check("pointer sweep: only the dwelled-on row prefetches", calls.length === 1 && calls[0] === "/row-3");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
