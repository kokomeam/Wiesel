/**
 * Timing presets (PRD §8) — pure, deterministic given (nowIso, rand).
 *
 * `plannedPostAt` is a PLANNING LABEL only: nothing fires from it in Phase 1
 * (no job, no timer, no notification). The Phase 3 scheduler will read the
 * same field. Suggested times are daytime slots in the creator's timezone
 * with ±20min jitter so followed plans don't look robotic.
 *
 * Timezone math is dependency-free: `zonedTimeToUtc` converts a wall-clock
 * time in an IANA zone to a UTC instant via Intl.DateTimeFormat, iterated so
 * it converges across DST transitions (verify-social.ts pins the DST edge).
 */

import type { TimingPreset } from "./constants";

export interface TimingInput {
  preset: TimingPreset;
  count: number;
  /** "now" — injected, never Date.now() inside (repo clock convention). */
  nowIso: string;
  /** IANA zone (e.g. "America/New_York"). Invalid/missing → UTC. */
  timeZone?: string;
  /** Injected randomness for jitter — deterministic in tests. */
  rand: () => number;
  /** Required (and validated upstream) for preset='custom'. */
  customTimes?: string[];
}

interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

function safeZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function wallPartsAt(utcMs: number, timeZone: string): WallParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24, // "24" at midnight in some ICU versions
    minute: Number(parts.minute),
  };
}

/** UTC instant whose wall clock in `timeZone` is the given parts. Iterated
 *  offset correction converges across DST (nonexistent local times land on
 *  the closest valid instant). */
export function zonedTimeToUtc(parts: WallParts, timeZone: string): number {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let ts = target;
  for (let i = 0; i < 3; i++) {
    const wall = wallPartsAt(ts, timeZone);
    const wallTs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    if (wallTs === target) break;
    ts += target - wallTs;
  }
  return ts;
}

/** Day-of-week (0=Sun..6=Sat) for a local calendar date — tz-independent. */
function weekdayOf(parts: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function addDays(parts: WallParts, days: number): WallParts {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

/** ±20min jitter, in whole minutes. */
function jitterMinutes(rand: () => number): number {
  return Math.round((rand() * 2 - 1) * 20);
}

/** A morning slot inside 9:00–11:00 local (leaving jitter room 9:20–10:40). */
function morningSlot(date: WallParts, timeZone: string, rand: () => number): number {
  const hour = 9 + Math.floor(rand() * 2); // 9 or 10
  const minute = 20 + Math.floor(rand() * 21); // :20–:40
  const base = zonedTimeToUtc({ ...date, hour, minute }, timeZone);
  return base + jitterMinutes(rand) * 60_000;
}

/**
 * Compute suggested plannedPostAt values (ISO strings, UTC) — or nulls for
 * preset 'none'. Times are ordered earliest→latest so the batch plan's
 * value-first ordering (tofu early, bofu last) maps 1:1 onto them.
 */
export function computePlannedTimes(input: TimingInput): (string | null)[] {
  const count = Math.max(1, Math.min(5, Math.floor(input.count)));
  const timeZone = safeZone(input.timeZone);
  const nowMs = Date.parse(input.nowIso);

  switch (input.preset) {
    case "none":
      return Array.from({ length: count }, () => null);

    case "custom": {
      const times = (input.customTimes ?? []).slice(0, count);
      return Array.from({ length: count }, (_, i) => times[i] ?? null);
    }

    case "same_day": {
      // Next full hour, then ~2h40m apart with ±20min jitter — spacing never
      // drops below 2h (PRD: "spaced ≥2h apart starting next full hour").
      const startHour = Math.ceil((nowMs + 60_000) / 3_600_000) * 3_600_000;
      return Array.from({ length: count }, (_, i) => {
        const base = startHour + i * (2 * 60 + 40) * 60_000;
        return new Date(base + jitterMinutes(input.rand) * 60_000).toISOString();
      });
    }

    case "spread_week": {
      // One weekday-ish morning slot per post across the next 7 days, never
      // two posts on the same day. Weekdays preferred; weekends only if the
      // window runs out of weekdays (it can't for count ≤ 5).
      const today = wallPartsAt(nowMs, timeZone);
      const days: WallParts[] = [];
      for (let offset = 1; days.length < count && offset <= 9; offset++) {
        const d = addDays(today, offset);
        const dow = weekdayOf(d);
        if (dow === 0 || dow === 6) continue;
        days.push(d);
      }
      // Fallback (only reachable for pathological counts): fill with weekends.
      for (let offset = 1; days.length < count; offset++) days.push(addDays(today, offset));
      return days.map((d) => new Date(morningSlot(d, timeZone, input.rand)).toISOString());
    }

    case "spread_2_weeks": {
      // Every ~2-3 days across 14 days, morning slots.
      const today = wallPartsAt(nowMs, timeZone);
      const offsets: number[] = [];
      if (count === 1) {
        offsets.push(2);
      } else {
        for (let i = 0; i < count; i++) {
          offsets.push(Math.max(1, Math.round(1 + (i * 12) / (count - 1))));
        }
      }
      // Keep offsets strictly increasing (distinct days).
      for (let i = 1; i < offsets.length; i++) {
        if (offsets[i] <= offsets[i - 1]) offsets[i] = offsets[i - 1] + 1;
      }
      return offsets.map((off) =>
        new Date(morningSlot(addDays(today, off), timeZone, input.rand)).toISOString()
      );
    }
  }
}
