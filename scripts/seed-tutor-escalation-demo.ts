/**
 * TUTOR-1 Wave 6.6 — the ESCALATION QUEUE demo seed (Henry's review artifact).
 * ONE command that stands up a fully populated Tutor Console AND a scripted
 * escalation scenario, so a reviewer can open the Escalations tab and see exactly
 * ONE cluster of eleven near-duplicate learner escalations with a representative
 * question — the deterministic subject for the reply / promote / digest paths.
 * ZERO OpenAI spend (a deterministic mock supplies the dossier verdict + the
 * clustering embeddings).
 *
 * It:
 *   (a) seeds the console fixture (author auto-provisioned) via
 *       seedTutorConsoleFixture — a published Microeconomics course, ≥6 enrolled
 *       learners, an ACCEPTED + ACTIVE concept graph, the tutor ENABLED, the
 *       analytics rollups tuned so ONE lesson is deliberately degraded;
 *   (b) recomputes lesson health (so the Analytics tab is populated too);
 *   (c) seeds the ESCALATION SCENARIO (seedEscalationScenario) — ONE learner-
 *       requested + TEN near-duplicate consented escalations on the degraded node,
 *       synthesized + clustered through the mock model into ONE cluster of 11;
 *   (d) prints a clean ready-to-click block: the author login, the
 *       /studio/{courseId}/tutor?tab=escalations URL, and WHICH cluster to expect
 *       (its representative question + member count).
 *
 * Idempotent-enough: each run provisions FRESH throwaway users (*@example.com — can't
 * be deleted with the anon key; clean them in Supabase → Auth). Exit 0 on success.
 *
 * Run: `npm run seed:tutor-escalation-demo`  (needs the anon key + SUPABASE_SERVICE_ROLE_KEY
 * in .env.local — the fixture rollup seeds, recompute, and escalation synthesis are
 * admin/service; NO OpenAI key needed).
 */

import dns from "node:dns";
import {
  seedTutorConsoleFixture,
  loadTutorConsoleFixtureEnv,
} from "./seed-fixture-tutor-console";
import { seedEscalationScenario } from "./seed-fixture-escalation";

dns.setDefaultResultOrder("ipv4first");

/** Raw RPC call (surfaces the error object). */
async function callRpcRaw(
  client: unknown,
  fn: string,
  args: Record<string, unknown>
): Promise<{ data: unknown; error: { message: string } | null }> {
  return (
    client as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
    }
  ).rpc(fn, args);
}

async function main() {
  const env = loadTutorConsoleFixtureEnv();

  console.log("# seeding the tutor console fixture (author auto-provisioned)…");
  const fixture = await seedTutorConsoleFixture(env);
  const { admin, courseId, slug, publicationId, version, degradedLessonId } = fixture;

  const { data: authUser } = await fixture.author.client.auth.getUser();
  const authorEmail = authUser.user?.email ?? "(unknown — check Supabase → Auth)";
  const authorPassword = "Test-passw0rd!"; // the fixed throwaway password the seeders use.

  // (b) Recompute lesson health so the Analytics tab is populated too.
  const recompute = await callRpcRaw(admin, "recompute_lesson_health_admin", { cid: courseId });
  if (recompute.error) throw new Error(`recompute_lesson_health_admin: ${recompute.error.message}`);
  console.log("# recomputed lesson health — the degraded lesson ranks #1");

  // (c) Seed the ESCALATION SCENARIO — 11 near-duplicates → ONE cluster (mock model).
  console.log("# seeding the escalation scenario (11 near-duplicate escalations, mock model)…");
  const scenario = await seedEscalationScenario(fixture);
  console.log(`# synthesized + clustered ${scenario.candidateIds.length} escalations into ONE cluster`);

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  TUTOR-1 ESCALATION QUEUE — DEMO SEED (ready to click)");
  console.log("════════════════════════════════════════════════════════════════");
  console.log(`  Author email      : ${authorEmail}`);
  console.log(`  Author password   : ${authorPassword}`);
  console.log("");
  console.log(`  Sign in           : /login`);
  console.log(`  Escalations queue  : /studio/${courseId}/tutor?tab=escalations`);
  console.log("");
  console.log("  EXPECT ONE cluster in the queue:");
  console.log(`    Concept node     : ${scenario.nodeTitle}`);
  console.log(`    Learners asked   : ${scenario.memberCount}  ("${scenario.memberCount} learners asked")`);
  console.log(`    Representative Q  : "${scenario.representativeQuestion}"`);
  console.log("");
  console.log("  Paths to review from this ONE cluster:");
  console.log("    Reply    → write an answer, Approve & send → one instructor turn");
  console.log(`               per member (${scenario.memberCount} learners), cluster → 'replied'`);
  console.log("    Promote  → 'Resolve in content' opens a promotion draft for the node");
  console.log("    Digest   → the creator digest summarizes this cluster for the author");
  console.log("");
  console.log(`  Degraded lesson   : ${degradedLessonId}`);
  console.log("════════════════════════════════════════════════════════════════");
  console.log("\n# throwaway users + course remain (clean in Supabase → Auth)");

  console.log(
    JSON.stringify(
      {
        authorEmail,
        authorPassword,
        courseId,
        slug,
        publicationId,
        version,
        escalationsUrl: `/studio/${courseId}/tutor?tab=escalations`,
        degradedLessonId,
        cluster: {
          id: scenario.clusterId,
          nodeId: scenario.nodeId,
          nodeTitle: scenario.nodeTitle,
          memberCount: scenario.memberCount,
          representativeQuestion: scenario.representativeQuestion,
        },
      },
      null,
      2
    )
  );
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
