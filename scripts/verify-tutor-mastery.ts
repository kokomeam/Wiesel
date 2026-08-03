/**
 * Tutor MASTERY — PURE suite (no key, no DB, no browser). TUTOR-1 Wave 2.
 *
 * Every golden below is HAND-COMPUTED to 4+ decimals with the arithmetic shown
 * in a comment beside the assertion — a silent change to the BKT recurrence,
 * the decay curve, the weight table, or the lineage fan-out trips it. Sections:
 *
 *   AC-T2.1  BKT goldens — the correct/wrong recurrence + the learning transition
 *            + the weighted blend, chained (3-corrects, 2-wrongs, mixed, a w=0.5
 *            blend), each value hand-derived.
 *   AC-A1.2  Ordinal golden — a wrong@1 / right@2 / right@3 chain weighted by the
 *            attempt-ordinal table differs from the unweighted control, and
 *            matches the hand computation.
 *   AC-T2.2  Decay goldens — 0 days unchanged; exactly one half-life = the
 *            midpoint to P_L0; evidence-count scales the half-life; the floor.
 *   AC-T2.3  Refold determinism — identical input ⇒ JSON-identical output; a
 *            pre-sorted shuffle of the SAME (at,sourceId) keys is identical; a
 *            split fans onto children; an inactive target drops silently.
 *   AC-T1.7b Lineage goldens — a split@0.75 child vs a direct-evidence control;
 *            a merge combines in timestamp order; a retired-no-lineage id
 *            self-resolves then DROPS when inactive without error; a merged→split
 *            chain multiplies factors.
 *   DRIFT    every documented weight/config default pinned to its literal.
 *   GUARD    the ZERO-MODEL grep over lib/tutor/mastery/ + the config override seam.
 *
 * Run: `npx tsx scripts/verify-tutor-mastery.ts`
 */

import { readFileSync, readdirSync } from "node:fs";
import {
  resolveMasteryConfig,
  MASTERY_MIN_COHORT,
  TUTOR_BKT_PL0,
  TUTOR_BKT_PT,
  TUTOR_BKT_PS,
  TUTOR_BKT_PG,
  TUTOR_DECAY_HALFLIFE_DAYS,
  TUTOR_MASTERY_THRESHOLD,
  TUTOR_DWELL_OVER_MEDIAN_MULT,
} from "@/lib/tutor/mastery/config";
import { updateBkt, decay } from "@/lib/tutor/mastery/bkt";
import {
  ORDINAL_WEIGHTS,
  ordinalWeight,
  hintWeight,
  contentEngagementWeight,
  tutorInferenceWeight,
  SELF_REPORT_WEIGHT,
  HISTORICAL_DETAILLESS_FACTOR,
  HISTORICAL_PASS_FRACTION,
  DWELL_OVER_MEDIAN_WEIGHT,
} from "@/lib/tutor/mastery/weights";
import { resolveNodeId, type LineageIndex } from "@/lib/tutor/mastery/lineage";
import { refoldMastery } from "@/lib/tutor/mastery/refold";
import { assembleEvidence, type MasteryEvidence } from "@/lib/tutor/mastery/evidence";

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
/** Approx-equal to 6 decimals (goldens are computed to that precision). */
function eq(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

const cfg = resolveMasteryConfig();

function main() {
  /* ─────────────────────── AC-T2.1  BKT goldens ──────────────────────────── */
  console.log("\nAC-T2.1 — BKT recurrence goldens (hand-computed, defaults P_L0=.25 T=.20 S=.10 G=.20)");

  // correct #1 from .25, w=1:
  //   post = .25·(1−.10) / (.25·(1−.10) + (1−.25)·.20)
  //        = .225 / (.225 + .150) = .225/.375 = 0.600000
  //   learned = .600000 + (1−.600000)·.20 = .600000 + .080000 = 0.680000
  const c1 = updateBkt(0.25, true, 1, cfg);
  check("correct#1 from .25 w=1 → 0.680000", eq(c1, 0.68), `got ${c1}`);

  // correct #2 from .680000:
  //   post = .68·.9 / (.68·.9 + .32·.2) = .612 / (.612 + .064) = .612/.676 = 0.905325…
  //   learned = .905325 + .094675·.2 = .905325 + .018935 = 0.924260
  const c2 = updateBkt(c1, true, 1, cfg);
  check("correct#2 from .68 w=1 → 0.924260", eq(c2, 0.92426), `got ${c2}`);

  // correct #3 from .924260 → 0.985692 (chained; see goldens.mjs derivation)
  const c3 = updateBkt(c2, true, 1, cfg);
  check("correct#3 chained → 0.985692", eq(c3, 0.985692), `got ${c3}`);

  // wrong #1 from .25, w=1:
  //   post = .25·.10 / (.25·.10 + .75·(1−.20)) = .025 / (.025 + .600) = .025/.625 = 0.040000
  //   learned = .040000 + (1−.040000)·.20 = .040000 + .192000 = 0.232000
  const w1 = updateBkt(0.25, false, 1, cfg);
  check("wrong#1 from .25 w=1 → 0.232000", eq(w1, 0.232), `got ${w1}`);

  // wrong #2 from .232000 → 0.229109 (chained)
  const w2 = updateBkt(w1, false, 1, cfg);
  check("wrong#2 chained → 0.229109", eq(w2, 0.229109), `got ${w2}`);

  // mixed C,W,C from .25 → 0.680000 → 0.367901 → 0.778953
  let m = updateBkt(0.25, true, 1, cfg);
  m = updateBkt(m, false, 1, cfg);
  check("mixed after C,W → 0.367901", eq(m, 0.367901), `got ${m}`);
  m = updateBkt(m, true, 1, cfg);
  check("mixed after C,W,C → 0.778953", eq(m, 0.778953), `got ${m}`);

  // WEIGHTED blend, w=0.5, one correct from .25:
  //   full = 0.680000 (the w=1 update); blend = .5·.680000 + .5·.250000 = .340000 + .125000 = 0.465000
  const blend = updateBkt(0.25, true, 0.5, cfg);
  check("w=0.5 blend, one correct from .25 → 0.465000", eq(blend, 0.465), `got ${blend}`);
  check("w=0.5 blend equals ½·full + ½·prior", eq(blend, 0.5 * 0.68 + 0.5 * 0.25));

  /* ─────────────────────── AC-A1.2  ordinal golden ───────────────────────── */
  console.log("\nAC-A1.2 — attempt-ordinal weighting golden");

  // wrong@1 (w=1.0) → 0.232000 ; right@2 (w=0.5) → 0.446464 ; right@3 (w=0.15) → 0.503574
  let o = updateBkt(0.25, false, ordinalWeight(1), cfg);
  check("ordinal wrong@1 (w=1.0) → 0.232000", eq(o, 0.232), `got ${o}`);
  o = updateBkt(o, true, ordinalWeight(2), cfg);
  check("ordinal right@2 (w=0.5) → 0.446464", eq(o, 0.446464), `got ${o}`);
  o = updateBkt(o, true, ordinalWeight(3), cfg);
  check("ordinal right@3 (w=0.15) → 0.503574", eq(o, 0.503574), `got ${o}`);

  // the unweighted control (all w=1) lands much higher (0.918129) — retry
  // contamination is really being discounted.
  let u = updateBkt(0.25, false, 1, cfg);
  u = updateBkt(u, true, 1, cfg);
  u = updateBkt(u, true, 1, cfg);
  check("unweighted control (all w=1) → 0.918129", eq(u, 0.918129), `got ${u}`);
  check("ordinal-weighted < unweighted (contamination discounted)", o < u);
  check("ordinal ≥3 clamps to the floor 0.15", ordinalWeight(3) === 0.15 && ordinalWeight(9) === 0.15);

  /* ─────────────────────── AC-T2.2  decay goldens ────────────────────────── */
  console.log("\nAC-T2.2 — forgetting-curve goldens");

  // start from the 3-correct estimate p3 = 0.985692
  const p3 = c3;
  check("decay 0 days → unchanged", eq(decay(p3, 0, 3, cfg), p3));
  check("decay negative days → unchanged", eq(decay(p3, -5, 3, cfg), p3));

  // halfLife(count=3) = 30·(1 + ln(1+3)) = 30·(1 + ln4) = 30·2.386294… = 71.588831
  const hl3 = 30 * (1 + Math.log(4));
  //   decayed at exactly one half-life = P_L0 + (p − P_L0)·2^(−1) = midpoint to P_L0
  const midpoint = 0.25 + (p3 - 0.25) / 2; // 0.617846
  check("decay at one half-life (count=3) → midpoint to P_L0 (0.617846)", eq(decay(p3, hl3, 3, cfg), midpoint), `mid=${midpoint}`);

  // evidence-count SCALES the half-life: count=0 → halfLife=30; at 30 days that's
  // one half-life for count=0, so ALSO the midpoint — but count=3 at 30 days
  // decays LESS (its half-life is longer). Direct golden + monotonicity.
  check("halfLife(count=0)=30 → decay at 30 days is the midpoint too", eq(decay(p3, 30, 0, cfg), midpoint));
  check("more evidence ⇒ slower decay (count=3 keeps more than count=0 at 30 days)", decay(p3, 30, 3, cfg) > decay(p3, 30, 0, cfg));

  // FLOOR: decay never drops below P_L0, and an estimate at/below the floor is a no-op.
  check("decay huge days → floors at P_L0 (0.25)", eq(decay(p3, 100000, 3, cfg), 0.25));
  check("decay of an at-floor estimate → the floor unchanged", eq(decay(0.25, 50, 3, cfg), 0.25));
  check("decay of a below-floor estimate → the floor (never below)", eq(decay(0.2, 50, 3, cfg), 0.25));

  /* ─────────────────────── AC-T2.3  refold determinism ───────────────────── */
  console.log("\nAC-T2.3 — refold determinism");

  const active = new Set(["A", "B"]);
  const emptyLineage: LineageIndex = { mergedInto: new Map(), splitInto: new Map() };
  const now = "2026-08-03T00:00:00.000Z";

  // A pre-sorted evidence stream (assembleEvidence produces this order).
  const raw: MasteryEvidence[] = [
    { nodeId: "A", direction: 1, weight: 1, at: "2026-07-01T00:00:00.000Z", sourceId: "s1", kind: "quiz_detail" },
    { nodeId: "A", direction: -1, weight: 0.5, at: "2026-07-02T00:00:00.000Z", sourceId: "s2", kind: "practice_answer" },
    { nodeId: "B", direction: 1, weight: 0.25, at: "2026-07-02T00:00:00.000Z", sourceId: "s3", kind: "self_report" },
    { nodeId: "A", direction: 1, weight: 1, at: "2026-07-03T00:00:00.000Z", sourceId: "s4", kind: "quiz_detail" },
  ];
  const sorted = assembleEvidence([raw]);
  const out1 = refoldMastery(sorted, active, emptyLineage, now, cfg);
  const out2 = refoldMastery(sorted, active, emptyLineage, now, cfg);
  check("identical input ⇒ JSON-identical output", JSON.stringify(out1) === JSON.stringify(out2));
  check("output sorted by nodeId", out1[0].nodeId === "A" && out1[1].nodeId === "B");
  check("evidenceCount per node correct (A:3, B:1)", out1[0].evidenceCount === 3 && out1[1].evidenceCount === 1);
  check("lastPositiveAt = latest positive (A → 2026-07-03)", out1[0].lastPositiveAt === "2026-07-03T00:00:00.000Z");
  check("decayedP ≤ pLearned everywhere", out1.every((r) => r.decayedP <= r.pLearned + 1e-9));

  // A shuffle of the SAME rows, re-assembled (assembleEvidence re-sorts to the
  // canonical (at,sourceId) order) ⇒ identical output — order can't leak.
  const shuffled = assembleEvidence([[raw[3], raw[0], raw[2], raw[1]]]);
  const out3 = refoldMastery(shuffled, active, emptyLineage, now, cfg);
  check("shuffle re-assembled ⇒ identical output", JSON.stringify(out1) === JSON.stringify(out3));

  // An inactive target drops SILENTLY — evidence on a node not in the active set
  // produces no row (never an error).
  const outActiveOnly = refoldMastery(sorted, new Set(["A"]), emptyLineage, now, cfg);
  check("inactive target dropped silently (only A survives)", outActiveOnly.length === 1 && outActiveOnly[0].nodeId === "A");

  /* ─────────────────────── AC-T1.7b  lineage goldens ─────────────────────── */
  console.log("\nAC-T1.7b — lineage resolution goldens (pure-half hand-computed)");

  // resolveNodeId: a straight active id → itself at factor 1.
  const rSelf = resolveNodeId(emptyLineage, "X");
  check("active/unknown id → self at factor 1", rSelf.targets.length === 1 && rSelf.targets[0].nodeId === "X" && rSelf.targets[0].factor === 1);

  // SPLIT@0.75: parent P → children [C1, C2] at factor 0.75.
  const splitLineage: LineageIndex = {
    mergedInto: new Map(),
    splitInto: new Map([["P", { children: ["C1", "C2"], confidenceFactor: 0.75 }]]),
  };
  const rSplit = resolveNodeId(splitLineage, "P");
  check("split parent → 2 children at factor 0.75", rSplit.targets.length === 2 && rSplit.targets.every((t) => t.factor === 0.75));

  // The split child's folded estimate: one correct on the PARENT, factor 0.75 ⇒
  // effective w = 1·0.75 = 0.75:
  //   full = 0.680000 ; blend = .75·.680000 + .25·.250000 = .510000 + .062500 = 0.572500
  // The DIRECT-EVIDENCE control (one correct at w=1 straight on C1) = 0.680000.
  const controlOneCorrect = updateBkt(0.25, true, 1, cfg); // 0.68
  const splitChildFold = refoldMastery(
    [{ nodeId: "P", direction: 1, weight: 1, at: "2026-07-01T00:00:00.000Z", sourceId: "s", kind: "quiz_detail" }],
    new Set(["C1", "C2"]),
    splitLineage,
    now,
    cfg
  );
  check("split child folds parent evidence at w=0.75 → 0.572500", eq(splitChildFold[0].pLearned, 0.5725), `got ${splitChildFold[0].pLearned}`);
  check("split child (0.572500) < direct-evidence control (0.680000)", splitChildFold[0].pLearned < controlOneCorrect);
  check("both children got the fan-out row", splitChildFold.length === 2 && eq(splitChildFold[1].pLearned, 0.5725));

  // MERGE: absorbed id → survivor at factor 1; evidence combines IN TIMESTAMP
  // ORDER on the survivor. Two positives on the absorbed id fold as two survivor
  // observations (0.25 → 0.680000 → 0.924260).
  const mergeLineage: LineageIndex = {
    mergedInto: new Map([["OLD", "SURV"]]),
    splitInto: new Map(),
  };
  const rMerge = resolveNodeId(mergeLineage, "OLD");
  check("merged id → survivor at factor 1", rMerge.targets.length === 1 && rMerge.targets[0].nodeId === "SURV" && rMerge.targets[0].factor === 1);
  const mergeFold = refoldMastery(
    assembleEvidence([[
      { nodeId: "OLD", direction: 1, weight: 1, at: "2026-07-01T00:00:00.000Z", sourceId: "a", kind: "quiz_detail" },
      { nodeId: "SURV", direction: 1, weight: 1, at: "2026-07-02T00:00:00.000Z", sourceId: "b", kind: "quiz_detail" },
    ]]),
    new Set(["SURV"]),
    mergeLineage,
    now,
    cfg
  );
  check("merge combines absorbed+survivor evidence in order → 0.924260", eq(mergeFold[0].pLearned, 0.92426) && mergeFold[0].evidenceCount === 2, `got ${mergeFold[0].pLearned}`);

  // RETIRED, no lineage: self-resolves, then DROPS when it isn't active — no error,
  // no row.
  const retiredFold = refoldMastery(
    [{ nodeId: "RETIRED", direction: 1, weight: 1, at: "2026-07-01T00:00:00.000Z", sourceId: "r", kind: "quiz_detail" }],
    new Set(["OTHER"]), // RETIRED not active
    emptyLineage,
    now,
    cfg
  );
  check("retired-no-lineage id self-resolves then drops when inactive (no error, no row)", retiredFold.length === 0);

  // MERGED→SPLIT chain: OLD merges into MID, MID splits into [C1,C2] at 0.5 ⇒ each
  // child inherits factor 1·0.5 = 0.5.
  const chainLineage: LineageIndex = {
    mergedInto: new Map([["OLD", "MID"]]),
    splitInto: new Map([["MID", { children: ["C1", "C2"], confidenceFactor: 0.5 }]]),
  };
  const rChain = resolveNodeId(chainLineage, "OLD");
  check("merged→split chain multiplies factors (1·0.5=0.5) onto each child", rChain.targets.length === 2 && rChain.targets.every((t) => t.factor === 0.5));

  // A two-level split (0.75 then 0.5) multiplies to 0.375 → effective w on one
  // correct = 0.375: blend = .375·.68 + .625·.25 = .255 + .15625 = 0.411250.
  const twoSplit: LineageIndex = {
    mergedInto: new Map(),
    splitInto: new Map([
      ["P", { children: ["Q"], confidenceFactor: 0.75 }],
      ["Q", { children: ["R"], confidenceFactor: 0.5 }],
    ]),
  };
  const rTwo = resolveNodeId(twoSplit, "P");
  check("two-level split multiplies to 0.375", rTwo.targets.length === 1 && eq(rTwo.targets[0].factor, 0.375));
  const twoFold = refoldMastery(
    [{ nodeId: "P", direction: 1, weight: 1, at: "2026-07-01T00:00:00.000Z", sourceId: "s", kind: "quiz_detail" }],
    new Set(["R"]),
    twoSplit,
    now,
    cfg
  );
  check("two-level split child folds at w=0.375 → 0.411250", eq(twoFold[0].pLearned, 0.41125), `got ${twoFold[0].pLearned}`);

  /* ─────────────────────── DRIFT — pinned defaults ───────────────────────── */
  console.log("\nDRIFT — every documented default pinned to its literal");

  check("P_L0 = 0.25", TUTOR_BKT_PL0 === 0.25);
  check("P_T = 0.20", TUTOR_BKT_PT === 0.2);
  check("P_S = 0.10", TUTOR_BKT_PS === 0.1);
  check("P_G = 0.20", TUTOR_BKT_PG === 0.2);
  check("decay base half-life = 30 days", TUTOR_DECAY_HALFLIFE_DAYS === 30);
  check("mastery threshold = 0.6", TUTOR_MASTERY_THRESHOLD === 0.6);
  check("MASTERY_MIN_COHORT = 5 (D-4 TS mirror)", MASTERY_MIN_COHORT === 5);
  check("dwell-over-median multiple = 2", TUTOR_DWELL_OVER_MEDIAN_MULT === 2);

  check("ordinal weights = [1.0, 0.5, 0.15]", ORDINAL_WEIGHTS[0] === 1.0 && ORDINAL_WEIGHTS[1] === 0.5 && ORDINAL_WEIGHTS[2] === 0.15);
  check("hint rung 0 → +0.10 positive", hintWeight(0).direction === 1 && hintWeight(0).weight === 0.1);
  check("hint rung 1 → +0.10 positive", hintWeight(1).direction === 1 && hintWeight(1).weight === 0.1);
  check("hint rung 2 → −0.15 negative", hintWeight(2).direction === -1 && hintWeight(2).weight === 0.15);
  check("hint rung 3 → −0.15 negative", hintWeight(3).direction === -1 && hintWeight(3).weight === 0.15);
  check("hint rung 4 → −0.30 negative", hintWeight(4).direction === -1 && hintWeight(4).weight === 0.3);
  check("self_report weight = 0.25 (±)", SELF_REPORT_WEIGHT === 0.25);
  check("tutor_inference weak = 0.10", tutorInferenceWeight("weak") === 0.1);
  check("tutor_inference moderate = 0.25", tutorInferenceWeight("moderate") === 0.25);
  check("content completed → +0.10", contentEngagementWeight("completed").direction === 1 && contentEngagementWeight("completed").weight === 0.1);
  check("content rewatch → −0.05", contentEngagementWeight("rewatch").direction === -1 && contentEngagementWeight("rewatch").weight === 0.05);
  check("content scrub_back → −0.05", contentEngagementWeight("scrub_back").direction === -1 && contentEngagementWeight("scrub_back").weight === 0.05);
  check("historical detail-less factor = 0.3", HISTORICAL_DETAILLESS_FACTOR === 0.3);
  check("historical pass fraction = 0.6", HISTORICAL_PASS_FRACTION === 0.6);
  check("dwell-over-median weight = 0.05 (negative)", DWELL_OVER_MEDIAN_WEIGHT === 0.05);

  /* ─────────────────────── GUARD — zero-model + config seam ──────────────── */
  console.log("\nGUARD — zero-model grep + config override seam");

  // ZERO-MODEL grep over lib/tutor/mastery/*: no module may import a model client
  // or the structured-call/loop primitives — the whole wave is deterministic math.
  const masteryDir = new URL("../lib/tutor/mastery/", import.meta.url);
  const files = readdirSync(masteryDir).filter((f) => f.endsWith(".ts"));
  const forbidden = /(TUTOR_MODELS|modelClient|runStructuredCall|createOpenAIModelClient|from ["']@\/lib\/ai\/providers|@\/lib\/ai\/modelClient|withSemaphore)/;
  let modelLeak = "";
  for (const f of files) {
    const src = readFileSync(new URL(f, masteryDir), "utf8");
    if (forbidden.test(src)) modelLeak = f;
  }
  check("ZERO-MODEL: no mastery module imports a model client/loop primitive", modelLeak === "", `leak in ${modelLeak}`);
  check("mastery dir has the 8 modules on disk", files.length >= 8, `found ${files.length}: ${files.join(",")}`);

  // The refold Inngest function must carry NO model client either (the assembly
  // pattern minus the model).
  const fnSrc = readFileSync(new URL("../lib/inngest/functions/tutorMastery.ts", import.meta.url), "utf8");
  check("tutor-mastery Inngest fn imports no model client", !/createOpenAIModelClient|withSemaphore|@\/lib\/ai\/providers/.test(fnSrc));
  check("tutor-mastery Inngest fn declares the refold concurrency key", fnSrc.includes('event.data.userId + \\":\\" + event.data.courseId') || fnSrc.includes('event.data.userId + ":" + event.data.courseId'));
  check("nightly cron is 0 4 * * *", /cron:\s*["']0 4 \* \* \*["']/.test(fnSrc));
  check("nightly defensively dynamic-imports queries.materializeMasteryResults", fnSrc.includes('import("./../../tutor/mastery/queries")') && fnSrc.includes("materializeMasteryResults"));

  // The event surface constant is exported at the pinned name.
  const evSrc = readFileSync(new URL("../lib/inngest/tutorMasteryEvents.ts", import.meta.url), "utf8");
  check("refold event name = tutor/mastery.refold.requested", evSrc.includes('"tutor/mastery.refold.requested"'));
  check("best-effort sender never throws (try/catch + console.log)", /try\s*\{[\s\S]*inngest\.send[\s\S]*\}\s*catch/.test(evSrc));

  // Both functions are registered in the serve route.
  const routeSrc = readFileSync(new URL("../app/api/inngest/route.ts", import.meta.url), "utf8");
  check("serve route registers tutorMasteryRefold + tutorMasteryNightly", routeSrc.includes("tutorMasteryRefold") && routeSrc.includes("tutorMasteryNightly"));

  // CONFIG OVERRIDE SEAM: resolveMasteryConfig takes overrides and they win.
  const overridden = resolveMasteryConfig({ pL0: 0.4, masteryThreshold: 0.7 });
  check("config override seam: pL0 override wins", overridden.pL0 === 0.4);
  check("config override seam: threshold override wins", overridden.masteryThreshold === 0.7);
  check("config override seam: un-overridden knobs keep defaults", overridden.pT === 0.2 && overridden.pG === 0.2);
  // An override changes the decay FLOOR (pL0) — a fold with the override floors higher.
  const overFloor = decay(0.99, 100000, 3, overridden);
  check("override changes the decay floor (floors at overridden pL0=0.4)", eq(overFloor, 0.4), `got ${overFloor}`);

  /* ─────────────────────────────── done ─────────────────────────────────── */
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
