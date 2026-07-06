/**
 * Pure statistics mirrors (Milestone 3). The SQL in
 * supabase/migrations/20260702050000_analytics_events.sql is AUTHORITATIVE for
 * stored rollup values — these TS twins exist so verify-analytics.ts can prove
 * the SQL and the dashboard agree on the same golden fixtures, and so the
 * dashboard never recomputes raw statistics at render time.
 */

/**
 * Linear-interpolation percentile — the exact semantics of Postgres
 * `percentile_cont(p) within group (order by v)`.
 */
export function percentileCont(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

export function median(values: number[]): number | null {
  return percentileCont(values, 0.5);
}

export function p90(values: number[]): number | null {
  return percentileCont(values, 0.9);
}

/** One respondent's outcome on one question: was THIS item correct, and what
 *  was the respondent's TOTAL score on the attempt (item included). */
export interface PointBiserialItem {
  correct: boolean;
  total: number;
}

/**
 * Point-biserial item-total correlation, mirroring the migration's formula:
 *   r_pb = ((m1 - m0) / sd_pop(total)) * sqrt(p * (1 - p))
 * where p = proportion correct, m1/m0 = mean total of correct/incorrect
 * respondents. Returns null when undefined (n < 2, sd = 0, or a group is
 * empty). Rounded to 4 dp exactly like the SQL's round(…, 4).
 */
export function pointBiserial(items: PointBiserialItem[]): number | null {
  const n = items.length;
  if (n < 2) return null;
  const totals = items.map((i) => i.total);
  const mean = totals.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  if (sd === 0) return null;
  const correct = items.filter((i) => i.correct);
  const incorrect = items.filter((i) => !i.correct);
  if (correct.length === 0 || incorrect.length === 0) return null;
  const p = correct.length / n;
  const m1 = correct.reduce((a, b) => a + b.total, 0) / correct.length;
  const m0 = incorrect.reduce((a, b) => a + b.total, 0) / incorrect.length;
  const r = ((m1 - m0) / sd) * Math.sqrt(p * (1 - p));
  return Math.round(r * 10000) / 10000;
}
