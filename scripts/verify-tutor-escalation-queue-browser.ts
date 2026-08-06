/**
 * TUTOR-1 Wave 6 (P6.3, W6Q.1) — the ESCALATION QUEUE BROWSER suite. Drives the
 * real /studio/[courseId]/tutor?tab=escalations creator queue through Playwright
 * chromium against a running server + live Supabase. NO OpenAI key needed: the
 * cluster + dossiers are seeded directly (service-role), so the queue is
 * deterministic; the Approve action is the REAL server action + apply_escalation_
 * reply RPC, verified against the DB.
 *
 *   PREREQUISITE: the server MUST run with TUTOR_ESCALATIONS_UI unset or =true
 *   (Wave 6 default is ON). This suite is tsconfig-excluded; the orchestrator runs
 *   it. Start a server (dev :3000 or a prod build :3100) THEN run it (set
 *   TUTOR_ESC_Q_BROWSER_BASE to override :3000).
 *
 * W6Q.1
 *   1. The Escalations tab appears in the console nav and the queue shows the
 *      seeded cluster: the concept, the representative question, and the COUNT
 *      ("N learners asked") — with NO learner name / email / roster anywhere on
 *      the page.
 *   2. The author writes a reply and clicks Approve & send → the card shows the
 *      "Delivered to N learners" state, and the DB carries N instructor tutor_turns
 *      (one per member) + the cluster is `replied` (verified service-role).
 *
 * Re-runnable: fresh throwaway users each run (the *@example.com convention).
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { chromium, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { seedTutorFixture } from "./seed-fixture-tutor";

dns.setDefaultResultOrder("ipv4first");

const BASE = process.env.TUTOR_ESC_Q_BROWSER_BASE ?? "http://localhost:3000";

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

async function provisionLearner(env: Env, tag: string) {
  const email = `tutor-esc-q-b-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
  return { client, userId: data.user.id, email };
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

async function main() {
  const env = loadEnv();
  const ping = await fetch(BASE).catch(() => null);
  if (!ping || !ping.ok) {
    throw new Error(`No server at ${BASE} — run \`npm run dev\` (TUTOR_ESCALATIONS_UI on) first.`);
  }

  const admin = createClient<Database>(env.url, env.service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  console.log("# seeding tutor fixture …");
  const fixture = await seedTutorFixture({ url: env.url, anon: env.anon });
  const courseId = fixture.courseId;

  // N learner members (distinct users). We only need their user_ids on the
  // dossiers — they never sign in.
  const N = 3;
  const learners: { userId: string; email: string }[] = [];
  for (let i = 0; i < N; i++) {
    const l = await provisionLearner(env, `m${i}`);
    learners.push({ userId: l.userId, email: l.email });
  }

  // Seed a concept node + one open cluster + N dossiers (service-role).
  const nodeA = crypto.randomUUID();
  const REP_Q = "Why does supply and demand reach equilibrium at all?";
  const { error: nErr } = await admin.from("concept_nodes").insert([
    { id: nodeA, course_id: courseId, title: "Market equilibrium", description: "Where supply meets demand.", anchors: [{ lessonId: fixture.doc.modules[0].lessons[0].id, blockId: "blk-1" }] },
  ] as never);
  if (nErr) throw new Error(`concept_nodes insert: ${nErr.message}`);

  const clusterId = crypto.randomUUID();
  const { error: clErr } = await admin.from("escalation_cluster").insert({
    id: clusterId,
    course_id: courseId,
    node_id: nodeA,
    representative_question: REP_Q,
    representative_answer: "Prices adjust until quantity supplied equals quantity demanded.",
    member_count: N,
    status: "open",
  } as never);
  if (clErr) throw new Error(`cluster insert: ${clErr.message}`);

  for (const l of learners) {
    const { data: cand, error: candErr } = await admin
      .from("tutor_escalation_candidates")
      .insert({
        user_id: l.userId,
        course_id: courseId,
        learner_question: REP_Q,
        node_ids: [nodeA] as never,
        anchors: [] as never,
        rung_trail: [{ rung: 2 }] as never,
        tutor_proposed_answer: "Prices adjust to clear the market.",
        status: "consented",
        consented_at: new Date().toISOString(),
      } as never)
      .select("id")
      .single();
    if (candErr || !cand) throw new Error(`candidate insert: ${candErr?.message}`);
    const { error: dErr } = await admin.from("escalation_dossier").insert({
      candidate_id: cand.id,
      course_id: courseId,
      user_id: l.userId,
      node_ids: [nodeA] as never,
      learner_question: REP_Q,
      rung_trail: [{ rung: 2 }] as never,
      tutor_proposed_answer: "Prices adjust to clear the market.",
      dossier: { summary: "Confusion about the equilibrating mechanism.", confidenceNotes: "n/a" } as never,
      cluster_id: clusterId,
    } as never);
    if (dErr) throw new Error(`dossier insert: ${dErr.message}`);
  }
  console.log(`# seeded 1 cluster + ${N} dossiers`);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const cleanup = async () => {
    await admin.from("escalation_reply_delivery").delete().eq("cluster_id", clusterId);
    await admin.from("escalation_dossier").delete().eq("course_id", courseId);
    await admin.from("escalation_cluster").delete().eq("course_id", courseId);
    await admin.from("tutor_turns").delete().eq("course_id", courseId);
    await fixture.author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, fixture.email, fixture.password);

    /* ── W6Q.1 (1) — the queue shows the COUNT, no identity ── */
    console.log("\n[W6Q.1] the queue shows the count, never a name");
    await page.goto(`${BASE}/studio/${courseId}/tutor?tab=escalations`);
    await page.locator('[data-ai-component="escalation-queue"]').first().waitFor({ timeout: 20000 });
    check("the Escalations tab + queue render (flag on)", (await page.locator('[data-ai-component="escalation-queue"]').count()) > 0);

    const pageText = await page.locator("body").innerText();
    check(`the queue shows the "${N} learners asked" count`, pageText.includes(`${N} learners asked`), pageText.slice(0, 200));
    check("the queue shows the concept node title", pageText.includes("Market equilibrium"));
    check("the queue shows the representative question", pageText.includes(REP_Q));

    // No learner identity anywhere on the page (the roster-privacy guarantee).
    const leaks = learners.filter((l) => pageText.includes(l.email) || pageText.includes(l.userId));
    check("NO learner email / user_id appears anywhere on the page", leaks.length === 0, `leaked=${leaks.map((l) => l.email).join(",")}`);

    /* ── W6Q.1 (2) — Approve delivers to every member ── */
    console.log("\n[W6Q.1] Approve & send delivers one instructor turn per member");
    const answerField = page.locator('[data-ai-tool="escalation-answer"]');
    await answerField.first().waitFor({ timeout: 10000 });
    const FINAL = "Great question — equilibrium is reached because any surplus pushes price down and any shortage pushes it up until they balance.";
    await answerField.first().fill(FINAL);
    await page.click('[data-ai-tool="escalation-approve"]');
    await page.getByText(/Delivered to \d+ learner/i).first().waitFor({ timeout: 20000 });
    check("the card shows the 'Delivered to N learners' state", true);

    // Verify service-role: N instructor turns + cluster replied.
    let turns: { user_id?: string; role?: string; content?: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await admin.from("tutor_turns").select("user_id, role, content").eq("course_id", courseId).eq("role", "instructor");
      turns = (r.data ?? []) as typeof turns;
      if (turns.length >= N) break;
      await new Promise((res) => setTimeout(res, 600));
    }
    check(`exactly ${N} instructor turns were delivered`, turns.length === N, `count=${turns.length}`);
    check("every delivered turn carries the author's reply", turns.every((t) => t.content === FINAL));
    check("each member received exactly one turn", learners.every((l) => turns.filter((t) => t.user_id === l.userId).length === 1));

    const clusterRow = await admin.from("escalation_cluster").select("status").eq("id", clusterId).single();
    check("the cluster flipped to 'replied'", clusterRow.data?.status === "replied");
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
