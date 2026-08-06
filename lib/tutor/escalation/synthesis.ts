/**
 * Escalation SYNTHESIS + CLUSTERING service (TUTOR-1 Wave 6 · P6.2).
 *
 * `synthesizeAndCluster(admin, model, candidateId)` is the on-consent job body: it
 * turns ONE consented escalation candidate into the two derived rows (an identity-
 * bearing escalation_dossier + a join into an identity-free escalation_cluster).
 * It runs SERVICE-ROLE (the admin client) — escalation_dossier has ZERO policies,
 * so only the service role writes/reads it.
 *
 * IDEMPOTENT per candidate_id: the dossier PK is candidate_id, so a re-run (an
 * Inngest event replay OR the nightly reconcile) UPSERTS the same row and re-uses
 * its already-assigned cluster (STABLE identity — a candidate never hops clusters
 * on re-run). A candidate already carrying a dossier short-circuits with its
 * existing cluster id.
 *
 * PRIVACY: the Terra prompt carries NO learner identity (buildDossierPrompt takes
 * only the anonymized question + node context). The identity (user_id) lands only
 * on the dossier ROW, never in a model call.
 *
 * FAIL-BENIGN: a not-'consented' candidate, a missing candidate, or a model that
 * declines to synthesize is a no-op returning a reason — never a throw. The caller
 * (the Inngest step / the nightly reconcile) settles on the returned result.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { ModelClient } from "@/lib/ai/modelClient";
import { TUTOR_MODELS } from "@/lib/ai/modelConfig";
import { synthesizeDossier, type DossierNodeContext } from "./dossier";
import { assignCluster, type OpenCluster } from "./clustering";
import { TUTOR_ESCALATION_CLUSTER_THRESHOLD } from "./config";

type DB = SupabaseClient<Database>;

export interface SynthesizeAndClusterResult {
  ok: boolean;
  /** The cluster the candidate landed in (stable across re-runs). */
  clusterId: string | null;
  /** True when the candidate already had a dossier — the run was a stable no-op. */
  reused: boolean;
  reason?: string;
}

/** Coerce a jsonb array of node ids into a string[] (defensive; tolerates junk). */
function nodeIdsFromJson(value: Json | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Coerce a jsonb embedding into number[] (defensive). */
function vectorFromJson(value: Json | null | undefined): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === "number");
}

/** Coerce the rung trail jsonb into [{rung}] (defensive; drops malformed entries). */
function rungTrailFromJson(value: Json | null | undefined): { rung: number }[] {
  if (!Array.isArray(value)) return [];
  const out: { rung: number }[] = [];
  for (const entry of value) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const rung = (entry as Record<string, unknown>).rung;
      if (typeof rung === "number") out.push({ rung });
    }
  }
  return out;
}

/**
 * Synthesize + cluster ONE consented escalation candidate. Service-role. Idempotent
 * per candidate_id. Returns the (stable) cluster id.
 */
export async function synthesizeAndCluster(
  admin: DB,
  model: ModelClient,
  candidateId: string
): Promise<SynthesizeAndClusterResult> {
  // 1. Load the candidate (service-role — a consent_pending/withdrawn row is
  //    unreadable to any client role; only synthesis reaches it).
  const cand = await admin
    .from("tutor_escalation_candidates")
    .select("id, user_id, course_id, node_ids, learner_question, rung_trail, tutor_proposed_answer, status")
    .eq("id", candidateId)
    .maybeSingle();
  if (cand.error || !cand.data) {
    return { ok: false, clusterId: null, reused: false, reason: "candidate_not_found" };
  }
  if (cand.data.status !== "consented") {
    // Only consent moves an escalation into creator scope. A pending/withdrawn row
    // is never synthesized (defense in depth — the caller already gates on consent).
    return { ok: false, clusterId: null, reused: false, reason: "not_consented" };
  }

  const courseId = cand.data.course_id;
  const userId = cand.data.user_id;
  const question = cand.data.learner_question ?? "";
  const nodeIds = nodeIdsFromJson(cand.data.node_ids);
  const rungTrail = rungTrailFromJson(cand.data.rung_trail);
  const tutorProposedAnswer = cand.data.tutor_proposed_answer;
  // The cluster lives on the FIRST implicated concept node (the primary stuck node).
  const primaryNodeId = nodeIds[0] ?? null;
  if (!primaryNodeId) {
    return { ok: false, clusterId: null, reused: false, reason: "no_node" };
  }

  // 2. Idempotency: a candidate already carrying a dossier is a stable no-op —
  //    reuse its cluster (never hop). Recompute the cluster's rollup so a re-run
  //    still reconciles the count (cheap + keeps the cluster fresh).
  const existing = await admin
    .from("escalation_dossier")
    .select("candidate_id, cluster_id")
    .eq("candidate_id", candidateId)
    .maybeSingle();
  if (existing.data?.cluster_id) {
    await recomputeCluster(admin, existing.data.cluster_id);
    return { ok: true, clusterId: existing.data.cluster_id, reused: true };
  }

  // 3. Load the concept-node context (identity-free — titles/descriptions/anchors).
  const nodeContext = await loadNodeContext(admin, nodeIds, tutorProposedAnswer, rungTrail);

  // 4. Synthesize the dossier (Terra; NO identity in the prompt). A model failure is
  //    benign — we still cluster + persist the raw payload so the creator sees the
  //    question, just without the synthesized prose.
  const synth = await synthesizeDossier({ model }, { question, nodeContext });
  const dossierJson: Json | null = synth.ok && synth.data ? { ...synth.data } : null;

  // 5. Embed the question (emits an 'embedding' tutor_model_call cost row via the
  //    withPooledModel decorator — the cost telemetry AC-W6D.1 requires).
  const questionVector = await embedQuestion(model, question);

  // 6. Assign to the nearest OPEN cluster on the SAME node, or create a new one.
  const openClusters = await loadOpenClusters(admin, courseId, primaryNodeId);
  let clusterId = assignCluster(
    questionVector,
    openClusters,
    primaryNodeId,
    TUTOR_ESCALATION_CLUSTER_THRESHOLD
  );
  if (!clusterId) {
    const created = await admin
      .from("escalation_cluster")
      .insert({
        course_id: courseId,
        node_id: primaryNodeId,
        representative_question: question,
        representative_answer: tutorProposedAnswer ?? null,
        member_count: 0,
        status: "open",
      })
      .select("id")
      .single();
    if (created.error || !created.data) {
      return { ok: false, clusterId: null, reused: false, reason: `cluster_insert: ${created.error?.message}` };
    }
    clusterId = created.data.id;
  }

  // 7. UPSERT the dossier (PK candidate_id → idempotent). Identity-bearing row.
  const up = await admin.from("escalation_dossier").upsert(
    {
      candidate_id: candidateId,
      course_id: courseId,
      user_id: userId,
      node_ids: nodeIds as unknown as Json,
      learner_question: question,
      rung_trail: rungTrail as unknown as Json,
      tutor_proposed_answer: tutorProposedAnswer ?? null,
      dossier: dossierJson,
      question_embedding: questionVector as unknown as Json,
      cluster_id: clusterId,
    },
    { onConflict: "candidate_id" }
  );
  if (up.error) {
    return { ok: false, clusterId: null, reused: false, reason: `dossier_upsert: ${up.error.message}` };
  }

  // 8. Recompute the cluster's member_count + representative from its members.
  await recomputeCluster(admin, clusterId);

  return { ok: true, clusterId, reused: false };
}

/* ─────────────────────────── node context load ──────────────────────────── */

/** Load the concept-node context (titles/descriptions) for the escalation's nodes.
 *  Identity-free. Missing nodes (an escalation may name a node that was later
 *  retired, or a non-uuid placeholder) are simply omitted. */
async function loadNodeContext(
  admin: DB,
  nodeIds: string[],
  tutorProposedAnswer: string | null,
  rungTrail: { rung: number }[]
): Promise<DossierNodeContext> {
  const uuidIds = nodeIds.filter(isUuid);
  const nodes: { title: string; description?: string }[] = [];
  if (uuidIds.length > 0) {
    const res = await admin
      .from("concept_nodes")
      .select("id, title, description")
      .in("id", uuidIds);
    if (!res.error && res.data) {
      // Preserve the escalation's own node order.
      const byId = new Map(res.data.map((n) => [n.id, n]));
      for (const id of uuidIds) {
        const n = byId.get(id);
        if (n) nodes.push({ title: n.title, description: n.description ?? undefined });
      }
    }
  }
  return { nodes, tutorProposedAnswer, rungTrail };
}

/* ─────────────────────────── embedding ──────────────────────────────────── */

/** Embed the question through the (pooled) model client. The decorator emits the
 *  'embedding' cost row. A model with no embed / a failure yields an empty vector
 *  (→ the question forms its own cluster, never crashes synthesis). */
async function embedQuestion(model: ModelClient, question: string): Promise<number[]> {
  if (!model.embed || !question.trim()) return [];
  try {
    const res = await model.embed({
      model: TUTOR_MODELS.embedding.model,
      inputs: [question],
      timeoutMs: TUTOR_MODELS.embedding.timeoutMs,
    });
    return res.vectors[0] ?? [];
  } catch {
    return [];
  }
}

/* ─────────────────────────── cluster helpers ────────────────────────────── */

/** Load the OPEN clusters on ONE node of a course, each with its representative
 *  member's embedding as the centroid stand-in (the earliest dossier on the
 *  cluster — STABLE, matches recomputeCluster's representative choice). */
async function loadOpenClusters(admin: DB, courseId: string, nodeId: string): Promise<OpenCluster[]> {
  const clusters = await admin
    .from("escalation_cluster")
    .select("id, node_id")
    .eq("course_id", courseId)
    .eq("node_id", nodeId)
    .eq("status", "open");
  if (clusters.error || !clusters.data) return [];

  const out: OpenCluster[] = [];
  for (const cl of clusters.data) {
    const centroid = await centroidVectorFor(admin, cl.id);
    out.push({ id: cl.id, nodeId: cl.node_id, centroidVector: centroid });
  }
  return out;
}

/** The centroid stand-in for a cluster = the earliest member dossier's embedding. */
async function centroidVectorFor(admin: DB, clusterId: string): Promise<number[]> {
  const rep = await admin
    .from("escalation_dossier")
    .select("question_embedding")
    .eq("cluster_id", clusterId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (rep.error || !rep.data) return [];
  return vectorFromJson(rep.data.question_embedding);
}

/**
 * Recompute a cluster's member_count + representative from its dossier members.
 * The representative is the EARLIEST member (the cluster's origin — stable so the
 * creator's queue row doesn't reshuffle its example text as members arrive).
 */
async function recomputeCluster(admin: DB, clusterId: string): Promise<void> {
  const members = await admin
    .from("escalation_dossier")
    .select("learner_question, tutor_proposed_answer, created_at")
    .eq("cluster_id", clusterId)
    .order("created_at", { ascending: true });
  if (members.error) return;
  const rows = members.data ?? [];
  const rep = rows[0];
  await admin
    .from("escalation_cluster")
    .update({
      member_count: rows.length,
      ...(rep
        ? {
            representative_question: rep.learner_question ?? null,
            representative_answer: rep.tutor_proposed_answer ?? null,
          }
        : {}),
    })
    .eq("id", clusterId);
}

/* ─────────────────────────── util ───────────────────────────────────────── */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
