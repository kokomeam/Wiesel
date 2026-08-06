/**
 * TUTOR-1 Wave 6 (P6.4) — escalation CONTENT-PATCH PROMOTION INTEGRATION suite
 * (live Supabase + the mock ModelClient, NO OpenAI key). Self-provisions throwaway
 * users each run. Requires the W6.2/W6.3/P6.4 migrations APPLIED (the orchestrator
 * applies them) AND SUPABASE_SERVICE_ROLE_KEY (escalation_dossier is service-role-only;
 * apply_escalation_reply is granted to service_role).
 *
 * ── AC-T6.3 — promotion rides the STANDARD change-set rail ────────────────────
 *   promoteClusterToPatch stages a change-set with a PENDING change_set_items row
 *   (node_type='block', op='create') carrying the dossier-summary EVIDENCE, and the
 *   cluster records its change_set_id. acceptChangeSet attaches the FAQ block to the
 *   lesson (the draft doc now has it) → the queue's `resolved` flag flips (DERIVED)
 *   and the node bundle's `clarifications` lists the cluster. rejectChangeSet on a
 *   FRESH promotion restores the draft doc BYTE-IDENTICAL (loadCourseDoc before ==
 *   after).
 *
 * ── AC-W6P.1 — the FULL LOOP ──────────────────────────────────────────────────
 *   A consented candidate → synthesizeAndCluster (dossier + cluster) → reply delivery
 *   (apply_escalation_reply — one instructor turn) → promoteClusterToPatch → accept →
 *   the change-set is accepted AND the FAQ block is present in the DRAFT doc (which
 *   the next publish snapshots). Each hop asserted.
 *
 * Run (AFTER the migrations): `npx tsx scripts/verify-tutor-escalation-promotion-int.ts`
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
import type { CourseDocument, LessonBlock } from "@/lib/course/types";
import type { EmbedParams, EmbedResult, ModelClient } from "@/lib/ai/modelClient";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { withPooledModel, poolFor } from "@/lib/ai/subagent";
import { createModule, createLesson } from "@/lib/course/factories";
import { defaultCourseTheme } from "@/lib/course/persistence";
import { buildLectureBlock } from "@/lib/ai/tools/blockBuilders";
import { loadCourseDoc, reconcileCourseDoc } from "@/lib/ai/serverPersistence";
import { acceptChangeSet, rejectChangeSet } from "@/lib/ai/changeSet";
import { synthesizeAndCluster } from "@/lib/tutor/escalation/synthesis";
import { DOSSIER_RESPONSE_NAME } from "@/lib/tutor/escalation/dossier";
import { promoteClusterToPatch } from "@/lib/tutor/escalation/promotion";
import { PROMOTION_RESPONSE_NAME } from "@/lib/tutor/escalation/promotionDraft";
import { loadEscalationQueue } from "@/lib/studio/escalationQueue";
import { loadGraphConsole } from "@/lib/studio/graphConsole";

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
const NOW = new Date().toISOString();

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

async function provisionUser(url: string, anon: string, tag: string): Promise<{ client: DB; userId: string; email: string }> {
  const email = `tutor-esc-promo-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

/** A mock model with the escalation_dossier + escalation_promotion structured
 *  responses + a deterministic near-family embed (so clustering works). */
function promotionMock(): ModelClient {
  const base = createMockModelClient([], {
    structured: {
      [DOSSIER_RESPONSE_NAME]: { summary: "The learner is stuck on this concept.", confidenceNotes: "Confirm the exact bound." },
      [PROMOTION_RESPONSE_NAME]: {
        title: "FAQ: Asymptotic notation",
        paragraphs: [
          { kind: "key_idea", text: "Q: Why does my Theta bound differ from the book?" },
          { kind: "paragraph", text: "Theta is a TIGHT bound — it needs matching upper AND lower bounds." },
        ],
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

/** A valid seed lecture block for the fixture lesson. */
function seedBlock(): LessonBlock {
  return buildLectureBlock({
    title: "Big-O, Theta, Omega",
    tone: "concise",
    paragraphs: [{ kind: "paragraph", text: "Asymptotic notation bounds a function's growth rate." }],
  });
}

/** The fixture course doc: one module, one lesson (the promotion target) with one
 *  existing block, plus a second lesson so we can prove the append is scoped. */
function fixtureDoc(): CourseDocument {
  const mod = createModule("Complexity", 0);
  const les = createLesson("Asymptotic notation", 0);
  les.blocks = [seedBlock()];
  const other = createLesson("Recurrences", 1);
  mod.lessons = [les, other];
  return {
    id: crypto.randomUUID(),
    title: "Algorithms",
    description: "Core CS.",
    audience: "beginners",
    level: "beginner",
    plan: { outcomes: ["Reason about growth"], prerequisites: [], teachingStyle: "friendly" },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: { createdAt: NOW, updatedAt: NOW, aiReadableVersion: "1.0" },
  };
}

/** Insert a CONSENTED candidate directly (service-role). */
async function seedConsentedCandidate(admin: DB, learnerUserId: string, courseId: string, nodeId: string, question: string): Promise<string> {
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
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`candidate insert: ${error?.message}`);
  return data.id;
}

/** Deep structural equality of the MODULE/LESSON/BLOCK tree via canonical JSON. We
 *  compare `modules` only: reconcileCourseDoc legitimately bumps the course row's
 *  updated_at (→ doc.metadata.updatedAt) on every write, so the course-level metadata
 *  is volatile by design; the byte-identity that matters is the authored content
 *  tree the FAQ block was added to and removed from. */
function docsEqual(a: CourseDocument, b: CourseDocument): boolean {
  return JSON.stringify(a.modules) === JSON.stringify(b.modules);
}

/** Count the blocks in a named lesson of a doc. */
function lessonBlockCount(doc: CourseDocument, lessonId: string): number {
  for (const m of doc.modules) for (const l of m.lessons) if (l.id === lessonId) return l.blocks.length;
  return -1;
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:tutor-escalation-promotion:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  // Seed the course row (reconcile only UPDATES it), then the module/lesson/block tree.
  const seedDoc = fixtureDoc();
  const courseId = seedDoc.id;
  const lessonId = seedDoc.modules[0].lessons[0].id; // the promotion target lesson
  const { error: cErr } = await author.client.from("courses").insert({
    id: courseId,
    author_id: author.userId,
    title: seedDoc.title,
    description: seedDoc.description,
    audience: seedDoc.audience,
    level: seedDoc.level,
    plan: seedDoc.plan as never,
    theme: seedDoc.theme as never,
  } as never);
  if (cErr) throw new Error(`course insert: ${cErr.message}`);
  const seedErr = await reconcileCourseDoc(admin, seedDoc, author.userId);
  if (seedErr) throw new Error(`seed reconcile: ${seedErr}`);

  // A concept node whose teaching anchor points at the seeded lesson (the promotion's
  // lesson-pick reads concept_nodes.anchors[0].lessonId).
  const nodeId = crypto.randomUUID();
  const { error: nErr } = await author.client.from("concept_nodes").insert([
    { id: nodeId, course_id: courseId, title: "Asymptotic notation", description: "Big-O / Theta / Omega.", anchors: [{ lessonId, blockId: seedDoc.modules[0].lessons[0].blocks[0].id }] },
  ] as never);
  if (nErr) throw new Error(`concept_nodes insert: ${nErr.message}`);

  // A live publication so apply_escalation_reply can resolve a publication_id/version.
  const pubId = crypto.randomUUID();
  const { error: pErr } = await admin.from("course_publications").insert({
    id: pubId,
    course_id: courseId,
    version: 1,
    slug: `esc-promo-${crypto.randomUUID().slice(0, 8)}`,
    snapshot: {} as never,
    content_hash: crypto.randomUUID(),
    status: "live",
    visibility: "public",
    created_by: author.userId,
  } as never);
  if (pErr) throw new Error(`publication insert: ${pErr.message}`);

  // Enroll the learner (so the delivered instructor turn is readable to them).
  const { error: eErr } = await learner.client.from("enrollments").insert({ course_id: courseId, user_id: learner.userId } as never);
  if (eErr) throw new Error(`enroll: ${eErr.message}`);
  console.log("# seeded course + lesson + concept node (anchored) + live publication + enrollment");

  const model = withPooledModel(promotionMock(), {
    pool: poolFor("creator"),
    cost: { supabase: admin, courseId, emittedBy: author.userId, jobType: "escalation_dossier" },
  });

  const cleanup = async () => {
    // escalation_reply_delivery cascades off escalation_cluster (FK on delete cascade),
    // and dossiers/clusters/candidates cascade off the course — delete the parents.
    await admin.from("escalation_dossier").delete().eq("course_id", courseId);
    await admin.from("escalation_cluster").delete().eq("course_id", courseId);
    await admin.from("tutor_turns").delete().eq("course_id", courseId);
    await admin.from("course_publications").delete().eq("id", pubId);
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ══════════ AC-W6P.1 — the FULL LOOP, hop by hop ═══════════════════════ */
    console.log("\n# AC-W6P.1 — full loop: consent → cluster → reply → promote → accept");

    // Hop 1: consented candidate → synthesizeAndCluster (dossier + cluster).
    const candidateId = await seedConsentedCandidate(admin, learner.userId, courseId, nodeId, "Why does my Theta bound differ from the book?");
    const synth = await synthesizeAndCluster(admin, model, candidateId);
    check("hop 1 — synthesizeAndCluster produced a cluster", synth.ok && synth.clusterId != null, synth.reason ?? "");
    const clusterId = synth.clusterId!;
    const clusterAfterSynth = await admin.from("escalation_cluster").select("member_count, status").eq("id", clusterId).single();
    check("hop 1 — the cluster has member_count 1, status open", clusterAfterSynth.data?.member_count === 1 && clusterAfterSynth.data?.status === "open");

    // Hop 2: reply delivery (one instructor turn to the member).
    const reply = await (admin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> })
      .rpc("apply_escalation_reply", { p_cluster_id: clusterId, p_final_answer: "Theta needs matching upper AND lower bounds." });
    check("hop 2 — apply_escalation_reply delivered exactly 1 instructor turn", !reply.error && (reply.data as { delivered: number }).delivered === 1, reply.error?.message ?? JSON.stringify(reply.data));
    const instructorTurns = await admin.from("tutor_turns").select("id").eq("course_id", courseId).eq("role", "instructor");
    check("hop 2 — one instructor turn exists in the thread", (instructorTurns.data ?? []).length === 1);

    // Hop 3: promoteClusterToPatch → a pending change-set in the STANDARD rail.
    const docBeforePromote = await loadCourseDoc(admin, courseId);
    if (!docBeforePromote) throw new Error("course doc missing before promote");
    const promo = await promoteClusterToPatch(admin, model, { courseId, clusterId, finalAnswer: "Theta needs matching upper AND lower bounds." });
    check("hop 3 — promoteClusterToPatch succeeded", promo.ok, promo.ok ? "" : promo.reason);
    if (!promo.ok) throw new Error(`promotion failed: ${promo.reason}`);
    check("hop 3 — the promotion targeted the anchored lesson", promo.lessonId === lessonId, `got=${promo.lessonId} want=${lessonId}`);
    const changeSetId = promo.changeSetId;

    /* ══════════ AC-T6.3 — the promotion rides the STANDARD change-set rail ══ */
    console.log("\n# AC-T6.3 — promotion is a standard pending change-set (block/create/evidence)");
    const items = await admin
      .from("change_set_items")
      .select("node_type, op, block_id, lesson_id, evidence")
      .eq("change_set_id", changeSetId);
    const rows = items.data ?? [];
    check("exactly ONE change-set item was staged", rows.length === 1, `count=${rows.length}`);
    const item = rows[0];
    check("the item is node_type='block'", item?.node_type === "block");
    check("the item is op='create'", item?.op === "create");
    check("the item targets the promotion lesson", item?.lesson_id === lessonId);
    check("the item carries EVIDENCE (the dossier summary)", !!item?.evidence && typeof item.evidence === "object");
    const ev = item?.evidence as Record<string, unknown> | null;
    check("the evidence kind is escalation_cluster", ev?.kind === "escalation_cluster");
    check("the evidence summary names the learner count", typeof ev?.summary === "string" && (ev.summary as string).includes("learner"));

    const csRow = await admin.from("change_sets").select("status").eq("id", changeSetId).single();
    check("the change-set is PENDING", csRow.data?.status === "pending");
    const clusterAfterPromo = await admin.from("escalation_cluster").select("change_set_id").eq("id", clusterId).single();
    check("the cluster recorded its change_set_id", clusterAfterPromo.data?.change_set_id === changeSetId);

    // The FAQ block IS in the draft doc already (the rail applies+persists first).
    const docAfterPromote = await loadCourseDoc(admin, courseId);
    check("the FAQ block is in the draft lesson (persisted before staging)", lessonBlockCount(docAfterPromote!, lessonId) === 2);
    const faqBlock = docAfterPromote!.modules[0].lessons.find((l) => l.id === lessonId)!.blocks.find((b) => b.id === item?.block_id);
    check("the staged block is a lecture_text FAQ", faqBlock?.type === "lecture_text" && typeof faqBlock.title === "string" && faqBlock.title.startsWith("FAQ:"));

    // The queue does NOT show `resolved` yet (change-set still pending).
    const queuePending = await loadEscalationQueue(author.client, courseId);
    const rowPending = queuePending.find((c) => c.id === clusterId);
    check("before accept — the queue row exists (status replied), resolved=false", rowPending != null && rowPending.resolved === false, `resolved=${rowPending?.resolved}`);

    // Hop 4: acceptChangeSet → the block stays + resolution flips (DERIVED).
    console.log("\n# hop 4 + AC-T6.3 — acceptChangeSet: block stays, resolution is DERIVED");
    await acceptChangeSet(admin, changeSetId);
    const csAccepted = await admin.from("change_sets").select("status").eq("id", changeSetId).single();
    check("hop 4 — the change-set is ACCEPTED", csAccepted.data?.status === "accepted");
    const docAfterAccept = await loadCourseDoc(admin, courseId);
    check("hop 4 — the FAQ block is STILL in the draft doc (the next publish snapshots it)", lessonBlockCount(docAfterAccept!, lessonId) === 2);

    // The queue no longer lists this cluster once its promotion is accepted? No — the
    // cluster status is 'replied' (open/replied stay in the queue); `resolved` is now
    // TRUE (derived from the accepted change-set). The RESOLUTION IS DERIVED, with NO
    // trigger and NO acceptChangeSet hook.
    const queueResolved = await loadEscalationQueue(author.client, courseId);
    const rowResolved = queueResolved.find((c) => c.id === clusterId);
    check("after accept — the queue row's DERIVED resolved flag is TRUE", rowResolved != null && rowResolved.resolved === true, `resolved=${rowResolved?.resolved}`);

    // The node bundle's clarifications lists the cluster (drawer's "clarified after N asks").
    const graph = await loadGraphConsole(author.client, courseId);
    check("the graph console bundle carries clarifications", graph != null && typeof graph.clarifications === "object");
    const nodeClar = graph?.clarifications[nodeId] ?? [];
    check("the node's clarifications lists the accepted cluster", nodeClar.some((c) => c.clusterId === clusterId), JSON.stringify(nodeClar));
    check("the clarification carries the member count (identity-free)", nodeClar.find((c) => c.clusterId === clusterId)?.memberCount === 1);

    /* ══════════ AC-T6.3 — reject restores BYTE-IDENTICAL (a fresh promotion) ═ */
    console.log("\n# AC-T6.3 — rejectChangeSet restores the draft doc BYTE-IDENTICAL");
    // A second candidate → a second cluster → a fresh promotion we will REJECT.
    const cand2 = await seedConsentedCandidate(admin, learner.userId, courseId, nodeId, "Is Theta the same as Big-O when the bounds match? (a distinct-enough phrasing here)");
    // Force a distinct cluster by clearing the family cluster's status? Simpler: just
    // synthesize; if it joins the same cluster that's fine — we promote whichever
    // cluster and reject it. Use a brand-new cluster to keep it clean.
    const clusterId2 = crypto.randomUUID();
    await admin.from("escalation_cluster").insert({
      id: clusterId2,
      course_id: courseId,
      node_id: nodeId,
      representative_question: "Is Theta the same as Big-O when the bounds match?",
      representative_answer: "Only when the tight bounds coincide.",
      member_count: 1,
      status: "open",
    } as never);
    await admin.from("escalation_dossier").insert({
      candidate_id: cand2,
      course_id: courseId,
      user_id: learner.userId,
      node_ids: [nodeId] as never,
      learner_question: "Is Theta the same as Big-O when the bounds match?",
      rung_trail: [{ rung: 2 }] as never,
      tutor_proposed_answer: "Only when the tight bounds coincide.",
      dossier: { summary: "s", confidenceNotes: "n" } as never,
      cluster_id: clusterId2,
    } as never);

    const docBeforeReject = await loadCourseDoc(admin, courseId);
    if (!docBeforeReject) throw new Error("doc missing before reject-promotion");

    const promo2 = await promoteClusterToPatch(admin, model, { courseId, clusterId: clusterId2, finalAnswer: "Only when the tight bounds coincide." });
    check("a second promotion staged a change-set", promo2.ok, promo2.ok ? "" : promo2.reason);
    if (!promo2.ok) throw new Error("second promotion failed");
    const docAfterPromo2 = await loadCourseDoc(admin, courseId);
    check("the second FAQ block is present before reject", lessonBlockCount(docAfterPromo2!, lessonId) === 3);

    await rejectChangeSet(admin, promo2.changeSetId, author.userId);
    const csRejected = await admin.from("change_sets").select("status").eq("id", promo2.changeSetId).single();
    check("the rejected change-set is 'rejected'", csRejected.data?.status === "rejected");
    const docAfterReject = await loadCourseDoc(admin, courseId);
    check("after reject the lesson block count is back to 2 (the FAQ was removed)", lessonBlockCount(docAfterReject!, lessonId) === 2);
    check(
      "rejectChangeSet restored the draft doc BYTE-IDENTICAL to before the promotion",
      docAfterReject != null && docsEqual(docBeforeReject, docAfterReject),
      "docs differ after reject"
    );

    /* ══════════ idempotency — a double promote returns the pending change-set ═ */
    console.log("\n# idempotency — a re-promote of a still-pending cluster reuses the change-set");
    const cand3 = await seedConsentedCandidate(admin, learner.userId, courseId, nodeId, "One more Theta question (for the idempotency case)");
    const clusterId3 = crypto.randomUUID();
    await admin.from("escalation_cluster").insert({
      id: clusterId3, course_id: courseId, node_id: nodeId,
      representative_question: "One more Theta question", representative_answer: "answer", member_count: 1, status: "open",
    } as never);
    await admin.from("escalation_dossier").insert({
      candidate_id: cand3, course_id: courseId, user_id: learner.userId, node_ids: [nodeId] as never,
      learner_question: "One more Theta question", rung_trail: [{ rung: 1 }] as never, tutor_proposed_answer: "answer",
      dossier: { summary: "s", confidenceNotes: "n" } as never, cluster_id: clusterId3,
    } as never);
    const p3a = await promoteClusterToPatch(admin, model, { courseId, clusterId: clusterId3 });
    const p3b = await promoteClusterToPatch(admin, model, { courseId, clusterId: clusterId3 });
    check("the re-promote returns the SAME change-set id (no double-file)", p3a.ok && p3b.ok && p3a.changeSetId === p3b.changeSetId && p3b.reused === true, JSON.stringify([p3a, p3b]));
    const items3 = await admin.from("change_set_items").select("id").eq("change_set_id", (p3a as { changeSetId: string }).changeSetId);
    check("the re-promote did NOT add a second FAQ block (one change-set item)", (items3.data ?? []).length === 1);
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
