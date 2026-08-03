/**
 * TUTOR-1 W1.2B — concept-graph change-set rail extension. PURE verification.
 * Run: `npx tsx scripts/verify-tutor-rail.ts`.
 *
 * The graph side of the reject rail (the block/lesson/module side is
 * scripts/verify-reject-revert.ts, which this suite does NOT modify — the
 * orchestrator chains both under `verify:reject`). Covers:
 *   - the payload-parse partition (isConceptGraphItem),
 *   - planConceptGraphRestore goldens: create-revert → FK-safe delete steps,
 *     update/delete-revert → exact-row restores, ONE bad payload fails the WHOLE
 *     plan (all-or-nothing), empty graph items → ok/zero-steps,
 *   - revertChangeSet's defensive guard (a concept_graph item never reaches the
 *     CoursePatch pipeline),
 *   - migration drift guards (20260803100200 widenings; 20260701000000 unchanged),
 *   - the studioLoad enum + the SSE type both mention concept_graph / graphCount.
 *
 * No Supabase, no key, no network.
 */

import { readFileSync } from "node:fs";
import {
  isConceptGraphItem,
  planConceptGraphRestore,
  type ConceptGraphRevertItem,
  type RestoreStep,
} from "@/lib/tutor/railRestore";
import { revertChangeSet, type RevertItem } from "@/lib/ai/changeSet";
import type { CourseDocument } from "@/lib/course/types";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
};

const NOW = "2026-08-03T00:00:00.000Z";

/** A concept_graph item payload (rides before/after). */
function payload(
  entity: "concept_node" | "concept_edge" | "assumed_prior" | "snapshot_map",
  row: Record<string, unknown>,
  classification: string | null = null
) {
  return { entity, row, classification };
}

/* ── 1. Partition: isConceptGraphItem ─────────────────────────────────────── */
function testPartition() {
  console.log("\n# partition (isConceptGraphItem)");
  check("concept_graph node_type → true", isConceptGraphItem({ node_type: "concept_graph" }));
  check("block node_type → false", !isConceptGraphItem({ node_type: "block" }));
  check("lesson node_type → false", !isConceptGraphItem({ node_type: "lesson" }));
  check("module node_type → false", !isConceptGraphItem({ node_type: "module" }));
  check("absent node_type (back-compat block) → false", !isConceptGraphItem({}));
  check("null node_type → false", !isConceptGraphItem({ node_type: null }));
}

/* ── 2. planConceptGraphRestore goldens ───────────────────────────────────── */
function testPlanGoldens() {
  console.log("\n# planConceptGraphRestore");

  // create-revert → delete steps, FK-safe order (edge delete BEFORE node delete).
  {
    const items: ConceptGraphRevertItem[] = [
      { node_id: "node-a", op: "create", before: null, after: payload("concept_node", { id: "node-a" }, "added") },
      { node_id: "edge-1", op: "create", before: null, after: payload("concept_edge", { id: "edge-1", source_node_id: "node-a", target_node_id: "node-b", kind: "prerequisite" }, "added") },
    ];
    const plan = planConceptGraphRestore(items);
    check("create-revert plan ok", plan.ok, plan.ok ? "" : plan.error);
    if (plan.ok) {
      check("create-revert → 2 delete steps", plan.steps.length === 2 && plan.steps.every((s) => s.kind === "delete"));
      // FK-safe: edge delete precedes node delete.
      const edgeIdx = plan.steps.findIndex((s) => s.entity === "concept_edge");
      const nodeIdx = plan.steps.findIndex((s) => s.entity === "concept_node");
      check("edge delete ordered BEFORE node delete (FK-safe)", edgeIdx >= 0 && nodeIdx >= 0 && edgeIdx < nodeIdx, `edge@${edgeIdx} node@${nodeIdx}`);
      const del = plan.steps.find((s) => s.entity === "concept_node") as Extract<RestoreStep, { kind: "delete" }>;
      check("create-revert deletes by the row id", del.kind === "delete" && del.id === "node-a");
    }
  }

  // update-revert → exact-row restore from BEFORE.
  {
    const beforeRow = { id: "node-x", title: "Old title", version: 1 };
    const items: ConceptGraphRevertItem[] = [
      { node_id: "node-x", op: "update", before: payload("concept_node", beforeRow, "matched"), after: payload("concept_node", { id: "node-x", title: "New title", version: 2 }, "matched") },
    ];
    const plan = planConceptGraphRestore(items);
    check("update-revert plan ok", plan.ok, plan.ok ? "" : plan.error);
    if (plan.ok) {
      check("update-revert → 1 restore step", plan.steps.length === 1 && plan.steps[0].kind === "restore");
      const step = plan.steps[0] as Extract<RestoreStep, { kind: "restore" }>;
      check("update-revert restores the EXACT before-row", JSON.stringify(step.row) === JSON.stringify(beforeRow));
      check("update-revert entity is concept_node", step.entity === "concept_node");
    }
  }

  // delete-revert → re-insert the BEFORE row.
  {
    const beforeRow = { id: "prior-1", title: "Assumed prior", status: "active" };
    const items: ConceptGraphRevertItem[] = [
      { node_id: "prior-1", op: "delete", before: payload("assumed_prior", beforeRow), after: null },
    ];
    const plan = planConceptGraphRestore(items);
    check("delete-revert plan ok", plan.ok, plan.ok ? "" : plan.error);
    if (plan.ok) {
      const step = plan.steps[0] as Extract<RestoreStep, { kind: "restore" }>;
      check("delete-revert → restore step with exact row", step.kind === "restore" && JSON.stringify(step.row) === JSON.stringify(beforeRow));
      check("delete-revert entity is assumed_prior", step.entity === "assumed_prior");
    }
  }

  // Restore ordering: nodes restored BEFORE edges (FK-safe).
  {
    const items: ConceptGraphRevertItem[] = [
      { node_id: "edge-9", op: "delete", before: payload("concept_edge", { id: "edge-9", source_node_id: "n1", target_node_id: "n2", kind: "related" }), after: null },
      { node_id: "n1", op: "delete", before: payload("concept_node", { id: "n1" }), after: null },
    ];
    const plan = planConceptGraphRestore(items);
    check("mixed delete-revert plan ok", plan.ok, plan.ok ? "" : plan.error);
    if (plan.ok) {
      const nodeIdx = plan.steps.findIndex((s) => s.entity === "concept_node");
      const edgeIdx = plan.steps.findIndex((s) => s.entity === "concept_edge");
      check("node restore ordered BEFORE edge restore (FK-safe)", nodeIdx >= 0 && edgeIdx >= 0 && nodeIdx < edgeIdx, `node@${nodeIdx} edge@${edgeIdx}`);
    }
  }

  // snapshot_map: create-revert deletes by node_id (composite PK, no `id`).
  {
    const items: ConceptGraphRevertItem[] = [
      { node_id: "node-s", op: "create", before: null, after: payload("snapshot_map", { publication_id: "pub-1", node_id: "node-s", course_id: "c1", version: 1 }, "added") },
    ];
    const plan = planConceptGraphRestore(items);
    check("snapshot_map create-revert ok", plan.ok, plan.ok ? "" : plan.error);
    if (plan.ok) {
      const step = plan.steps[0] as Extract<RestoreStep, { kind: "delete" }>;
      check("snapshot_map delete keyed by node_id (no row id)", step.kind === "delete" && step.entity === "snapshot_map" && step.id === "node-s");
    }
  }

  // ALL-OR-NOTHING: ONE bad payload fails the WHOLE plan (nothing applied).
  {
    const items: ConceptGraphRevertItem[] = [
      { node_id: "good-1", op: "update", before: payload("concept_node", { id: "good-1", title: "ok" }), after: null },
      // Bad: op update with a missing before-snapshot.
      { node_id: "bad-1", op: "update", before: null, after: payload("concept_node", { id: "bad-1" }) },
    ];
    const plan = planConceptGraphRestore(items);
    check("one missing-before item fails the WHOLE plan", !plan.ok, plan.ok ? "unexpected ok" : "");
    check("failure names the offending item", !plan.ok && /bad-1/.test(plan.error));
  }

  // Bad: a payload that doesn't parse as ConceptGraphItemPayload (unknown entity).
  {
    const items: ConceptGraphRevertItem[] = [
      { node_id: "x", op: "delete", before: { entity: "not_a_real_entity", row: {} }, after: null },
    ];
    const plan = planConceptGraphRestore(items);
    check("unparseable payload fails the plan", !plan.ok);
  }

  // Bad: create-revert with a missing after-snapshot.
  {
    const items: ConceptGraphRevertItem[] = [
      { node_id: "y", op: "create", before: null, after: null },
    ];
    const plan = planConceptGraphRestore(items);
    check("create-revert with no after fails", !plan.ok && /missing after-snapshot/.test(plan.error));
  }

  // Bad: unknown op.
  {
    const items: ConceptGraphRevertItem[] = [
      { node_id: "z", op: "frobnicate", before: payload("concept_node", { id: "z" }), after: null },
    ];
    const plan = planConceptGraphRestore(items);
    check("unknown op fails the plan", !plan.ok && /Unknown concept_graph op/.test(plan.error));
  }

  // Empty graph items → ok with zero steps.
  {
    const plan = planConceptGraphRestore([]);
    check("empty graph items → ok, zero steps", plan.ok && plan.steps.length === 0);
  }
}

/* ── 3. revertChangeSet defensive guard ───────────────────────────────────── */
function testRevertGuard() {
  console.log("\n# revertChangeSet defensive guard");
  const emptyDoc = {
    id: "c1",
    title: "t",
    plan: { outcomes: [], prerequisites: [] },
    modules: [],
    theme: { id: "editorial-warm", name: "Editorial Warm", accentColor: "#ea580c" },
    metadata: { createdAt: NOW, updatedAt: NOW, ownerId: "o", aiReadableVersion: "1.0" },
  } as unknown as CourseDocument;

  const graphItem: RevertItem = { block_id: null, lesson_id: null, op: "update", before: null, node_type: "concept_graph", node_id: "node-a", after: null };
  const res = revertChangeSet(emptyDoc, [graphItem], NOW);
  check("concept_graph item in the doc-revert path returns error (not thrown)", !res.ok);
  check("guard error names the graph restore path", !res.ok && /graph restore path/.test(res.error));

  // A truly-unknown node_type still hits the unknown-node_type message.
  const unknown: RevertItem = { block_id: null, lesson_id: null, op: "update", before: null, node_type: "galaxy", node_id: "g", after: null };
  const res2 = revertChangeSet(emptyDoc, [unknown], NOW);
  check("unknown (non-graph) node_type still errors via unknown path", !res2.ok && /Unknown node_type/.test(res2.error));

  // A pure block/lesson set still works (guard doesn't false-positive).
  const okRes = revertChangeSet(emptyDoc, [], NOW);
  check("empty item set reverts ok (no false guard trip)", okRes.ok);
}

/* ── 4. Migration drift guards ────────────────────────────────────────────── */
function testMigrationDrift() {
  console.log("\n# migration drift");
  const mig = readFileSync(`${process.cwd()}/supabase/migrations/20260803100200_concept_graph_rail.sql`, "utf8");

  // node_type CHECK contains all four members.
  const nodeTypeCheck = /check\s*\(\s*node_type\s+in\s*\(([^)]*)\)/i.exec(mig);
  check("node_type CHECK present", nodeTypeCheck != null);
  if (nodeTypeCheck) {
    const members = nodeTypeCheck[1];
    for (const m of ["block", "lesson", "module", "concept_graph"]) {
      check(`node_type CHECK contains '${m}'`, members.includes(`'${m}'`));
    }
  }

  // identity constraint widened to include concept_graph on the node_id arm.
  check("identity constraint mentions concept_graph", /change_set_items_identity_chk[\s\S]*node_type\s+in\s*\([^)]*'concept_graph'/i.test(mig));
  check("identity constraint keeps the block arm", /node_type\s*=\s*'block'\s+and\s+block_id\s+is\s+not\s+null/i.test(mig));

  // studio_course_bundle re-created with the widened pending_nodes IN clause.
  check("studio_course_bundle re-created", /create\s+or\s+replace\s+function\s+public\.studio_course_bundle/i.test(mig));
  check("pending_nodes IN clause widened to concept_graph", /p\.node_type\s+in\s*\('module','lesson','concept_graph'\)/i.test(mig));
  // grants preserved verbatim.
  check("grants preserved (revoke + grant execute)", /revoke all on function public\.studio_course_bundle/i.test(mig) && /grant execute on function public\.studio_course_bundle\(uuid\) to authenticated/i.test(mig));

  // 20260701000000 is UNCHANGED — still the original 3-member check + identity.
  const base = readFileSync(`${process.cwd()}/supabase/migrations/20260701000000_structural_change_set_items.sql`, "utf8");
  check("20260701000000 still lists only the original 3 node types", /check\s*\(node_type in \('block','lesson','module'\)\)/i.test(base));
  check("20260701000000 does NOT mention concept_graph", !/concept_graph/i.test(base));
}

/* ── 5. Lockstep type widenings (source text) ─────────────────────────────── */
function testTypeWidenings() {
  console.log("\n# lockstep widenings");
  const studioLoad = readFileSync(`${process.cwd()}/lib/editor/studioLoad.ts`, "utf8");
  check("studioLoad PendingNodeRowSchema enum contains concept_graph", /z\.enum\(\[\s*"module",\s*"lesson",\s*"concept_graph"\s*\]\)/.test(studioLoad));

  const events = readFileSync(`${process.cwd()}/lib/ai/events.ts`, "utf8");
  check("events.ts change_set member has graphCount", /graphCount\?:\s*number/.test(events));
}

function main() {
  testPartition();
  testPlanGoldens();
  testRevertGuard();
  testMigrationDrift();
  testTypeWidenings();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
