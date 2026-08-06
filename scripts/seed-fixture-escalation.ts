/**
 * Seed FIXTURE for the ESCALATION QUEUE (TUTOR-1 Wave 6.6, the escalation-review
 * demo artifact). Builds ON TOP of the tutor-console fixture: it seeds a SCRIPTED
 * escalation scenario on the fixture's degraded concept node, then runs the REAL
 * synthesis+clustering (`synthesizeAndCluster`) through a DETERMINISTIC MOCK model
 * (ZERO OpenAI spend) so the creator's Escalations queue shows exactly ONE cluster
 * of ~11 near-duplicate escalations with a stable representative question.
 *
 * WHAT IT SEEDS (on top of seedTutorConsoleFixture):
 *
 *   (1) ONE learner-REQUESTED consented escalation on node A — the "someone asked
 *       to send this to the instructor" origin (a fully-worded question).
 *
 *   (2) TEN NEAR-DUPLICATE consented escalations on the SAME node A, each with a
 *       DISTINCT learner user_id and a near-identical (paraphrased) question — the
 *       "eleven learners are stuck on the same thing" story.
 *
 *   (3) It runs `synthesizeAndCluster` for all 11 through a mock whose embed returns
 *       near-duplicate unit vectors (cosine ≫ the 0.83 cluster threshold), so the 11
 *       land in ONE cluster (member_count 11) whose representative_question is the
 *       first (learner-requested) question — deterministic subject text for the
 *       queue / reply / promote / digest paths to render.
 *
 * The synthesis path is the SAME production code the Inngest job runs — the demo
 * exercises real dossier + cluster + embedding-cost telemetry (each run lands a
 * tutor_model_call cost row: an 'embedding' row for the question embed AND now, since
 * Wave 6.6 widened the job_type CHECK, an 'escalation_dossier' row for the dossier
 * Terra call). NO model KEY is needed: the mock supplies both the structured dossier
 * verdict and the embedding vectors.
 *
 * Exported as `seedEscalationScenario`. It does NOT provision the fixture — the
 * caller passes an already-seeded TutorConsoleFixture (so the demo can print one
 * coherent story across the console + escalations surfaces). The caller owns
 * teardown (deleting the fixture course cascades the candidates/dossiers/clusters).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { EmbedParams, EmbedResult, ModelClient } from "@/lib/ai/modelClient";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
import { synthesizeAndCluster } from "@/lib/tutor/escalation/synthesis";
import { DOSSIER_RESPONSE_NAME } from "@/lib/tutor/escalation/dossier";
import type { TutorConsoleFixture } from "./seed-fixture-tutor-console";

type DB = SupabaseClient<Database>;

/** The scenario descriptor the demo prints. */
export interface EscalationScenario {
  /** The concept node the cluster forms on (the degraded lesson's node A). */
  nodeId: string;
  nodeTitle: string;
  /** The single cluster id every member joined. */
  clusterId: string;
  /** How many members landed in the cluster (should be 11). */
  memberCount: number;
  /** The cluster's representative question text (the queue row's subject). */
  representativeQuestion: string;
  /** The candidate ids seeded (the first is the learner-REQUESTED origin). */
  candidateIds: string[];
}

/** The near-duplicate question family (all paraphrase ONE confusion on node A). The
 *  FIRST entry is the learner-requested origin (fully worded). */
const QUESTION_FAMILY = [
  "Why does my Theta bound come out different from the book's answer for this loop?",
  "I keep getting a different Theta bound than the textbook — what am I missing?",
  "How come the Big-Theta I compute doesn't match the book's tight bound?",
  "My asymptotic bound disagrees with the book — is the constant factor the problem?",
  "The book says Theta(n log n) but I got Theta(n^2). Why the mismatch?",
  "Why is my tight bound off from the expected Theta for the same algorithm?",
  "I derived a different Theta than the answer key — where does the difference come from?",
  "The textbook's Theta bound and mine differ; what causes that gap?",
  "Why doesn't my Theta analysis line up with the book's stated bound?",
  "My computed Theta bound isn't the same as the book's — what's the mistake?",
  "How can my Theta bound be different from the book's if the algorithm is identical?",
];

/**
 * A MOCK ModelClient whose embed returns NEAR-DUPLICATE unit vectors for every input
 * (a shared family base + a tiny per-string perturbation → cosine ≫ the 0.83 cluster
 * threshold), and whose structured dossier call returns a fixed verdict. Deterministic
 * clustering with no key. (Mirrors verify-tutor-escalation-cluster-int's clusteringMock;
 * here EVERY question is a near-duplicate — there is no [distinct] path.)
 */
function escalationClusteringMock(): ModelClient {
  const base = createMockModelClient([], {
    structured: {
      [DOSSIER_RESPONSE_NAME]: {
        summary:
          "Learners are conflating the tight Theta bound with a looser upper bound; the confusion is the drop of lower-order terms and constant factors when matching the book's stated bound.",
        confidenceNotes: "Confirm the exact recurrence + which term dominates for this algorithm.",
      },
    },
  });
  const DIMS = 16;
  const familyBase = (() => {
    const raw = Array.from({ length: DIMS }, (_, i) => Math.cos(i + 1));
    const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0)) || 1;
    return raw.map((x) => x / norm);
  })();
  function vectorFor(input: string): number[] {
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

/** Insert ONE CONSENTED escalation candidate directly (service-role) on `nodeId`. */
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
      tutor_proposed_answer:
        "The tight Theta bound keeps only the dominant term and drops constants — match that term to the book's before comparing.",
      status: "consented",
      consented_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`candidate insert: ${error?.message}`);
  return (data as { id: string }).id;
}

/**
 * Seed the scripted escalation scenario ON the passed console fixture and run
 * synthesis+clustering (mock model). Returns the scenario descriptor. Does NOT clean
 * up — the caller owns the fixture course teardown (cascade removes these rows).
 */
export async function seedEscalationScenario(
  fixture: TutorConsoleFixture
): Promise<EscalationScenario> {
  const { admin, courseId } = fixture;
  const nodeId = fixture.nodeIds.A;

  // The node title (for the printed "which cluster to expect" line).
  const nodeRow = await admin
    .from("concept_nodes")
    .select("title")
    .eq("id", nodeId)
    .maybeSingle();
  const nodeTitle = (nodeRow.data as { title?: string } | null)?.title ?? "Asymptotic notation";

  // The pooled MOCK model — cost context (jobType 'escalation_dossier') so the
  // dossier Terra runTurn AND the question embed both land tutor_model_call cost
  // rows (Wave 6.6). emittedBy = the fixture author (the acting principal).
  const model = withPooledModel(escalationClusteringMock(), {
    pool: poolFor("creator"),
    cost: {
      supabase: admin,
      courseId,
      emittedBy: fixture.author.userId,
      jobType: "escalation_dossier",
    },
  });

  // (1) The learner-requested origin + (2) TEN near-duplicates — 11 distinct learner
  //     user_ids on ONE node (user_id has no FK, so random uuids are fine).
  const candidateIds: string[] = [];
  for (let i = 0; i < QUESTION_FAMILY.length; i++) {
    const learnerUserId = crypto.randomUUID();
    const id = await seedConsentedCandidate(admin, learnerUserId, courseId, nodeId, QUESTION_FAMILY[i]);
    candidateIds.push(id);
    const res = await synthesizeAndCluster(admin, model, id);
    if (!res.ok || !res.clusterId) {
      throw new Error(`synthesizeAndCluster failed for candidate ${i}: ${res.reason ?? "unknown"}`);
    }
  }

  // Read back the single cluster the family landed in (there should be exactly one
  // open cluster on node A).
  const clusters = await admin
    .from("escalation_cluster")
    .select("id, member_count, representative_question, status")
    .eq("course_id", courseId)
    .eq("node_id", nodeId)
    .eq("status", "open");
  const rows = (clusters.data ?? []) as Array<{
    id: string;
    member_count: number;
    representative_question: string | null;
    status: string;
  }>;
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly ONE open cluster on node A, got ${rows.length} — the mock family did not cluster`
    );
  }
  const cluster = rows[0];

  return {
    nodeId,
    nodeTitle,
    clusterId: cluster.id,
    memberCount: cluster.member_count,
    representativeQuestion: cluster.representative_question ?? QUESTION_FAMILY[0],
    candidateIds,
  };
}
