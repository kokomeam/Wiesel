/**
 * The mastery REFOLD (TUTOR-1 Wave 2 · AC-T2.3). PURE + deterministic.
 *
 * Given a learner's ordered evidence stream, the active concept-node set, the
 * resolved lineage index, and `nowIso`, fold every observation through BKT
 * (weights.ts already stamped `weight`/`direction`/`sourceId` on each item) to a
 * per-node P(L), then materialize a decayed estimate against `nowIso`. This is
 * the ONE function the Inngest refold + the loader both drive.
 *
 * DETERMINISM (R-22 idempotency — the whole point):
 *   - the caller PRE-SORTS `evidence` by (at, sourceId) — the fold trusts that
 *     exact order (assembleEvidence produces it). We do NOT re-sort here.
 *   - lineage resolution is a pure lookup; a split fans one item onto each child
 *     (its confidence factor multiplies the item weight); an inactive target is
 *     dropped SILENTLY (never an error).
 *   - no Date.now / no Math.random / no Map-iteration-order leak: the output rows
 *     are collected into a plain object keyed by nodeId then emitted SORTED by
 *     nodeId, so identical input ⇒ byte-identical JSON.
 *
 * ZERO MODEL CALLS — arithmetic only.
 */

import type { MasteryConfig } from "./config";
import { updateBkt, decay } from "./bkt";
import { resolveNodeId, type LineageIndex } from "./lineage";
import type { MasteryEvidence } from "./evidence";

/** One materialized mastery row (the loader hands these to the writer, which
 *  upserts them into learner_mastery). `pLearned` = the folded BKT estimate;
 *  `decayedP` = that estimate decayed to `nowIso`; `evidenceCount` = how many
 *  observations backed the node; `lastPositiveAt` = the ISO timestamp of the
 *  latest positive-direction observation (drives the decay clock), or null. */
export interface MasteryRow {
  nodeId: string;
  pLearned: number;
  decayedP: number;
  evidenceCount: number;
  lastPositiveAt: string | null;
}

/** Per-node fold accumulator (internal). */
interface NodeState {
  p: number;
  count: number;
  lastPositiveAt: string | null;
}

/** Days between two ISO instants (b − a), fractional. Non-finite/negative inputs
 *  are handled by decay() (which returns the estimate unchanged for days ≤ 0). */
function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return (b - a) / (1000 * 60 * 60 * 24);
}

/**
 * PURE. Fold the pre-sorted evidence into per-node mastery rows.
 *
 * @param evidence     the observations, ALREADY SORTED by (at, sourceId) — the
 *                     caller (assembleEvidence) owns the sort; we fold in place.
 * @param activeNodeIds the live concept-node ids; a resolved target NOT in this
 *                     set is dropped silently (retired-without-lineage, or a
 *                     lineage target that has since retired).
 * @param lineage      the merge/split index; each item's nodeId is resolved
 *                     through it (a split fans onto every child, factor-weighted).
 * @param nowIso       the instant to decay to (the writer's computed_at).
 * @param cfg          the resolved mastery config (BKT priors + decay knobs).
 */
export function refoldMastery(
  evidence: MasteryEvidence[],
  activeNodeIds: Set<string>,
  lineage: LineageIndex,
  nowIso: string,
  cfg: MasteryConfig
): MasteryRow[] {
  const states = new Map<string, NodeState>();

  for (const ev of evidence) {
    // Resolve the raw node id through lineage → 0..N live targets, each with a
    // factor (1 for merge/active; a split's confidenceFactor, chained/multiplied).
    const { targets } = resolveNodeId(lineage, ev.nodeId);
    for (const target of targets) {
      // Drop a target that isn't active (retired-without-lineage self-resolves,
      // then falls out here; a lineage chain that ends on a retired node too).
      if (!activeNodeIds.has(target.nodeId)) continue;

      let st = states.get(target.nodeId);
      if (!st) {
        st = { p: cfg.pL0, count: 0, lastPositiveAt: null };
        states.set(target.nodeId, st);
      }

      // The BKT weight for this target = the item weight × the lineage factor
      // (a split discounts every child; updateBkt clamps to (0,1] internally).
      const w = ev.weight * target.factor;
      const correct = ev.direction === 1;
      st.p = updateBkt(st.p, correct, w, cfg);
      st.count += 1;
      // Track the LATEST positive-direction observation (evidence is pre-sorted
      // ascending by time, so the last positive we see is the most recent).
      if (correct) st.lastPositiveAt = ev.at;
    }
  }

  // Materialize: decay each folded estimate to nowIso, then emit SORTED by nodeId
  // (deterministic output order — never Map insertion order).
  const rows: MasteryRow[] = [];
  for (const [nodeId, st] of states) {
    const days = st.lastPositiveAt === null ? 0 : daysBetween(st.lastPositiveAt, nowIso);
    const decayedP = decay(st.p, days, st.count, cfg);
    rows.push({
      nodeId,
      pLearned: st.p,
      decayedP,
      evidenceCount: st.count,
      lastPositiveAt: st.lastPositiveAt,
    });
  }
  rows.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  return rows;
}
