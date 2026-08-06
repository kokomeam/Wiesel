/**
 * TUTOR-1 Wave 6 (P6.3) — escalation QUEUE + REPLY DELIVERY INTEGRATION suite
 * (live Supabase, NO OpenAI key, no model — this is a pure DB/RPC test). Self-
 * provisions throwaway users each run. Requires the W6.3 migration
 * (20260806120000_escalation_reply.sql) APPLIED (the orchestrator applies it) AND
 * SUPABASE_SERVICE_ROLE_KEY (escalation_dossier + escalation_reply_delivery are
 * service-role-only by design; apply_escalation_reply is granted to service_role).
 *
 * ── AC-T6.2 — exactly-once reply delivery ─────────────────────────────────────
 *   Seed a cluster with N distinct dossier members → apply_escalation_reply delivers
 *   EXACTLY N instructor tutor_turns (one per member, in that member's own thread,
 *   role='instructor', content=the final answer). A SECOND call (retry / partial
 *   failure / double Approve) delivers ZERO more (idempotent per (cluster_id,
 *   user_id) via escalation_reply_delivery). One learner owning TWO dossiers in the
 *   cluster still gets ONE reply. The cluster flips to `replied`.
 *
 * ── AC-W6Q.1 — count without identity ─────────────────────────────────────────
 *   tutor_escalation_queue returns the cluster WITH member_count and NO user_id /
 *   identity by any field. A non-author gets null (→ [] from the loader). The
 *   escalation_reply_delivery ledger is creator-UNREADABLE (zero policies).
 *
 * Run (AFTER the migration): `npx tsx scripts/verify-tutor-escalation-queue-int.ts`
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

dns.setDefaultResultOrder("ipv4first");

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
  const email = `tutor-esc-q-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

/** The apply_escalation_reply RPC (service-role). */
async function applyReply(
  admin: DB,
  clusterId: string,
  finalAnswer: string
): Promise<{ delivered: number; alreadyDelivered: number; skipped: number }> {
  const { data, error } = await (
    admin as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
    }
  ).rpc("apply_escalation_reply", { p_cluster_id: clusterId, p_final_answer: finalAnswer });
  if (error) throw new Error(`apply_escalation_reply: ${error.message}`);
  return data as { delivered: number; alreadyDelivered: number; skipped: number };
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:tutor-escalation-queue:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  // N distinct learners = the cluster's N members.
  const N = 4;
  const learners: { client: DB; userId: string; email: string }[] = [];
  for (let i = 0; i < N; i++) learners.push(await provisionUser(url, anon, `learner${i}`));
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  // Seed a course + one concept node + a LIVE publication (the reply's fallback
  // publication_id/version when a member has no prior turn — which is our case).
  const courseId = crypto.randomUUID();
  const { error: cErr } = await author.client.from("courses").insert({
    id: courseId,
    author_id: author.userId,
    title: `Escalation queue itest ${crypto.randomUUID().slice(0, 6)}`,
    description: "P6.3 fixture",
  } as never);
  if (cErr) throw new Error(`course insert: ${cErr.message}`);

  const nodeA = crypto.randomUUID();
  const { error: nErr } = await author.client.from("concept_nodes").insert([
    { id: nodeA, course_id: courseId, title: "Asymptotic notation", description: "Big-O / Theta / Omega.", anchors: [{ lessonId: "les-1", blockId: "blk-1", slideId: "sld-1" }] },
  ] as never);
  if (nErr) throw new Error(`concept_nodes insert: ${nErr.message}`);

  // A live publication so the reply RPC can resolve publication_id/version.
  const pubId = crypto.randomUUID();
  const { error: pErr } = await admin.from("course_publications").insert({
    id: pubId,
    course_id: courseId,
    version: 1,
    slug: `esc-q-${crypto.randomUUID().slice(0, 8)}`,
    snapshot: {} as never,
    content_hash: crypto.randomUUID(),
    status: "live",
    visibility: "public",
    created_by: author.userId,
  } as never);
  if (pErr) throw new Error(`publication insert: ${pErr.message}`);

  // Enroll every learner (the escalating learner is always enrolled in reality —
  // the tutor_turns SELECT policy is user_id = auth.uid() AND is_enrolled, so the
  // "learner reads their own delivered turn" belt needs the enrollment).
  for (const l of learners) {
    const { error: eErr } = await l.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: l.userId } as never);
    if (eErr) throw new Error(`enroll: ${eErr.message}`);
  }
  console.log("# seeded course + node + live publication + enrollments");

  // Seed ONE open cluster on nodeA, then N dossier members (+ 1 extra dossier for
  // learner 0 → a learner with two questions still gets ONE reply).
  const clusterId = crypto.randomUUID();
  const { error: clErr } = await admin.from("escalation_cluster").insert({
    id: clusterId,
    course_id: courseId,
    node_id: nodeA,
    representative_question: "Why does my Theta bound differ from the book?",
    representative_answer: "The tutor's proposed answer, pending the instructor.",
    member_count: N,
    status: "open",
  } as never);
  if (clErr) throw new Error(`cluster insert: ${clErr.message}`);

  // Each dossier needs a candidate (candidate_id is the PK / FK). Seed a consented
  // candidate + a dossier per learner; learner 0 gets a SECOND dossier.
  async function seedDossier(learnerUserId: string): Promise<void> {
    const { data: cand, error: candErr } = await admin
      .from("tutor_escalation_candidates")
      .insert({
        user_id: learnerUserId,
        course_id: courseId,
        learner_question: "Why does my Theta bound differ from the book?",
        node_ids: [nodeA] as never,
        anchors: [] as never,
        rung_trail: [{ rung: 2 }] as never,
        tutor_proposed_answer: "The tutor's best guess.",
        status: "consented",
        consented_at: new Date().toISOString(),
      } as never)
      .select("id")
      .single();
    if (candErr || !cand) throw new Error(`candidate insert: ${candErr?.message}`);
    const { error: dErr } = await admin.from("escalation_dossier").insert({
      candidate_id: cand.id,
      course_id: courseId,
      user_id: learnerUserId,
      node_ids: [nodeA] as never,
      learner_question: "Why does my Theta bound differ from the book?",
      rung_trail: [{ rung: 2 }] as never,
      tutor_proposed_answer: "The tutor's best guess.",
      dossier: { summary: "Learner confuses tight vs loose bounds.", confidenceNotes: "n/a" } as never,
      cluster_id: clusterId,
    } as never);
    if (dErr) throw new Error(`dossier insert: ${dErr.message}`);
  }

  for (const l of learners) await seedDossier(l.userId);
  await seedDossier(learners[0].userId); // learner 0's SECOND question
  console.log(`# seeded 1 cluster + ${N + 1} dossiers across ${N} learners`);

  const FINAL_ANSWER = "Theta is a TIGHT bound: it needs matching upper AND lower bounds. Re-check your recurrence's exact solution.";

  const cleanup = async () => {
    await admin.from("escalation_reply_delivery").delete().eq("cluster_id", clusterId);
    await admin.from("escalation_dossier").delete().eq("course_id", courseId);
    await admin.from("escalation_cluster").delete().eq("course_id", courseId);
    await admin.from("tutor_turns").delete().eq("course_id", courseId);
    await admin.from("course_publications").delete().eq("id", pubId);
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ───── AC-T6.2 — one reply delivers exactly N instructor turns ─────────── */
    console.log("\n# AC-T6.2 — apply_escalation_reply delivers exactly N instructor turns");
    const r1 = await applyReply(admin, clusterId, FINAL_ANSWER);
    check(`the reply reports delivered=${N}`, r1.delivered === N, JSON.stringify(r1));
    check("the reply reports 0 skipped (a live publication resolves for every member)", r1.skipped === 0, JSON.stringify(r1));

    const turns1 = await admin
      .from("tutor_turns")
      .select("id, user_id, role, content")
      .eq("course_id", courseId)
      .eq("role", "instructor");
    check(`exactly ${N} instructor turns were written`, (turns1.data ?? []).length === N, `count=${(turns1.data ?? []).length}`);
    check("every delivered turn is role='instructor'", (turns1.data ?? []).every((t) => t.role === "instructor"));
    check("every delivered turn carries the final answer verbatim", (turns1.data ?? []).every((t) => t.content === FINAL_ANSWER));
    check(
      "every member (learner) received EXACTLY ONE turn (a 2-dossier learner still gets one)",
      learners.every((l) => (turns1.data ?? []).filter((t) => t.user_id === l.userId).length === 1)
    );
    const ledger1 = await admin.from("escalation_reply_delivery").select("user_id").eq("cluster_id", clusterId);
    check(`the delivery ledger has exactly ${N} rows (one per member)`, (ledger1.data ?? []).length === N, `count=${(ledger1.data ?? []).length}`);

    // Each turn landed in the RIGHT member's own thread.
    const threads = await admin.from("tutor_threads").select("id, user_id").eq("course_id", courseId);
    const threadByUser = new Map((threads.data ?? []).map((t) => [t.user_id, t.id]));
    const turnsWithThread = await admin
      .from("tutor_turns")
      .select("user_id, thread_id, role")
      .eq("course_id", courseId)
      .eq("role", "instructor");
    check(
      "every instructor turn is in its OWN member's thread",
      (turnsWithThread.data ?? []).every((t) => threadByUser.get(t.user_id) === t.thread_id)
    );

    const clusterAfter = await admin.from("escalation_cluster").select("status, representative_answer").eq("id", clusterId).single();
    check("the cluster flipped to 'replied'", clusterAfter.data?.status === "replied");
    check("the cluster's representative_answer is now the final answer", clusterAfter.data?.representative_answer === FINAL_ANSWER);

    /* ───── AC-T6.2 — a SECOND call delivers ZERO more (idempotent) ─────────── */
    console.log("\n# AC-T6.2 — a retry / double-Approve delivers ZERO additional turns");
    const r2 = await applyReply(admin, clusterId, FINAL_ANSWER);
    check("the second call reports delivered=0", r2.delivered === 0, JSON.stringify(r2));
    check(`the second call reports alreadyDelivered=${N}`, r2.alreadyDelivered === N, JSON.stringify(r2));
    const turns2 = await admin
      .from("tutor_turns")
      .select("id")
      .eq("course_id", courseId)
      .eq("role", "instructor");
    check(`still exactly ${N} instructor turns after the retry (exactly-once)`, (turns2.data ?? []).length === N, `count=${(turns2.data ?? []).length}`);
    const ledger2 = await admin.from("escalation_reply_delivery").select("user_id").eq("cluster_id", clusterId);
    check(`the delivery ledger still has exactly ${N} rows`, (ledger2.data ?? []).length === N);

    /* ───── AC-W6Q.1 — the queue returns the count with NO identity ─────────── */
    console.log("\n# AC-W6Q.1 — the author queue returns the cluster count, NEVER an identity");
    // The replied cluster stays in the queue (open+replied both surface).
    const queue = await loadEscalationQueue(author.client, courseId);
    check("the queue returns the (replied) cluster", queue.length === 1, `len=${queue.length}`);
    const row = queue[0];
    check(`the queue row carries member_count=${N}`, row?.memberCount === N, `mc=${row?.memberCount}`);
    check("the queue row carries the node title", row?.nodeTitle === "Asymptotic notation");
    check("the queue row status is 'replied'", row?.status === "replied");
    check(
      "the queue row leaks NO user_id / roster by any field",
      row != null &&
        !("user_id" in (row as Record<string, unknown>)) &&
        !("userId" in (row as Record<string, unknown>)) &&
        !("members" in (row as Record<string, unknown>)) &&
        !("roster" in (row as Record<string, unknown>)) &&
        !("email" in (row as Record<string, unknown>))
    );

    // A non-author gets NULL → [] (RLS + the RPC author gate).
    const strangerQueue = await loadEscalationQueue(learners[0].client, courseId);
    check("a non-author gets an EMPTY queue (RPC null → [])", strangerQueue.length === 0);

    /* ───── the delivery ledger is creator-UNREADABLE (zero policies) ───────── */
    console.log("\n# escalation_reply_delivery is creator-UNREADABLE (roster privacy)");
    const authorLedger = await author.client.from("escalation_reply_delivery").select("user_id").eq("cluster_id", clusterId);
    check("the AUTHOR reads ZERO delivery-ledger rows (zero policies)", (authorLedger.data ?? []).length === 0, `rows=${(authorLedger.data ?? []).length}`);
    const learnerLedger = await learners[0].client.from("escalation_reply_delivery").select("user_id").eq("cluster_id", clusterId);
    check("a LEARNER also reads ZERO delivery-ledger rows", (learnerLedger.data ?? []).length === 0);

    // Belt: the learner CAN see their own instructor turn (delivered into their thread).
    const learnerTurns = await learners[0].client
      .from("tutor_turns")
      .select("role, content")
      .eq("course_id", courseId)
      .eq("user_id", learners[0].userId)
      .eq("role", "instructor");
    check("the learner CAN read their own delivered instructor turn", (learnerTurns.data ?? []).length === 1 && learnerTurns.data?.[0]?.content === FINAL_ANSWER);
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
