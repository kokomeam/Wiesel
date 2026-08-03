/**
 * Concept graph — PURE suite (no key, no DB, no browser). TUTOR-1 Wave 1.2 (A).
 *
 *   - Zod round-trips: node / edge / assumed-prior / snapshot-map row shapes,
 *     the R-13 anchor shape (slideId text, optional/nullable), the const enums
 *   - Change-set payload contract goldens: ConceptGraphItemPayloadSchema parses
 *     each entity with/without classification + lineage; rejects a bad entity
 *   - Error classes: TutorVersionConflictError / ConceptEdgeCycleError carry the
 *     right fields + names
 *   - Revert-window math: the pure `revertRefusal` helper — null window refuses,
 *     closed window refuses, open window allows (fail-closed)
 *   - Migration drift guards (regex over the migration file): six tables; the
 *     tutor_upsert_concept_edge RPC has WITH RECURSIVE + both typed error
 *     strings + the depth<500 guard + security definer; concept_edges has
 *     select+delete policies but NO insert/update policy; moddatetime on all
 *     six trigger-carrying tables; the semi-join RLS idiom; unique
 *     (source,target,kind); the source<>target check; the merged_into CHECK
 *
 * Run: `npx tsx scripts/verify-tutor-graph.ts`
 */

import { readFileSync } from "node:fs";
import {
  ASSUMED_PRIOR_STATUSES,
  AssumedPriorSchema,
  CONCEPT_EDGE_KINDS,
  CONCEPT_NODE_STATUSES,
  ConceptAnchorSchema,
  ConceptEdgeSchema,
  ConceptGraphItemPayloadSchema,
  ConceptNodeSchema,
  SnapshotConceptMapRowSchema,
} from "@/lib/tutor/graph/schemas";
import { ConceptEdgeCycleError, TutorVersionConflictError } from "@/lib/tutor/graph/errors";
import { revertRefusal } from "@/lib/tutor/graph/entities";

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

const MIGRATION = readFileSync(
  new URL("../supabase/migrations/20260803100100_concept_graph.sql", import.meta.url),
  "utf8"
);

/* ─────────────────────────── fixtures ───────────────────────────────────── */

const LESSON = crypto.randomUUID();
const BLOCK = crypto.randomUUID();
const COURSE = crypto.randomUUID();
const NODE = crypto.randomUUID();
const NODE2 = crypto.randomUUID();
const PUB = crypto.randomUUID();
const now = new Date().toISOString();

const nodeRow = {
  id: NODE,
  courseId: COURSE,
  title: "Transparent washes",
  description: "How pigment behaves in a wet-on-wet wash.",
  status: "active" as const,
  mergedIntoNodeId: null,
  createdBy: "extraction" as const,
  creatorEdited: false,
  aliases: ["wet-on-wet"],
  anchors: [{ lessonId: LESSON, blockId: BLOCK, slideId: "s3" }],
  embedding: null,
  externalTaxonomyRef: null,
  version: 1,
  createdAt: now,
  updatedAt: now,
};

const edgeRow = {
  id: crypto.randomUUID(),
  courseId: COURSE,
  sourceNodeId: NODE,
  targetNodeId: NODE2,
  kind: "prerequisite" as const,
  evidenceRefs: [{ lessonId: LESSON }],
  creatorLocked: false,
  version: 1,
  createdAt: now,
  updatedAt: now,
};

function main() {
  /* ─────────────────────────── anchors ──────────────────────────────────── */
  console.log("\n# anchors — the R-13 shape");
  check("full anchor (slide-level) parses", ConceptAnchorSchema.safeParse({ lessonId: LESSON, blockId: BLOCK, slideId: "s3" }).success);
  check("block-level anchor (slideId omitted) parses", ConceptAnchorSchema.safeParse({ lessonId: LESSON, blockId: BLOCK }).success);
  check("block-level anchor (slideId null) parses", ConceptAnchorSchema.safeParse({ lessonId: LESSON, blockId: BLOCK, slideId: null }).success);
  check("slideId is TEXT not uuid — a short id is accepted", ConceptAnchorSchema.safeParse({ lessonId: LESSON, blockId: BLOCK, slideId: "abc" }).success);
  check("a non-uuid lessonId is rejected", !ConceptAnchorSchema.safeParse({ lessonId: "not-a-uuid", blockId: BLOCK }).success);

  /* ─────────────────────── row round-trips ──────────────────────────────── */
  console.log("\n# row schemas round-trip");
  check("ConceptNodeSchema parses a node row", ConceptNodeSchema.safeParse(nodeRow).success);
  check("a merged node with mergedIntoNodeId parses", ConceptNodeSchema.safeParse({ ...nodeRow, status: "merged_into", mergedIntoNodeId: NODE2 }).success);
  check("ConceptEdgeSchema parses an edge row", ConceptEdgeSchema.safeParse(edgeRow).success);
  check(
    "AssumedPriorSchema parses",
    AssumedPriorSchema.safeParse({ id: crypto.randomUUID(), courseId: COURSE, title: "Color theory basics", description: "", evidence: [], status: "active", createdAt: now, updatedAt: now }).success
  );
  check(
    "SnapshotConceptMapRowSchema parses",
    SnapshotConceptMapRowSchema.safeParse({ publicationId: PUB, nodeId: NODE, courseId: COURSE, version: 2, anchors: [{ lessonId: LESSON, blockId: BLOCK }], anchorDowngraded: true, createdAt: now }).success
  );
  check("an unknown node status is rejected", !ConceptNodeSchema.safeParse({ ...nodeRow, status: "bogus" }).success);
  check("an unknown edge kind is rejected", !ConceptEdgeSchema.safeParse({ ...edgeRow, kind: "causes" }).success);

  /* ──────────────────────────── consts ──────────────────────────────────── */
  console.log("\n# const enums");
  check("edge kinds = prerequisite/part_of/related", JSON.stringify(CONCEPT_EDGE_KINDS) === JSON.stringify(["prerequisite", "part_of", "related"]));
  check("node statuses = active/retired/merged_into", JSON.stringify(CONCEPT_NODE_STATUSES) === JSON.stringify(["active", "retired", "merged_into"]));
  check("assumed-prior statuses = active/dismissed", JSON.stringify(ASSUMED_PRIOR_STATUSES) === JSON.stringify(["active", "dismissed"]));

  /* ─────────────── change-set payload contract goldens ───────────────────── */
  console.log("\n# change-set item payload contract");
  check("concept_node payload, classification 'added', no lineage", ConceptGraphItemPayloadSchema.safeParse({ entity: "concept_node", row: nodeRow as unknown as Record<string, unknown>, classification: "added" }).success);
  check("concept_edge payload with lineage blob", ConceptGraphItemPayloadSchema.safeParse({ entity: "concept_edge", row: edgeRow as unknown as Record<string, unknown>, classification: "matched", lineage: { from: [NODE] } }).success);
  check("classification omitted is allowed", ConceptGraphItemPayloadSchema.safeParse({ entity: "assumed_prior", row: {} }).success);
  check("classification null is allowed", ConceptGraphItemPayloadSchema.safeParse({ entity: "snapshot_map", row: {}, classification: null }).success);
  check("split/merged/removed classifications parse", ["split", "merged", "removed"].every((c) => ConceptGraphItemPayloadSchema.safeParse({ entity: "concept_node", row: {}, classification: c }).success));
  check("a bad entity is rejected", !ConceptGraphItemPayloadSchema.safeParse({ entity: "lesson", row: {} }).success);
  check("a bad classification is rejected", !ConceptGraphItemPayloadSchema.safeParse({ entity: "concept_node", row: {}, classification: "renamed" }).success);

  /* ──────────────────────────── errors ──────────────────────────────────── */
  console.log("\n# typed error classes");
  const vc = new TutorVersionConflictError("concept_node", NODE);
  check("TutorVersionConflictError carries entity + id + name", vc.entity === "concept_node" && vc.id === NODE && vc.name === "TutorVersionConflictError");
  const ce = new ConceptEdgeCycleError(NODE, NODE2, "prerequisite");
  check("ConceptEdgeCycleError carries the edge + name", ce.sourceNodeId === NODE && ce.targetNodeId === NODE2 && ce.kind === "prerequisite" && ce.name === "ConceptEdgeCycleError");

  /* ─────────────────────── revert-window math ────────────────────────────── */
  console.log("\n# revert-window math (fail-closed)");
  const t0 = "2026-08-03T12:00:00.000Z";
  const open = "2026-08-03T20:00:00.000Z"; // window still open
  const closed = "2026-08-03T06:00:00.000Z"; // window already passed relative to t0? no — expiry BEFORE now
  check("null window refuses (never revertable)", revertRefusal(null, t0) !== null);
  check("open window allows (returns null)", revertRefusal(open, t0) === null);
  check("closed window refuses", revertRefusal(closed, t0) !== null);
  check("expiry exactly == now refuses (fail-closed on the boundary)", revertRefusal(t0, t0) !== null);

  /* ─────────────────── migration drift guards ────────────────────────────── */
  console.log("\n# migration drift guards");
  for (const tbl of ["concept_nodes", "concept_edges", "snapshot_concept_map", "assumed_prior_nodes", "tutor_course_settings", "tutor_action"]) {
    check(`table ${tbl} is created`, new RegExp(`create table public\\.${tbl}\\b`).test(MIGRATION));
  }
  // moddatetime on every table that carries updated_at (all but snapshot_concept_map, which is created_at-only).
  for (const tbl of ["concept_nodes", "concept_edges", "assumed_prior_nodes", "tutor_course_settings", "tutor_action"]) {
    check(`${tbl} has a moddatetime trigger`, new RegExp(`create trigger ${tbl}_set_updated_at`).test(MIGRATION) && new RegExp(`${tbl}_set_updated_at[\\s\\S]*?extensions\\.moddatetime\\(updated_at\\)`).test(MIGRATION));
  }
  check("snapshot_concept_map is created_at-only (no updated_at trigger)", !/snapshot_concept_map_set_updated_at/.test(MIGRATION));

  // RLS enabled on all six.
  for (const tbl of ["concept_nodes", "concept_edges", "snapshot_concept_map", "assumed_prior_nodes", "tutor_course_settings", "tutor_action"]) {
    check(`RLS enabled on ${tbl}`, new RegExp(`alter table public\\.${tbl}\\s+enable row level security`).test(MIGRATION));
  }

  // The semi-join RLS idiom is used (not the per-row helper).
  check("policies use the semi-join idiom", /course_id in \(select c\.id from public\.courses c where c\.author_id = \(select auth\.uid\(\)\)\)/.test(MIGRATION));
  check("no per-row is_course_author helper snuck into these policies", !/private\.is_course_author/.test(MIGRATION));

  // concept_edges: select + delete policies, but NO insert/update policy.
  check("concept_edges has a SELECT policy", /create policy "concept_edges_select" on public\.concept_edges for select/.test(MIGRATION));
  check("concept_edges has a DELETE policy", /create policy "concept_edges_delete" on public\.concept_edges for delete/.test(MIGRATION));
  check("concept_edges has NO insert policy", !/create policy "concept_edges_insert"/.test(MIGRATION) && !/on public\.concept_edges for insert/.test(MIGRATION));
  check("concept_edges has NO update policy", !/create policy "concept_edges_update"/.test(MIGRATION) && !/on public\.concept_edges for update/.test(MIGRATION));

  // concept_nodes has the full CRUD set (proving edges' omission is deliberate).
  check("concept_nodes has all four policies", ["select", "insert", "update", "delete"].every((a) => new RegExp(`create policy "concept_nodes_${a}"`).test(MIGRATION)));

  // The edge-write RPC — the cycle gate.
  check("tutor_upsert_concept_edge is defined", /create or replace function public\.tutor_upsert_concept_edge\(/.test(MIGRATION));
  check("the RPC is SECURITY DEFINER", /security definer/.test(MIGRATION));
  check("the RPC sets search_path", /set search_path = public/.test(MIGRATION));
  check("the RPC runs a WITH RECURSIVE cycle check", /with recursive reachable/.test(MIGRATION));
  check("the RPC raises 'concept_edge_cycle'", /raise exception 'concept_edge_cycle'/.test(MIGRATION));
  check("the RPC raises 'concept_edge_version_conflict'", /raise exception 'concept_edge_version_conflict'/.test(MIGRATION));
  check("the RPC uses errcode P0001 for its typed errors", /using errcode = 'P0001'/.test(MIGRATION));
  check("the recursion is depth-bounded (depth < 500)", /r\.depth < 500/.test(MIGRATION));
  check("execute is revoked from PUBLIC and anon (functions default-grant to PUBLIC — revoking only anon leaves the PUBLIC grant live)", /revoke all on function public\.tutor_upsert_concept_edge[\s\S]*?from public, anon/.test(MIGRATION));
  check("execute is granted to authenticated + service_role", /grant execute on function public\.tutor_upsert_concept_edge[\s\S]*?to authenticated, service_role/.test(MIGRATION));

  // Structural CHECKs / constraints.
  check("unique (source_node_id, target_node_id, kind)", /unique \(source_node_id, target_node_id, kind\)/.test(MIGRATION));
  check("check (source_node_id <> target_node_id)", /check \(source_node_id <> target_node_id\)/.test(MIGRATION));
  check("the merged_into CHECK ties status to merged_into_node_id", /check \(\(status = 'merged_into'\) = \(merged_into_node_id is not null\)\)/.test(MIGRATION));
  check("snapshot map PK is (publication_id, node_id)", /primary key \(publication_id, node_id\)/.test(MIGRATION));
  check("assumed_prior unique (course_id, title)", /unique \(course_id, title\)/.test(MIGRATION));
  check("tutor_course_settings course_id is the PK", /course_id\s+uuid primary key references public\.courses/.test(MIGRATION));
  check("budget_limit_usd CHECK (null or > 0)", /budget_limit_usd is null or budget_limit_usd > 0/.test(MIGRATION));

  /* ─────────────────────────────── done ─────────────────────────────────── */
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
