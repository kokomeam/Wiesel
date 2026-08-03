/**
 * TUTOR-1 Wave 2 · package D — the MASTERY cohort INTEGRATION suite (live
 * Supabase, ZERO model key). Seeds the six-learner mastery cohort
 * (seed-fixture-mastery.ts · seedMasteryCohort), refolds + writes every
 * learner's mastery, materializes the review queue + course aggregate, and
 * asserts the full frozen Wave-2 acceptance matrix against the LIVE rows —
 * recomputing every golden IN-TEST from the bkt/weights/queries modules (no
 * magic constants baked into an assertion).
 *
 * The orchestrator applies migrations 20260803110000/110100/110200 BEFORE
 * running this (record_quiz_attempt / quiz_attempt_detail / learner_mastery /
 * mastery_review_queue / mastery_course_aggregate / the mastery RPCs don't exist
 * until then). DO NOT run this before the migrations are applied.
 *
 * ZERO MODEL SPEND is a hard gate: the concept graph + evidence are seeded
 * deterministically (no model client is imported anywhere in this suite or the
 * seeder); the tutor_model_call learning_events count for the cohort course is
 * asserted identical BEFORE vs AFTER the whole run (the SQL + both counts are
 * printed).
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) — the refold
 * loader/writer/materializer are service-role by design (strict-regime tables:
 * RLS on, service-role is the only writer).
 *
 * Run (AFTER the migrations are applied): `npx tsx scripts/verify-tutor-mastery-int.ts`
 *
 * ACs covered (each labeled in the section headers below):
 *   AC-T2.2  decay: the decayed-inactive learner has decayed_p < p_learned; a
 *            refold at now+30d decays FURTHER.
 *   AC-T2.3  idempotency: refold the strong learner TWICE → JSON-identical
 *            writer input.
 *   AC-A1.2  ordinal weighting: the retry-heavy learner's node-A trajectory
 *            equals an in-test recomputation via bkt/weights (no constants).
 *   AC-T2.4  RLS: a learner reads OWN learner_mastery only; the author reads
 *            ZERO learner_mastery AND ZERO mastery_review_queue directly;
 *            my_review_queue as the weak learner returns rows WITH titles;
 *            concept_mastery_aggregate works for the author + raises for a
 *            stranger.
 *   AC-T2.5  rootCause: the weak-with-upstream-gap learner's pure rootCause over
 *            their mastery + course edges = node A, and A ranks at/near the top
 *            of their materialized queue.
 *   AC-W2Q.1 materialized queue + aggregate rows MATCH an in-test pure-TS
 *            recomputation from the same inputs (golden-mirror equality).
 *   AC-W2Q.2 6 learners → real aggregates = hand-recomputation; admin-delete 2
 *            learners' mastery + re-materialize → learner_count 4 →
 *            suppressed:true, every value AND the count null.
 *   cold start a 7th zero-evidence learner → refold yields zero rows;
 *            my_review_queue empty.
 */

import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; on IPv6-broken networks (this dev
// machine's Clash setup) the TLS socket resets before the handshake. Pin
// IPv4-first — harmless everywhere else, load-bearing here.
dns.setDefaultResultOrder("ipv4first");

/** This network drops connections sporadically mid-run. Retry transient
 *  TRANSPORT failures (never HTTP errors) so the suite is deterministic. */
const retryingFetch: typeof fetch = async (input, init) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
};

import type { Database } from "@/lib/database.types";
import {
  seedMasteryCohort,
  loadMasteryEnv,
  type MasteryCohort,
  type NodeKey,
} from "./seed-fixture-mastery";
import { refoldLearnerCourse } from "@/lib/tutor/mastery/loader";
import { writeMastery } from "@/lib/tutor/mastery/writer";
import { materializeMasteryResults, rootCause, reviewQueue, type EdgeLike, type ReviewMasteryLike } from "@/lib/tutor/mastery/queries";
import { resolveMasteryConfig } from "@/lib/tutor/mastery/config";
import { updateBkt, decay } from "@/lib/tutor/mastery/bkt";
import { ordinalWeight } from "@/lib/tutor/mastery/weights";
import type { MasteryRow } from "@/lib/tutor/mastery/refold";

type DB = SupabaseClient<Database>;

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

const CFG = resolveMasteryConfig();

/** Provision one throwaway learner + a signed-in RLS-scoped client (the
 *  cohort's own helper is not exported; this mirrors it for the cold-start +
 *  RLS-principal cases). */
async function provisionLearner(
  url: string,
  anon: string,
  tag: string
): Promise<{ client: DB; userId: string; email: string; password: string }> {
  const email = `mastery-int-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup ${tag} failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin ${tag} failed: ${error?.message}`);
  return { client, userId: data.user.id, email, password };
}

/** Sign in an already-provisioned cohort learner (RLS principal for the read
 *  matrix). */
async function signIn(url: string, anon: string, email: string, password: string): Promise<DB> {
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signin ${email} failed: ${error.message}`);
  return client;
}

/** Serialize a MasteryRow[] into the writer-input shape the writer would send
 *  (AC-T2.3 idempotency compares THIS across two refolds). Sorted by nodeId
 *  (the refold already emits sorted, but be defensive). */
function writerInputJson(userId: string, courseId: string, rows: MasteryRow[], nowIso: string): string {
  const payload = [...rows]
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
    .map((r) => ({
      user_id: userId,
      course_id: courseId,
      node_id: r.nodeId,
      p_learned: r.pLearned,
      decayed_p: r.decayedP,
      evidence_count: r.evidenceCount,
      last_positive_at: r.lastPositiveAt,
      computed_at: nowIso,
    }));
  return JSON.stringify(payload);
}

async function main() {
  const env = loadMasteryEnv();

  /* ── seed the cohort ── */
  console.log("# seeding the six-learner mastery cohort (deterministic, zero model spend)");
  const t0 = Date.now();
  const cohort: MasteryCohort = await seedMasteryCohort(env);
  console.log(`# seeded course ${cohort.courseId} (${Date.now() - t0}ms) — ${cohort.learners.length} learners`);

  const admin = cohort.admin;
  const { courseId } = cohort;
  const byProfile = (p: string) => cohort.learners.find((l) => l.profile === p)!;
  const strong = byProfile("strong");
  const weak = byProfile("weak-with-upstream-gap");
  const decayed = byProfile("decayed-inactive");
  const retry = byProfile("retry-heavy");

  // A FIXED materialize instant so every decay is reproducible in-test.
  const NOW = new Date().toISOString();

  const cleanup = async () => {
    // Deleting the course cascades modules/lessons/blocks/publications/nodes.
    // learner_mastery/review_queue/aggregate cascade off concept_nodes (node fk
    // on delete cascade); learning_events + quiz_* rows are course-scoped and
    // die with the course. Throwaway users remain (clean in Supabase → Auth).
    await cohort.fixture.author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ── ZERO-MODEL-SPEND baseline (before the refold/materialize work) ── */
    console.log("\n# zero-model-spend baseline");
    const ZERO_SPEND_SQL =
      `select count(*) from learning_events ` +
      `where course_id = '${courseId}' and event_type = 'tutor_model_call'`;
    console.log(`  SQL: ${ZERO_SPEND_SQL}`);
    const spendBefore = await admin
      .from("learning_events")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId)
      .eq("event_type", "tutor_model_call");
    const spendBeforeCount = spendBefore.count ?? 0;
    console.log(`  tutor_model_call count BEFORE = ${spendBeforeCount}`);

    /* ── refold + write every cohort learner ── */
    console.log("\n# refold + write every cohort learner");
    let totalEvidence = 0;
    const perLearnerMs: number[] = [];
    const refoldStart = Date.now();
    const refoldByUser = new Map<string, MasteryRow[]>();
    for (const learner of cohort.learners) {
      const lt0 = Date.now();
      const { rows, evidenceCount } = await refoldLearnerCourse(admin, {
        userId: learner.userId,
        courseId,
        nowIso: NOW,
        cfg: CFG,
      });
      await writeMastery(admin, { userId: learner.userId, courseId, rows, nowIso: NOW });
      perLearnerMs.push(Date.now() - lt0);
      totalEvidence += evidenceCount;
      refoldByUser.set(learner.userId, rows);
    }
    const totalMs = Date.now() - refoldStart;
    check("every learner produced ≥1 mastery row", [...refoldByUser.values()].every((r) => r.length > 0));

    /* ── materialize the review queue + course aggregate ── */
    console.log("\n# materialize (review queue + course aggregate)");
    const mat = await materializeMasteryResults(admin, { nowIso: NOW });
    check("materializer processed the cohort course", mat.coursesProcessed >= 1);
    check("materializer wrote review-queue rows", mat.queuesWritten > 0);
    check("materializer wrote aggregate rows", mat.aggregatesWritten > 0);

    /* ── node id ↔ key lookup ── */
    const nodeKeyById = new Map<string, NodeKey>(
      (Object.entries(cohort.nodeIds) as [NodeKey, string][]).map(([k, id]) => [id, k])
    );
    const A = cohort.nodeIds.A;
    const B = cohort.nodeIds.B;
    const C = cohort.nodeIds.C;

    // The course's active prerequisite edges (the queries' graph input).
    const edgeRes = await admin
      .from("concept_edges")
      .select("source_node_id, target_node_id, kind")
      .eq("course_id", courseId)
      .eq("kind", "prerequisite");
    const edges: EdgeLike[] = (edgeRes.data ?? []).map((e) => ({
      sourceNodeId: e.source_node_id,
      targetNodeId: e.target_node_id,
      kind: e.kind,
    }));
    check("course carries the seeded prerequisite edges", edges.length === 7, `edges=${edges.length}`);

    /* ═══════════════ AC-A1.2 — ordinal weighting (retry-heavy) ══════════════
       L4 answered the node-A quiz wrong → right → right across 3 attempts. The
       loader derives the ordinal from (created_at, id), weighting 1.0/0.5/0.15.
       Recompute A's p_learned IN-TEST from the bkt/weights modules (no baked
       constant) and assert equality with the folded row. */
    console.log("\n— AC-A1.2 · ordinal-weighted retry contamination (node A, retry-heavy) —");
    const retryRows = refoldByUser.get(retry.userId)!;
    const retryA = retryRows.find((r) => r.nodeId === A);
    check("retry-heavy has a node-A mastery row", Boolean(retryA));
    // In-test recomputation via the SAME pure modules the loader uses.
    let recomputedA = CFG.pL0;
    recomputedA = updateBkt(recomputedA, false, ordinalWeight(1), CFG); // attempt 1 wrong, w=1.0
    recomputedA = updateBkt(recomputedA, true, ordinalWeight(2), CFG); // attempt 2 right, w=0.5
    recomputedA = updateBkt(recomputedA, true, ordinalWeight(3), CFG); // attempt 3 right, w=0.15
    check(
      "node-A p_learned = in-test bkt/weights recomputation (ordinal-weighted)",
      retryA !== undefined && Math.abs(retryA.pLearned - recomputedA) < 1e-9,
      `folded=${retryA?.pLearned} recomputed=${recomputedA}`
    );
    // The unweighted control (all w=1) — assert the ordinal discount really bit.
    let controlA = CFG.pL0;
    controlA = updateBkt(controlA, false, 1, CFG);
    controlA = updateBkt(controlA, true, 1, CFG);
    controlA = updateBkt(controlA, true, 1, CFG);
    check(
      "ordinal weighting DISCOUNTS retry contamination (weighted ≪ unweighted control)",
      retryA !== undefined && retryA.pLearned < controlA - 0.3,
      `weighted=${retryA?.pLearned} control=${controlA}`
    );
    check(
      "retry-heavy node A ends below the mastery threshold",
      retryA !== undefined && retryA.decayedP < CFG.masteryThreshold,
      `decayedP=${retryA?.decayedP}`
    );

    /* ═══════════════ AC-T2.3 — refold idempotency (strong learner) ══════════
       Refold the strong learner AGAIN with the same nowIso → the writer input
       is JSON-identical (R-22). */
    console.log("\n— AC-T2.3 · refold idempotency (strong learner) —");
    const first = await refoldLearnerCourse(admin, { userId: strong.userId, courseId, nowIso: NOW, cfg: CFG });
    const second = await refoldLearnerCourse(admin, { userId: strong.userId, courseId, nowIso: NOW, cfg: CFG });
    const firstJson = writerInputJson(strong.userId, courseId, first.rows, NOW);
    const secondJson = writerInputJson(strong.userId, courseId, second.rows, NOW);
    check("two refolds of the strong learner → byte-identical writer input", firstJson === secondJson);
    const strongLevels = new Map(first.rows.map((r) => [r.nodeId, r.decayedP]));
    // A/B/C are all comfortably above the mastery threshold. (A single correct
    // BKT observation from the 0.25 prior lands at ~0.68, so B/C — one correct
    // quiz each — sit there; A carries a SECOND positive [quiz + practice_answer]
    // and rises to ~0.92. The real "strong" guarantee is above-threshold with A
    // the strongest, NOT an arbitrary 0.9 floor on every node.)
    check(
      "strong learner's A/B/C are all above threshold",
      [A, B, C].every((id) => (strongLevels.get(id) ?? 0) >= CFG.masteryThreshold),
      JSON.stringify([A, B, C].map((id) => strongLevels.get(id)))
    );
    check(
      "the double-positive node A is the strongest of A/B/C",
      (strongLevels.get(A) ?? 0) > (strongLevels.get(B) ?? 0) &&
        (strongLevels.get(A) ?? 0) > (strongLevels.get(C) ?? 0),
      `A=${strongLevels.get(A)} B=${strongLevels.get(B)} C=${strongLevels.get(C)}`
    );
    check("strong learner has NO below-threshold node", first.rows.every((r) => r.decayedP >= CFG.masteryThreshold));

    /* ═══════════════ AC-T2.2 — decay (decayed-inactive learner) ═════════════
       L3's evidence is backdated ~60d. decayed_p < p_learned at materialize; a
       fresh refold at now+30d decays FURTHER (the read-side forgetting curve). */
    console.log("\n— AC-T2.2 · decay of an inactive learner (backdated ~60d) —");
    const decayedRows = refoldByUser.get(decayed.userId)!;
    const decayedA = decayedRows.find((r) => r.nodeId === A);
    check("decayed-inactive has a node-A row", Boolean(decayedA));
    check(
      "decayed_p < p_learned (materialized decay against now)",
      decayedA !== undefined && decayedA.decayedP < decayedA.pLearned,
      `decayedP=${decayedA?.decayedP} pLearned=${decayedA?.pLearned}`
    );
    // A refold 30 days LATER decays further (same evidence, later nowIso).
    const nowPlus30 = new Date(Date.parse(NOW) + 30 * 86_400_000).toISOString();
    const laterRefold = await refoldLearnerCourse(admin, { userId: decayed.userId, courseId, nowIso: nowPlus30, cfg: CFG });
    const laterA = laterRefold.rows.find((r) => r.nodeId === A);
    check(
      "a refold at now+30d decays node A FURTHER",
      laterA !== undefined && decayedA !== undefined && laterA.decayedP < decayedA.decayedP,
      `later=${laterA?.decayedP} original=${decayedA?.decayedP}`
    );
    // Independently verify the decay math on the folded p_learned + evidence.
    if (decayedA && decayedA.lastPositiveAt) {
      const daysNow = (Date.parse(NOW) - Date.parse(decayedA.lastPositiveAt)) / 86_400_000;
      const expectedDecayNow = decay(decayedA.pLearned, daysNow, decayedA.evidenceCount, CFG);
      check(
        "decayed_p matches decay() recomputed from p_learned + evidence_count",
        Math.abs(decayedA.decayedP - expectedDecayNow) < 1e-9,
        `stored=${decayedA.decayedP} recomputed=${expectedDecayNow}`
      );
    } else {
      check("decayed-inactive node A carries a last-positive instant for the decay clock", false);
    }

    /* ═══════════════ AC-T2.5 — rootCause (weak-with-upstream-gap) ═══════════
       Pure rootCause over L2's mastery + the course edges = node A; and A ranks
       at/near the top of L2's MATERIALIZED review queue. */
    console.log("\n— AC-T2.5 · rootCause over a real learner's mastery —");
    const weakRows = refoldByUser.get(weak.userId)!;
    const weakMastery: ReviewMasteryLike[] = weakRows.map((r) => ({
      nodeId: r.nodeId,
      decayedP: r.decayedP,
      pLearned: r.pLearned,
      lastPositiveAt: r.lastPositiveAt,
    }));
    const weakA = weakRows.find((r) => r.nodeId === A);
    const weakB = weakRows.find((r) => r.nodeId === B);
    const weakC = weakRows.find((r) => r.nodeId === C);
    check("weak learner: node A is below threshold", weakA !== undefined && weakA.decayedP < CFG.masteryThreshold, `A=${weakA?.decayedP}`);
    check("weak learner: node B is above threshold", weakB !== undefined && weakB.decayedP >= CFG.masteryThreshold, `B=${weakB?.decayedP}`);
    check("weak learner: node C is above threshold", weakC !== undefined && weakC.decayedP >= CFG.masteryThreshold, `C=${weakC?.decayedP}`);
    const rc = rootCause(weakMastery, edges, C, CFG);
    check("rootCause(C) over the weak learner's real mastery = node A", rc === A, `rootCause=${rc ? nodeKeyById.get(rc) ?? rc : rc}`);

    // A at/near the top of L2's MATERIALIZED queue (read via the definer RPC
    // below asserts titles; here read the raw rows to check the rank).
    const weakQueueRes = await admin
      .from("mastery_review_queue")
      .select("node_id, rank")
      .eq("user_id", weak.userId)
      .eq("course_id", courseId)
      .order("rank");
    const weakQueue = weakQueueRes.data ?? [];
    const aRank = weakQueue.find((q) => q.node_id === A)?.rank;
    check(
      "node A ranks at/near the top of the weak learner's materialized queue (rank ≤ 2)",
      aRank !== undefined && aRank <= 2,
      `A rank=${aRank}`
    );

    /* ═══════════════ AC-W2Q.1 — golden-mirror: materialized = pure-TS ═══════
       The MATERIALIZED review-queue + aggregate rows equal an in-test pure-TS
       recomputation from the SAME learner_mastery inputs. */
    console.log("\n— AC-W2Q.1 · materialized rows = pure-TS recomputation (golden mirror) —");
    // Read the authoritative learner_mastery rows back (the materializer's input).
    const allMasteryRes = await admin
      .from("learner_mastery")
      .select("user_id, node_id, p_learned, decayed_p, last_positive_at")
      .eq("course_id", courseId);
    const allMastery = allMasteryRes.data ?? [];
    const masteryByUser = new Map<string, ReviewMasteryLike[]>();
    for (const r of allMastery) {
      const list = masteryByUser.get(r.user_id) ?? [];
      list.push({ nodeId: r.node_id, decayedP: r.decayed_p, pLearned: r.p_learned, lastPositiveAt: r.last_positive_at });
      masteryByUser.set(r.user_id, list);
    }
    // Golden-mirror the weak learner's queue (rank + score + reason.dependents).
    const expectedWeakQueue = reviewQueue(masteryByUser.get(weak.userId)!, edges, NOW, 50, CFG);
    const liveWeakQueueRes = await admin
      .from("mastery_review_queue")
      .select("node_id, rank, score, reason")
      .eq("user_id", weak.userId)
      .eq("course_id", courseId)
      .order("rank");
    const liveWeakQueue = liveWeakQueueRes.data ?? [];
    check(
      "weak learner's materialized queue length = pure reviewQueue length",
      liveWeakQueue.length === expectedWeakQueue.length,
      `live=${liveWeakQueue.length} pure=${expectedWeakQueue.length}`
    );
    const queueMatches = expectedWeakQueue.every((e) => {
      const live = liveWeakQueue.find((l) => l.node_id === e.nodeId);
      if (!live) return false;
      const reason = (live.reason ?? {}) as { dependents?: number; belowThreshold?: boolean };
      return (
        live.rank === e.rank &&
        Math.abs(live.score - e.score) < 1e-9 &&
        reason.dependents === e.reason.dependents &&
        reason.belowThreshold === e.reason.belowThreshold
      );
    });
    check("every materialized queue row matches the pure reviewQueue golden (rank/score/reason)", queueMatches);

    // Golden-mirror the course aggregate for node A (learner_count / avg / below).
    const aggRes = await admin
      .from("mastery_course_aggregate")
      .select("node_id, learner_count, avg_decayed_p, p50, below_threshold_count")
      .eq("course_id", courseId)
      .eq("node_id", A)
      .maybeSingle();
    const aggA = aggRes.data;
    const aDecayed = allMastery.filter((r) => r.node_id === A).map((r) => r.decayed_p);
    const expectedCountA = new Set(allMastery.filter((r) => r.node_id === A).map((r) => r.user_id)).size;
    const expectedAvgA = aDecayed.reduce((a, b) => a + b, 0) / aDecayed.length;
    const expectedBelowA = aDecayed.filter((p) => p < CFG.masteryThreshold).length;
    check("aggregate(A).learner_count = distinct users with an A row", aggA?.learner_count === expectedCountA, `agg=${aggA?.learner_count} expected=${expectedCountA}`);
    check("aggregate(A).avg_decayed_p = mean of A's decayed_p", aggA !== null && aggA !== undefined && aggA.avg_decayed_p !== null && Math.abs(aggA.avg_decayed_p - expectedAvgA) < 1e-9, `agg=${aggA?.avg_decayed_p} expected=${expectedAvgA}`);
    check("aggregate(A).below_threshold_count = count of A rows below threshold", aggA?.below_threshold_count === expectedBelowA, `agg=${aggA?.below_threshold_count} expected=${expectedBelowA}`);

    /* ═══════════════ AC-W2Q.2 — cohort floor + suppression ══════════════════
       6 learners → real aggregates (learner_count 6 for A/B/C, ≥5). Then
       admin-delete 2 learners' mastery, re-materialize → learner_count 4 for
       A → the AUTHOR-gated RPC suppresses: suppressed=true, every value AND the
       count null. */
    console.log("\n— AC-W2Q.2 · cohort floor (6 ≥ 5 real; delete 2 → 4 < 5 suppressed) —");
    // Node A got graded/evidence for all 6 learners (every profile touches A),
    // so its aggregate row carries the full cohort.
    check("A's cohort learner_count = 6 (≥ floor 5)", aggA?.learner_count === 6, `count=${aggA?.learner_count}`);

    // The AUTHOR-gated RPC returns the REAL numbers at count ≥ 5.
    const authorClient = cohort.fixture.author.client;
    const aggRpcBefore = await authorClient.rpc("concept_mastery_aggregate", { p_course_id: courseId });
    check("concept_mastery_aggregate callable by the author", !aggRpcBefore.error, String(aggRpcBefore.error?.message));
    const rpcRowsBefore = (aggRpcBefore.data ?? []) as {
      node_id: string;
      suppressed: boolean;
      learner_count: number | null;
      avg_decayed_p: number | null;
    }[];
    const rpcA_before = rpcRowsBefore.find((r) => r.node_id === A);
    check(
      "at cohort 6 the author RPC discloses node A (suppressed=false, real count)",
      rpcA_before !== undefined && rpcA_before.suppressed === false && rpcA_before.learner_count === 6,
      JSON.stringify(rpcA_before)
    );

    // Admin-delete two learners' mastery rows, then re-materialize → A drops to 4.
    for (const victim of [byProfile("average"), cohort.learners.filter((l) => l.profile === "average")[1]]) {
      const del = await admin.from("learner_mastery").delete().eq("user_id", victim.userId).eq("course_id", courseId);
      if (del.error) throw new Error(`delete mastery for ${victim.profile}: ${del.error.message}`);
    }
    await materializeMasteryResults(admin, { nowIso: NOW });
    const aggAafter = await admin
      .from("mastery_course_aggregate")
      .select("learner_count")
      .eq("course_id", courseId)
      .eq("node_id", A)
      .maybeSingle();
    check("stored aggregate learner_count dropped to 4 after deleting 2", aggAafter.data?.learner_count === 4, `count=${aggAafter.data?.learner_count}`);

    const aggRpcAfter = await authorClient.rpc("concept_mastery_aggregate", { p_course_id: courseId });
    const rpcRowsAfter = (aggRpcAfter.data ?? []) as {
      node_id: string;
      suppressed: boolean;
      learner_count: number | null;
      avg_decayed_p: number | null;
      p25: number | null;
      p50: number | null;
      p75: number | null;
      below_threshold_count: number | null;
    }[];
    const rpcA_after = rpcRowsAfter.find((r) => r.node_id === A);
    check(
      "below the floor (4 < 5) node A is suppressed:true with EVERY value + the count NULL",
      rpcA_after !== undefined &&
        rpcA_after.suppressed === true &&
        rpcA_after.learner_count === null &&
        rpcA_after.avg_decayed_p === null &&
        rpcA_after.p25 === null &&
        rpcA_after.p50 === null &&
        rpcA_after.p75 === null &&
        rpcA_after.below_threshold_count === null,
      JSON.stringify(rpcA_after)
    );

    /* ═══════════════ AC-T2.4 — RLS matrix (strict regime) ═══════════════════ */
    console.log("\n— AC-T2.4 · RLS matrix (strict regime) —");
    const weakClient = await signIn(env.url, env.anon, weak.email, weak.password);
    const strongClient = await signIn(env.url, env.anon, strong.email, strong.password);

    // A learner reads OWN learner_mastery only (zero of another's).
    const weakOwn = await weakClient.from("learner_mastery").select("node_id").eq("course_id", courseId);
    check("weak learner reads their OWN learner_mastery rows", (weakOwn.data ?? []).length > 0, String(weakOwn.error?.message));
    const weakSeesStrong = await weakClient
      .from("learner_mastery")
      .select("node_id")
      .eq("course_id", courseId)
      .eq("user_id", strong.userId);
    check("weak learner reads ZERO of another learner's learner_mastery", (weakSeesStrong.data ?? []).length === 0);

    // The AUTHOR reads ZERO learner_mastery + ZERO mastery_review_queue directly.
    const authorSeesMastery = await authorClient.from("learner_mastery").select("node_id").eq("course_id", courseId);
    check("author reads ZERO learner_mastery rows directly (no author policy)", (authorSeesMastery.data ?? []).length === 0);
    const authorSeesQueue = await authorClient.from("mastery_review_queue").select("node_id").eq("course_id", courseId);
    check("author reads ZERO mastery_review_queue rows directly (zero policies)", (authorSeesQueue.data ?? []).length === 0);

    // my_review_queue as the weak learner returns rows WITH titles (the ONLY
    // learner-readable title path — the definer RPC joins concept_nodes).
    const weakQueueRpc = await weakClient.rpc("my_review_queue", { p_course_id: courseId });
    const weakQueueRpcRows = (weakQueueRpc.data ?? []) as { node_id: string; title: string | null; rank: number }[];
    check("my_review_queue returns the weak learner's queue", !weakQueueRpc.error && weakQueueRpcRows.length > 0, String(weakQueueRpc.error?.message));
    check(
      "every my_review_queue row carries a non-empty concept TITLE (definer join)",
      weakQueueRpcRows.length > 0 && weakQueueRpcRows.every((r) => typeof r.title === "string" && r.title.trim().length > 0)
    );
    check(
      "the weak learner's top queued concept is node A's title (Scarcity)",
      weakQueueRpcRows.length > 0 && weakQueueRpcRows[0].node_id === A && weakQueueRpcRows[0].title === "Scarcity",
      JSON.stringify(weakQueueRpcRows[0])
    );

    // concept_mastery_aggregate works for the author and raises for a stranger.
    const aggAuthorCall = await authorClient.rpc("concept_mastery_aggregate", { p_course_id: courseId });
    check("concept_mastery_aggregate succeeds for the author", !aggAuthorCall.error, String(aggAuthorCall.error?.message));
    const aggStranger = await strongClient.rpc("concept_mastery_aggregate", { p_course_id: courseId });
    check(
      "concept_mastery_aggregate RAISES 'not the course author' for a stranger",
      aggStranger.error !== null && /not the course author/.test(aggStranger.error?.message ?? ""),
      String(aggStranger.error?.message)
    );
    // A stranger reads ZERO of the aggregate table directly too.
    const strangerAggDirect = await strongClient.from("mastery_course_aggregate").select("node_id").eq("course_id", courseId);
    check("a stranger reads ZERO mastery_course_aggregate rows directly", (strangerAggDirect.data ?? []).length === 0);

    /* ═══════════════ cold start — a 7th zero-evidence learner ═══════════════ */
    console.log("\n— cold start · a 7th zero-evidence learner —");
    const cold = await provisionLearner(env.url, env.anon, "cold");
    // Enroll (through the real RLS insert) but emit NO evidence.
    const enrollCold = await cold.client.from("enrollments").insert({ course_id: courseId, user_id: cold.userId });
    check("cold learner enrolls", !enrollCold.error, String(enrollCold.error?.message));
    const coldRefold = await refoldLearnerCourse(admin, { userId: cold.userId, courseId, nowIso: NOW, cfg: CFG });
    check("zero-evidence refold yields ZERO mastery rows", coldRefold.rows.length === 0 && coldRefold.evidenceCount === 0, `rows=${coldRefold.rows.length} ev=${coldRefold.evidenceCount}`);
    await writeMastery(admin, { userId: cold.userId, courseId, rows: coldRefold.rows, nowIso: NOW });
    await materializeMasteryResults(admin, { nowIso: NOW });
    const coldQueue = await cold.client.rpc("my_review_queue", { p_course_id: courseId });
    check("cold learner's my_review_queue is empty", !coldQueue.error && (coldQueue.data ?? []).length === 0, String(coldQueue.error?.message));
    const coldOwn = await cold.client.from("learner_mastery").select("node_id").eq("course_id", courseId);
    check("cold learner has ZERO own learner_mastery rows", (coldOwn.data ?? []).length === 0);

    /* ═══════════════ ZERO-MODEL-SPEND — after the whole run ═════════════════ */
    console.log("\n# zero-model-spend check (after the full run)");
    const spendAfter = await admin
      .from("learning_events")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId)
      .eq("event_type", "tutor_model_call");
    const spendAfterCount = spendAfter.count ?? 0;
    console.log(`  SQL: ${ZERO_SPEND_SQL}`);
    console.log(`  tutor_model_call count BEFORE = ${spendBeforeCount}`);
    console.log(`  tutor_model_call count AFTER  = ${spendAfterCount}`);
    check("ZERO model spend: tutor_model_call count identical before vs after (both 0)", spendBeforeCount === spendAfterCount && spendAfterCount === 0, `before=${spendBeforeCount} after=${spendAfterCount}`);

    /* ── refold perf line ── */
    const perLearnerAvg = perLearnerMs.length > 0 ? perLearnerMs.reduce((a, b) => a + b, 0) / perLearnerMs.length : 0;
    console.log(
      "\n# refold perf: " +
        JSON.stringify({
          learners: cohort.learners.length,
          totalEvidence,
          perLearnerMs: Math.round(perLearnerAvg),
          totalMs,
        })
    );
  } finally {
    await cleanup();
    console.log("\n# cleaned up course (throwaway users remain — clean in Supabase → Auth)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
