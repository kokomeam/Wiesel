/**
 * TUTOR-1 Wave 2 · package C — PURE verification of the graph-aware mastery
 * queries + the studentHome review-source swap. No DB, no key, no browser.
 * Run: `npx tsx scripts/verify-tutor-queries.ts`
 *
 * Covers lib/tutor/mastery/queries.ts:
 *   • the edge DIRECTION convention (A prereq-of B prereq-of C ⇒ dependents(A)=2);
 *   • downstreamDependencyCount (diamond, missing node, cycle-tolerance);
 *   • weakestNodes ordering + deterministic tiebreak;
 *   • rootCause — AC-T2.5 (chain A→B→C, A below threshold ⇒ rootCause(C)=A),
 *     deeper-ancestor-wins, no-weak-ancestor → null, cycle-tolerance;
 *   • reviewQueue — decay-gap ordering, below-threshold boost, deterministic
 *     ranks, the reason payload golden;
 *   • masteryPercentile ≡ lib/analytics/stats.percentileCont (golden equality);
 *   • the studentHome swap decision (pickReviewSource) + masteryReviewItems;
 *   • a ZERO-model grep guard over queries.ts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  downstreamDependencyCount,
  weakestNodes,
  rootCause,
  reviewQueue,
  masteryPercentile,
  REVIEW_BELOW_THRESHOLD_BOOST,
  type EdgeLike,
  type MasteryLike,
  type ReviewMasteryLike,
} from "@/lib/tutor/mastery/queries";
import { resolveMasteryConfig } from "@/lib/tutor/mastery/config";
import { percentileCont } from "@/lib/analytics/stats";
import {
  pickReviewSource,
  masteryReviewItems,
  type HomeReviewItem,
  type MasteryReviewRow,
  type MasteryLevelRow,
} from "@/lib/learn/studentHome";

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

/** A 'prerequisite' edge helper: source is the prereq, target depends on it. */
function pre(source: string, target: string): EdgeLike {
  return { sourceNodeId: source, targetNodeId: target, kind: "prerequisite" };
}

const cfg = resolveMasteryConfig(); // masteryThreshold = 0.6

function main() {
  /* ── DIRECTION convention + downstreamDependencyCount ── */
  console.log("\n— downstreamDependencyCount (direction convention) —");
  // A prereq-of B prereq-of C  ⇒  A→B→C.  Dependents(A) = {B, C} = 2.
  const chain: EdgeLike[] = [pre("A", "B"), pre("B", "C")];
  check("A prereq-of B prereq-of C ⇒ dependents(A) = 2", downstreamDependencyCount(chain, "A") === 2);
  check("dependents(B) = 1 (only C)", downstreamDependencyCount(chain, "B") === 1);
  check("dependents(C) = 0 (leaf)", downstreamDependencyCount(chain, "C") === 0);
  check("dependents of a node absent from the graph = 0", downstreamDependencyCount(chain, "Z") === 0);

  // Diamond A→B, A→C, B→D, C→D ⇒ dependents(A) = {B,C,D} = 3 (D counted once).
  const diamond: EdgeLike[] = [pre("A", "B"), pre("A", "C"), pre("B", "D"), pre("C", "D")];
  check("diamond dependents(A) = 3 (D deduped)", downstreamDependencyCount(diamond, "A") === 3);

  // Non-prerequisite edges are ignored.
  const mixed: EdgeLike[] = [pre("A", "B"), { sourceNodeId: "A", targetNodeId: "X", kind: "related" }];
  check("related/part_of edges ignored for leverage", downstreamDependencyCount(mixed, "A") === 1);

  // Cycle tolerance: A→B→C→A must terminate. Reachable from A (excluding A) = {B,C}.
  const cycle: EdgeLike[] = [pre("A", "B"), pre("B", "C"), pre("C", "A")];
  check("cyclic graph terminates; dependents(A) = 2", downstreamDependencyCount(cycle, "A") === 2);
  check("self-loop contributes no dependents", downstreamDependencyCount([pre("A", "A")], "A") === 0);

  /* ── weakestNodes ── */
  console.log("\n— weakestNodes —");
  // A low-mastery high-leverage node beats a lower-mastery zero-leverage one.
  const wMastery: MasteryLike[] = [
    { nodeId: "A", decayedP: 0.5 }, // (1-0.5)*(1+2)=1.5
    { nodeId: "B", decayedP: 0.5 }, // (1-0.5)*(1+1)=1.0
    { nodeId: "C", decayedP: 0.2 }, // (1-0.8)... leaf: (0.8)*(1+0)=0.8
  ];
  const weakest = weakestNodes(wMastery, chain, 10, cfg);
  check("weakest ordered by (1-mastery)×(1+dependents) desc", weakest[0].nodeId === "A" && weakest[1].nodeId === "B" && weakest[2].nodeId === "C");
  check("weakest score(A) = 1.5", Math.abs(weakest[0].score - 1.5) < 1e-9);
  check("weakest dependents count attached", weakest[0].dependents === 2);
  check("limit respected", weakestNodes(wMastery, chain, 1, cfg).length === 1);
  check("limit ≤ 0 → empty", weakestNodes(wMastery, chain, 0, cfg).length === 0);
  // Deterministic tiebreak by nodeId ascending on equal scores.
  const tie: MasteryLike[] = [
    { nodeId: "zeta", decayedP: 0.5 },
    { nodeId: "alpha", decayedP: 0.5 },
  ];
  const tied = weakestNodes(tie, [], 10, cfg);
  check("equal-score tiebreak by nodeId asc", tied[0].nodeId === "alpha" && tied[1].nodeId === "zeta");

  /* ── rootCause — AC-T2.5 + deeper-wins + null ── */
  console.log("\n— rootCause (AC-T2.5) —");
  // AC-T2.5: chain A→B→C, A below threshold, B/C above ⇒ rootCause(C) = A.
  const acMastery: MasteryLike[] = [
    { nodeId: "A", decayedP: 0.3 }, // below 0.6
    { nodeId: "B", decayedP: 0.8 }, // above
    { nodeId: "C", decayedP: 0.9 }, // above
  ];
  check("AC-T2.5: rootCause(C) = A (deepest below-threshold ancestor)", rootCause(acMastery, chain, "C", cfg) === "A");

  // Deeper-ancestor-wins: A weak AND B weak ⇒ A (the deeper one, distance 2 from C).
  const bothWeak: MasteryLike[] = [
    { nodeId: "A", decayedP: 0.3 },
    { nodeId: "B", decayedP: 0.4 },
    { nodeId: "C", decayedP: 0.9 },
  ];
  check("deeper ancestor wins (A over B)", rootCause(bothWeak, chain, "C", cfg) === "A");

  // Only B weak ⇒ B (nearest weak ancestor is the only one).
  const onlyBWeak: MasteryLike[] = [
    { nodeId: "A", decayedP: 0.9 },
    { nodeId: "B", decayedP: 0.4 },
    { nodeId: "C", decayedP: 0.9 },
  ];
  check("only-B-weak ⇒ rootCause(C) = B", rootCause(onlyBWeak, chain, "C", cfg) === "B");

  // No below-threshold ancestor ⇒ null.
  const noneWeak: MasteryLike[] = [
    { nodeId: "A", decayedP: 0.9 },
    { nodeId: "B", decayedP: 0.9 },
    { nodeId: "C", decayedP: 0.3 }, // target itself weak — but target is excluded
  ];
  check("no weak ancestor ⇒ null (target itself excluded)", rootCause(noneWeak, chain, "C", cfg) === null);

  // Tie in depth → deterministic nodeId asc. Two ancestors X,Y both at distance 1
  // from T (X→T, Y→T), both below threshold ⇒ pick 'X' (asc).
  const tieDepth: EdgeLike[] = [pre("X", "T"), pre("Y", "T")];
  const tieDepthMastery: MasteryLike[] = [
    { nodeId: "X", decayedP: 0.2 },
    { nodeId: "Y", decayedP: 0.2 },
  ];
  check("depth-tie broken by nodeId asc", rootCause(tieDepthMastery, tieDepth, "T", cfg) === "X");

  // Cycle tolerance in rootCause: A→B→C→A, target C, A weak ⇒ terminates, A found.
  const cycleMastery: MasteryLike[] = [
    { nodeId: "A", decayedP: 0.3 },
    { nodeId: "B", decayedP: 0.9 },
  ];
  check("rootCause tolerates a cycle (terminates)", rootCause(cycleMastery, cycle, "C", cfg) === "A");

  /* ── reviewQueue ── */
  console.log("\n— reviewQueue —");
  const nowIso = "2026-08-03T00:00:00Z";
  // Decay-gap ordering (all above threshold so no boost interferes):
  //   N3: gap 0.4, deps 0 → 0.4  (highest)
  //   N1: gap 0.1, deps 2 → 0.3 ;  N2: gap 0.1, deps 2 → 0.3  → EXACT tie (same
  //   gap + same deps, distinct nodeIds) so the tiebreak is genuinely exercised.
  const rqEdges: EdgeLike[] = [pre("N1", "x1"), pre("x1", "y1"), pre("N2", "x2"), pre("x2", "y2")]; // deps(N1)=deps(N2)=2
  const rqMastery: ReviewMasteryLike[] = [
    { nodeId: "N1", pLearned: 0.8, decayedP: 0.7, lastPositiveAt: null }, // gap .1 ×3 = .3
    { nodeId: "N2", pLearned: 0.8, decayedP: 0.7, lastPositiveAt: null }, // gap .1 ×3 = .3 (exact tie w/ N1)
    { nodeId: "N3", pLearned: 1.0, decayedP: 0.6, lastPositiveAt: null }, // gap .4, at threshold (not below)
  ];
  const rq = reviewQueue(rqMastery, rqEdges, nowIso, 10, cfg);
  check("reviewQueue ranks are 1-based + contiguous", rq[0].rank === 1 && rq[1].rank === 2 && rq[2].rank === 3);
  check("highest score first (N3 gap .4)", rq[0].nodeId === "N3");
  check("score(N3) = 0.4", Math.abs(rq[0].score - 0.4) < 1e-9);
  check("exact-tie broken by nodeId asc (N1 before N2)", rq[1].nodeId === "N1" && rq[2].nodeId === "N2");
  check("reason payload golden (N1: gap .1, deps 2, below=false)", (() => {
    const n1 = rq.find((r) => r.nodeId === "N1")!;
    return Math.abs(n1.reason.decayGap - 0.1) < 1e-9 && n1.reason.dependents === 2 && n1.reason.belowThreshold === false;
  })());

  // Below-threshold boost: a below-threshold node with a tiny gap still outranks a
  // slightly-larger-gap above-threshold node once the flat boost applies.
  const boostMastery: ReviewMasteryLike[] = [
    { nodeId: "above", pLearned: 0.9, decayedP: 0.7, lastPositiveAt: null }, // gap .2, deps 0 → .2
    { nodeId: "below", pLearned: 0.4, decayedP: 0.3, lastPositiveAt: null }, // gap .1, deps 0, below → .1+boost
  ];
  const boosted = reviewQueue(boostMastery, [], nowIso, 10, cfg);
  check("below-threshold boost lifts a small-gap node above a larger-gap one", boosted[0].nodeId === "below");
  check("below-threshold flag set + boost applied", (() => {
    const b = boosted.find((r) => r.nodeId === "below")!;
    return b.reason.belowThreshold === true && Math.abs(b.score - (0.1 + REVIEW_BELOW_THRESHOLD_BOOST)) < 1e-9;
  })());
  check("reviewQueue limit respected", reviewQueue(rqMastery, rqEdges, nowIso, 1, cfg).length === 1);
  check("reviewQueue limit ≤ 0 → empty", reviewQueue(rqMastery, rqEdges, nowIso, 0, cfg).length === 0);
  // Determinism: same input ⇒ byte-identical output.
  check("reviewQueue deterministic (identical JSON on re-run)", JSON.stringify(reviewQueue(rqMastery, rqEdges, nowIso, 10, cfg)) === JSON.stringify(rq));
  // Cycle-tolerant reviewQueue.
  const rqCycle = reviewQueue(
    [{ nodeId: "A", pLearned: 1, decayedP: 0.5, lastPositiveAt: null }],
    cycle,
    nowIso,
    10,
    cfg
  );
  check("reviewQueue tolerates a cyclic graph", rqCycle.length === 1 && rqCycle[0].reason.dependents === 2);

  /* ── masteryPercentile ≡ percentileCont (golden equality) ── */
  console.log("\n— masteryPercentile mirrors analytics.percentileCont —");
  const fixtures: number[][] = [
    [],
    [0.5],
    [0.2, 0.8],
    [0.1, 0.3, 0.6, 0.9],
    [0.15, 0.15, 0.4, 0.55, 0.7, 0.95, 1.0],
  ];
  const ps = [0.25, 0.5, 0.75];
  let percentileMatch = true;
  for (const f of fixtures) {
    for (const p of ps) {
      if (masteryPercentile(f, p) !== percentileCont(f, p)) percentileMatch = false;
    }
  }
  check("masteryPercentile === percentileCont on every shared fixture×p", percentileMatch);
  check("empty → null", masteryPercentile([], 0.5) === null);

  /* ── studentHome swap: pickReviewSource ── */
  console.log("\n— pickReviewSource (studentHome swap) —");
  const heuristic: HomeReviewItem[] = [
    { key: "b1", quizTitle: "Quiz", lessonTitle: "L", courseTitle: "C", scorePct: 40, href: "/x" },
  ];
  const mastery: HomeReviewItem[] = [
    { key: "n1", quizTitle: "Concept", lessonTitle: "Below mastery", courseTitle: "C", scorePct: 30, href: "/y" },
  ];
  const srcMastery = pickReviewSource(mastery, heuristic);
  check("mastery rows present ⇒ source = mastery", srcMastery.source === "mastery" && srcMastery.rows[0].key === "n1");
  const srcHeuristic = pickReviewSource([], heuristic);
  check("mastery empty ⇒ source = heuristic (cold start)", srcHeuristic.source === "heuristic" && srcHeuristic.rows[0].key === "b1");
  const srcBothEmpty = pickReviewSource<HomeReviewItem, HomeReviewItem>([], []);
  check("both empty ⇒ heuristic (empty)", srcBothEmpty.source === "heuristic" && srcBothEmpty.rows.length === 0);

  /* ── masteryReviewItems mapping ── */
  console.log("\n— masteryReviewItems —");
  const rows: MasteryReviewRow[] = [
    { node_id: "n1", title: "Recursion", rank: 1, score: 2, reason: { belowThreshold: true, dependents: 3, decayGap: 0.4 } },
    { node_id: "n2", title: "Big-O", rank: 2, score: 1, reason: { belowThreshold: false, dependents: 1, decayGap: 0.2 } },
    { node_id: "n3", title: null, rank: 3, score: 1, reason: {} }, // untitled → skipped
    { node_id: "n4", title: "  ", rank: 4, score: 1, reason: {} }, // whitespace → skipped
  ];
  const levels: MasteryLevelRow[] = [
    { node_id: "n1", decayed_p: 0.3 },
    { node_id: "n2", decayed_p: 0.75 },
  ];
  const items = masteryReviewItems(rows, "Algorithms", "/learn/algos", levels);
  check("untitled + whitespace-title rows skipped (never a uuid)", items.length === 2 && items.every((i) => i.key === "n1" || i.key === "n2"));
  check("rank order preserved", items[0].key === "n1" && items[1].key === "n2");
  check("title → quizTitle (the concept to review)", items[0].quizTitle === "Recursion");
  check("below-threshold → 'Below mastery' label", items[0].lessonTitle === "Below mastery");
  check("above-threshold-but-fading → 'Fading' label", items[1].lessonTitle.startsWith("Fading"));
  check("pill = current mastery level % from own learner_mastery (n1: 30%)", items[0].scorePct === 30);
  check("pill uses learner_mastery decayed_p (n2: 75%)", items[1].scorePct === 75);
  check("href → course landing", items[0].href === "/learn/algos" && items[0].courseTitle === "Algorithms");
  // Fallback pct from decayGap when no own learner_mastery level exists.
  const noLevel = masteryReviewItems(
    [{ node_id: "z", title: "Z", rank: 1, score: 1, reason: { decayGap: 0.25 } }],
    "C",
    "/learn/c",
    []
  );
  check("no own mastery row ⇒ pct falls back to 1-decayGap (75%)", noLevel[0].scorePct === 75);

  /* ── ZERO-model grep guard ── */
  console.log("\n— zero-model guard —");
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "lib", "tutor", "mastery", "queries.ts"), "utf8");
  const forbidden = /modelClient|ModelClient|providers\/openai|runSubagent|runStructured|OpenAI|generateImage|inspectImage/;
  check("queries.ts imports/references NO model client (zero model calls)", !forbidden.test(src));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
