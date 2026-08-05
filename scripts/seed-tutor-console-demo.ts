/**
 * TUTOR-1 Wave 5.4 — the CREATOR TUTOR CONSOLE demo seed (Henry's review artifact).
 * ONE command that stands up a fully populated Tutor Console so a reviewer can click
 * through all four tabs and see real substance everywhere — no build steps, no
 * fixtures to assemble by hand, ZERO model spend.
 *
 * It:
 *   (a) seeds the console fixture (author auto-provisioned) via
 *       seedTutorConsoleFixture — a published Microeconomics course, ≥6 enrolled
 *       learners, an ACCEPTED + ACTIVE concept graph, the tutor ENABLED, per-question
 *       quiz_attempt_detail (most-missed), cohort-floored mastery aggregate, and the
 *       analytics rollups tuned so ONE lesson is deliberately degraded;
 *   (b) runs recompute_lesson_health_admin (service role) so the Analytics tab's
 *       composite + ranking exist BEFORE the reviewer opens it (AC-T5.5);
 *   (c) seeds a small tutor-usage cohort (≥5 threads/turns, admin) so the Overview
 *       usage card shows real cohort-floored numbers instead of the suppressed state;
 *   (d) prints a clean ready-to-click block: the author login (email/password), the
 *       /studio/{courseId}/tutor URL, and a one-line tour of all four tabs.
 *
 * Idempotent-enough: each run provisions FRESH throwaway users (*@example.com — can't
 * be deleted with the anon key; clean them in Supabase → Auth).
 *
 * Run: `npm run seed:tutor-console-demo`  (needs the anon key + SUPABASE_SERVICE_ROLE_KEY
 * in .env.local — the rollup seeds, recompute, and usage seed are admin/service).
 */

import dns from "node:dns";
import {
  seedTutorConsoleFixture,
  loadTutorConsoleFixtureEnv,
} from "./seed-fixture-tutor-console";

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

  // The author's email/password: seedMasteryCohort provisions the author via
  // seedTutorFixture, which uses the fixed test password. We reconstruct login by
  // reading the author's email from the auth admin API (the fixture doesn't surface
  // it) — but simpler: the author client is signed in, so its user carries the email.
  const { data: authUser } = await fixture.author.client.auth.getUser();
  const authorEmail = authUser.user?.email ?? "(unknown — check Supabase → Auth)";
  const authorPassword = "Test-passw0rd!"; // the fixed throwaway password the seeders use.

  // (b) Recompute lesson health so the Analytics tab is populated (AC-T5.5).
  const recompute = await callRpcRaw(admin, "recompute_lesson_health_admin", { cid: courseId });
  if (recompute.error) throw new Error(`recompute_lesson_health_admin: ${recompute.error.message}`);
  console.log("# recomputed lesson health — the degraded lesson now ranks #1");

  // (c) Seed a tutor-usage cohort (≥5 learners) so the Overview usage card shows
  //     real cohort-floored numbers. Six synthetic learners, one thread + turn each.
  let usageSeeded = 0;
  for (let i = 0; i < 6; i++) {
    const uid = crypto.randomUUID();
    const thread = await admin
      .from("tutor_threads")
      .insert({ user_id: uid, course_id: courseId } as never)
      .select("id")
      .single();
    if (thread.error || !thread.data) continue;
    const turn = await admin.from("tutor_turns").insert({
      thread_id: (thread.data as { id: string }).id,
      user_id: uid,
      course_id: courseId,
      role: "learner",
      content: `Demo usage turn ${i}`,
      publication_id: publicationId,
      version,
    } as never);
    if (!turn.error) usageSeeded++;
  }
  console.log(`# seeded ${usageSeeded} tutor-usage learner(s) for the Overview card`);

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("  TUTOR-1 CREATOR TUTOR CONSOLE — DEMO SEED (ready to click)");
  console.log("────────────────────────────────────────────────────────────");
  console.log(`  Author email      : ${authorEmail}`);
  console.log(`  Author password   : ${authorPassword}`);
  console.log("");
  console.log(`  Sign in           : /login`);
  console.log(`  Console URL       : /studio/${courseId}/tutor`);
  console.log("");
  console.log("  Tour (four tabs):");
  console.log("    Overview      → cohort-floored usage (≥5 learners) + tutor spend");
  console.log("    Charter       → change the guidance style; every save is versioned");
  console.log("    Concept graph → an accepted, editable graph (rename nodes,");
  console.log("                    mastery/confusion overlays, drawer detail)");
  console.log(`    Analytics     → the degraded lesson ranks #1 in "Lessons needing`);
  console.log(`                    attention", plus the most-missed questions table`);
  console.log("");
  console.log(`  Degraded lesson   : ${degradedLessonId}`);
  console.log("────────────────────────────────────────────────────────────");
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
        consoleUrl: `/studio/${courseId}/tutor`,
        degradedLessonId,
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
