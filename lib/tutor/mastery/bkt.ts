/**
 * Bayesian Knowledge Tracing — the pure 4-param mastery update (TUTOR-1 Wave 2).
 *
 * PURE + deterministic: no I/O, no clock, no randomness. Every function takes the
 * resolved `MasteryConfig` explicitly. The engine folds a learner's ordered
 * evidence through `updateBkt` per concept, then materializes a decayed estimate
 * with `decay`. ZERO MODEL CALLS — this is arithmetic.
 *
 * The standard BKT recurrence, given the prior P(L) that the learner knows the
 * skill BEFORE this observation:
 *
 *   Bayesian update (condition on the observation):
 *     correct   →  P' = P(L)·(1−S) / ( P(L)·(1−S) + (1−P(L))·G )
 *     incorrect →  P' = P(L)·S     / ( P(L)·S     + (1−P(L))·(1−G) )
 *   Learning transition (a practice opportunity may teach it):
 *     P'' = P' + (1−P')·T
 *
 * WEIGHTED observation (evidence weight w ∈ (0,1]): a low-confidence signal
 * shouldn't move the estimate as far as a graded quiz answer. We blend the full
 * posterior with the prior:
 *     P_new = w·P'' + (1−w)·P(L)
 * so w=1 is the textbook update and w→0 is a no-op. This keeps the estimate a
 * valid probability (a convex combination of two values in [0,1]).
 */

import type { MasteryConfig } from "./config";

/** Clamp x into [0,1] (guards float drift; the math already stays in range). */
function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * One BKT observation. `prior` = P(L) before this observation; `correct` = the
 * observed direction; `weight` = the evidence weight in (0,1] (1 = full-strength).
 * Returns the posterior P(L) AFTER the Bayesian update + learning transition,
 * blended with the prior by the weight. Pure.
 */
export function updateBkt(
  prior: number,
  correct: boolean,
  weight: number,
  cfg: MasteryConfig
): number {
  const pl = clamp01(prior);
  const w = clamp01(weight);
  const { pS: S, pG: G, pT: T } = cfg;

  // Bayesian update: condition P(L) on the observation.
  let posterior: number;
  if (correct) {
    const num = pl * (1 - S);
    const den = pl * (1 - S) + (1 - pl) * G;
    posterior = den === 0 ? pl : num / den;
  } else {
    const num = pl * S;
    const den = pl * S + (1 - pl) * (1 - G);
    posterior = den === 0 ? pl : num / den;
  }

  // Learning transition: a practice opportunity may move an unknown skill to known.
  const learned = posterior + (1 - posterior) * T;

  // Weighted blend of the full posterior with the prior (w=1 ⇒ full update).
  const blended = w * learned + (1 - w) * pl;
  return clamp01(blended);
}

/**
 * Forgetting curve. Given a current estimate `p`, the days since the learner's
 * LAST positive evidence, and how much evidence backs the estimate, decay `p`
 * toward the prior P(L0):
 *
 *   halfLife = H0 · (1 + ln(1 + evidenceCount))   — more evidence ⇒ slower decay
 *   decayed  = P_L0 + (p − P_L0) · 2^(−days / halfLife)
 *
 * The decayed value is clamped to [P_L0, p]: decay never pushes an estimate BELOW
 * the prior (you never know less than the baseline) and never ABOVE the current
 * estimate (decay only forgets). `days ≤ 0` ⇒ no decay (returns p). Pure.
 */
export function decay(
  p: number,
  daysSinceLastPositive: number,
  evidenceCount: number,
  cfg: MasteryConfig
): number {
  const prior = cfg.pL0;
  const current = clamp01(p);
  if (current <= prior) return prior <= current ? current : prior; // already at/below floor
  if (!Number.isFinite(daysSinceLastPositive) || daysSinceLastPositive <= 0) return current;

  const count = Math.max(0, evidenceCount);
  const halfLife = cfg.decayHalfLifeDays * (1 + Math.log(1 + count));
  if (halfLife <= 0) return current;

  const factor = Math.pow(2, -daysSinceLastPositive / halfLife);
  const decayed = prior + (current - prior) * factor;

  // Clamp to [prior, current]: never below the floor, never above the estimate.
  if (decayed < prior) return prior;
  if (decayed > current) return current;
  return decayed;
}
