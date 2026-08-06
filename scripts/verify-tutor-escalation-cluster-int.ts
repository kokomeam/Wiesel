/**
 * TUTOR-1 Wave 6 (P6.2) — escalation DOSSIER + CLUSTERING INTEGRATION suite
 * (live Supabase + the mock ModelClient, NO OpenAI key). Self-provisions throwaway
 * users each run. Requires the W6.2 migration (20260806110000_escalation_dossier_cluster.sql)
 * to be APPLIED (the orchestrator applies it before this runs) AND
 * SUPABASE_SERVICE_ROLE_KEY (escalation_dossier is service-role-only by design).
 *
 * ── AC-T6.1 — clustering ──────────────────────────────────────────────────────
 *   Seed 10 NEAR-DUPLICATE consented escalations on ONE concept node → synthesize
 *   each → exactly ONE cluster with member_count 10. An 11th near-duplicate arriving
 *   LATER JOINS the SAME cluster id (unchanged — stable identity). A DISTINCT
 *   question on the same node forms a SECOND cluster.
 *
 * ── AC-W6D.1 — synthesis idempotency + cost + privacy ─────────────────────────
 *   Re-running synthesis for a candidate is a no-op (no duplicate dossier, cluster
 *   count unchanged). Cost telemetry is emitted (≥1 tutor_model_call row for the
 *   question embed). escalation_dossier has ZERO author policies (a creator/author
 *   principal reads ZERO dossier rows — the roster-privacy guarantee) WHILE the
 *   author-gated tutor_escalation_queue RPC returns the cluster WITH its count.
 *
 * Run (AFTER the migration): `npx tsx scripts/verify-tutor-escalation-cluster-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Node prefers supabase.co's IPv6 record; pin IPv4-first for this dev machine.
dns.setDefaultResultOrder("ipv4first");

/** Retry transient TRANSPORT failures (never HTTP errors) so the suite is stable. */
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
import type { EmbedParams, EmbedResult, ModelClient } from "@/lib/ai/modelClient";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
import { synthesizeAndCluster } from "@/lib/tutor/escalation/synthesis";
import { DOSSIER_RESPONSE_NAME } from "@/lib/tutor/escalation/dossier";
import { loadEscalationQueue } from "@/lib/studio/escalationQueue";

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

type DB = SupabaseClient<Database>;

function loadEnv(): { url: string; anon: string; service?: string } {
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

async function provisionUser(
  url: string,
  anon: string,
  tag: string
): Promise<{ client: DB; userId: string; email: string }> {
  const email = `tutor-esc-clu-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  console.log(`# provisioned ${email}`);
  return { client, userId: data.user.id, email };
}

/**
 * A mock ModelClient whose embed returns NEAR-DUPLICATE unit vectors for any input
 * marked "near" (a shared base + a tiny per-string perturbation → cosine ≫ 0.83) and
 * a DISTINCT unit vector for a "distinct" input — so we can drive genuine clustering
 * deterministically without a key. Structured dossier calls fall through to the base
 * mock's configured `structured` map. embed usage is a real EmbedResult so the
 * withPooledModel cost decorator emits a tutor_model_call row.
 */
function clusteringMock(): ModelClient {
  const base = createMockModelClient([], {
    structured: { [DOSSIER_RESPONSE_NAME]: { summary: "The learner is stuck on this concept.", confidenceNotes: "Confirm the exact bound." } },
  });
  const DIMS = 16;
  // The shared "near-duplicate family" base vector (deterministic).
  const familyBase = (() => {
    const raw = Array.from({ length: DIMS }, (_, i) => Math.cos(i + 1));
    const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0)) || 1;
    return raw.map((x) => x / norm);
  })();
  const distinctBase = (() => {
    const raw = Array.from({ length: DIMS }, (_, i) => (i % 2 === 0 ? 1 : -1) * ((i % 3) + 1));
    const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0)) || 1;
    return raw.map((x) => x / norm);
  })();
  function vectorFor(input: string): number[] {
    if (input.startsWith("[distinct]")) return distinctBase;
    // Near family: perturb dimension (hash % DIMS) by a tiny epsilon, renormalize.
    let h = 0;
    for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
    const idx = h % DIMS;
    const nudged = familyBase.map((v, i) => (i === idx ? v + 0.01 : v));
    const norm = Math.sqrt(nudged.reduce((s, x) => s + x * x, 0)) || 1;
    return nudged.map((x) => x / norm);
  }
  return {
    model: base.model,
    runTurn: (params, onEvent) => base.runTurn(params, onEvent),
    async embed(params: EmbedParams): Promise<EmbedResult> {
      const vectors = params.inputs.map(vectorFor);
      const inputTokens = params.inputs.reduce((s, str) => s + Math.ceil(str.length / 4), 0);
      return { vectors, usage: { inputTokens } };
    },
  };
}

/** Insert a CONSENTED candidate directly (service-role), on `nodeId`. */
async function seedConsentedCandidate(
  admin: DB,
  learnerUserId: string,
  courseId: string,
  nodeId: string,
  question: string
): Promise<string> {
  const { data, error } = await admin
    .from("tutor_escalation_candidates")
    .insert({
      user_id: learnerUserId,
      course_id: courseId,
      learner_question: question,
      node_ids: [nodeId] as never,
      anchors: [] as never,
      rung_trail: [{ rung: 2 }] as never,
      tutor_proposed_answer: "The tutor's best guess, for the instructor to confirm.",
      status: "consented",
      consented_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`candidate insert: ${error?.message}`);
  return data.id;
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:tutor-escalation-cluster:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  // Seed a minimal course + one concept node (the node the escalations cluster on).
  const courseId = crypto.randomUUID();
  const { error: cErr } = await author.client.from("courses").insert({
    id: courseId,
    author_id: author.userId,
    title: `Escalation cluster itest ${crypto.randomUUID().slice(0, 6)}`,
    description: "P6.2 fixture",
  } as never);
  if (cErr) throw new Error(`course insert: ${cErr.message}`);

  const nodeA = crypto.randomUUID();
  const nodeB = crypto.randomUUID();
  const { error: nErr } = await author.client.from("concept_nodes").insert([
    { id: nodeA, course_id: courseId, title: "Asymptotic notation", description: "Big-O / Theta / Omega.", anchors: [{ lessonId: "les-1", blockId: "blk-1", slideId: "sld-1" }] },
    { id: nodeB, course_id: courseId, title: "Recurrence relations", description: "Solving recurrences.", anchors: [] },
  ] as never);
  if (nErr) throw new Error(`concept_nodes insert: ${nErr.message}`);
  console.log("# seeded course + 2 concept nodes");

  // The pooled model — cost context so the embed emits a tutor_model_call row.
  const model = withPooledModel(clusteringMock(), {
    pool: poolFor("creator"),
    cost: { supabase: admin, courseId, emittedBy: author.userId, jobType: "escalation_dossier" },
  });

  const cleanup = async () => {
    // Children cascade off courses (candidates, dossiers, clusters, nodes).
    await admin.from("escalation_dossier").delete().eq("course_id", courseId);
    await admin.from("escalation_cluster").delete().eq("course_id", courseId);
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ───── AC-T6.1 — 10 near-duplicates → ONE cluster of 10 ─────────────────── */
    console.log("\n# AC-T6.1 — 10 near-duplicate escalations on one node → one cluster");
    const candidateIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await seedConsentedCandidate(
        admin,
        learner.userId,
        courseId,
        nodeA,
        `Why does my Theta bound differ from the book? (phrasing ${i})`
      );
      candidateIds.push(id);
      const res = await synthesizeAndCluster(admin, model, id);
      check(`synthesis ${i} ok`, res.ok && res.clusterId != null, res.reason ?? "");
    }

    const clustersA = await admin
      .from("escalation_cluster")
      .select("id, member_count, node_id, status")
      .eq("course_id", courseId)
      .eq("node_id", nodeA);
    check("exactly ONE cluster formed on node A", (clustersA.data ?? []).length === 1, `count=${(clustersA.data ?? []).length}`);
    const clusterId = clustersA.data?.[0]?.id;
    if (!clusterId) throw new Error("no family cluster formed — cannot continue");
    check("the cluster member_count is 10", clustersA.data?.[0]?.member_count === 10, `mc=${clustersA.data?.[0]?.member_count}`);
    check("the cluster status is open", clustersA.data?.[0]?.status === "open");

    const dossiers = await admin.from("escalation_dossier").select("candidate_id, cluster_id").eq("course_id", courseId);
    check("10 dossiers exist", (dossiers.data ?? []).length === 10);
    check("all 10 dossiers point at the SAME cluster", (dossiers.data ?? []).every((d) => d.cluster_id === clusterId));

    /* ───── an 11th near-dup JOINS the same cluster (stable id) ──────────────── */
    console.log("\n# AC-T6.1 — an 11th near-duplicate JOINS the same cluster (id unchanged)");
    const id11 = await seedConsentedCandidate(admin, learner.userId, courseId, nodeA, "Yet another Theta phrasing (11th)");
    const res11 = await synthesizeAndCluster(admin, model, id11);
    check("11th joined the SAME cluster id", res11.ok && res11.clusterId === clusterId, `got=${res11.clusterId} want=${clusterId}`);
    const afterEleven = await admin.from("escalation_cluster").select("id, member_count").eq("course_id", courseId).eq("node_id", nodeA);
    check("still exactly ONE cluster on node A", (afterEleven.data ?? []).length === 1);
    check("member_count is now 11", afterEleven.data?.[0]?.member_count === 11, `mc=${afterEleven.data?.[0]?.member_count}`);

    /* ───── a DISTINCT question forms a SECOND cluster ──────────────────────── */
    console.log("\n# AC-T6.1 — a distinct question forms a NEW cluster");
    const idDistinct = await seedConsentedCandidate(admin, learner.userId, courseId, nodeA, "[distinct] How do I even set up the recurrence?");
    const resDistinct = await synthesizeAndCluster(admin, model, idDistinct);
    check("distinct question got a cluster", resDistinct.ok && resDistinct.clusterId != null);
    check("distinct question is a DIFFERENT cluster", resDistinct.clusterId !== clusterId);
    const twoClusters = await admin.from("escalation_cluster").select("id").eq("course_id", courseId).eq("node_id", nodeA);
    check("now TWO clusters on node A", (twoClusters.data ?? []).length === 2);

    /* ───── AC-W6D.1 — idempotency: re-run is a no-op ───────────────────────── */
    console.log("\n# AC-W6D.1 — synthesis is idempotent per candidate");
    const reRun = await synthesizeAndCluster(admin, model, candidateIds[0]);
    check("re-run reports reused + the SAME cluster", reRun.ok && reRun.reused && reRun.clusterId === clusterId);
    const dossiersAfterRerun = await admin.from("escalation_dossier").select("candidate_id").eq("course_id", courseId);
    // 10 (family) + 1 (11th) + 1 (distinct) = 12 dossiers; re-run added none.
    check("re-run did NOT duplicate the dossier (still 12 total)", (dossiersAfterRerun.data ?? []).length === 12, `count=${(dossiersAfterRerun.data ?? []).length}`);
    const clusterAfterRerun = await admin.from("escalation_cluster").select("member_count").eq("id", clusterId).single();
    check("the family cluster count stays 11 after a re-run", clusterAfterRerun.data?.member_count === 11);

    /* ───── AC-W6D.1 — cost telemetry emitted ───────────────────────────────── */
    console.log("\n# AC-W6D.1 — cost telemetry (a tutor_model_call row)");
    const tutorEvents = await admin
      .from("learning_events")
      .select("id, event_type, job_type")
      .eq("course_id", courseId)
      .like("event_type", "tutor_%");
    check("≥1 tutor_model_call row was emitted", (tutorEvents.data ?? []).length >= 1, `rows=${(tutorEvents.data ?? []).length}`);
    check("every tutor telemetry row is a tutor_model_call", (tutorEvents.data ?? []).every((e) => e.event_type === "tutor_model_call"));
    check("at least one row is job_type=embedding (the question embed)", (tutorEvents.data ?? []).some((e) => e.job_type === "embedding"));

    /* ───── AC-W6D.1 — dossier ZERO author policies (privacy) ────────────────── */
    console.log("\n# AC-W6D.1 — escalation_dossier is creator-UNREADABLE (roster privacy)");
    const authorDossier = await author.client.from("escalation_dossier").select("candidate_id").eq("course_id", courseId);
    check("the AUTHOR reads ZERO dossier rows (zero policies)", (authorDossier.data ?? []).length === 0, `rows=${(authorDossier.data ?? []).length}, err=${authorDossier.error?.message}`);
    const learnerDossier = await learner.client.from("escalation_dossier").select("candidate_id").eq("course_id", courseId);
    check("the LEARNER also reads ZERO dossier rows (identity-bearing, server-only)", (learnerDossier.data ?? []).length === 0);

    /* ───── AC-W6Q — the queue returns the cluster WITH its count (no roster) ── */
    console.log("\n# the author-gated queue returns clusters WITH counts (never a user_id)");
    const queue = await loadEscalationQueue(author.client, courseId);
    check("queue returns TWO clusters on node A", queue.length === 2, `len=${queue.length}`);
    const familyRow = queue.find((c) => c.id === clusterId);
    check("the family cluster is in the queue with member_count 11", familyRow?.memberCount === 11, `mc=${familyRow?.memberCount}`);
    check("the queue row carries the node title", familyRow?.nodeTitle === "Asymptotic notation");
    check("the queue row carries the node anchors (deep-link)", (familyRow?.anchors ?? []).length === 1 && familyRow?.anchors[0]?.lessonId === "les-1");
    check(
      "NO queue row leaks a user_id (COUNT ONLY)",
      queue.every((c) => !("userId" in (c as Record<string, unknown>)) && !("user_id" in (c as Record<string, unknown>)))
    );
    // A non-author gets an empty queue (RPC → null → []).
    const strangerQueue = await loadEscalationQueue(learner.client, courseId);
    check("a non-author gets an EMPTY queue (RPC null → [])", strangerQueue.length === 0);
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
