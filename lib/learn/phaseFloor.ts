/**
 * TUTOR-1 Amendment A2-14 — the display-phase FLOOR.
 *
 * A tutor turn walks through phases (sent → thinking → composing) driven by REAL
 * wire frames. Some of those frames can arrive back-to-back in milliseconds (e.g.
 * model_started immediately followed by the first text_delta on a fast turn), so a
 * phase indicator could flash on-screen and vanish before the learner perceives
 * it. `createPhaseFloor` enforces a minimum on-screen dwell (`PHASE_FLOOR_MS`) for
 * whichever phase is showing: a proposal that lands within the floor of the last
 * APPLIED phase is HELD and flushed by one scheduled callback when the floor
 * expires (latest proposal wins), instead of applying instantly.
 *
 * ── THE SCHEDULER ONLY FLUSHES — IT NEVER INVENTS PROGRESS (A2-15's spirit) ────
 * Every phase this thing applies came from a REAL event the caller proposed; the
 * scheduled callback exists SOLELY to release a phase that was held back for the
 * floor. It never advances a phase on its own, never times anything out, and never
 * fabricates a phase the caller didn't propose. (The display component itself
 * carries no timers at all — this is the one place a timer touches phase display.)
 *
 * PURE + injectable: `now`/`schedule`/`cancel` default to performance.now +
 * setTimeout/clearTimeout, but a test drives it with a fake clock and no real
 * timers. ZOD-FREE (rides the learn route bundle): no imports at all.
 */

/** The minimum on-screen dwell, in ms, for a displayed phase before the next one
 *  may replace it. */
export const PHASE_FLOOR_MS = 400;

export interface PhaseFloorOptions {
  /** The floor duration in ms (default `PHASE_FLOOR_MS`). */
  floorMs?: number;
  /** Monotonic clock (default `performance.now`, falling back to `Date.now`). */
  now?: () => number;
  /** Schedule a one-shot flush (default `setTimeout`); returns an opaque handle. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Cancel a scheduled flush by its handle (default `clearTimeout`). */
  cancel?: (handle: unknown) => void;
}

export interface PhaseFloor<T> {
  /**
   * Propose a phase. The FIRST proposal applies immediately (stamping its
   * shown-at time). A later proposal within `floorMs` of the last APPLIED phase is
   * QUEUED (latest queued proposal wins) and flushed via ONE scheduled callback
   * when the floor expires; a proposal after the floor applies immediately.
   *
   * `apply` is invoked with the winning phase whenever a phase actually takes the
   * screen (immediately, or later from the flush).
   */
  propose(phase: T, apply: (phase: T) => void): void;
  /** Cancel any pending flush and forget the last-applied stamp (new send / unmount). */
  reset(): void;
}

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Build a phase floor. See {@link PhaseFloor} for the propose/reset contract.
 */
export function createPhaseFloor<T>(opts: PhaseFloorOptions = {}): PhaseFloor<T> {
  const floorMs = opts.floorMs ?? PHASE_FLOOR_MS;
  const now = opts.now ?? defaultNow;
  const schedule =
    opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // The timestamp the currently-shown phase was applied (null before the first).
  let appliedAt: number | null = null;
  // A phase held back for the floor + the apply it should flush through, and the
  // scheduled-flush handle. `pending` is null when nothing is queued.
  let pending: { phase: T; apply: (phase: T) => void } | null = null;
  let handle: unknown = null;

  function clearPending() {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
    pending = null;
  }

  function applyNow(phase: T, apply: (phase: T) => void) {
    appliedAt = now();
    apply(phase);
  }

  return {
    propose(phase, apply) {
      // First phase of this cycle: show it immediately.
      if (appliedAt === null) {
        applyNow(phase, apply);
        return;
      }
      const elapsed = now() - appliedAt;
      // Past the floor → apply immediately (and drop any stale queued proposal —
      // this newer one supersedes it).
      if (elapsed >= floorMs) {
        clearPending();
        applyNow(phase, apply);
        return;
      }
      // Within the floor → queue (latest proposal wins) and (re)arm ONE flush that
      // fires when the floor expires. We keep the ORIGINAL flush timing (measured
      // from the applied phase), so a burst of proposals still releases exactly
      // once, `floorMs` after the shown phase went up.
      const alreadyScheduled = handle !== null;
      pending = { phase, apply };
      if (!alreadyScheduled) {
        handle = schedule(() => {
          handle = null;
          const p = pending;
          pending = null;
          if (p) applyNow(p.phase, p.apply);
        }, floorMs - elapsed);
      }
    },
    reset() {
      clearPending();
      appliedAt = null;
    },
  };
}
