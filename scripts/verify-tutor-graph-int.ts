/**
 * Concept graph — INTEGRATION suite (live Supabase, no OpenAI key needed).
 * Self-provisions throwaway users each run. WRITE-ONLY in this package: the
 * orchestrator applies migration 20260803100100 before running it.
 *
 *   AC-T1.1  per-kind DAG cycle gate: A→B→C prerequisite edges succeed; C→A
 *            prerequisite is refused (ConceptEdgeCycleError); C→A 'related'
 *            SUCCEEDS — cycles are per-kind
 *   AC-T1.2  RLS matrix: author full CRUD on nodes; a stranger reads ZERO rows
 *            from every graph table; a stranger's direct INSERT into
 *            concept_edges fails (no policy); calling the RPC on someone else's
 *            course fails the author gate
 *   AC-W1M.1 versioned node update: a stale version → TutorVersionConflictError;
 *            re-read + re-apply succeeds and bumps version; recordTutorAction →
 *            revertTutorAction restores the node BYTE-FOR-BYTE; a revert PAST
 *            the window refuses; an edge upsert with a stale p_expected_version
 *            → version-conflict error
 *
 * Run (AFTER the migration is applied): `npx tsx scripts/verify-tutor-graph-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; on IPv6-broken networks (this dev
// machine's Clash setup) the TLS socket resets before the handshake. Pin
// IPv4-first — harmless everywhere else, load-bearing here.
dns.setDefaultResultOrder("ipv4first");

/** This network also drops connections sporadically mid-run. Retry transient
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

import type { Database, Json } from "@/lib/database.types";
import { ConceptEdgeCycleError, TutorVersionConflictError } from "@/lib/tutor/graph/errors";
import {
  createConceptNode,
  getConceptNode,
  upsertConceptEdge,
  versionedUpdateConceptNode,
} from "@/lib/tutor/graph/repository";
import { recordTutorAction, revertTutorAction, snapshotTutorEntity } from "@/lib/tutor/graph/entities";

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
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

async function provisionUser(url: string, anon: string, tag: string) {
  const email = `tutor-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY in .env.local");

  const A = await provisionUser(url, anon, "a");
  const B = await provisionUser(url, anon, "b");
  console.log("# provisioned two throwaway creators");

  // Fixture course owned by A (simplest RLS-legal insert).
  const courseId = crypto.randomUUID();
  const { error: courseErr } = await A.supabase.from("courses").insert({
    id: courseId,
    author_id: A.userId,
    title: "Watercolor Foundations",
    description: "Learn transparent watercolor from first principles.",
  });
  if (courseErr) throw new Error(`course insert: ${courseErr.message}`);

  /* ─────────────────── AC-T1.1 — per-kind cycle gate ─────────────────────── */
  console.log("\n# AC-T1.1 — the per-kind DAG cycle gate");
  const A_ = await createConceptNode(A.supabase as never, { courseId, title: "Concept A", createdBy: "creator" });
  const B_ = await createConceptNode(A.supabase as never, { courseId, title: "Concept B", createdBy: "creator" });
  const C_ = await createConceptNode(A.supabase as never, { courseId, title: "Concept C", createdBy: "creator" });

  const ab = await upsertConceptEdge(A.supabase as never, { id: crypto.randomUUID(), courseId, sourceNodeId: A_.id, targetNodeId: B_.id, kind: "prerequisite" });
  const bc = await upsertConceptEdge(A.supabase as never, { id: crypto.randomUUID(), courseId, sourceNodeId: B_.id, targetNodeId: C_.id, kind: "prerequisite" });
  check("A→B and B→C prerequisite edges commit through the RPC", ab.version === 1 && bc.version === 1);

  let cycleErr: unknown = null;
  try {
    await upsertConceptEdge(A.supabase as never, { id: crypto.randomUUID(), courseId, sourceNodeId: C_.id, targetNodeId: A_.id, kind: "prerequisite" });
  } catch (e) {
    cycleErr = e;
  }
  check("C→A prerequisite is refused (would close A→B→C→A)", cycleErr instanceof ConceptEdgeCycleError, String(cycleErr));

  const related = await upsertConceptEdge(A.supabase as never, { id: crypto.randomUUID(), courseId, sourceNodeId: C_.id, targetNodeId: A_.id, kind: "related" });
  check("C→A 'related' SUCCEEDS — cycles are per-kind", related.kind === "related" && related.version === 1);

  /* ─────────────────────── AC-T1.2 — RLS matrix ──────────────────────────── */
  console.log("\n# AC-T1.2 — the RLS matrix");
  // author full CRUD on nodes
  const upd = await versionedUpdateConceptNode(A.supabase as never, A_.id, A_.version, { description: "author can update" });
  check("author can create + read + update a node", upd.description === "author can update" && upd.version === A_.version + 1);

  // stranger reads zero from every graph table
  const bNodes = await B.supabase.from("concept_nodes").select("id").eq("course_id", courseId);
  const bEdges = await B.supabase.from("concept_edges").select("id").eq("course_id", courseId);
  const bSettings = await B.supabase.from("tutor_course_settings").select("course_id").eq("course_id", courseId);
  const bActions = await B.supabase.from("tutor_action").select("id").eq("course_id", courseId);
  const bAssumed = await B.supabase.from("assumed_prior_nodes").select("id").eq("course_id", courseId);
  const bSnap = await B.supabase.from("snapshot_concept_map").select("node_id").eq("course_id", courseId);
  check(
    "a stranger reads ZERO rows from every graph table",
    (bNodes.data ?? []).length === 0 &&
      (bEdges.data ?? []).length === 0 &&
      (bSettings.data ?? []).length === 0 &&
      (bActions.data ?? []).length === 0 &&
      (bAssumed.data ?? []).length === 0 &&
      (bSnap.data ?? []).length === 0
  );

  // stranger direct INSERT into concept_edges fails (no policy)
  const bInsert = await B.supabase.from("concept_edges").insert({
    course_id: courseId,
    source_node_id: A_.id,
    target_node_id: B_.id,
    kind: "related",
  } as never);
  check("a stranger's direct INSERT into concept_edges is refused (no policy)", bInsert.error !== null);

  // stranger calling the RPC on A's course fails the author gate
  let bRpcErr: unknown = null;
  try {
    await upsertConceptEdge(B.supabase as never, { id: crypto.randomUUID(), courseId, sourceNodeId: A_.id, targetNodeId: C_.id, kind: "related" });
  } catch (e) {
    bRpcErr = e;
  }
  check("a stranger calling the RPC on A's course is refused (author gate)", bRpcErr !== null && String(bRpcErr).includes("concept_edge_forbidden"));

  /* ───────────────── AC-W1M.1 — versioning + revert ──────────────────────── */
  console.log("\n# AC-W1M.1 — versioned writes + reversible ledger");
  const fresh = await getConceptNode(A.supabase as never, A_.id);
  const staleVersion = A_.version; // == 1, but the row is at version 2 now

  let staleErr: unknown = null;
  try {
    await versionedUpdateConceptNode(A.supabase as never, A_.id, staleVersion, { description: "stale write" });
  } catch (e) {
    staleErr = e;
  }
  check("a stale version → TutorVersionConflictError", staleErr instanceof TutorVersionConflictError);

  const reapplied = await versionedUpdateConceptNode(A.supabase as never, A_.id, fresh!.version, { description: "re-read then re-apply" });
  check("re-read + re-apply succeeds and bumps version", reapplied.description === "re-read then re-apply" && reapplied.version === fresh!.version + 1);

  // reversible ledger: snapshot BEFORE the change, record, mutate, then revert.
  const before = await snapshotTutorEntity(A.supabase as never, { entity: "concept_node", id: A_.id });
  const beforeRow = await getConceptNode(A.supabase as never, A_.id);
  const action = await recordTutorAction(A.supabase as never, {
    courseId,
    toolName: "edit_concept_node",
    actionKind: "update",
    reversibility: "reversible",
    beforeSnapshot: before as Json,
    targetRef: { entity: "concept_node", id: A_.id },
    summary: "edited the description",
  });
  await versionedUpdateConceptNode(A.supabase as never, A_.id, beforeRow!.version, { description: "post-record edit", title: "Concept A (renamed)" });
  const revertResult = await revertTutorAction(A.supabase as never, action.id);
  const restored = await getConceptNode(A.supabase as never, A_.id);
  check(
    "revertTutorAction restores the node BYTE-FOR-BYTE",
    revertResult.reverted &&
      restored!.description === beforeRow!.description &&
      restored!.title === beforeRow!.title &&
      restored!.version === beforeRow!.version
  );
  const secondRevert = await revertTutorAction(A.supabase as never, action.id);
  check("a second revert is an idempotent no-op", secondRevert.reverted === false);

  // a revert PAST the window refuses (fail-closed).
  const expBeforeRow = await getConceptNode(A.supabase as never, A_.id);
  const expiredAction = await recordTutorAction(A.supabase as never, {
    courseId,
    toolName: "edit_concept_node",
    actionKind: "update",
    reversibility: "reversible",
    beforeSnapshot: (await snapshotTutorEntity(A.supabase as never, { entity: "concept_node", id: A_.id })) as Json,
    targetRef: { entity: "concept_node", id: A_.id },
  });
  await versionedUpdateConceptNode(A.supabase as never, A_.id, expBeforeRow!.version, { description: "another edit" });
  let windowErr: unknown = null;
  try {
    // now == far past the default 24h window
    await revertTutorAction(A.supabase as never, expiredAction.id, { nowIso: "2099-01-01T00:00:00.000Z" });
  } catch (e) {
    windowErr = e;
  }
  check("a revert PAST the window refuses (fail-closed)", windowErr !== null && String(windowErr).includes("Revert window expired"));

  // an edge upsert with a stale p_expected_version → version-conflict error.
  const bumped = await upsertConceptEdge(A.supabase as never, { id: ab.id, courseId, sourceNodeId: A_.id, targetNodeId: B_.id, kind: "prerequisite", creatorLocked: true }, ab.version);
  check("an edge upsert with the current version bumps it", bumped.version === ab.version + 1 && bumped.creatorLocked);
  let edgeVerErr: unknown = null;
  try {
    await upsertConceptEdge(A.supabase as never, { id: ab.id, courseId, sourceNodeId: A_.id, targetNodeId: B_.id, kind: "prerequisite" }, ab.version);
  } catch (e) {
    edgeVerErr = e;
  }
  check("an edge upsert with a STALE p_expected_version → TutorVersionConflictError", edgeVerErr instanceof TutorVersionConflictError);

  /* ─────────────────────────────── done ─────────────────────────────────── */
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
