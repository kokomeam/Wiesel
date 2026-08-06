/**
 * TUTOR-1 Wave 6 (P6.1, W6C.1) — the CONSENT-CARD BROWSER suite. Drives the real
 * /learn tutor consent card through Playwright chromium against a running server
 * + live Supabase. NO OpenAI key needed here: the turn SSE is MOCKED (route
 * interception) so the escalationProposal + escalationCandidateId are
 * deterministic; the consent POST is the REAL /api/learn/tutor {escalate_consent}
 * write, verified against the DB.
 *
 *   PREREQUISITE: the server MUST run with `TUTOR_ESCALATIONS_UI=true` (Wave 6
 *   default is ON, so an unset env also satisfies it). This suite is
 *   tsconfig-excluded; the orchestrator runs it. Start a server (dev :3000 or a
 *   prod build :3100) THEN run it (set TUTOR_ESC_BROWSER_BASE to override :3000).
 *
 * W6C.1
 *   1. A mocked turn carrying an escalationProposal + a REAL consent_pending
 *      candidate id renders the consent card with the EXACT payload — the
 *      question (in an editable textarea, seeded), the concept(s), the proposed
 *      answer — plus Send/Cancel.
 *   2. The learner EDITS the question and clicks Send → the card shows the
 *      "sent — your instructor will see this in their queue" state, and the
 *      candidate row is now `consented` carrying the LEARNER'S EDITED question
 *      (verified service-role) + consented_at set.
 *   3. Cancel on a SECOND proposal → the candidate flips `withdrawn` (nothing
 *      shared) and the card dismisses.
 *
 * Re-runnable: fresh throwaway users each run (the *@example.com convention).
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { chromium, type Page, type Route } from "playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { seedTutorFixture } from "./seed-fixture-tutor";

dns.setDefaultResultOrder("ipv4first");

const BASE = process.env.TUTOR_ESC_BROWSER_BASE ?? "http://localhost:3000";

type DB = SupabaseClient<Database>;

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

interface Env {
  url: string;
  anon: string;
  service: string;
}
function loadEnv(): Env {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const service = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY;
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY || !service) {
    throw new Error("Missing Supabase env (URL/ANON/SERVICE) in .env.local");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, service };
}

async function provisionUser(env: Env, tag: string) {
  const email = `tutor-esc-b-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${env.url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: env.anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup ${tag} failed: ${await signup.text()}`);
  const client = createClient<Database>(env.url, env.anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin ${tag} failed: ${error?.message}`);
  console.log(`# provisioned ${email}`);
  return { client, userId: data.user.id, email, password };
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.click('button[type="submit"]').catch(() => {});
    const landed = await page
      .waitForURL((u) => new URL(u).pathname !== "/login", { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (landed) return;
  }
  throw new Error(`sign-in did not leave /login for ${email}`);
}

async function openTutor(page: Page) {
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-ai-tool="tutor-composer"]') !== null ||
        document.querySelector('[data-ai-tool="tutor-open"]') !== null,
      undefined,
      { timeout: 25000 }
    )
    .catch(() => {});
  if ((await page.locator('[data-ai-tool="tutor-composer"]').count()) > 0) {
    await page.locator('[data-ai-tool="tutor-composer"]').first().waitFor({ timeout: 5000 });
    return;
  }
  const tab = page.locator('[data-ai-tool="tutor-open"]');
  await tab.first().waitFor({ timeout: 20000 });
  for (let i = 0; i < 6; i++) {
    await tab.first().click().catch(() => {});
    if ((await page.locator('[data-ai-tool="tutor-composer"]').count()) > 0) break;
    await page.waitForTimeout(500);
  }
  await page.locator('[data-ai-tool="tutor-composer"]').first().waitFor({ timeout: 15000 });
}

/** A mocked `turn` SSE frame carrying an escalation proposal + candidate id. */
function escalationSseBody(payload: Record<string, unknown>): string {
  return (
    `data: ${JSON.stringify({ type: "turn", payload })}\n\n` +
    `data: ${JSON.stringify({ type: "done" })}\n\n`
  );
}

/** Seed a consent_pending candidate for the learner (service-role). */
async function seedCandidate(admin: DB, learnerUserId: string, courseId: string, question: string): Promise<string> {
  const { data, error } = await admin
    .from("tutor_escalation_candidates")
    .insert({
      user_id: learnerUserId,
      course_id: courseId,
      learner_question: question,
      node_ids: ["node-x"] as never,
      anchors: [] as never,
      rung_trail: [{ rung: 2 }] as never,
      tutor_proposed_answer: "The tutor's proposed answer, for the instructor to confirm.",
      status: "consent_pending",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`candidate insert: ${error?.message}`);
  return data.id;
}

async function main() {
  const env = loadEnv();
  const ping = await fetch(BASE).catch(() => null);
  if (!ping || !ping.ok) {
    throw new Error(`No server at ${BASE} — run \`npm run dev\` (with TUTOR_ESCALATIONS_UI=true) first.`);
  }

  const admin = createClient<Database>(env.url, env.service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  console.log("# seeding tutor fixture …");
  const fixture = await seedTutorFixture({ url: env.url, anon: env.anon });
  const slug = fixture.slug;
  const courseTitle = fixture.doc.title;
  const lessonA = fixture.doc.modules[0].lessons[0];
  const learner = await provisionUser(env, "learner");

  // Enable the tutor + enroll the learner.
  const settings = await fixture.author.client
    .from("tutor_course_settings")
    .upsert({ course_id: fixture.courseId, enabled: true } as never, { onConflict: "course_id" });
  if (settings.error) throw new Error(`enable tutor: ${settings.error.message}`);
  const enrolled = await learner.client
    .from("enrollments")
    .insert({ course_id: fixture.courseId, user_id: learner.userId } as never);
  if (enrolled.error) throw new Error(`enroll: ${enrolled.error.message}`);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const cleanup = async () => {
    await fixture.author.client.from("courses").delete().eq("id", fixture.courseId);
  };

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, learner.email, learner.password);
    void courseTitle;

    /* ── seed the REAL candidate the mocked turn will point the card at ── */
    const ORIGINAL_Q = "Why does supply and demand reach equilibrium at all?";
    const candidateId = await seedCandidate(admin, learner.userId, fixture.courseId, ORIGINAL_Q);
    const PROPOSED = "Prices adjust until the quantity supplied equals the quantity demanded.";

    /* ─────────────── W6C.1 (1) — the card renders the EXACT payload ─────────── */
    console.log("\n[W6C.1] consent card renders the exact editable payload");
    await page.route("**/api/learn/tutor", async (route: Route) => {
      const req = route.request();
      // Only intercept the interactive TURN POST — let the escalate_consent POST
      // (a different action) hit the real route so the DB write is genuine.
      if (req.method() !== "POST") return route.continue().catch(() => {});
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
      } catch {
        /* noop */
      }
      if (body.action !== "turn") return route.continue().catch(() => {});
      await route
        .fulfill({
          status: 200,
          contentType: "text/event-stream; charset=utf-8",
          body: escalationSseBody({
            prose: "That's a good one for your instructor — here's my take meanwhile.",
            spans: null,
            citations: [],
            rung: null,
            practiceItems: [],
            escalationProposal: {
              learnerQuestion: ORIGINAL_Q,
              nodeIds: ["node-x"],
              proposedAnswer: PROPOSED,
            },
            escalationCandidateId: candidateId,
            flags: [],
          }),
        })
        .catch(() => {});
    });

    await page.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
    await page.getByLabel("Next slide").last().waitFor({ timeout: 30000 }).catch(() => {});
    await openTutor(page);
    await page.fill('[data-ai-tool="tutor-composer"]', "should I ask my instructor?");
    await page.click('[data-ai-tool="tutor-send"]');

    const card = page.locator('[data-ai-tool="tutor-escalation"]');
    await card.first().waitFor({ timeout: 15000 });
    check("consent card renders (flag on)", (await card.count()) > 0);

    const questionField = page.locator('[data-ai-tool="tutor-escalation-question"]');
    check("the question textarea is present + editable", (await questionField.count()) > 0);
    check("the question textarea is seeded with the exact learner question", (await questionField.first().inputValue()) === ORIGINAL_Q);
    const cardText = await card.first().innerText();
    check("the card shows the proposed answer (shared too)", cardText.includes(PROPOSED));
    check("Send + Cancel affordances present", (await page.locator('[data-ai-tool="tutor-escalation-send"]').count()) > 0 && (await page.locator('[data-ai-tool="tutor-escalation-cancel"]').count()) > 0);

    /* ─────── W6C.1 (2) — edit + Send → the consented row carries the edit ───── */
    console.log("\n[W6C.1] the learner's edit is what the consented row carries");
    const EDITED_Q = "Edited: what force actually pushes price toward equilibrium?";
    await questionField.first().fill(EDITED_Q);
    await page.click('[data-ai-tool="tutor-escalation-send"]');
    // The card flips to the sent state.
    await page.getByText(/your instructor will see this in their queue/i).first().waitFor({ timeout: 15000 });
    check("the card shows the 'sent — instructor will see this in their queue' state", true);

    // Verify service-role: the candidate is consented + carries the EDITED question.
    let row: { status?: string; learner_question?: string; consented_at?: string | null } | null = null;
    for (let i = 0; i < 12; i++) {
      const r = await admin
        .from("tutor_escalation_candidates")
        .select("status, learner_question, consented_at")
        .eq("id", candidateId)
        .maybeSingle();
      row = r.data as typeof row;
      if (row?.status === "consented") break;
      await new Promise((res) => setTimeout(res, 600));
    }
    check("the candidate row is now `consented`", row?.status === "consented", JSON.stringify(row));
    check("the consented row carries the LEARNER'S EDITED question (not the original)", row?.learner_question === EDITED_Q, JSON.stringify(row?.learner_question));
    check("consented_at is set", row?.consented_at != null);

    /* ─────────────────── W6C.1 (3) — Cancel → withdrawn + dismiss ──────────── */
    console.log("\n[W6C.1] Cancel withdraws (nothing shared) and dismisses the card");
    const candidate2 = await seedCandidate(admin, learner.userId, fixture.courseId, "A second question to cancel.");
    // Re-point the mocked turn at the second candidate.
    await page.unroute("**/api/learn/tutor");
    await page.route("**/api/learn/tutor", async (route: Route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.continue().catch(() => {});
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
      } catch {
        /* noop */
      }
      if (body.action !== "turn") return route.continue().catch(() => {});
      await route
        .fulfill({
          status: 200,
          contentType: "text/event-stream; charset=utf-8",
          body: escalationSseBody({
            prose: "Another good one for the instructor.",
            spans: null,
            citations: [],
            rung: null,
            practiceItems: [],
            escalationProposal: { learnerQuestion: "A second question to cancel.", nodeIds: [], proposedAnswer: "" },
            escalationCandidateId: candidate2,
            flags: [],
          }),
        })
        .catch(() => {});
    });
    await page.fill('[data-ai-tool="tutor-composer"]', "another instructor question?");
    await page.click('[data-ai-tool="tutor-send"]');
    await page.getByText(/Another good one for the instructor/i).first().waitFor({ timeout: 15000 });
    // The NEW card's Cancel button (last card in the transcript).
    await page.locator('[data-ai-tool="tutor-escalation-cancel"]').last().click();
    await page.waitForTimeout(1200);

    let row2: { status?: string } | null = null;
    for (let i = 0; i < 12; i++) {
      const r = await admin
        .from("tutor_escalation_candidates")
        .select("status")
        .eq("id", candidate2)
        .maybeSingle();
      row2 = r.data as typeof row2;
      if (row2?.status === "withdrawn") break;
      await new Promise((res) => setTimeout(res, 600));
    }
    check("Cancel flips the second candidate to `withdrawn` (nothing shared)", row2?.status === "withdrawn", JSON.stringify(row2));

    await page.unroute("**/api/learn/tutor");
  } finally {
    await browser.close();
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
