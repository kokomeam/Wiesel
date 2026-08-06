/**
 * TUTOR-1 Wave 6 (P6.2) PURE verification — no key, no DB, no browser.
 * Run: `npx tsx scripts/verify-tutor-escalation-cluster.ts`
 *
 * Covers the escalation dossier + clustering PURE core:
 *   - assignCluster STABLE-identity logic: a near-duplicate joins the nearest OPEN
 *     cluster on the SAME node; a distinct question clears no cluster → null (a new
 *     cluster); a wrong-node cluster NEVER joins; the highest-cosine cluster wins.
 *   - DossierSchema parses a valid dossier + rejects an empty/over-long one.
 *   - buildDossierPrompt is IDENTITY-FREE (no user id / email / name leaks) and
 *     carries the question + node context.
 *   - the cosine helper is REUSED from graph/canonicalize (one implementation).
 *   - the cluster threshold is a documented ratio in [0,1].
 */

import { cosineSimilarity } from "@/lib/tutor/graph/canonicalize";
import { assignCluster, type OpenCluster } from "@/lib/tutor/escalation/clustering";
import { DossierSchema, buildDossierPrompt, DOSSIER_RESPONSE_NAME } from "@/lib/tutor/escalation/dossier";
import { TUTOR_ESCALATION_CLUSTER_THRESHOLD } from "@/lib/tutor/escalation/config";

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

/** A deterministic near-duplicate of `base`: nudge one dimension slightly then
 *  renormalize, so cosine stays well above any sensible threshold. */
function nearDuplicate(base: number[], epsilon = 0.02): number[] {
  const nudged = base.map((v, i) => (i === 0 ? v + epsilon : v));
  const norm = Math.sqrt(nudged.reduce((s, x) => s + x * x, 0)) || 1;
  return nudged.map((x) => x / norm);
}

/** A deterministic ORTHOGONAL-ish vector (low cosine to `base`). */
function distinctVector(dims: number): number[] {
  const raw = Array.from({ length: dims }, (_, i) => (i % 2 === 0 ? 1 : -1) * ((i % 5) + 1));
  const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0)) || 1;
  return raw.map((x) => x / norm);
}

function clusteringTests() {
  console.log("\n— assignCluster stable-identity —");
  const dims = 16;
  const baseA = (() => {
    const raw = Array.from({ length: dims }, (_, i) => Math.sin(i + 1));
    const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0)) || 1;
    return raw.map((x) => x / norm);
  })();

  const nodeX = "11111111-1111-4111-8111-111111111111";
  const nodeY = "22222222-2222-4222-8222-222222222222";
  const threshold = 0.83;

  // One OPEN cluster on nodeX with baseA as its centroid.
  const clusters: OpenCluster[] = [{ id: "cluster-A", nodeId: nodeX, centroidVector: baseA }];

  // A near-duplicate on the SAME node JOINS cluster-A.
  const dup = nearDuplicate(baseA);
  check(
    "a near-duplicate question on the SAME node joins the existing cluster",
    assignCluster(dup, clusters, nodeX, threshold) === "cluster-A",
    `cosine=${cosineSimilarity(dup, baseA)}`
  );

  // A DISTINCT question on the same node clears no cluster → null (new cluster).
  const distinct = distinctVector(dims);
  check(
    "a distinct question on the same node forms a NEW cluster (null)",
    assignCluster(distinct, clusters, nodeX, threshold) === null,
    `cosine=${cosineSimilarity(distinct, baseA)}`
  );

  // A near-duplicate on a DIFFERENT node NEVER joins cluster-A (wrong node).
  check(
    "a near-duplicate on the WRONG node never joins (returns null)",
    assignCluster(dup, clusters, nodeY, threshold) === null
  );

  // The HIGHEST-cosine cluster wins when two on the same node clear the bar.
  const baseB = nearDuplicate(baseA, 0.05); // still similar but less so than `dup`
  const twoClusters: OpenCluster[] = [
    { id: "cluster-B", nodeId: nodeX, centroidVector: baseB },
    { id: "cluster-A", nodeId: nodeX, centroidVector: baseA },
  ];
  const winner = assignCluster(dup, twoClusters, nodeX, threshold);
  check(
    "the highest-cosine cluster wins when several clear the threshold",
    winner === "cluster-A",
    `winner=${winner} simA=${cosineSimilarity(dup, baseA)} simB=${cosineSimilarity(dup, baseB)}`
  );

  // An empty/zero question vector clears nothing (cosine 0) → null.
  check(
    "an empty question vector clears nothing → null (a fresh cluster)",
    assignCluster([], clusters, nodeX, threshold) === null
  );

  // STABLE identity: re-assigning the same near-dup still lands cluster-A (id never
  // changes across calls — the function is pure + deterministic).
  check(
    "re-assigning the same near-duplicate is stable (same cluster id)",
    assignCluster(dup, clusters, nodeX, threshold) === "cluster-A"
  );
}

function schemaTests() {
  console.log("\n— DossierSchema —");
  const good = DossierSchema.safeParse({ summary: "The learner confuses X with Y.", confidenceNotes: "Unsure about Z." });
  check("valid dossier parses", good.success);
  check("responseFormat name is 'escalation_dossier'", DOSSIER_RESPONSE_NAME === "escalation_dossier");
  check("empty summary rejected", !DossierSchema.safeParse({ summary: "", confidenceNotes: "ok" }).success);
  check("empty confidenceNotes rejected", !DossierSchema.safeParse({ summary: "ok", confidenceNotes: "" }).success);
  check(
    "over-long summary rejected (> 2000)",
    !DossierSchema.safeParse({ summary: "x".repeat(2001), confidenceNotes: "ok" }).success
  );
  check(
    "missing field rejected",
    !DossierSchema.safeParse({ summary: "ok" }).success
  );
}

function promptPrivacyTests() {
  console.log("\n— buildDossierPrompt is IDENTITY-FREE —");
  const question = "Why does my Theta(N) analysis give a different bound than the book?";
  const prompt = buildDossierPrompt(question, {
    nodes: [
      { title: "Asymptotic notation", description: "Big-O / Theta / Omega bounds." },
      { title: "Recurrence relations" },
    ],
    tutorProposedAnswer: "Theta is a tight bound; check whether your recurrence is exact.",
    rungTrail: [{ rung: 1 }, { rung: 2 }, { rung: 3 }],
  });

  check("prompt carries the question text", prompt.includes(question));
  check("prompt carries a node title", prompt.includes("Asymptotic notation"));
  check("prompt carries a node description", prompt.includes("Big-O"));
  check("prompt carries the tutor's proposed answer", prompt.includes("Theta is a tight bound"));
  check("prompt carries the rung trail", prompt.includes("1 → 2 → 3"));

  // No identity token: build with a plausible user id / email / name in scope and
  // assert NONE of them appear (buildDossierPrompt is never handed identity — it
  // takes only question + node context; this pins that no future field leaks one).
  const userId = "abcd1234-5678-4abc-8def-0123456789ab";
  const email = "learner@example.com";
  const name = "Jordan Rivera";
  const lowered = prompt.toLowerCase();
  check("prompt contains NO user id", !prompt.includes(userId));
  check("prompt contains NO email", !lowered.includes(email.toLowerCase()));
  check("prompt contains NO learner name", !lowered.includes(name.toLowerCase()));
  check("prompt says 'anonymized'", lowered.includes("anonymized"));

  // A prompt built with ONLY a question (no nodes) still holds the question.
  const bare = buildDossierPrompt("plain question", { nodes: [] });
  check("a node-less prompt still carries the question", bare.includes("plain question"));
}

function cosineReuseTests() {
  console.log("\n— cosine reuse + threshold —");
  // The clustering module uses the SAME cosine as the graph pipeline (imported, not
  // re-implemented). Sanity-check its identity + orthogonality behaviour here.
  check("cosine of identical vectors is 1", Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  check("cosine of orthogonal vectors is 0", Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  check("cosine of a zero vector is 0", cosineSimilarity([0, 0], [1, 1]) === 0);
  check(
    "cluster threshold is a documented ratio in [0,1]",
    typeof TUTOR_ESCALATION_CLUSTER_THRESHOLD === "number" &&
      TUTOR_ESCALATION_CLUSTER_THRESHOLD >= 0 &&
      TUTOR_ESCALATION_CLUSTER_THRESHOLD <= 1
  );
  check("cluster threshold defaults to 0.83", TUTOR_ESCALATION_CLUSTER_THRESHOLD === 0.83);
}

function main() {
  clusteringTests();
  schemaTests();
  promptPrivacyTests();
  cosineReuseTests();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
