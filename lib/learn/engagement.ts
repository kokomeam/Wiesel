/**
 * TUTOR-1 Wave 4 — the PURE video-engagement tracker (Contract 2). Fed the
 * learner's window-relative position (0–100) at each progress tick, it emits at
 * most one behavioral signal per tick: 'scrub_back' when they jump backward,
 * then 'rewatch' when they re-cross ground they'd already seen. The tracker is
 * deterministic and clock-free — LearnVideo feeds it; it never touches the DOM.
 *
 * ─────────────────────────── Episode semantics ──────────────────────────────
 * The tracker keeps two internal marks:
 *   • `last`      — the position of the previous feed (advances or retreats).
 *   • `highWater` — the furthest position ever reached this session (monotone
 *                   non-decreasing; a backward seek NEVER lowers it).
 *
 * A "back-seek EPISODE" begins the first tick where the position drops MORE
 * THAN 5 points below `last`. That tick returns 'scrub_back' exactly once.
 * While the episode is open:
 *   • a CONTINUING drop (another decrease) returns null — 'scrub_back' does not
 *     re-fire until forward motion resumes (a single drag scrubs through many
 *     ticks; that is one episode, one signal).
 *   • the FIRST advancing tick (position increases vs the previous tick) that
 *     is still over ALREADY-SEEN ground (position ≤ the highWater captured when
 *     the episode opened) returns 'rewatch' exactly once, and CLOSES the
 *     episode. Advancing onto FRESH ground (position > that highWater) closes
 *     the episode with null (they seeked back then jumped past where they were).
 *
 * Outside an episode, plain forward progress and small jitter (≤5-point dips)
 * return null. Multiple independent back-seeks each produce their own
 * scrub_back → rewatch pair.
 *
 * 'completed' is NOT produced here — it rides LearnVideo's existing
 * crossedComplete branch (the tracker has no notion of the clip's end).
 */

export type EngagementSignal = "scrub_back" | "rewatch";

/** The drop, in percentage points below the previous position, that counts as a
 *  deliberate backward seek (smaller dips are jitter). */
export const SCRUB_BACK_THRESHOLD = 5;

export interface EngagementTracker {
  /** Feed the current window-relative position (0–100). Returns the signal for
   *  this tick, or null. */
  feed(pct: number): EngagementSignal | null;
}

export function createEngagementTracker(): EngagementTracker {
  let last: number | null = null;
  let highWater = 0;
  // When an episode is open, the highWater AT THE MOMENT it opened — 'rewatch'
  // fires when the learner advances back up to (but not past) this mark.
  let episodeHighWater: number | null = null;

  return {
    feed(pct: number): EngagementSignal | null {
      // First tick: seed the marks, emit nothing.
      if (last === null) {
        last = pct;
        highWater = pct;
        return null;
      }

      const prev = last;
      last = pct;

      // A deliberate backward seek: >5 points below the previous position.
      if (pct < prev - SCRUB_BACK_THRESHOLD) {
        if (episodeHighWater === null) {
          // Open a new episode → fire scrub_back once.
          episodeHighWater = highWater;
          return "scrub_back";
        }
        // Already inside an episode; a continuing drop does not re-fire.
        return null;
      }

      // Advancing (or holding) motion.
      if (episodeHighWater !== null && pct > prev) {
        const seenCeiling = episodeHighWater;
        if (pct <= seenCeiling) {
          // Re-crossing already-seen ground → rewatch once, close the episode.
          episodeHighWater = null;
          return "rewatch";
        }
        // Advanced past where they'd been → close the episode silently, and
        // let the fresh-ground high-water update below.
        episodeHighWater = null;
      }

      if (pct > highWater) highWater = pct;
      return null;
    },
  };
}
