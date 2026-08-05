/**
 * Concept Graph console -- PURE suite (no key, no DB, no browser). TUTOR-1 Wave 5
 * (P5.2). Covers:
 *
 *   - Layout GOLDENS (AC-W5G.1): layoutConceptGraph over three fixtures (linear
 *     chain / branching / deep-prereq) matches the recorded golden positions +
 *     layer ordering EXACTLY, is DETERMINISTIC (a second run byte-matches the
 *     first AND an edge-order shuffle produces the same result), and has ZERO
 *     edge crossings (the regression metric, via the exported countEdgeCrossings).
 *   - The ConceptEdgeCycleError message formatting (the exact
 *     "a {kind} edge {src} -> {tgt} would create a cycle" pattern the UI shows).
 *   - A banned-import FENCE grep: layout.ts / editorStore.ts (if present) /
 *     graphConsole.ts / graphActions.ts import NONE of the editor-store leaks
 *     (lib/course/store, lib/course/patches, lib/editor/uiStore,
 *     lib/editor/dragStore, SlideStage) -- the tutor route keeps its own budget.
 *
 * Run: `npx tsx scripts/verify-tutor-graph-console.ts`
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  layoutConceptGraph,
  countEdgeCrossings,
  type LayoutNodeInput,
  type LayoutEdgeInput,
  type LayoutPosition,
} from "@/lib/tutor/graph/layout";
import { ConceptEdgeCycleError } from "@/lib/tutor/graph/errors";

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

/* --------------------------------- fixtures -------------------------------- */

interface Fixture {
  nodes: LayoutNodeInput[];
  edges: LayoutEdgeInput[];
}

const LINEAR: Fixture = {
  nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
  edges: [
    { source: "a", target: "b", kind: "prerequisite" },
    { source: "b", target: "c", kind: "prerequisite" },
    { source: "c", target: "d", kind: "prerequisite" },
  ],
};

const BRANCHING: Fixture = {
  nodes: [{ id: "root" }, { id: "l1" }, { id: "l2" }, { id: "l3" }, { id: "leaf" }],
  edges: [
    { source: "root", target: "l1", kind: "prerequisite" },
    { source: "root", target: "l2", kind: "prerequisite" },
    { source: "root", target: "l3", kind: "prerequisite" },
    { source: "l2", target: "leaf", kind: "prerequisite" },
    { source: "root", target: "leaf", kind: "related" },
  ],
};

const DEEP: Fixture = {
  nodes: [
    { id: "n0" }, { id: "n1" }, { id: "n2" }, { id: "n3" },
    { id: "n4" }, { id: "n5" }, { id: "n6" },
  ],
  edges: [
    { source: "n0", target: "n1", kind: "prerequisite" },
    { source: "n0", target: "n2", kind: "prerequisite" },
    { source: "n1", target: "n3", kind: "prerequisite" },
    { source: "n2", target: "n3", kind: "prerequisite" },
    { source: "n3", target: "n4", kind: "prerequisite" },
    { source: "n3", target: "n5", kind: "prerequisite" },
    { source: "n4", target: "n6", kind: "prerequisite" },
    { source: "n5", target: "n6", kind: "prerequisite" },
  ],
};

/* --------------------------------- goldens --------------------------------- */
// Recorded from the deterministic layout (a change here is a real regression --
// re-record only when the layout algorithm is intentionally changed).

type Golden = { positions: Record<string, LayoutPosition>; layers: string[][] };

const GOLD_LINEAR: Golden = {
  positions: {
    a: { x: 0.5, y: 0 },
    b: { x: 0.5, y: 0.3333333333333333 },
    c: { x: 0.5, y: 0.6666666666666666 },
    d: { x: 0.5, y: 1 },
  },
  layers: [["a"], ["b"], ["c"], ["d"]],
};

const GOLD_BRANCHING: Golden = {
  positions: {
    root: { x: 0.5, y: 0 },
    l1: { x: 0, y: 0.5 },
    l2: { x: 0.5, y: 0.5 },
    l3: { x: 1, y: 0.5 },
    leaf: { x: 0.5, y: 1 },
  },
  layers: [["root"], ["l1", "l2", "l3"], ["leaf"]],
};

const GOLD_DEEP: Golden = {
  positions: {
    n0: { x: 0.5, y: 0 },
    n1: { x: 0, y: 0.25 },
    n2: { x: 1, y: 0.25 },
    n3: { x: 0.5, y: 0.5 },
    n4: { x: 0, y: 0.75 },
    n5: { x: 1, y: 0.75 },
    n6: { x: 0.5, y: 1 },
  },
  layers: [["n0"], ["n1", "n2"], ["n3"], ["n4", "n5"], ["n6"]],
};

function positionsEqual(a: Map<string, LayoutPosition>, gold: Record<string, LayoutPosition>): boolean {
  const keys = Object.keys(gold);
  if (a.size !== keys.length) return false;
  for (const k of keys) {
    const p = a.get(k);
    if (!p) return false;
    if (Math.abs(p.x - gold[k].x) > 1e-12 || Math.abs(p.y - gold[k].y) > 1e-12) return false;
  }
  return true;
}

function layersEqual(a: string[][], b: string[][]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function runFixture(label: string, fx: Fixture, gold: Golden) {
  const r = layoutConceptGraph(fx.nodes, fx.edges);
  check(`[${label}] positions match the golden`, positionsEqual(r.positions, gold.positions));
  check(`[${label}] layer ordering matches the golden`, layersEqual(r.layers, gold.layers));
  check(`[${label}] ZERO edge crossings (regression metric)`, countEdgeCrossings(fx.edges, r.positions) === 0);

  // Determinism: a second run byte-matches.
  const r2 = layoutConceptGraph(fx.nodes, fx.edges);
  check(
    `[${label}] deterministic across runs`,
    positionsEqual(r2.positions, gold.positions) && layersEqual(r2.layers, gold.layers)
  );

  // Determinism under edge-order shuffle (reverse the edge list): same output.
  const shuffled = layoutConceptGraph(fx.nodes, [...fx.edges].reverse());
  check(
    `[${label}] deterministic under edge-order shuffle`,
    positionsEqual(shuffled.positions, gold.positions) && layersEqual(shuffled.layers, gold.layers)
  );
}

console.log("# AC-W5G.1 -- layout goldens + zero-crossing regressions");
runFixture("linear", LINEAR, GOLD_LINEAR);
runFixture("branching", BRANCHING, GOLD_BRANCHING);
runFixture("deep-prereq", DEEP, GOLD_DEEP);

// Longest-path layering correctness on the deep fixture: n3 has prereqs n1,n2
// (layer 1) so it sits at layer 2; n6 has prereqs n4,n5 (layer 3) so it sits at
// layer 4 -- the LONGEST path, not the shortest.
console.log("\n# longest-path layering (deep fixture)");
{
  const r = layoutConceptGraph(DEEP.nodes, DEEP.edges);
  check("n3 lands at layer 2 (below n1/n2)", r.layers[2].includes("n3"));
  check("n6 lands at the deepest layer 4 (longest path)", r.layers[4].includes("n6"));
}

// A defensive stray cycle must not loop the layout (back-edge broken).
console.log("\n# defensive cycle tolerance");
{
  const cyclic: Fixture = {
    nodes: [{ id: "x" }, { id: "y" }, { id: "z" }],
    edges: [
      { source: "x", target: "y", kind: "prerequisite" },
      { source: "y", target: "z", kind: "prerequisite" },
      { source: "z", target: "x", kind: "prerequisite" }, // back-edge
    ],
  };
  let ok = true;
  try {
    const r = layoutConceptGraph(cyclic.nodes, cyclic.edges);
    ok = r.positions.size === 3;
  } catch {
    ok = false;
  }
  check("a stray cycle lays out without looping (back-edge broken)", ok);
}

/* ----------------------------- cycle-error message ------------------------- */

console.log("\n# ConceptEdgeCycleError message formatting");
{
  const err = new ConceptEdgeCycleError("SRC", "TGT", "prerequisite");
  check(
    "message reads 'concept_edge_cycle: a prerequisite edge SRC -> TGT would create a cycle'",
    err.message === "concept_edge_cycle: a prerequisite edge SRC → TGT would create a cycle",
    JSON.stringify(err.message)
  );
  check("carries the typed endpoints + kind", err.sourceNodeId === "SRC" && err.targetNodeId === "TGT" && err.kind === "prerequisite");
}

/* -------------------------------- fence grep ------------------------------- */

console.log("\n# banned-import fence (no editor-store leaks)");
const BANNED = ["lib/course/store", "lib/course/patches", "lib/editor/uiStore", "lib/editor/dragStore", "SlideStage"];
const here = fileURLToPath(new URL(".", import.meta.url));
const root = new URL("../", import.meta.url);
const FILES = [
  "lib/tutor/graph/layout.ts",
  "lib/tutor/graph/editorStore.ts", // may not exist yet (built by the UI agent) -- skip if absent
  "lib/studio/graphConsole.ts",
  "app/(app)/studio/[courseId]/tutor/graphActions.ts",
];
void here;
for (const rel of FILES) {
  const path = fileURLToPath(new URL(rel, root));
  if (!existsSync(path)) {
    // editorStore.ts is optional at this stage; other files must exist.
    if (rel.endsWith("editorStore.ts")) {
      console.log(`  (skip ${rel} -- not present yet)`);
      continue;
    }
    check(`${rel} exists`, false, "missing");
    continue;
  }
  const src = readFileSync(path, "utf8");
  // Scan only real import statements — a file's OWN header comment names the
  // banned modules to say it does NOT import them (a raw text match false-positives).
  const importText = src
    .split("\n")
    .filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+['"]/.test(l) || /\brequire\(/.test(l))
    .join("\n");
  const hits = BANNED.filter((b) => importText.includes(b));
  check(`${rel} imports none of the editor-store leaks`, hits.length === 0, hits.join(", "));
}

/* ---------------------------------- report --------------------------------- */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
