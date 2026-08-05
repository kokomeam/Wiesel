/**
 * Concept Graph console -- INTEGRATION suite (live Supabase, no OpenAI key).
 * Self-provisions throwaway users each run + seeds a deterministic graph (no
 * model). Apply migrations 20260803100100 / 20260803100200 / 20260803110200 /
 * 20260805110000 before running. Covers:
 *
 *   T5.PRIV  tutor_graph_console is AUTHOR-GATED: the author gets a bundle, a
 *            stranger gets null; the mastery + confusion overlays are COHORT-
 *            FLOORED (a >=5 cohort shows a number; a <5 cohort is suppressed with
 *            the value NULL); a stranger reads ZERO learner rows by any path.
 *   T5.3     a versioned rename + addEdge PERSIST; a cycle-creating prerequisite
 *            edge is REJECTED by tutor_upsert_concept_edge with the specific
 *            "a {kind} edge {src} -> {tgt} would create a cycle" message.
 *   T5.4     tutor_merge_concept_nodes folds learner_mastery per Directive §1.4:
 *            the survivor row's evidence_count is the SUM; the absorbed rows are
 *            DELETED; the absorbed nodes are retired (merged_into).
 *   W5G.2    acceptChangeSet activates a staged concept_graph change-set (rows
 *            stay live, the set resolves); rejectChangeSet restores byte-for-byte
 *            (the un-created node is gone, the set is rejected).
 *
 * Run: `npx tsx scripts/verify-tutor-graph-console-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; on IPv6-broken networks the TLS socket
// resets before the handshake. Pin IPv4-first (load-bearing on this dev machine).
dns.setDefaultResultOrder("ipv4first");

/** Retry transient TRANSPORT failures (never HTTP errors) so the suite is
 *  deterministic on a flaky network. */
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

import type { Database, Json } from "@/lib/database.types";
import { ConceptEdgeCycleError } from "@/lib/tutor/graph/errors";
import {
  createConceptNode,
  getConceptNode,
  upsertConceptEdge,
  versionedUpdateConceptNode,
} from "@/lib/tutor/graph/repository";
import { acceptChangeSet, rejectChangeSet } from "@/lib/ai/changeSet";
import { loadGraphConsole } from "@/lib/studio/graphConsole";


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

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return {
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    service: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY,
  };
}

async function provisionUser(url: string, anon: string, tag: string) {
  const email = `tutor-gc-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "test-password-1234";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup: ${await signup.text()}`);
  const supabase = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin: ${error?.message}`);
  return { supabase, userId: data.user.id, email };
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY in .env.local");
  if (!service) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in .env.local (admin seeds)");

  const admin = createClient<Database>(url, service, {
    auth: { persistSession: false },
    global: { fetch: retryingFetch },
  });

  const A = await provisionUser(url, anon, "author");
  const B = await provisionUser(url, anon, "stranger");
  console.log("# provisioned an author + a stranger");

  // Fixture course owned by A.
  const courseId = crypto.randomUUID();
  const { error: courseErr } = await A.supabase.from("courses").insert({
    id: courseId,
    author_id: A.userId,
    title: "Concept Graph Console Fixture",
    description: "Deterministic graph for the P5.2 console suite.",
  });
  if (courseErr) throw new Error(`course insert: ${courseErr.message}`);

  /* ---- seed a small prerequisite chain A -> B -> C (author, real RPC edges) --- */
  const nA = await createConceptNode(A.supabase as never, { courseId, title: "Concept A", createdBy: "creator" });
  const nB = await createConceptNode(A.supabase as never, { courseId, title: "Concept B", createdBy: "creator" });
  const nC = await createConceptNode(A.supabase as never, { courseId, title: "Concept C", createdBy: "creator" });
  const nD = await createConceptNode(A.supabase as never, { courseId, title: "Concept D", createdBy: "creator" });
  await upsertConceptEdge(A.supabase as never, { id: crypto.randomUUID(), courseId, sourceNodeId: nA.id, targetNodeId: nB.id, kind: "prerequisite" });
  await upsertConceptEdge(A.supabase as never, { id: crypto.randomUUID(), courseId, sourceNodeId: nB.id, targetNodeId: nC.id, kind: "prerequisite" });

  /* ---- seed cohort overlays via admin (the strict-regime tables) --------------
   * mastery_course_aggregate: node A has a >=5 cohort (visible), node B has a <5
   * cohort (suppressed). rollup_content_feedback needs a live publication. */
  // A live publication (minimal snapshot) so the confusion overlay + the course
  // join resolves.
  const pubId = crypto.randomUUID();
  const snapshot = { modules: [] } as unknown as Json;
  const { error: pubErr } = await admin.from("course_publications").insert({
    id: pubId,
    course_id: courseId,
    version: 1,
    slug: `gc-fixture-${crypto.randomUUID().slice(0, 8)}`,
    snapshot,
    visibility: "unlisted",
    status: "live",
    content_hash: crypto.randomUUID().replace(/-/g, ""),
    created_by: A.userId,
  } as never);
  if (pubErr) throw new Error(`publication insert: ${pubErr.message}`);

  const { error: aggErr } = await admin.from("mastery_course_aggregate").insert([
    { course_id: courseId, node_id: nA.id, learner_count: 6, avg_decayed_p: 0.72, p25: 0.5, p50: 0.72, p75: 0.9, below_threshold_count: 1 },
    { course_id: courseId, node_id: nB.id, learner_count: 3, avg_decayed_p: 0.4, p25: 0.3, p50: 0.4, p75: 0.5, below_threshold_count: 2 },
  ] as never);
  if (aggErr) throw new Error(`aggregate insert: ${aggErr.message}`);

  // A confusion rollup row for a block: >=5 learners (visible). block_id must be a
  // uuid; slide_id null = the per-block row the RPC reads.
  const blockId = crypto.randomUUID();
  const lessonId = crypto.randomUUID();
  const { error: fbErr } = await admin.from("rollup_content_feedback").insert({
    course_id: courseId,
    publication_id: pubId,
    version: 1,
    lesson_id: lessonId,
    block_id: blockId,
    slide_id: null,
    helpful_count: 4,
    confusing_count: 3, // 4+3=7 >= 5 -> visible
    confusing_pct: 42.9,
    recent_comments: [],
  } as never);
  if (fbErr) throw new Error(`feedback insert: ${fbErr.message}`);

  /* ---------------- T5.PRIV -- author-gate + floored overlays ----------------- */
  console.log("\n# T5.PRIV -- tutor_graph_console author gate + cohort floor");
  const authorBundle = await loadGraphConsole(A.supabase as never, courseId);
  check("the author gets a bundle", authorBundle !== null);
  const strangerBundle = await loadGraphConsole(B.supabase as never, courseId);
  check("a stranger gets null (author gate -> 404)", strangerBundle === null);

  if (authorBundle) {
    check("bundle carries the 4 seeded nodes", authorBundle.nodes.length === 4, String(authorBundle.nodes.length));
    check("bundle carries the 2 seeded edges", authorBundle.edges.length === 2, String(authorBundle.edges.length));

    const mA = authorBundle.mastery.find((m) => m.node_id === nA.id);
    const mB = authorBundle.mastery.find((m) => m.node_id === nB.id);
    check(
      "node A mastery is VISIBLE (>=5 cohort): a number, not suppressed",
      !!mA && mA.suppressed === false && mA.learner_count === 6 && typeof mA.avg_decayed_p === "number",
      JSON.stringify(mA)
    );
    check(
      "node B mastery is SUPPRESSED (<5 cohort): NULL value, suppressed true, count hidden",
      !!mB && mB.suppressed === true && mB.learner_count === null && mB.avg_decayed_p === null,
      JSON.stringify(mB)
    );

    const conf = authorBundle.confusion.find((c) => c.block_id === blockId);
    check(
      "block confusion is VISIBLE (7 learners >= 5): a pct, not suppressed",
      !!conf && conf.suppressed === false && typeof conf.confusing_pct === "number" && conf.confusing_count === 3,
      JSON.stringify(conf)
    );
  }

  // A stranger reads ZERO learner rows by any direct path (strict regime).
  const bAgg = await B.supabase.from("mastery_course_aggregate").select("node_id").eq("course_id", courseId);
  const bMastery = await B.supabase.from("learner_mastery").select("node_id").eq("course_id", courseId);
  check(
    "a stranger reads ZERO rows from the strict learner tables directly",
    (bAgg.data ?? []).length === 0 && (bMastery.data ?? []).length === 0
  );

  /* ---------------- T5.3 -- versioned rename + addEdge + cycle rejection ------- */
  console.log("\n# T5.3 -- versioned edits persist; a cycle-creating edge is refused");
  const renamed = await versionedUpdateConceptNode(A.supabase as never, nA.id, nA.version, { title: "Concept A (renamed)", creator_edited: true });
  check("versioned rename persists + bumps version", renamed.title === "Concept A (renamed)" && renamed.version === nA.version + 1);

  const newEdge = await upsertConceptEdge(A.supabase as never, { id: crypto.randomUUID(), courseId, sourceNodeId: nA.id, targetNodeId: nD.id, kind: "prerequisite" });
  check("addEdge (A -> D prerequisite) persists via the RPC", newEdge.version === 1 && newEdge.sourceNodeId === nA.id && newEdge.targetNodeId === nD.id);

  let cycleErr: unknown = null;
  try {
    // C -> A would close A -> B -> C -> A.
    await upsertConceptEdge(A.supabase as never, { id: crypto.randomUUID(), courseId, sourceNodeId: nC.id, targetNodeId: nA.id, kind: "prerequisite" });
  } catch (e) {
    cycleErr = e;
  }
  check("a cycle-creating prerequisite edge is REJECTED (ConceptEdgeCycleError)", cycleErr instanceof ConceptEdgeCycleError, String(cycleErr));
  check(
    "the cycle error names the specific path (a prerequisite edge {C} -> {A} would create a cycle)",
    cycleErr instanceof ConceptEdgeCycleError &&
      cycleErr.message === `concept_edge_cycle: a prerequisite edge ${nC.id} → ${nA.id} would create a cycle`,
    cycleErr instanceof Error ? cycleErr.message : String(cycleErr)
  );

  /* ---------------- T5.4 -- merge folds learner_mastery ----------------------- */
  console.log("\n# T5.4 -- tutor_merge_concept_nodes folds learner_mastery (§1.4)");
  // Seed learner_mastery: survivor nC + absorbed nD, for TWO learners. Evidence
  // counts sum on fold; absorbed rows delete.
  const learner1 = crypto.randomUUID();
  const learner2 = crypto.randomUUID();
  const { error: lmErr } = await admin.from("learner_mastery").insert([
    { user_id: learner1, course_id: courseId, node_id: nC.id, p_learned: 0.8, decayed_p: 0.7, evidence_count: 3 },
    { user_id: learner1, course_id: courseId, node_id: nD.id, p_learned: 0.6, decayed_p: 0.5, evidence_count: 2 },
    { user_id: learner2, course_id: courseId, node_id: nD.id, p_learned: 0.4, decayed_p: 0.3, evidence_count: 5 },
  ] as never);
  if (lmErr) throw new Error(`learner_mastery insert: ${lmErr.message}`);

  const { data: mergeData, error: mergeErr } = await (A.supabase as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  }).rpc("tutor_merge_concept_nodes", {
    p_course_id: courseId,
    p_survivor_node_id: nC.id,
    p_absorbed_node_ids: [nD.id],
  } as never);
  check("merge RPC returns ok for the author", !mergeErr, mergeErr?.message ?? "");
  const merge = (mergeData ?? {}) as { survivorNodeId?: string; absorbedCount?: number; masteryRowsFolded?: number };
  check("merge report: survivor + 1 absorbed", merge.survivorNodeId === nC.id && merge.absorbedCount === 1);

  // Survivor learner rows: learner1 evidence 3+2=5; learner2 (only had D) folds to
  // the survivor node with evidence 5.
  const { data: survRows } = await admin
    .from("learner_mastery")
    .select("user_id, evidence_count")
    .eq("course_id", courseId)
    .eq("node_id", nC.id);
  const l1 = (survRows ?? []).find((r) => r.user_id === learner1);
  const l2 = (survRows ?? []).find((r) => r.user_id === learner2);
  check("learner1 survivor evidence_count = SUM (3+2 = 5)", l1?.evidence_count === 5, JSON.stringify(l1));
  check("learner2 (absorbed-only) folds onto the survivor node (evidence 5)", l2?.evidence_count === 5, JSON.stringify(l2));
  check("merge report folded both learners' rows", merge.masteryRowsFolded === 2, String(merge.masteryRowsFolded));

  // Absorbed rows deleted.
  const { data: absorbedRows } = await admin
    .from("learner_mastery")
    .select("user_id")
    .eq("course_id", courseId)
    .eq("node_id", nD.id);
  check("absorbed node's learner_mastery rows are DELETED", (absorbedRows ?? []).length === 0);

  // Absorbed node retired (merged_into) pointing at the survivor.
  const dAfter = await getConceptNode(A.supabase as never, nD.id);
  check(
    "absorbed node is retired: status merged_into, pointer to survivor",
    dAfter?.status === "merged_into" && dAfter?.mergedIntoNodeId === nC.id,
    JSON.stringify({ status: dAfter?.status, merged: dAfter?.mergedIntoNodeId })
  );

  /* ---------------- W5G.2 -- accept / reject a staged change-set -------------- */
  console.log("\n# W5G.2 -- accept activates; reject restores byte-for-byte");

  // Helper: stage a concept_graph change-set for a freshly-created node (op create,
  // after=payload). This mirrors what the extraction stager produces.
  async function stageCreate(node: { id: string }): Promise<string> {
    const row = await admin.from("concept_nodes").select("*").eq("id", node.id).single();
    if (row.error || !row.data) throw new Error(`stageCreate read: ${row.error?.message}`);
    const cs = await admin
      .from("change_sets")
      .insert({ course_id: courseId, summary: "graph review" } as never)
      .select("id")
      .single();
    if (cs.error || !cs.data) throw new Error(`change_set insert: ${cs.error?.message}`);
    const after = { entity: "concept_node", row: row.data, classification: "added" } as unknown as Json;
    const item = await admin.from("change_set_items").insert({
      change_set_id: cs.data.id,
      course_id: courseId,
      node_type: "concept_graph",
      node_id: node.id,
      block_id: null,
      op: "create",
      before: null,
      after,
      evidence: { discriminator: "graph_extraction", reason: "new concept" } as unknown as Json,
    } as never);
    if (item.error) throw new Error(`change_set_item insert: ${item.error.message}`);
    return cs.data.id;
  }

  // ACCEPT: a staged node stays live, the set resolves to 'accepted'.
  const acceptNode = await createConceptNode(A.supabase as never, { courseId, title: "Staged Accept Node", createdBy: "extraction" });
  const acceptCsId = await stageCreate(acceptNode);
  await acceptChangeSet(A.supabase as never, acceptCsId);
  const acceptSet = await admin.from("change_sets").select("status").eq("id", acceptCsId).single();
  const acceptStill = await getConceptNode(A.supabase as never, acceptNode.id);
  check("acceptChangeSet -> the set resolves to 'accepted'", acceptSet.data?.status === "accepted");
  check("accepted node stays live in concept_nodes", acceptStill !== null && acceptStill.status === "active");

  // The console bundle surfaces the pending set BEFORE accept + evidence-by-node.
  const rejectNode = await createConceptNode(A.supabase as never, { courseId, title: "Staged Reject Node", createdBy: "extraction" });
  const rejectCsId = await stageCreate(rejectNode);
  const pendingBundle = await loadGraphConsole(A.supabase as never, courseId);
  check("bundle exposes the pending concept_graph change-set id", pendingBundle?.pendingChangeSetId === rejectCsId, String(pendingBundle?.pendingChangeSetId));
  check("bundle exposes evidence for the staged node", !!pendingBundle && !!pendingBundle.evidenceByNode[rejectNode.id]);

  // REJECT: the un-created node is deleted, the set resolves to 'rejected'.
  await rejectChangeSet(A.supabase as never, rejectCsId, A.userId);
  const rejectSet = await admin.from("change_sets").select("status").eq("id", rejectCsId).single();
  const rejectGone = await getConceptNode(A.supabase as never, rejectNode.id);
  check("rejectChangeSet -> the set resolves to 'rejected'", rejectSet.data?.status === "rejected");
  check("rejected create is restored byte-for-byte: the node is GONE", rejectGone === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
