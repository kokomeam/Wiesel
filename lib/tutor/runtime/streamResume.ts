/**
 * TUTOR-1 Amendment A2 Wave 2 — the RESUME tail-follow loop.
 *
 * The GET handler of `/api/learn/tutor` replays a mid-turn stream to a
 * reconnecting client: it reads the buffered frames from an index, forwards them
 * VERBATIM (they are already SSE-encoded bytes), then polls the buffer for the
 * live tail until the stream is finalized or a deadline elapses. That polling loop
 * is EXTRACTED here so it is unit-testable against the in-memory buffer — the route
 * GET is thin glue over `followStream`.
 *
 * REPLAY IS GAP/DUP-FREE BY CONSTRUCTION: `read(from)` returns the frames at index
 * ≥ from and the next index to read from; the loop always resumes from the exact
 * `nextIndex` the previous read reported, so no frame is skipped or repeated.
 */

import type { TutorStreamBuffer } from "./streamBuffer";

export interface FollowStreamOptions {
  /** The frame index to start replaying from (0 = the whole buffer). */
  from: number;
  /** Poll interval (ms) between reads once the initial replay is drained. */
  pollMs: number;
  /** Hard ceiling (ms) — stop following at this wall-clock budget even if the
   *  stream never finalizes (mirrors the route's totalMs). */
  deadlineMs: number;
  /** Called with each frame (a raw SSE string) as it becomes available, in order. */
  onFrame: (frame: string) => void | Promise<void>;
  /** Injectable clock (ms). Defaults to Date.now — tests pass a fake. */
  now?: () => number;
  /** Injectable sleep. Defaults to a real setTimeout — tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

/** Why the follow loop stopped: the stream finalized, or the deadline elapsed. */
export type FollowStreamOutcome = "finalized" | "deadline";

/**
 * Replay buffered frames from `from`, then poll for the live tail until the stream
 * finalizes or the deadline elapses. Returns which happened. Never throws on an
 * `onFrame` callback error the caller wants surfaced — it awaits it, so a throwing
 * sink WILL propagate (the caller decides); a buffer read error propagates too
 * (the route wraps the whole GET in try/catch). Deterministic under injected
 * clock+sleep.
 */
export async function followStream(
  buffer: TutorStreamBuffer,
  streamId: string,
  opts: FollowStreamOptions
): Promise<FollowStreamOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();

  let cursor = Math.max(0, opts.from);

  // Initial replay: drain everything already buffered from `cursor`.
  const first = await buffer.read(streamId, cursor);
  for (const frame of first.frames) {
    await opts.onFrame(frame);
  }
  cursor = first.nextIndex;
  if (first.finalized) return "finalized";

  // Live tail: poll until finalized or the deadline.
  while (now() - start < opts.deadlineMs) {
    await sleep(opts.pollMs);
    const next = await buffer.read(streamId, cursor);
    for (const frame of next.frames) {
      await opts.onFrame(frame);
    }
    cursor = next.nextIndex;
    if (next.finalized) return "finalized";
  }
  return "deadline";
}
