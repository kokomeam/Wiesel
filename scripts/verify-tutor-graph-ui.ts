/**
 * Pure verification for the concept-graph console UI (TUTOR-1 Wave 5, P5.2). NO DB,
 * no browser, no network — exercises the pure exports of the graph editor stack and
 * asserts the LOAD-BEARING import fence over every file this package authored.
 *
 *   npx tsx scripts/verify-tutor-graph-ui.ts   (bare exit code: 0 pass, 1 fail)
 *
 * Coverage:
 *   - editorStore reducers: selection set/clear, zoom clamp (0.5..3), collapsedModules
 *     add/remove, and the LOCAL FrameCoalescer batching many push()es → ONE write/frame.
 *   - the teaching-slide deep-link URL builder (R-13 block-level fallback).
 *   - the suppressed-overlay render-decision helper (suppressed → no number).
 *   - the mastery/confusion render helpers (suppressed → neutral).
 *   - the staged-node classification helper.
 *   - the banned-import FENCE grep over ALL package files (the ~590 KB editor leak).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  useGraphEditorStore,
  clampZoom,
  createFrameCoalescer,
  MIN_ZOOM,
  MAX_ZOOM,
} from "@/lib/tutor/graph/editorStore";
import { buildTeachingDeepLink, masteryFill, confusionStroke } from "@/components/studio/tutor/graph/GraphCanvas";
import { overlayDisplay } from "@/components/studio/tutor/graph/NodeDetailDrawer";
import { classifyStagedNode } from "@/components/studio/tutor/graph/GraphReviewPanel";

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

// Wrapped in main() — the FrameCoalescer test awaits a frame, and top-level await
// compiles to an unsupported CJS form under this project's tsx config.
async function main() {
/* ----------------------------- store reducers ----------------------------- */

console.log("editorStore reducers");
{
  const s = useGraphEditorStore.getState();

  s.selectNode("node-a");
  check("selectNode sets a node selection", useGraphEditorStore.getState().selection.kind === "node" && useGraphEditorStore.getState().selection.id === "node-a");

  s.selectEdge("edge-b");
  check("selectEdge sets an edge selection", useGraphEditorStore.getState().selection.kind === "edge" && useGraphEditorStore.getState().selection.id === "edge-b");

  s.clearSelection();
  check("clearSelection clears to null", useGraphEditorStore.getState().selection.kind === null && useGraphEditorStore.getState().selection.id === null);

  // zoom clamp through the store
  s.setZoom(99);
  check("setZoom clamps to MAX_ZOOM", useGraphEditorStore.getState().zoom === MAX_ZOOM);
  s.setZoom(0.01);
  check("setZoom clamps to MIN_ZOOM", useGraphEditorStore.getState().zoom === MIN_ZOOM);
  s.resetZoom();
  check("resetZoom returns to 1", useGraphEditorStore.getState().zoom === 1);
  s.zoomIn();
  check("zoomIn increases zoom", useGraphEditorStore.getState().zoom > 1);
  s.resetZoom();
  s.zoomOut();
  check("zoomOut decreases zoom", useGraphEditorStore.getState().zoom < 1);
  s.resetZoom();

  // collapsedModules add/remove — always a NEW Set (referential change).
  const before = useGraphEditorStore.getState().collapsedModules;
  s.toggleModule("m1");
  const afterAdd = useGraphEditorStore.getState().collapsedModules;
  check("toggleModule adds a module", afterAdd.has("m1"));
  check("toggleModule returns a NEW Set (subscribers notified)", afterAdd !== before);
  s.toggleModule("m1");
  check("toggleModule removes on second call", !useGraphEditorStore.getState().collapsedModules.has("m1"));

  s.setSearchFocus("dijkstra");
  check("setSearchFocus stores the query", useGraphEditorStore.getState().searchFocus === "dijkstra");
  s.setSearchFocus("");

  s.setDragFrame({ nodeId: "n1", x: 10, y: 20 });
  check("setDragFrame stores the transient frame", useGraphEditorStore.getState().drag?.nodeId === "n1");
  s.setDragFrame(null);
  check("setDragFrame(null) clears the transient frame", useGraphEditorStore.getState().drag === null);
}

/* ------------------------------- zoom clamp ------------------------------- */

console.log("clampZoom (pure)");
{
  check("clampZoom floors at 0.5", clampZoom(0.1) === 0.5);
  check("clampZoom caps at 3", clampZoom(10) === 3);
  check("clampZoom rounds to 2 dp", clampZoom(1.23456) === 1.23);
  check("clampZoom passes a mid value through", clampZoom(2) === 2);
}

/* ----------------------------- FrameCoalescer ----------------------------- */

console.log("FrameCoalescer (one write per frame)");
{
  // In Node there is no requestAnimationFrame → the coalescer falls back to a
  // setTimeout(~16ms). Push several values, then wait past the frame and assert
  // exactly ONE write landed with the LAST value.
  const writes: number[] = [];
  const c = createFrameCoalescer<number>((v) => writes.push(v));
  c.push(1);
  c.push(2);
  c.push(3);
  check("push() does not write synchronously (batched)", writes.length === 0);

  await new Promise((r) => setTimeout(r, 40));
  check("exactly ONE write landed per frame", writes.length === 1, `got ${writes.length}`);
  check("the batched write carries the LAST value", writes[0] === 3, `got ${writes[0]}`);

  // flush() writes the pending value synchronously.
  const flushed: number[] = [];
  const c2 = createFrameCoalescer<number>((v) => flushed.push(v));
  c2.push(7);
  c2.flush();
  check("flush() writes the pending value synchronously", flushed.length === 1 && flushed[0] === 7);
  await new Promise((r) => setTimeout(r, 40));
  check("flush() drains the frame (no duplicate later write)", flushed.length === 1);

  // cancel() drops the pending value.
  const cancelled: number[] = [];
  const c3 = createFrameCoalescer<number>((v) => cancelled.push(v));
  c3.push(9);
  c3.cancel();
  await new Promise((r) => setTimeout(r, 40));
  check("cancel() drops the pending value (no write)", cancelled.length === 0);
}

/* --------------------------- deep-link builder ---------------------------- */

console.log("buildTeachingDeepLink (R-13 block-level fallback)");
{
  check(
    "block-level link includes course, lesson, block",
    buildTeachingDeepLink("c1", "l1", "b1") === "/studio?course=c1&lesson=l1&block=b1"
  );
  check(
    "no block → block param omitted (degrades block-level)",
    buildTeachingDeepLink("c1", "l1") === "/studio?course=c1&lesson=l1"
  );
  check(
    "never appends a slide id (R-13: block-level resolution)",
    !buildTeachingDeepLink("c1", "l1", "b1").includes("slide")
  );
}

/* ----------------------- suppressed-overlay decision ---------------------- */

console.log("overlayDisplay (suppressed → no number)");
{
  check("undefined overlay → not shown", overlayDisplay(undefined).show === false);
  check("suppressed overlay → not shown", overlayDisplay({ suppressed: true, value: null }).show === false);
  check("null value (below floor) → not shown", overlayDisplay({ suppressed: false, value: null }).show === false);
  const shown = overlayDisplay({ suppressed: false, value: 0.72 });
  check("a resolved overlay → shown WITH the value", shown.show === true && shown.show && shown.value === 0.72);
}

/* -------------------- mastery/confusion render helpers -------------------- */

console.log("masteryFill / confusionStroke (suppressed → neutral)");
{
  check("masteryFill neutral when toggle off", masteryFill({ node_id: "n", avg_decayed_p: 0.9, learner_count: 10, suppressed: false }, false) === "#ffffff");
  check("masteryFill neutral when suppressed", masteryFill({ node_id: "n", avg_decayed_p: null, learner_count: null, suppressed: true }, true) === "#ffffff");
  check("masteryFill green for strong mastery", masteryFill({ node_id: "n", avg_decayed_p: 0.85, learner_count: 8, suppressed: false }, true).includes("22, 163, 74"));
  check("masteryFill rose for weak mastery", masteryFill({ node_id: "n", avg_decayed_p: 0.2, learner_count: 8, suppressed: false }, true).includes("225, 29, 72"));
  check("confusionStroke null when toggle off", confusionStroke({ block_id: "b", confusing_pct: 0.9, confusing_count: 9, suppressed: false }, false) === null);
  check("confusionStroke null when suppressed", confusionStroke({ block_id: "b", confusing_pct: null, confusing_count: null, suppressed: true }, true) === null);
  check("confusionStroke rose for high confusion", confusionStroke({ block_id: "b", confusing_pct: 0.5, confusing_count: 9, suppressed: false }, true) === "#e11d48");
  check("confusionStroke null for low confusion", confusionStroke({ block_id: "b", confusing_pct: 0.1, confusing_count: 9, suppressed: false }, true) === null);
}

/* --------------------------- staged classification ------------------------ */

console.log("classifyStagedNode");
{
  check("retired → removed", classifyStagedNode({ status: "retired", created_by: "extraction", creator_edited: false }) === "removed");
  check("merged_into → merged", classifyStagedNode({ status: "merged_into", created_by: "extraction", creator_edited: false }) === "merged");
  check("creator-authored → split", classifyStagedNode({ status: "active", created_by: "creator", creator_edited: true }) === "split");
  check("matched-changed → matched", classifyStagedNode({ status: "active", created_by: "extraction", creator_edited: true }) === "matched");
  check("fresh extraction → added", classifyStagedNode({ status: "active", created_by: "extraction", creator_edited: false }) === "added");
}

/* ---------------------------- IMPORT FENCE -------------------------------- */

console.log("banned-import fence (the ~590 KB editor leak)");
{
  const files = [
    "lib/tutor/graph/editorStore.ts",
    "components/studio/tutor/graph/GraphCanvas.tsx",
    "components/studio/tutor/graph/NodeDetailDrawer.tsx",
    "components/studio/tutor/graph/OverlayToggles.tsx",
    "components/studio/tutor/graph/AssumedPriorsPanel.tsx",
    "components/studio/tutor/graph/GraphReviewPanel.tsx",
    "components/studio/tutor/GraphTab.tsx",
    "scripts/verify-tutor-graph-ui.ts",
  ];
  // Banned MODULE specifiers (an import from any of these pulls the editor graph).
  const bannedModules = [
    "@/lib/course/store",
    "@/lib/course/patches",
    "@/lib/editor/uiStore",
    "@/lib/editor/dragStore",
  ];
  const root = process.cwd();
  for (const rel of files) {
    let src = "";
    try {
      src = readFileSync(resolve(root, rel), "utf8");
    } catch {
      check(`fence: ${rel} exists`, false, "file missing");
      continue;
    }
    // NUL / control-byte guard (a prior file went binary from a stray NUL).
    check(`fence: ${rel} is clean UTF-8 (no NUL)`, !src.includes("\u0000"));
    // Only inspect import lines so a banned string in a comment/JSX doesn't false-positive.
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /from\s+['"]/.test(l));
    const importBlob = importLines.join("\n");
    for (const mod of bannedModules) {
      check(`fence: ${rel} does not import ${mod}`, !importBlob.includes(mod), "BANNED IMPORT");
    }
    // SlideStage: neither imported as a module path nor named in an import.
    const importsSlideStage =
      /from\s+['"][^'"]*slide\/SlideStage['"]/.test(importBlob) || /\bimport\b[^;]*\bSlideStage\b/.test(importBlob);
    check(`fence: ${rel} does not import SlideStage`, !importsSlideStage, "BANNED IMPORT");
  }
}

/* -------------------------------- summary --------------------------------- */

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
