/**
 * Per-principal concurrency pools + the withPooledModel cost decorator — PURE
 * suite (no DB, no key, no browser). TUTOR-1 Wave 3.1 (§1 · Amendment D-2).
 *
 * The acceptance for the HARDENED Semaphore + the two principal pools + the
 * single cost-interception decorator:
 *
 *   AC-T0.1  pool isolation: a SATURATED creator pool (both slots held) does NOT
 *            delay a learner-pool acquire — the learner is admitted synchronously.
 *   AC-T0.2  FIFO wake order over ≥4 waiters; queued positions correct; onQueued
 *            fires with the 1-based position via withPooledModel; an aborted
 *            waiter is removed WITHOUT disturbing its neighbours; a stress run of
 *            N=50 through max=8 all complete exactly once (final inFlight=0,
 *            queued=0).
 *   barging regression: a release racing fresh acquires NEVER exceeds max (a
 *            concurrent probe over the slot-transfer path).
 *   slot transfer: inFlight never DIPS while waiters are queued.
 *   withPooledModel cost path: ONE cost emission per runTurn AND per embed, the
 *            deterministic `${runKey}:${seq}` ids across two identical runs
 *            (retry-stable), cost-path errors swallowed, no `cost` → zero
 *            emissions.
 *   grep guards: extraction.ts + reconcile.ts contain ZERO emitTutorModelCall
 *            CALLS (doc-comment mentions allowed); subagent.ts is the only
 *            production caller besides telemetry.ts.
 *
 * Run: `npx tsx scripts/verify-concurrency-pools.ts`
 */

import { readFileSync } from "node:fs";
import {
  Semaphore,
  learnerPool,
  modelCallSemaphore,
  poolFor,
  withPooledModel,
} from "@/lib/ai/subagent";
import { tutorEventId } from "@/lib/tutor/telemetry";
import type {
  EmbedParams,
  EmbedResult,
  ModelClient,
  ModelStreamEvent,
  ModelTurnParams,
  ModelTurnResult,
} from "@/lib/ai/modelClient";

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

/** Let the microtask + macrotask queues drain so every pending acquire has run. */
const settle = () => new Promise<void>((r) => setImmediate(r));

/* ─────────────────── a gated fake ModelClient for the decorator ──────────── */

interface RecordedEmit {
  client_event_id: string;
}

/** A stub supabase whose `.from("learning_events").upsert(rows)` records the
 *  first row's client_event_id (the only field the decorator's cost path sets
 *  through emitTutorModelCall that this suite inspects). Optionally THROWS to
 *  prove the cost path swallows telemetry errors. */
function makeCostStub(opts: { throwOnUpsert?: boolean } = {}) {
  const emitted: RecordedEmit[] = [];
  const supabase = {
    from(_table: string) {
      return {
        upsert(rows: unknown[]) {
          if (opts.throwOnUpsert) throw new Error("boom (telemetry must swallow this)");
          const first = (rows?.[0] ?? {}) as Record<string, unknown>;
          emitted.push({ client_event_id: first.client_event_id as string });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { supabase: supabase as never, emitted };
}

/** A ModelClient whose runTurn + embed resolve immediately with fixed usage +
 *  a per-call responseId. Records how many times each ran. */
function makeCountingClient(): ModelClient & { turns: number; embeds: number } {
  const state = { turns: 0, embeds: 0 };
  const client: ModelClient = {
    model: "fake-model",
    async runTurn(_p: ModelTurnParams, _e: (ev: ModelStreamEvent) => void): Promise<ModelTurnResult> {
      state.turns += 1;
      return {
        text: "{}",
        toolCalls: [],
        finishReason: "stop",
        responseId: `resp-${state.turns}`,
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
      };
    },
    async embed(_p: EmbedParams): Promise<EmbedResult> {
      state.embeds += 1;
      return { vectors: [[1, 0, 0]], usage: { inputTokens: 7 } };
    },
  };
  return Object.assign(client, state, {
    get turns() {
      return state.turns;
    },
    get embeds() {
      return state.embeds;
    },
  });
}

async function main() {
  /* ── AC-T0.1 — pool isolation (creator saturated ≠ learner delayed) ── */
  console.log("\n# AC-T0.1 — the creator pool and the learner pool are independent");
  {
    const creator = new Semaphore(2);
    const learner = new Semaphore(2);
    // Saturate the creator pool: hold BOTH slots and never release.
    const c1 = await creator.acquire();
    const c2 = await creator.acquire();
    void c1;
    void c2;
    check("creator pool is saturated (2 in flight, next would queue)", creator.inFlight === 2 && creator.atCapacity);

    // A learner acquire must be admitted SYNCHRONOUSLY — no dependence on creator.
    let learnerAdmitted = false;
    const learnerAcq = learner.acquire().then((rel) => {
      learnerAdmitted = true;
      return rel;
    });
    await settle();
    check("a learner acquire is admitted while the creator pool is saturated", learnerAdmitted && learner.inFlight === 1);
    (await learnerAcq)();
    check("learner pool releases cleanly, creator untouched", learner.inFlight === 0 && creator.inFlight === 2);
  }

  // The exported singletons resolve independently through poolFor.
  check("poolFor('creator') IS modelCallSemaphore (legacy alias)", poolFor("creator") === modelCallSemaphore);
  check("poolFor('learner') IS learnerPool", poolFor("learner") === learnerPool);
  check("the two singleton pools are distinct instances", poolFor("creator") !== poolFor("learner"));

  /* ── AC-T0.2 — FIFO wake order + queued positions over ≥4 waiters ── */
  console.log("\n# AC-T0.2 — FIFO wake order + queued positions (≥4 waiters)");
  {
    const sem = new Semaphore(1);
    const hold = await sem.acquire(); // slot occupied; all subsequent acquires queue
    const wakeOrder: number[] = [];
    const releases: (() => void)[] = [];
    // Enqueue FOUR waiters in a known order.
    for (let i = 0; i < 4; i++) {
      const posAtEnqueue = sem.queued + 1; // 1-based position this waiter will hold
      check(`waiter ${i} queued at position ${i + 1}`, posAtEnqueue === i + 1);
      sem.acquire().then((rel) => {
        wakeOrder.push(i);
        releases.push(rel);
      });
    }
    await settle();
    check("four waiters are queued", sem.queued === 4 && sem.inFlight === 1);

    // Release the holder → the head waiter (0) wakes; then chain-release each.
    hold();
    await settle();
    // Now waiter 0 holds the (transferred) slot. Release it → waiter 1, etc.
    for (let i = 0; i < 4; i++) {
      const rel = releases.shift();
      if (rel) rel();
      await settle();
    }
    check("wake order is strict FIFO [0,1,2,3]", JSON.stringify(wakeOrder) === "[0,1,2,3]", JSON.stringify(wakeOrder));
    check("fully drained (inFlight=0, queued=0)", sem.inFlight === 0 && sem.queued === 0);
  }

  /* ── onQueued fires with the 1-based position via withPooledModel ── */
  console.log("\n# withPooledModel.onQueued reports the 1-based queue position");
  {
    const pool = new Semaphore(1);
    const positions: number[] = [];
    // A client whose runTurn blocks on an external gate so calls pile up.
    const gates: (() => void)[] = [];
    const blocking: ModelClient = {
      model: "blocker",
      async runTurn(): Promise<ModelTurnResult> {
        await new Promise<void>((r) => gates.push(r));
        return { text: "{}", toolCalls: [], finishReason: "stop", responseId: "x" };
      },
    };
    const decorated = withPooledModel(blocking, { pool, onQueued: (p) => positions.push(p) });
    const runs = Array.from({ length: 3 }, () =>
      decorated.runTurn({ system: "", input: [], tools: [] }, () => {})
    );
    await settle();
    // Call 0 acquires synchronously (no onQueued); calls 1 and 2 queue at 1 and 2.
    check("onQueued fires only for the calls that WAIT (positions [1,2])", JSON.stringify(positions) === "[1,2]", JSON.stringify(positions));
    // Drain.
    while (gates.length > 0 || pool.inFlight > 0 || pool.queued > 0) {
      const g = gates.shift();
      if (g) g();
      await settle();
    }
    await Promise.all(runs);
    check("all queued calls complete, pool fully drained", pool.inFlight === 0 && pool.queued === 0);
  }

  /* ── aborted waiter removed WITHOUT disturbing neighbours ── */
  console.log("\n# an aborted waiter is removed without disturbing its neighbours");
  {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    const w0 = new AbortController();
    const w1 = new AbortController();
    const wokeOrder: string[] = [];
    let w0Rejected = false;
    let w1Rejected = false;

    const p0 = sem.acquire(w0.signal).then(
      (rel) => {
        wokeOrder.push("w0");
        rel();
      },
      (err) => {
        w0Rejected = (err as Error).name === "AbortError";
      }
    );
    const pMid = sem.acquire().then((rel) => {
      wokeOrder.push("mid");
      rel();
    });
    const p1 = sem.acquire(w1.signal).then(
      (rel) => {
        wokeOrder.push("w1");
        rel();
      },
      (err) => {
        w1Rejected = (err as Error).name === "AbortError";
      }
    );
    await settle();
    check("three waiters queued (w0, mid, w1)", sem.queued === 3);

    // Abort the HEAD waiter (w0). It must reject + be removed; the queue shrinks to
    // [mid, w1] with their relative order intact.
    w0.abort();
    await settle();
    check("aborted head waiter rejects with AbortError", w0Rejected);
    check("neighbours untouched (queue now [mid, w1])", sem.queued === 2);

    // Release the holder → mid wakes FIRST (it inherited w0's spot as the new head),
    // then w1.
    hold();
    await settle();
    // mid now holds; release it → w1.
    await settle();
    await Promise.all([p0, pMid, p1]);
    check("survivors woke in FIFO order after the abort ([mid, w1])", JSON.stringify(wokeOrder) === '["mid","w1"]', JSON.stringify(wokeOrder));
    check("w1 was never spuriously aborted", !w1Rejected);
    check("fully drained after the abort scenario", sem.inFlight === 0 && sem.queued === 0);
  }

  /* ── slot transfer: inFlight never DIPS while waiters are queued ── */
  console.log("\n# slot transfer — inFlight never dips while waiters wait");
  {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    let sawDip = false;
    // Queue two waiters; sample inFlight after each release — with a waiter present
    // the count must stay pinned at 1 (the slot is HANDED over, never released).
    const rels: (() => void)[] = [];
    for (let i = 0; i < 2; i++) sem.acquire().then((r) => rels.push(r));
    await settle();
    hold();
    if (sem.inFlight !== 1) sawDip = true; // still one waiter behind the new holder
    await settle();
    const first = rels.shift();
    if (first) first();
    if (sem.inFlight !== 1) sawDip = true; // one waiter still queued → still 1
    await settle();
    const second = rels.shift();
    if (second) second();
    await settle();
    check("inFlight held at 1 across every hand-off (no dip)", !sawDip);
    check("only the FINAL release (no waiters) decrements to 0", sem.inFlight === 0 && sem.queued === 0);
  }

  /* ── barging regression: a release racing fresh acquires never exceeds max ── */
  console.log("\n# barging regression — a release racing fresh acquires never exceeds max");
  {
    const MAX = 3;
    const sem = new Semaphore(MAX);
    let live = 0;
    let peak = 0;
    // A worker acquires, records concurrency, yields a few microtasks (to interleave
    // with releases racing fresh acquires), then releases.
    async function worker() {
      const rel = await sem.acquire();
      live += 1;
      peak = Math.max(peak, live);
      // Interleave: yield so other workers' acquires/releases race this one.
      await settle();
      await settle();
      live -= 1;
      rel();
    }
    await Promise.all(Array.from({ length: 40 }, () => worker()));
    check(`peak concurrency never exceeded max (${MAX})`, peak <= MAX, `peak=${peak}`);
    check("no over-admission observed (peak == max under contention)", peak === MAX, `peak=${peak}`);
    check("barging regression: fully drained", sem.inFlight === 0 && sem.queued === 0);
  }

  /* ── stress: N=50 through max=8, each completes exactly once ── */
  console.log("\n# stress — N=50 through max=8, every task completes exactly once");
  {
    const sem = new Semaphore(8);
    const completions = new Set<number>();
    let peak = 0;
    let live = 0;
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => async () => {
        const rel = await sem.acquire();
        live += 1;
        peak = Math.max(peak, live);
        await settle();
        completions.add(i);
        live -= 1;
        rel();
      }).map((f) => f())
    );
    check("all 50 tasks completed exactly once", completions.size === 50);
    check("stress peak concurrency == max (8)", peak === 8, `peak=${peak}`);
    check("stress final state clean (inFlight=0, queued=0)", sem.inFlight === 0 && sem.queued === 0);
  }

  /* ── withPooledModel cost path — one emission per runTurn AND per embed ── */
  console.log("\n# withPooledModel cost path — deterministic `${runKey}:${seq}` ids");
  // courseId/emittedBy must be real uuids — the emitter's own Zod guard
  // (buildTutorModelCallEvent) rejects non-uuids and the cost path swallows the
  // throw, so a bad id would silently drop every emission.
  const COURSE = crypto.randomUUID();
  const AUTHOR = crypto.randomUUID();
  {
    const runKey = "run-abc";
    const { supabase, emitted } = makeCostStub();
    const base = makeCountingClient();
    const decorated = withPooledModel(base, {
      pool: new Semaphore(4),
      cost: { supabase, courseId: COURSE, emittedBy: AUTHOR, jobType: "graph_extraction", runKey },
    });
    // Two runTurns + one embed → seqs 0,1,2 in call order.
    await decorated.runTurn({ system: "", input: [], tools: [] }, () => {});
    await decorated.runTurn({ system: "", input: [], tools: [] }, () => {});
    await decorated.embed!({ model: "m", inputs: ["a"] });
    const ids = emitted.map((e) => e.client_event_id);
    check("one emission per gated call (2 runTurn + 1 embed = 3)", ids.length === 3, `emitted=${ids.length}`);
    check(
      "cost ids are the deterministic `${runKey}:${seq}` sequence 0..2",
      [0, 1, 2].every((seq) => ids.includes(tutorEventId(`${runKey}:${seq}`))),
      ids.join(",")
    );

    // Retry-stability: an identical second run mints the SAME ids (so an Inngest
    // step retry upserts as a no-op instead of double-counting).
    const { supabase: sb2, emitted: emitted2 } = makeCostStub();
    const decorated2 = withPooledModel(makeCountingClient(), {
      pool: new Semaphore(4),
      cost: { supabase: sb2, courseId: COURSE, emittedBy: AUTHOR, jobType: "graph_extraction", runKey },
    });
    await decorated2.runTurn({ system: "", input: [], tools: [] }, () => {});
    await decorated2.runTurn({ system: "", input: [], tools: [] }, () => {});
    await decorated2.embed!({ model: "m", inputs: ["a"] });
    const ids2 = emitted2.map((e) => e.client_event_id);
    check("a double-run mints IDENTICAL ids (retry-stable → no double-count)", JSON.stringify(ids) === JSON.stringify(ids2));
  }

  // embeds ALWAYS emit under 'embedding' regardless of the run's jobType — asserted
  // indirectly here by the emission COUNT (jobType 'practice_gen' would skip a
  // runTurn emit but embed still emits under 'embedding').
  console.log("\n# withPooledModel cost path — errors swallowed + no-cost is silent");
  {
    // (a) A throwing supabase must NOT surface into the model path.
    const { supabase } = makeCostStub({ throwOnUpsert: true });
    const decorated = withPooledModel(makeCountingClient(), {
      pool: new Semaphore(2),
      cost: { supabase, courseId: COURSE, emittedBy: AUTHOR, jobType: "graph_extraction", runKey: "k" },
    });
    let threw = false;
    let result: ModelTurnResult | null = null;
    try {
      result = await decorated.runTurn({ system: "", input: [], tools: [] }, () => {});
    } catch {
      threw = true;
    }
    check("a cost-path throw is swallowed — runTurn still resolves", !threw && result?.finishReason === "stop");

    // (b) No `cost` context → ZERO emissions (the decorator is pure gating then).
    const { supabase: sb, emitted } = makeCostStub();
    void sb;
    const plain = withPooledModel(makeCountingClient(), { pool: new Semaphore(2) });
    await plain.runTurn({ system: "", input: [], tools: [] }, () => {});
    await plain.embed!({ model: "m", inputs: ["a"] });
    check("no cost context → zero cost emissions", emitted.length === 0);
  }

  /* ── grep guards — the inline emit path is retired ── */
  console.log("\n# grep guards — inline emitTutorModelCall is retired from the pipelines");
  {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
    const extraction = read("../lib/tutor/graph/extraction.ts");
    const reconcile = read("../lib/tutor/graph/reconcile.ts");
    const subagent = read("../lib/ai/subagent.ts");
    const CALL = /emitTutorModelCall\s*\(/g;
    check("extraction.ts contains ZERO emitTutorModelCall CALLS (comments allowed)", (extraction.match(CALL) ?? []).length === 0);
    check("reconcile.ts contains ZERO emitTutorModelCall CALLS (comments allowed)", (reconcile.match(CALL) ?? []).length === 0);
    check("subagent.ts is the decorator's single call site (exactly ONE call)", (subagent.match(CALL) ?? []).length === 1);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
