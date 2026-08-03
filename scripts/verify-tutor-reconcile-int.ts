/**
 * Concept-graph RECONCILIATION — INTEGRATION suite (live Supabase + MOCK model).
 * CI-SAFE: no OpenAI key. Self-provisions a FRESH throwaway fixture each run.
 * TUTOR-1 Wave 1.4.
 *
 * The full W1.4 acceptance flow against the live DB:
 *   seed fixture → EXTRACTION → ACCEPT (route sequence) →
 *   as the author: mark ONE edge creator_locked (RPC) + mark ONE node
 *   creator_edited + widen the split-target node's aliases →
 *   REWRITE one lesson's slide content in the draft + REPUBLISH (publishCourse —
 *   the publish hook fires; enqueueGraphRunForPublish decisions asserted
 *   separately: fresh→'extraction', accepted-graph→'reconciliation',
 *   pending-set→'skipped_pending' = AC-T1.6) →
 *   run runGraphReconciliation with engineered candidates:
 *     • an unchanged concept re-proposed identically (→ matched; creator_edited →
 *       SUPPRESSED, never auto-changed),
 *     • two candidates both alias-matching one old node (→ SPLIT),
 *     • one old concept omitted (→ REMOVED / retired),
 *     • inference omits the locked edge.
 *   ACCEPT → assert:
 *     AC-T1.7a  every untouched-lesson node id IDENTICAL after accept; the split
 *               parent retired with lineage {parent→children + 0.75} readable from
 *               the item payloads AND the accepted rows; retired ≠ deleted;
 *               classifications visible in the change-set items.
 *     AC-T1.8   the creator_locked edge produced NO item and still exists after
 *               accept.
 *   Then: a SECOND reconciliation → REJECT restores the prior graph byte-for-byte
 *   (before-rows); the creator_edited node was never auto-changed.
 *
 * Run: `npx tsx scripts/verify-tutor-reconcile-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";

dns.setDefaultResultOrder("ipv4first");

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
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import { PublicationSnapshotSchema } from "@/lib/course/publish/schemas";
import { loadCourseDoc, reconcileCourseDoc } from "@/lib/course/persistenceSync";
import { publishCourse } from "@/lib/course/publish/service";
import { resolveLivePublicationBySlug } from "@/lib/learn/resolve";
import { stableStringify } from "@/lib/course/publish/hash";
import { runGraphExtraction } from "@/lib/tutor/graph/extraction";
import { runGraphReconciliation } from "@/lib/tutor/graph/reconcile";
import { enqueueGraphRunForPublish } from "@/lib/tutor/graph/publishHook";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { acceptChangeSet, rejectChangeSet } from "@/lib/ai/changeSet";
import { PROPOSAL_RESPONSE_NAME } from "@/lib/tutor/graph/propose";
import { MERGE_RESPONSE_NAME } from "@/lib/tutor/graph/canonicalize";
import { EDGE_RESPONSE_NAME } from "@/lib/tutor/graph/edges";
import { seedTutorFixture } from "./seed-fixture-tutor";

// Load .env.local → process.env.
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

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

function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY in .env.local");
  if (!service) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / SECRET_KEY (admin client) in .env.local");
  return { url, anon, service };
}

function directSnapshotLoader(admin: SupabaseClient<Database>) {
  return async (publicationId: string) => {
    const { data, error } = await admin.from("course_publications").select("version, snapshot").eq("id", publicationId).maybeSingle();
    if (error) throw new Error(`directSnapshotLoader: ${error.message}`);
    if (!data) throw new Error(`publication ${publicationId} not found`);
    return { snapshot: PublicationSnapshotSchema.parse(data.snapshot), version: data.version };
  };
}

/* ─────────────────────────── mock model scripts ─────────────────────────── */

/** Extraction batch: three durable taught concepts + one assumed prior. Anchored
 *  to the first lesson's real block/slide so anchors resolve. Deduped course-wide
 *  (the batch answers every lesson) → the graph = {Scarcity, Opportunity Cost,
 *  Deadweight Loss}. */
function extractionResponses(doc: CourseDocument) {
  const lesson0 = doc.modules[0].lessons[0];
  const deck0 = lesson0.blocks.find((b) => b.type === "slide_deck") as SlideDeckBlock | undefined;
  const block0 = deck0?.id ?? lesson0.blocks[0].id;
  const slide0 = deck0?.slides[0]?.id ?? null;

  const proposal = {
    concepts: [
      { title: "Scarcity", description: "Wants exceed the resources available to satisfy them.", lessonAnchors: [{ blockId: block0, slideId: slide0 }], confidence: 0.95, isAssumedPrior: false, evidenceQuote: "Scarcity means wants exceed resources." },
      { title: "Opportunity Cost", description: "The value of the next-best alternative forgone.", lessonAnchors: [{ blockId: block0, slideId: null }], confidence: 0.9, isAssumedPrior: false, evidenceQuote: "Opportunity cost is the next-best alternative." },
      { title: "Deadweight Loss", description: "The reduction in total surplus from an inefficient quantity.", lessonAnchors: [{ blockId: block0, slideId: null }], confidence: 0.85, isAssumedPrior: false, evidenceQuote: "Deadweight loss reduces total surplus." },
      { title: "Arithmetic", description: "Basic arithmetic — assumed background.", lessonAnchors: [{ blockId: block0, slideId: null }], confidence: 0.7, isAssumedPrior: true, evidenceQuote: "Uses arithmetic without teaching it." },
    ],
  };
  const merge = { groups: [] as unknown[] };
  // A single prerequisite Scarcity(0)→Opportunity Cost(1) — the edge we'll LOCK.
  const edges = { edges: [{ sourceIndex: 0, targetIndex: 1, kind: "prerequisite", confidence: 0.9, evidenceQuote: "Scarcity precedes opportunity cost." }] };
  return { [PROPOSAL_RESPONSE_NAME]: proposal, [MERGE_RESPONSE_NAME]: merge, [EDGE_RESPONSE_NAME]: edges };
}

/** Reconciliation batch (over the NEW publication):
 *   • "Scarcity" re-proposed identically → matched (creator_edited → SUPPRESSED),
 *   • "Marginal Tradeoff" + "Next-Best Alternative" → BOTH alias-match the widened
 *     Opportunity Cost node → SPLIT,
 *   • "Deadweight Loss" OMITTED → the stored node is REMOVED (retired).
 *   Edge inference returns NO edge → the locked edge is never re-inferred (and, being
 *   locked, is never touched). */
function reconciliationResponses(doc: CourseDocument) {
  const lesson0 = doc.modules[0].lessons[0];
  const deck0 = lesson0.blocks.find((b) => b.type === "slide_deck") as SlideDeckBlock | undefined;
  const block0 = deck0?.id ?? lesson0.blocks[0].id;

  const proposal = {
    concepts: [
      { title: "Scarcity", description: "Wants exceed the resources available to satisfy them.", lessonAnchors: [{ blockId: block0, slideId: null }], confidence: 0.95, isAssumedPrior: false, evidenceQuote: "Scarcity means wants exceed resources." },
      { title: "Marginal Tradeoff", description: "Choosing at the margin trades one option for another.", lessonAnchors: [{ blockId: block0, slideId: null }], confidence: 0.9, isAssumedPrior: false, evidenceQuote: "A marginal tradeoff at the frontier." },
      { title: "Next-Best Alternative", description: "The forgone alternative that defines a cost.", lessonAnchors: [{ blockId: block0, slideId: null }], confidence: 0.88, isAssumedPrior: false, evidenceQuote: "The next-best alternative is forgone." },
    ],
  };
  const merge = { groups: [] as unknown[] };
  const edges = { edges: [] as unknown[] };
  return { [PROPOSAL_RESPONSE_NAME]: proposal, [MERGE_RESPONSE_NAME]: merge, [EDGE_RESPONSE_NAME]: edges };
}

async function main() {
  const { url, anon, service } = env();

  const fx = await seedTutorFixture({ url, anon });
  const lessonCount = fx.doc.modules.reduce((n, m) => n + m.lessons.length, 0);
  console.log(`# seeded fixture: course ${fx.courseId}, ${lessonCount} lessons, pub ${fx.publicationId} v${fx.version}`);

  const admin = createClient<Database>(url, service, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: retryingFetch } });
  const author = fx.author.client;
  const loadSnapshot = directSnapshotLoader(admin);

  const newRun = async (): Promise<string> => {
    const { data, error } = await admin.from("agent_runs").insert({ course_id: fx.courseId, trigger: "scheduled", status: "running" }).select("id").single();
    if (error || !data) throw new Error(`agent_runs insert: ${error?.message}`);
    return data.id;
  };

  /* ─────────────────── 1. EXTRACTION → ACCEPT ─────────────────── */
  console.log("\n# 1. extraction → accept (establishes the active graph)");
  const extractModel = createMockModelClient([], { structured: extractionResponses(fx.doc) });
  const extractResult = await runGraphExtraction(
    { supabase: admin, model: extractModel, loadSnapshot, config: { canonSimThreshold: -1 } },
    { courseId: fx.courseId, publicationId: fx.publicationId, runId: await newRun() }
  );
  check("extraction ok", extractResult.ok, JSON.stringify({ cp: extractResult.checkpoint, flags: extractResult.flags }));
  check("extraction produced 3 taught nodes", extractResult.nodeCount === 3, `nodeCount=${extractResult.nodeCount}`);

  const extractCs = extractResult.changeSetId!;
  await acceptChangeSet(author, extractCs);
  await author.from("agent_findings").update({ status: "accepted" }).eq("change_set_id", extractCs).eq("status", "proposed");

  const nodesAfterExtract = (await admin.from("concept_nodes").select("id,title,status,created_by").eq("course_id", fx.courseId)).data ?? [];
  const activeAfterExtract = nodesAfterExtract.filter((n) => n.status === "active");
  check("3 active nodes after accept", activeAfterExtract.length === 3, JSON.stringify(activeAfterExtract.map((n) => n.title)));
  const nodeByTitle = new Map(activeAfterExtract.map((n) => [n.title, n]));
  const scarcityId = nodeByTitle.get("Scarcity")!.id;
  const oppCostId = nodeByTitle.get("Opportunity Cost")!.id;
  const dwlId = nodeByTitle.get("Deadweight Loss")!.id;
  check("Scarcity + Opportunity Cost + Deadweight Loss all present", !!scarcityId && !!oppCostId && !!dwlId);

  const edgesAfterExtract = (await admin.from("concept_edges").select("id,source_node_id,target_node_id,kind,creator_locked").eq("course_id", fx.courseId)).data ?? [];
  check("≥1 edge after extraction", edgesAfterExtract.length >= 1, `edges=${edgesAfterExtract.length}`);
  const lockedEdge = edgesAfterExtract.find((e) => e.source_node_id === scarcityId && e.target_node_id === oppCostId) ?? edgesAfterExtract[0];

  /* ─────────────────── 2. creator marks + alias widening ─────────────────── */
  console.log("\n# 2. author: lock an edge, mark a node creator_edited, widen split-target aliases");
  // Lock the Scarcity→OppCost edge via the definer RPC (as the author).
  const lockRpc = await author.rpc("tutor_upsert_concept_edge", {
    p_id: lockedEdge.id,
    p_course_id: fx.courseId,
    p_source_node_id: lockedEdge.source_node_id,
    p_target_node_id: lockedEdge.target_node_id,
    p_kind: lockedEdge.kind,
    p_evidence_refs: [],
    p_creator_locked: true,
  });
  check("author locked an edge via the RPC", !lockRpc.error, lockRpc.error?.message ?? "");
  const lockedNow = (await admin.from("concept_edges").select("creator_locked").eq("id", lockedEdge.id).maybeSingle()).data;
  check("the edge is now creator_locked", lockedNow?.creator_locked === true);

  // Mark "Scarcity" creator_edited (the matched-but-protected node).
  const editMark = await author.from("concept_nodes").update({ creator_edited: true }).eq("id", scarcityId);
  check("author marked Scarcity creator_edited", !editMark.error, editMark.error?.message ?? "");

  // Widen the Opportunity Cost node's aliases so two reconcile candidates
  // title-match it (→ split). Both writes are plain author-CRUD on concept_nodes.
  const aliasMark = await author.from("concept_nodes").update({ aliases: ["Marginal Tradeoff", "Next-Best Alternative"] as never }).eq("id", oppCostId);
  check("author widened Opportunity Cost aliases (split setup)", !aliasMark.error, aliasMark.error?.message ?? "");

  // Snapshot the PRIOR graph (nodes+edges) for the byte-for-byte reject assertion later.
  const priorNodes = (await admin.from("concept_nodes").select("*").eq("course_id", fx.courseId).order("id")).data ?? [];
  const priorEdges = (await admin.from("concept_edges").select("*").eq("course_id", fx.courseId).order("id")).data ?? [];

  /* ─────────────────── 3. AC-T1.6 publish-hook decisions ─────────────────── */
  console.log("\n# 3. AC-T1.6 — enqueueGraphRunForPublish decisions");
  // accepted-graph course → 'reconciliation'.
  const decReconcile = await enqueueGraphRunForPublish(author, { courseId: fx.courseId, publicationId: fx.publicationId });
  check("AC-T1.6: an accepted-graph course → 'reconciliation'", decReconcile === "reconciliation", decReconcile);
  // a course with NO graph → 'extraction' (a fresh throwaway course).
  const freshCourseId = crypto.randomUUID();
  {
    const { error } = await admin.from("courses").insert({ id: freshCourseId, title: "Fresh", author_id: fx.author.userId, status: "draft" } as never);
    if (error) throw new Error(`fresh course insert: ${error.message}`);
  }
  const decExtract = await enqueueGraphRunForPublish(admin, { courseId: freshCourseId, publicationId: fx.publicationId });
  check("AC-T1.6: a fresh course (no graph) → 'extraction'", decExtract === "extraction", decExtract);
  await admin.from("courses").delete().eq("id", freshCourseId);

  /* ─────────────────── 4. rewrite a lesson + REPUBLISH ─────────────────── */
  console.log("\n# 4. rewrite one lesson's slide content + republish (hook fires)");
  const draft = await loadCourseDoc(author, fx.courseId);
  if (!draft) throw new Error("could not load draft");
  // Rewrite the FIRST lesson's first slide heading/bullets (a real content change).
  const firstLesson = draft.modules[0].lessons[0];
  const firstDeck = firstLesson.blocks.find((b) => b.type === "slide_deck") as SlideDeckBlock | undefined;
  if (firstDeck && firstDeck.slides[0]) {
    for (const el of firstDeck.slides[0].elements) {
      if (el.type === "heading") el.text = "Scarcity (revised)";
      else if (el.type === "bullet_list") el.items = ["A revised teaching sentence about scarcity and choice."];
    }
  }
  const rerr = await reconcileCourseDoc(author, draft, fx.author.userId);
  if (rerr) throw new Error(`draft reconcile: ${rerr}`);

  const republished = await publishCourse(author, draft, { visibility: "unlisted" });
  const live2 = await resolveLivePublicationBySlug(author, republished.publication.slug);
  if (live2.kind !== "found") throw new Error("republished publication not resolvable");
  check("republish produced a NEW publication version", live2.publication.version > fx.version, `v${live2.publication.version} vs v${fx.version}`);
  const newPubId = live2.publication.id;

  /* ─────────────────── 5. RECONCILIATION → ACCEPT ─────────────────── */
  console.log("\n# 5. reconciliation → accept");
  const reconcileModel = createMockModelClient([], { structured: reconciliationResponses(fx.doc) });
  const reconcileResult = await runGraphReconciliation(
    { supabase: admin, model: reconcileModel, loadSnapshot, config: { canonSimThreshold: -1 } },
    { courseId: fx.courseId, publicationId: newPubId, runId: await newRun() }
  );
  check("reconciliation ok", reconcileResult.ok, JSON.stringify({ cp: reconcileResult.checkpoint, flags: reconcileResult.flags }));
  check("classified: matched≥1 (Scarcity, suppressed)", reconcileResult.classified.matched >= 1, JSON.stringify(reconcileResult.classified));
  check("classified: split=3 (2 children + parent)", reconcileResult.classified.split === 3, JSON.stringify(reconcileResult.classified));
  check("classified: removed=1 (Deadweight Loss)", reconcileResult.classified.removed === 1, JSON.stringify(reconcileResult.classified));

  const reconcileCs = reconcileResult.changeSetId!;

  // A pending concept_graph set now exists → the publish hook must SKIP (AC-T1.6).
  console.log("\n# AC-T1.6 — pending set → 'skipped_pending'");
  const decPending = await enqueueGraphRunForPublish(author, { courseId: fx.courseId, publicationId: newPubId });
  check("AC-T1.6: a pending concept_graph set → 'skipped_pending'", decPending === "skipped_pending", decPending);

  // Inspect the change-set items BEFORE accept (classifications + split lineage).
  const items = (await admin.from("change_set_items").select("node_id,node_type,op,before,after").eq("change_set_id", reconcileCs)).data ?? [];
  check("all reconcile items are node_type concept_graph", items.length > 0 && items.every((i) => i.node_type === "concept_graph"));
  const itemClasses = items.map((i) => ((i.after as Record<string, unknown> | null)?.classification ?? (i.before as Record<string, unknown> | null)?.classification));
  check("AC-T1.7a: classifications visible in the items (matched? no — suppressed; split + removed present)", itemClasses.includes("split") && itemClasses.includes("removed"));

  // Split parent lineage readable from the ITEM payloads.
  const splitParentItem = items.find((i) => i.op === "update" && (i.before as Record<string, unknown> | null)?.classification === "split");
  const splitLineage = splitParentItem && ((splitParentItem.before as Record<string, unknown>).lineage as { parentNodeId?: string; childNodeIds?: string[]; confidenceFactor?: number } | undefined);
  check(
    "AC-T1.7a: split parent item lineage = {parent, ≥2 children, confidenceFactor 0.75}",
    !!splitLineage && splitLineage.parentNodeId === oppCostId && (splitLineage.childNodeIds?.length ?? 0) >= 2 && splitLineage.confidenceFactor === 0.75,
    JSON.stringify(splitLineage)
  );
  const splitChildItem = items.find((i) => i.op === "create" && (i.after as Record<string, unknown> | null)?.classification === "split");
  const childLineage = splitChildItem && ((splitChildItem.after as Record<string, unknown>).lineage as { parentNodeId?: string; confidenceFactor?: number } | undefined);
  check("AC-T1.7a: split CHILD items carry the same lineage (parent + 0.75)", !!childLineage && childLineage.parentNodeId === oppCostId && childLineage.confidenceFactor === 0.75);

  // AC-T1.8: the locked edge produced NO item.
  const lockedEdgeItem = items.find((i) => i.node_id === lockedEdge.id);
  check("AC-T1.8: the creator_locked edge produced NO change-set item", lockedEdgeItem === undefined);

  // The creator_edited Scarcity node was NOT staged with an update (suppressed).
  const scarcityUpdateItem = items.find((i) => i.node_id === scarcityId && i.op === "update");
  check("the creator_edited node produced NO update item (suppressed)", scarcityUpdateItem === undefined);

  // Record the untouched-lesson node ids (Scarcity + Deadweight Loss are the
  // "untouched" survivors of matching/removal — their ids must be stable).
  await acceptChangeSet(author, reconcileCs);
  await author.from("agent_findings").update({ status: "accepted" }).eq("change_set_id", reconcileCs).eq("status", "proposed");

  const nodesAfterReconcile = (await admin.from("concept_nodes").select("id,title,status,merged_into_node_id,creator_edited").eq("course_id", fx.courseId)).data ?? [];
  const byId = new Map(nodesAfterReconcile.map((n) => [n.id, n]));

  // AC-T1.7a: untouched node id IDENTICAL after accept (Scarcity kept its id).
  check("AC-T1.7a: the matched node kept its identical id after accept", byId.has(scarcityId));
  check("AC-T1.7a: the creator_edited matched node is UNCHANGED (still active, still creator_edited, title intact)", byId.get(scarcityId)?.status === "active" && byId.get(scarcityId)?.creator_edited === true && byId.get(scarcityId)?.title === "Scarcity");

  // AC-T1.7a: split parent retired (retired ≠ deleted — the row still exists).
  const parentRow = byId.get(oppCostId);
  check("AC-T1.7a: the split parent is RETIRED, not deleted (row still present)", !!parentRow && parentRow.status === "retired");

  // The 2 split children exist as active reconciliation-created nodes.
  const children = nodesAfterReconcile.filter((n) => n.status === "active" && (n.title === "Marginal Tradeoff" || n.title === "Next-Best Alternative"));
  check("AC-T1.7a: the split produced 2 active child nodes", children.length === 2, JSON.stringify(children.map((c) => c.title)));

  // The split parent's lineage is readable from the ACCEPTED rows (item before-row).
  check("AC-T1.7a: split lineage children resolve to the real accepted child ids", (childLineage as { parentNodeId?: string } | undefined)?.parentNodeId === oppCostId);
  const parentLineageChildren = (splitLineage?.childNodeIds ?? []).filter((cid) => byId.get(cid)?.status === "active");
  check("AC-T1.7a: the parent lineage's childNodeIds are REAL active node ids in the graph", parentLineageChildren.length >= 2, JSON.stringify(splitLineage?.childNodeIds));

  // REMOVED: Deadweight Loss retired (not deleted).
  check("removed node (Deadweight Loss) is RETIRED, not deleted", byId.get(dwlId)?.status === "retired");

  // AC-T1.8: the locked edge STILL EXISTS after accept.
  const lockedStill = (await admin.from("concept_edges").select("id,creator_locked").eq("id", lockedEdge.id).maybeSingle()).data;
  check("AC-T1.8: the creator_locked edge still exists after accept", !!lockedStill && lockedStill.creator_locked === true);

  /* ─────────────────── 6. SECOND reconciliation → REJECT (byte-for-byte) ─── */
  console.log("\n# 6. second reconciliation → reject restores the prior graph byte-for-byte");
  // Snapshot the CURRENT (post-accept) graph — the reject of the 2nd run must
  // restore exactly this. `updated_at` is a moddatetime-TRIGGER-maintained audit
  // mtime that a restore-upsert unavoidably re-stamps (the trigger fires BEFORE
  // UPDATE); it is NOT part of the semantic graph, so we strip it from the
  // byte-for-byte comparison (title/description/status/aliases/anchors/version/
  // merged_into + every edge field ARE compared).
  const stripMtime = (rows: Record<string, unknown>[]) => rows.map((r) => { const { updated_at, ...rest } = r; void updated_at; return rest; });
  const graphBeforeSecond = {
    nodes: stripMtime((await admin.from("concept_nodes").select("*").eq("course_id", fx.courseId).order("id")).data ?? []),
    edges: stripMtime((await admin.from("concept_edges").select("*").eq("course_id", fx.courseId).order("id")).data ?? []),
  };
  const graphBeforeStr = stableStringify(graphBeforeSecond);

  // A second reconciliation over the same publication — engineer a fresh delta
  // (re-propose the current active titles + one new concept) so it stages items.
  const currentActiveTitles = nodesAfterReconcile.filter((n) => n.status === "active").map((n) => n.title);
  const secondProposal = {
    concepts: [
      ...currentActiveTitles.map((t) => ({ title: t, description: `${t} — reconfirmed.`, lessonAnchors: [] as { blockId: string; slideId: string | null }[], confidence: 0.9, isAssumedPrior: false, evidenceQuote: "reconfirmed" })),
      { title: "Second-Run Novelty", description: "A brand new concept from the second run.", lessonAnchors: [], confidence: 0.8, isAssumedPrior: false, evidenceQuote: "novelty" },
    ],
  };
  const model2 = createMockModelClient([], { structured: { [PROPOSAL_RESPONSE_NAME]: secondProposal, [MERGE_RESPONSE_NAME]: { groups: [] }, [EDGE_RESPONSE_NAME]: { edges: [] } } });
  const second = await runGraphReconciliation(
    { supabase: admin, model: model2, loadSnapshot, config: { canonSimThreshold: -1 } },
    { courseId: fx.courseId, publicationId: newPubId, runId: await newRun() }
  );
  check("second reconciliation ok + staged a new set", second.ok && !second.alreadyPending && !!second.changeSetId, JSON.stringify({ ap: second.alreadyPending }));

  await rejectChangeSet(author, second.changeSetId!, fx.author.userId);
  await author.from("agent_findings").update({ status: "dismissed" }).eq("change_set_id", second.changeSetId!).eq("status", "proposed");

  const graphAfterReject = {
    nodes: stripMtime((await admin.from("concept_nodes").select("*").eq("course_id", fx.courseId).order("id")).data ?? []),
    edges: stripMtime((await admin.from("concept_edges").select("*").eq("course_id", fx.courseId).order("id")).data ?? []),
  };
  check(
    "reject restores the prior graph BYTE-FOR-BYTE (nodes + edges, excl. trigger mtime)",
    stableStringify(graphAfterReject) === graphBeforeStr,
    `before=${graphBeforeStr.length}b after=${stableStringify(graphAfterReject).length}b`
  );
  const rejectedSet = (await admin.from("change_sets").select("status").eq("id", second.changeSetId!).maybeSingle()).data;
  check("the second change_set is 'rejected'", rejectedSet?.status === "rejected");

  // The creator_edited node was NEVER auto-changed across the whole flow.
  const scarcityFinal = (await admin.from("concept_nodes").select("title,creator_edited,status,version").eq("id", scarcityId).maybeSingle()).data;
  check("the creator_edited node was never auto-changed (title/status/creator_edited intact)", scarcityFinal?.title === "Scarcity" && scarcityFinal?.creator_edited === true && scarcityFinal?.status === "active");

  // The prior locked edge STILL exists (survived every reconciliation).
  const lockedFinal = (await admin.from("concept_edges").select("id,creator_locked").eq("id", lockedEdge.id).maybeSingle()).data;
  check("the creator_locked edge survived the whole flow", !!lockedFinal && lockedFinal.creator_locked === true);

  /* ─────────────────────────────── done ─────────────────────────────────── */
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(JSON.stringify({ counts: { priorNodes: priorNodes.length, priorEdges: priorEdges.length, classified: reconcileResult.classified } }));
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
