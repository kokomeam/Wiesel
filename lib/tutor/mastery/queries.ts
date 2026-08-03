/**
 * Graph-aware mastery QUERIES + the materializer (TUTOR-1 Wave 2 · package C).
 *
 * PURE graph analytics over a learner's per-node mastery + the course's
 * prerequisite DAG, plus ONE impure `materializeMasteryResults` that reads the
 * already-written `learner_mastery` rows (service-role) and full-replaces the two
 * derived output tables (`mastery_review_queue`, `mastery_course_aggregate`).
 *
 * ZERO MODEL CALLS — every function is deterministic arithmetic/graph traversal.
 * No Date.now / no Math.random in the pure layer; the materializer's ONLY clock
 * read is the caller-supplied (or default) `nowIso`, stamped into computed_at.
 *
 * ── EDGE DIRECTION CONVENTION (verified against lib/tutor/graph/edges.ts) ──
 * The edge inference prompt states: `prerequisite — the source must be understood
 * BEFORE the target`. So for a 'prerequisite' edge A→B (source=A, target=B):
 *   • A is a PREREQUISITE OF B;
 *   • B DEPENDS ON A.
 * Therefore, following edges in the source→target direction FROM a node walks to
 * everything that DEPENDS on it (its downstream dependents). Walking edges in
 * REVERSE (target→source) from a node walks to its prerequisites/ancestors —
 * everything it depends on. Both traversals here consider 'prerequisite' edges
 * ONLY (the per-kind DAG; part_of/related are ignored for leverage + root-cause).
 *
 * Cycle tolerance: the graph write path hardens prerequisite edges into a DAG, but
 * a corrupt/legacy edge set could still contain a cycle. Every traversal here is
 * visited-set guarded so it always terminates (the graph-doctrine renderers stay
 * cycle-tolerant; so do these queries).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { percentileCont } from "@/lib/analytics/stats";
import { resolveMasteryConfig, type MasteryConfig } from "./config";

/* ────────────────────────────── input shapes ────────────────────────────── */

/** The subset of a concept_edges row the graph queries read. */
export interface EdgeLike {
  sourceNodeId: string;
  targetNodeId: string;
  kind: string;
}

/** A learner's per-node mastery estimate (the leverage/root-cause inputs). */
export interface MasteryLike {
  nodeId: string;
  decayedP: number;
}

/** A learner's per-node mastery row with the forgetting-signal fields the review
 *  queue needs. */
export interface ReviewMasteryLike {
  nodeId: string;
  decayedP: number;
  pLearned: number;
  lastPositiveAt: string | null;
}

/* ─────────────────────────── prerequisite adjacency ─────────────────────── */

/** Build forward (source→target = "who depends on me") + reverse
 *  (target→source = "what I depend on") adjacency over 'prerequisite' edges only. */
function prerequisiteAdjacency(edges: EdgeLike[]): {
  forward: Map<string, string[]>;
  reverse: Map<string, string[]>;
} {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "prerequisite") continue;
    if (!e.sourceNodeId || !e.targetNodeId) continue;
    if (e.sourceNodeId === e.targetNodeId) continue; // self-loop — no leverage
    (forward.get(e.sourceNodeId) ?? forward.set(e.sourceNodeId, []).get(e.sourceNodeId)!).push(
      e.targetNodeId
    );
    (reverse.get(e.targetNodeId) ?? reverse.set(e.targetNodeId, []).get(e.targetNodeId)!).push(
      e.sourceNodeId
    );
  }
  return { forward, reverse };
}

/**
 * PURE. Count the TRANSITIVE downstream dependents of `nodeId` — every node
 * reachable by following 'prerequisite' edges in the source→target direction FROM
 * `nodeId` (i.e. everything that depends, directly or transitively, on it). The
 * node itself is excluded. Cycle-tolerant (visited set); a node not present in the
 * graph has 0 dependents.
 */
export function downstreamDependencyCount(edges: EdgeLike[], nodeId: string): number {
  const { forward } = prerequisiteAdjacency(edges);
  return reachableCount(forward, nodeId);
}

/** BFS/DFS reachable-count over an adjacency map, excluding the start node.
 *  Visited-set guarded ⇒ cycle-safe. */
function reachableCount(adj: Map<string, string[]>, start: string): number {
  const seen = new Set<string>([start]);
  const stack: string[] = [start];
  let count = 0;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      count += 1;
      stack.push(next);
    }
  }
  return count;
}

/* ──────────────────────────────── weakestNodes ──────────────────────────── */

export interface WeakNode {
  nodeId: string;
  score: number;
  dependents: number;
}

/**
 * PURE. Rank a learner's nodes by REMEDIATION LEVERAGE: low mastery × high
 * downstream leverage. score = (1 − decayedP) × (1 + dependents) where
 * `dependents` = transitive downstream dependents (how many later concepts rest on
 * this one). Highest score first; deterministic tiebreak by nodeId ascending.
 * Returns at most `limit` entries (limit ≤ 0 ⇒ empty).
 */
export function weakestNodes(
  mastery: MasteryLike[],
  edges: EdgeLike[],
  limit: number,
  cfg: MasteryConfig = resolveMasteryConfig()
): WeakNode[] {
  // cfg is the reserved tuning seam (signature-pinned by the pure suite);
  // weakestNodes' formula has no threshold today.
  void cfg;
  if (limit <= 0) return [];
  const { forward } = prerequisiteAdjacency(edges);
  const scored: WeakNode[] = mastery.map((m) => {
    const dependents = reachableCount(forward, m.nodeId);
    const score = (1 - clamp01(m.decayedP)) * (1 + dependents);
    return { nodeId: m.nodeId, score, dependents };
  });
  scored.sort((a, b) => b.score - a.score || cmpStr(a.nodeId, b.nodeId));
  return scored.slice(0, limit);
}

/* ──────────────────────────────── rootCause ─────────────────────────────── */

/**
 * PURE. Find the DEEPEST below-threshold ANCESTOR of `targetNodeId` over
 * prerequisite edges — the earliest prerequisite gap a learner should shore up
 * before the target. Ancestors = nodes from which the target is reachable (walk
 * REVERSE edges target→source). "Below threshold" = decayedP < cfg.masteryThreshold.
 * "Deepest" = the maximum prerequisite-path distance UPSTREAM from the target
 * (the ancestor furthest back in the dependency chain). Ties break deterministically
 * by nodeId ascending. The target itself is excluded. Returns null when the target
 * has no below-threshold ancestor. Cycle-tolerant (BFS distance with a visited set).
 */
export function rootCause(
  mastery: MasteryLike[],
  edges: EdgeLike[],
  targetNodeId: string,
  cfg: MasteryConfig = resolveMasteryConfig()
): string | null {
  const { reverse } = prerequisiteAdjacency(edges);
  const masteryByNode = new Map(mastery.map((m) => [m.nodeId, clamp01(m.decayedP)]));

  // BFS upstream from the target, recording the shortest distance to each ancestor.
  // (Shortest-path distance is a well-defined "depth" that is cycle-tolerant; the
  // deepest ancestor = the one with the largest distance.)
  const dist = new Map<string, number>();
  const queue: string[] = [targetNodeId];
  dist.set(targetNodeId, 0);
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist.get(cur)!;
    for (const prereq of reverse.get(cur) ?? []) {
      if (dist.has(prereq)) continue;
      dist.set(prereq, d + 1);
      queue.push(prereq);
    }
  }

  let best: { nodeId: string; depth: number } | null = null;
  for (const [nodeId, depth] of dist) {
    if (depth === 0) continue; // exclude the target itself
    const p = masteryByNode.get(nodeId);
    if (p === undefined || p >= cfg.masteryThreshold) continue; // not below threshold
    if (
      best === null ||
      depth > best.depth ||
      (depth === best.depth && cmpStr(nodeId, best.nodeId) < 0)
    ) {
      best = { nodeId, depth };
    }
  }
  return best ? best.nodeId : null;
}

/* ──────────────────────────────── reviewQueue ───────────────────────────── */

/** The reason payload persisted to mastery_review_queue.reason (jsonb). */
export interface ReviewReason {
  decayGap: number;
  dependents: number;
  belowThreshold: boolean;
}

export interface ReviewQueueEntry {
  nodeId: string;
  rank: number;
  score: number;
  reason: ReviewReason;
}

/**
 * A below-threshold node gets a floor boost so a stale-but-still-below-threshold
 * concept never sinks beneath a node with a slightly larger raw decay gap. The
 * boost is a flat additive term on the score of any below-threshold node.
 */
export const REVIEW_BELOW_THRESHOLD_BOOST = 0.5;

/**
 * PURE. Build a learner's ranked spaced-review queue. For each node:
 *   decayGap = max(0, pLearned − decayedP)            — the forgetting signal
 *   dependents = transitive downstream dependents      — the leverage multiplier
 *   score = decayGap × (1 + dependents) [+ boost if belowThreshold]
 * Ranked by score DESC, deterministic tiebreak by nodeId ascending; rank is
 * 1-based. Returns at most `limit` entries (limit ≤ 0 ⇒ empty). `nowIso` is
 * accepted for signature parity + future recency weighting; the current score is
 * time-independent beyond the already-decayed inputs, so it is not read here.
 * Cycle-tolerant via reachableCount.
 */
export function reviewQueue(
  mastery: ReviewMasteryLike[],
  edges: EdgeLike[],
  _nowIso: string,
  limit: number,
  cfg: MasteryConfig = resolveMasteryConfig()
): ReviewQueueEntry[] {
  if (limit <= 0) return [];
  const { forward } = prerequisiteAdjacency(edges);
  const scored = mastery.map((m) => {
    const decayGap = Math.max(0, clamp01(m.pLearned) - clamp01(m.decayedP));
    const dependents = reachableCount(forward, m.nodeId);
    const belowThreshold = clamp01(m.decayedP) < cfg.masteryThreshold;
    const score = decayGap * (1 + dependents) + (belowThreshold ? REVIEW_BELOW_THRESHOLD_BOOST : 0);
    return {
      nodeId: m.nodeId,
      score,
      reason: { decayGap, dependents, belowThreshold } as ReviewReason,
    };
  });
  scored.sort((a, b) => b.score - a.score || cmpStr(a.nodeId, b.nodeId));
  return scored.slice(0, limit).map((s, i) => ({
    nodeId: s.nodeId,
    rank: i + 1,
    score: s.score,
    reason: s.reason,
  }));
}

/* ───────────────────────────── shared helpers ───────────────────────────── */

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * PURE. The percentile helper the aggregate uses. Delegates to the analytics
 * golden-mirror (`percentileCont`) so the review-queue materializer and the
 * dashboard rollups share ONE percentile semantics (linear-interpolation, exactly
 * Postgres `percentile_cont`). Re-exported so the pure suite can golden it against
 * the analytics twin on a shared fixture.
 */
export function masteryPercentile(values: number[], p: number): number | null {
  return percentileCont(values, p);
}

/* ────────────────────────── the materializer (impure) ───────────────────── */

type DB = SupabaseClient<Database>;

export interface MaterializeResult {
  coursesProcessed: number;
  queuesWritten: number;
  aggregatesWritten: number;
}

/** How many review-queue rows to keep per learner (the top-of-queue the /home
 *  rail + tutor read; well above the ≤4 the UI shows). */
const REVIEW_QUEUE_LIMIT = 50;

/**
 * IMPURE. Materialize the two derived mastery tables from the already-written
 * `learner_mastery` rows (service-role reads — the pinned DDL: the materializer
 * reads learner_mastery). For EVERY course that has any learner_mastery rows:
 *   1. load the course's active 'prerequisite' edges + all mastery rows;
 *   2. per learner → `reviewQueue` → FULL-REPLACE that learner's
 *      mastery_review_queue rows (delete rows no longer present, upsert present —
 *      the writer.ts full-replace pattern);
 *   3. per node → aggregate decayed_p across learners (learner_count = distinct
 *      users with a row; avg/p25/p50/p75; below_threshold_count = rows with
 *      decayed_p < threshold) → FULL-REPLACE mastery_course_aggregate for the
 *      course.
 *
 * ⚠ COHORT FLOOR: we write ALL aggregate rows, INCLUDING learner_count < 5. The
 * cohort floor (MASTERY_MIN_COHORT = 5) is applied at the READ RPC
 * (concept_mastery_aggregate) — the table is service-role-only (RLS on, zero
 * policies), so storing a below-floor row discloses nothing to a creator. Storing
 * every row keeps the aggregate honest as the cohort crosses the floor.
 *
 * Sibling B's nightly Inngest function dynamic-imports this from this exact path.
 * `nowIso` (default: current instant) is stamped into every computed_at.
 */
export async function materializeMasteryResults(
  admin: DB,
  opts: { nowIso?: string } = {}
): Promise<MaterializeResult> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const cfg = resolveMasteryConfig();

  // Every course that has any learner_mastery rows. (Distinct course_ids — the
  // materializer runs the whole cohort per course.)
  const { data: courseRows, error: courseErr } = await admin
    .from("learner_mastery")
    .select("course_id");
  if (courseErr) throw new Error(`materializeMasteryResults courses: ${courseErr.message}`);
  const courseIds = [...new Set((courseRows ?? []).map((r) => r.course_id))];

  let queuesWritten = 0;
  let aggregatesWritten = 0;

  for (const courseId of courseIds) {
    // (1) active prerequisite edges + all mastery rows for the course.
    const [{ data: edgeRows, error: edgeErr }, { data: masteryRows, error: masteryErr }] =
      await Promise.all([
        admin
          .from("concept_edges")
          .select("source_node_id, target_node_id, kind")
          .eq("course_id", courseId)
          .eq("kind", "prerequisite"),
        admin
          .from("learner_mastery")
          .select("user_id, node_id, p_learned, decayed_p, last_positive_at")
          .eq("course_id", courseId),
      ]);
    if (edgeErr) throw new Error(`materializeMasteryResults edges: ${edgeErr.message}`);
    if (masteryErr) throw new Error(`materializeMasteryResults mastery: ${masteryErr.message}`);

    const edges: EdgeLike[] = (edgeRows ?? []).map((e) => ({
      sourceNodeId: e.source_node_id,
      targetNodeId: e.target_node_id,
      kind: e.kind,
    }));

    // Group mastery rows by learner.
    const byUser = new Map<string, ReviewMasteryLike[]>();
    for (const r of masteryRows ?? []) {
      const list = byUser.get(r.user_id) ?? [];
      list.push({
        nodeId: r.node_id,
        decayedP: r.decayed_p,
        pLearned: r.p_learned,
        lastPositiveAt: r.last_positive_at,
      });
      byUser.set(r.user_id, list);
    }

    // (2) per learner → reviewQueue → full-replace their queue rows.
    for (const [userId, rows] of byUser) {
      const queue = reviewQueue(rows, edges, nowIso, REVIEW_QUEUE_LIMIT, cfg);
      queuesWritten += await replaceReviewQueue(admin, userId, courseId, queue, nowIso);
    }

    // (3) per node → cohort aggregate → full-replace the course's aggregate rows.
    const byNode = new Map<string, { values: number[]; users: Set<string>; below: number }>();
    for (const r of masteryRows ?? []) {
      const agg = byNode.get(r.node_id) ?? { values: [], users: new Set<string>(), below: 0 };
      agg.values.push(r.decayed_p);
      agg.users.add(r.user_id);
      if (r.decayed_p < cfg.masteryThreshold) agg.below += 1;
      byNode.set(r.node_id, agg);
    }
    const aggregateRows = [...byNode.entries()].map(([nodeId, agg]) => ({
      course_id: courseId,
      node_id: nodeId,
      learner_count: agg.users.size,
      avg_decayed_p: agg.values.length > 0 ? mean(agg.values) : null,
      p25: masteryPercentile(agg.values, 0.25),
      p50: masteryPercentile(agg.values, 0.5),
      p75: masteryPercentile(agg.values, 0.75),
      below_threshold_count: agg.below,
      computed_at: nowIso,
    }));
    aggregatesWritten += await replaceCourseAggregate(admin, courseId, aggregateRows);
  }

  return { coursesProcessed: courseIds.length, queuesWritten, aggregatesWritten };
}

/** Full-replace one learner's mastery_review_queue rows: upsert the fresh set,
 *  delete any node no longer present. Returns the number of rows upserted. */
async function replaceReviewQueue(
  admin: DB,
  userId: string,
  courseId: string,
  queue: ReviewQueueEntry[],
  nowIso: string
): Promise<number> {
  const rows = queue.map((q) => ({
    user_id: userId,
    course_id: courseId,
    node_id: q.nodeId,
    rank: q.rank,
    score: q.score,
    reason: q.reason as unknown as Json,
    computed_at: nowIso,
  }));

  if (rows.length > 0) {
    const { error } = await admin
      .from("mastery_review_queue")
      .upsert(rows, { onConflict: "user_id,course_id,node_id" });
    if (error) throw new Error(`replaceReviewQueue upsert: ${error.message}`);
  }

  // Delete rows for this (user, course) whose node is NOT in the fresh set.
  const keep = rows.map((r) => r.node_id);
  let del = admin
    .from("mastery_review_queue")
    .delete()
    .eq("user_id", userId)
    .eq("course_id", courseId);
  if (keep.length > 0) del = del.not("node_id", "in", `(${keep.join(",")})`);
  const { error: delErr } = await del;
  if (delErr) throw new Error(`replaceReviewQueue delete: ${delErr.message}`);

  return rows.length;
}

/** Full-replace a course's mastery_course_aggregate rows: upsert the fresh set,
 *  delete any node no longer present. Returns the number of rows upserted. */
async function replaceCourseAggregate(
  admin: DB,
  courseId: string,
  rows: Database["public"]["Tables"]["mastery_course_aggregate"]["Insert"][]
): Promise<number> {
  if (rows.length > 0) {
    const { error } = await admin
      .from("mastery_course_aggregate")
      .upsert(rows, { onConflict: "course_id,node_id" });
    if (error) throw new Error(`replaceCourseAggregate upsert: ${error.message}`);
  }

  const keep = rows.map((r) => r.node_id);
  let del = admin.from("mastery_course_aggregate").delete().eq("course_id", courseId);
  if (keep.length > 0) del = del.not("node_id", "in", `(${keep.join(",")})`);
  const { error: delErr } = await del;
  if (delErr) throw new Error(`replaceCourseAggregate delete: ${delErr.message}`);

  return rows.length;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
