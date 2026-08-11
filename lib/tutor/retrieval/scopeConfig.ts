/**
 * TUTOR-1 Amendment A4, Wave 3 — scope-policy config.
 *
 * Tier budgets + the relevance threshold τ + the weak-mastery line. All env-
 * configurable (call-time, so tests can flip them).
 *
 * τ (TUTOR_RETRIEVAL_TAU) gates `insufficient_local_context` on the top retrieved
 * chunk's COSINE SIMILARITY to the query (0..1). CALIBRATED (Wave 5,
 * `scripts/calibrate-tutor-tau.ts`) against cs61b (real embeddings, 32 labeled
 * queries): sufficient queries scored 0.51–0.68, insufficient 0.02–0.33 — a clean
 * gap, with τ ∈ [0.33, 0.50] giving 0% false-expansion AND 0% missed-expansion.
 * The default **0.40** sits mid-band for robustness to distribution shift.
 * (An earlier draft gated on the RRF rank score; calibration showed that score
 * clusters at ~1/61 for both relevant and irrelevant queries and cannot be
 * separated — hence the similarity signal + the Wave-5 RPC change.)
 */

import { TUTOR_MASTERY_THRESHOLD } from "@/lib/tutor/mastery/config";

export interface ScopeConfig {
  /** Tier 1 (active lesson) chunk budget. */
  tier1Budget: number;
  /** Tier 2 (completed lessons) additional chunk budget — only under expansion. */
  tier2Budget: number;
  /** τ — the min cosine SIMILARITY for a Tier-1 chunk to count as relevant local
   *  context. Calibrated (Wave 5); default 0.40. */
  tau: number;
  /** The below-mastery line a prerequisite must fall under to be a `prerequisite_gap`. */
  weakMasteryThreshold: number;
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}
function envFloat(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function scopeConfig(): ScopeConfig {
  return {
    tier1Budget: envInt("TUTOR_RETRIEVAL_TIER1_BUDGET", 6),
    tier2Budget: envInt("TUTOR_RETRIEVAL_TIER2_BUDGET", 4),
    // Calibrated (Wave 5) on the cosine-similarity scale — see the header.
    tau: envFloat("TUTOR_RETRIEVAL_TAU", 0.4),
    weakMasteryThreshold: envFloat("TUTOR_MASTERY_THRESHOLD", TUTOR_MASTERY_THRESHOLD),
  };
}
