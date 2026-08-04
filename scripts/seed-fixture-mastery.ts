/**
 * Seed FIXTURE for the TUTOR-1 Wave 2 MASTERY cohort (package D).
 *
 * Builds a DETERMINISTIC synthetic mastery cohort so the live integration matrix
 * (verify-tutor-mastery-int.ts) and the /home browser test have real mastery
 * substance to exercise — WITHOUT any model call (ZERO MODEL SPEND is a hard
 * gate; nothing here imports a model client). The concept GRAPH is built
 * DETERMINISTICALLY (a real extraction needs a model), and evidence is produced
 * through the REAL grade path (quizService → record_quiz_attempt) plus admin- and
 * client-emitted evidence events.
 *
 * WHAT IT SEEDS
 *   1. A fresh throwaway AUTHOR + the deterministic Microeconomics course
 *      (seedTutorFixture) — published unlisted.
 *   2. ~10 concept_nodes (admin insert; created_by 'extraction', each ANCHORED to
 *      REAL seeded block ids via anchors jsonb) forming a prerequisite chain
 *      A→B→C plus a wider fan (A→D, A→E, A→F, B→G, C→H) so A has many transitive
 *      dependents — root-cause + review-queue leverage have real structure. Edges
 *      go through the tutor_upsert_concept_edge RPC (the service-role DAG gate).
 *   3. SIX scripted learners (fresh throwaway users each, self-enrolled through
 *      the real RLS insert path) with distinct evidence profiles (goldens below),
 *      graded through the REAL quizService path; PLUS admin-emitted evidence
 *      events (practice_answer w/ attempt_ordinal, a rung-4 hint_request for L2,
 *      a self_report, a tutor_inference) and ONE content_engagement through the
 *      CLIENT batch RPC as the learner — so every evidence KIND exists in the
 *      cohort.
 *
 * EXPECTED MASTERY DIRECTIONS (the goldens the int suite asserts against; every
 * probability is P(L0)=.25 folded through BKT with S=.10/G=.20/T=.20):
 *   • L1 "strong"    — correct on the A/B/C quizzes (all-correct, real grade path)
 *                      + a correct practice_answer@1 → HIGH decayed_p everywhere
 *                      (A/B/C ≳ 0.9); nothing below threshold.
 *   • L2 "weak-with-upstream-gap" — WRONG on the node-A quiz (2 wrong attempts) +
 *                      a rung-4 hint_request on A + a negative self_report on A,
 *                      but CORRECT on B and C → A's decayed_p sits LOW (< .6, below
 *                      threshold) while B/C are high. A is the DEEPEST below-
 *                      threshold ancestor of C and the highest-leverage weak node,
 *                      so rootCause(C)→A and A ranks at/near the top of L2's queue.
 *   • L3 "decayed-inactive" — correct A/B/C evidence, but every row's created_at /
 *                      server_ts / submitted_at is BACKDATED ~60 days (admin UPDATE
 *                      after insert — see backdateLearner). p_learned stays high;
 *                      decayed_p ≪ p_learned (materialized decay against now); a
 *                      fresh refold at now+30d decays FURTHER (read-side decay).
 *   • L4 "retry-heavy" — the SAME node-A quiz answered wrong→right→right across 3
 *                      attempts (the A1.2 subject). The attempt ordinal is derived
 *                      (created_at,id): w1=1.0 wrong, w2=0.5 right, w3=0.15 right →
 *                      A's p_learned equals the pure ordinal golden (0.503574), far
 *                      below the unweighted control (0.918129) — retry contamination
 *                      really is discounted. A ends below threshold.
 *   • L5,L6 "average" — a mix (A correct, B wrong, C correct for L5; the mirror for
 *                      L6) → some nodes high, some low; they populate the cohort so
 *                      the 6-learner aggregate crosses the floor of 5.
 *
 * The 7th "cold-start" learner (ZERO evidence) is NOT seeded here — the int suite
 * provisions it inline (it needs no course content beyond enrollment).
 *
 * Exported as `seedMasteryCohort` for the int + browser suites (neither duplicates
 * the build). Standalone: `npx tsx scripts/seed-fixture-mastery.ts` prints the
 * cohort JSON. Needs the anon key (self-provision) + SUPABASE_SERVICE_ROLE_KEY
 * (admin graph inserts, backdating, event emits) in .env.local.
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { parsePublicationSnapshot, resolveLivePublicationBySlug } from "@/lib/learn/resolve";
import { submitQuizAttempt } from "@/lib/learn/quizService";
import { buildTutorEvidenceEvent, buildEvent, mapEventToColumns } from "@/lib/analytics/events";
import { createConceptNode, upsertConceptEdge } from "@/lib/tutor/graph/repository";
import type { ConceptAnchor } from "@/lib/tutor/graph/schemas";
import type { QuizBlock } from "@/lib/course/types";
import { createBlock, createQuestion } from "@/lib/course/factories";
import { seedTutorFixture, type TutorFixture } from "./seed-fixture-tutor";

// Node prefers supabase.co's IPv6 record; on this dev machine's IPv6-broken
// network the TLS socket resets before the handshake. Pin IPv4-first.
dns.setDefaultResultOrder("ipv4first");

type DB = SupabaseClient<Database>;

/** Retry transient TRANSPORT failures (never HTTP errors) — the network drops
 *  connections sporadically mid-run. */
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

export interface MasteryCohortEnv {
  url: string;
  anon: string;
  service: string;
}

export function loadMasteryEnv(): MasteryCohortEnv {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const service = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY;
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new Error("Missing Supabase env (URL/ANON) in .env.local");
  }
  if (!service) throw new Error("seed-fixture-mastery needs SUPABASE_SERVICE_ROLE_KEY");
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, service };
}

/** Self-provision one throwaway learner + a signed-in RLS-scoped client. */
async function provisionLearner(
  url: string,
  anon: string,
  tag: string
): Promise<{ client: DB; userId: string; email: string; password: string }> {
  const email = `mastery-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup ${tag} failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin ${tag} failed: ${error?.message}`);
  return { client, userId: data.user.id, email, password };
}

/* ───────────────────────── graph node identities ─────────────────────────── */

/** The ten synthetic concept nodes. `key` is the goldens label (A..J); `anchorTo`
 *  names WHICH seeded block the node anchors onto (resolved to real ids below).
 *  A/B/C also carry a dedicated quiz block (the real grade path targets it). */
export type NodeKey = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J";

export interface SeededNode {
  key: NodeKey;
  id: string;
  title: string;
}

/* ─────────────────── the mastery cohort seed (the deliverable) ───────────── */

export interface CohortLearner {
  email: string;
  password: string;
  userId: string;
  /** The scripted evidence profile label. */
  profile: string;
}

export interface MasteryCohort {
  courseId: string;
  publicationId: string;
  version: number;
  slug: string;
  /** The author (client + id) — the concept_mastery_aggregate principal. */
  author: { userId: string };
  learners: CohortLearner[];
  /** Every seeded concept node keyed A..J → its uuid + title. */
  nodeIds: Record<NodeKey, string>;
  /** Node A/B/C's dedicated quiz block ids (the real-grade-path targets). */
  quizBlockIds: { A: string; B: string; C: string };
  /** Kept alive so a caller (int suite) can re-grade / re-emit / clean up. */
  fixture: TutorFixture;
  admin: DB;
}

/**
 * A node's title, taken from the seeded Microeconomics content so the /home
 * "Worth a review" card renders a real concept name (never a uuid). Node A is a
 * FOUNDATIONAL prerequisite (Scarcity) — the root-cause subject.
 */
const NODE_TITLES: Record<NodeKey, string> = {
  A: "Scarcity",
  B: "Supply and Demand",
  C: "Market Equilibrium",
  D: "Opportunity Cost",
  E: "Price Signals",
  F: "The Law of Demand",
  G: "Price Elasticity of Demand",
  H: "Consumer Surplus",
  I: "Producer Surplus",
  J: "Market Structures",
};

/**
 * Build a dedicated single-question multiple-choice quiz block for a concept.
 * choices[1] is the correct one. The block id + question id + choice ids are
 * stamped DETERMINISTICALLY (per concept) so we can anchor a concept node onto
 * the block and target the question/choice from the grade path. Uses the real
 * factories so `ai`/settings/manifest are well-formed.
 */
function conceptQuiz(blockId: string, concept: string): QuizBlock {
  const quiz = createBlock("quiz", 99) as QuizBlock;
  quiz.id = blockId;
  quiz.title = `${concept} check`;
  const q = createQuestion("multiple_choice");
  if (q.kind !== "multiple_choice") throw new Error("unreachable");
  q.id = `q-${concept}`;
  q.prompt = `Which statement about ${concept} is correct?`;
  q.choices = [
    { id: `c-${concept}-0`, text: `A wrong claim about ${concept}.` },
    { id: `c-${concept}-1`, text: `The correct definition of ${concept}.` },
    { id: `c-${concept}-2`, text: `Another wrong claim about ${concept}.` },
  ];
  q.correctChoiceId = `c-${concept}-1`;
  q.explanation = `See the ${concept} lesson.`;
  quiz.questions = [q];
  return quiz;
}

/**
 * SEED THE COHORT. Fresh throwaway author + 6 learners each run (idempotent).
 * Returns the cohort descriptor. Does NOT clean up — the caller owns teardown
 * (`cohort.fixture.author.client.from("courses").delete()`).
 */
export async function seedMasteryCohort(
  env: MasteryCohortEnv = loadMasteryEnv()
): Promise<MasteryCohort> {
  const admin = createClient<Database>(env.url, env.service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  // 1) The deterministic Microeconomics course, published unlisted.
  const fixture = await seedTutorFixture({ url: env.url, anon: env.anon });
  const courseId = fixture.courseId;

  // Insert three dedicated concept quiz blocks (A/B/C) into three real lessons so
  // the REAL grade path lands quiz_attempt_detail on a block a concept anchors to.
  // Exclude the W4.4 video lesson (a deck-less lesson appended to module 1 for
  // the browser suite) so the flattened lesson indices this cohort's anchors +
  // goldens depend on stay byte-identical to the pre-video fixture.
  const lessons = fixture.doc.modules
    .flatMap((m) => m.lessons)
    .filter((l) => !l.blocks.some((b) => b.type === "video"));
  const quizBlockIds = {
    A: crypto.randomUUID(),
    B: crypto.randomUUID(),
    C: crypto.randomUUID(),
  };
  const quizFor: Record<"A" | "B" | "C", { blockId: string; lessonId: string; concept: string }> = {
    A: { blockId: quizBlockIds.A, lessonId: lessons[0].id, concept: "Scarcity" },
    B: { blockId: quizBlockIds.B, lessonId: lessons[1].id, concept: "Supply and Demand" },
    C: { blockId: quizBlockIds.C, lessonId: lessons[2].id, concept: "Market Equilibrium" },
  };
  for (const key of ["A", "B", "C"] as const) {
    const { blockId, lessonId, concept } = quizFor[key];
    const block = conceptQuiz(blockId, concept);
    const { error } = await admin.from("blocks").insert({
      id: block.id,
      lesson_id: lessonId,
      course_id: courseId,
      type: "quiz",
      title: block.title,
      order: block.order,
      content: block as unknown as Json,
    } as never);
    if (error) throw new Error(`quiz block ${key} insert: ${error.message}`);
  }

  // We publish a v2 that INCLUDES the new quiz blocks so the snapshot the grade
  // path reads carries them + their answer keys. (seedTutorFixture published v1
  // without them.)
  const docV2 = structuredClone(fixture.doc);
  const lessonsV2 = docV2.modules.flatMap((m) => m.lessons);
  lessonsV2[0].blocks.push(conceptQuiz(quizBlockIds.A, "Scarcity"));
  lessonsV2[1].blocks.push(conceptQuiz(quizBlockIds.B, "Supply and Demand"));
  lessonsV2[2].blocks.push(conceptQuiz(quizBlockIds.C, "Market Equilibrium"));
  const { publishCourse } = await import("@/lib/course/publish/service");
  const v2 = await publishCourse(fixture.author.client, docV2, { visibility: "unlisted" });
  const liveV2 = await resolveLivePublicationBySlug(fixture.author.client, v2.publication.slug);
  if (liveV2.kind !== "found") throw new Error("v2 publication not resolvable");
  const publication = liveV2.publication;
  const publicationId = publication.id;
  const version = publication.version;
  const snapshot = parsePublicationSnapshot(publication);
  const slug = v2.publication.slug;

  // 2) The concept graph — ~10 nodes anchored to real block ids + a prereq chain
  //    A→B→C plus a wider fan (A→D, A→E, A→F, B→G, C→H). Nodes I/J are anchored,
  //    edge-light leaves (they round out the cohort aggregate).
  const anchorForLesson = (idx: number, blockId?: string): ConceptAnchor => ({
    lessonId: lessons[idx].id,
    blockId: blockId ?? (lessons[idx].blocks[0]?.id as string),
  });
  const anchorPlan: Record<NodeKey, ConceptAnchor[]> = {
    // A/B/C anchor to BOTH their concept quiz block (grade-path evidence) AND
    // their lesson deck (so a dwell/self-report on the deck maps too).
    A: [anchorForLesson(0, quizBlockIds.A), anchorForLesson(0)],
    B: [anchorForLesson(1, quizBlockIds.B), anchorForLesson(1)],
    C: [anchorForLesson(2, quizBlockIds.C), anchorForLesson(2)],
    D: [anchorForLesson(0)],
    E: [anchorForLesson(1)],
    F: [anchorForLesson(2)],
    G: [anchorForLesson(3)],
    H: [anchorForLesson(4)],
    I: [anchorForLesson(5)],
    J: [anchorForLesson(6)],
  };

  const nodeIds = {} as Record<NodeKey, string>;
  for (const key of Object.keys(NODE_TITLES) as NodeKey[]) {
    const node = await createConceptNode(admin as never, {
      courseId,
      title: NODE_TITLES[key],
      createdBy: "extraction",
      anchors: anchorPlan[key],
    });
    nodeIds[key] = node.id;
  }

  // Prerequisite edges (source must be understood BEFORE target). A is the root:
  // A→B→C plus A→D, A→E, A→F, B→G, C→H. Following edges FROM A reaches
  // B,C,D,E,F,G,H (7 transitive dependents) — A is the highest-leverage node.
  const edges: [NodeKey, NodeKey][] = [
    ["A", "B"],
    ["B", "C"],
    ["A", "D"],
    ["A", "E"],
    ["A", "F"],
    ["B", "G"],
    ["C", "H"],
  ];
  for (const [src, tgt] of edges) {
    await upsertConceptEdge(admin as never, {
      id: crypto.randomUUID(),
      courseId,
      sourceNodeId: nodeIds[src],
      targetNodeId: nodeIds[tgt],
      kind: "prerequisite",
    });
  }

  // 3) The six scripted learners.
  const pubForGrade = { id: publicationId, version, snapshot };

  /** Grade one MC attempt on a concept quiz block through the REAL quizService
   *  path (records quiz_attempts + quiz_attempt_detail). `correct` picks the
   *  right/wrong choice. Returns the attempt id. */
  const gradeQuiz = async (
    learner: { client: DB; userId: string },
    key: "A" | "B" | "C",
    correct: boolean
  ): Promise<string> => {
    const { concept } = quizFor[key];
    const choiceId = correct ? `c-${concept}-1` : `c-${concept}-0`;
    const res = await submitQuizAttempt(admin, {
      userId: learner.userId,
      role: "student",
      courseId,
      publication: pubForGrade,
      request: {
        publicationId,
        blockId: quizBlockIds[key],
        responses: [{ kind: "multiple_choice", questionId: `q-${concept}`, choiceId }],
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    if (!res.attemptId) throw new Error(`grade ${key} did not record an attempt`);
    return res.attemptId;
  };

  /** Enroll a learner through the real RLS self-insert (needs the live pub). */
  const enroll = async (learner: { client: DB; userId: string }) => {
    const { error } = await learner.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: learner.userId });
    if (error) throw new Error(`enroll failed: ${error.message}`);
  };

  /** Admin-emit one SERVER tutor-evidence event (the serverEmit upsert pattern:
   *  build → mapEventToColumns → idempotent upsert on client_event_id). */
  const emitServerEvidence = async (
    userId: string,
    input: Parameters<typeof buildTutorEvidenceEvent>[0]
  ): Promise<void> => {
    const event = buildTutorEvidenceEvent(input, { clientEventId: crypto.randomUUID() });
    const { error } = await admin
      .from("learning_events")
      .upsert([mapEventToColumns(event, userId)], { onConflict: "client_event_id", ignoreDuplicates: true });
    if (error) throw new Error(`emit ${input.eventType} failed: ${error.message}`);
  };

  /** Client-emit one content_engagement through the batch RPC as the learner
   *  (the ONE client evidence member — proves the client path). */
  const emitClientEngagement = async (
    learner: { client: DB },
    lessonIdx: number,
    signal: "completed" | "rewatch" | "scrub_back"
  ): Promise<void> => {
    const event = buildEvent(
      { publicationId, version, courseId, lessonId: lessons[lessonIdx].id },
      { eventType: "content_engagement", signal }
    );
    const wire = {
      client_event_id: event.clientEventId,
      event_type: event.eventType,
      publication_id: publicationId,
      version,
      course_id: courseId,
      lesson_id: lessons[lessonIdx].id,
      metadata: { signal },
      client_ts: event.clientTs,
    };
    const { error } = await learner.client.rpc("ingest_learning_events", {
      p_events: [wire] as unknown as Json,
    });
    if (error) throw new Error(`client content_engagement ingest failed: ${error.message}`);
  };

  const learners: CohortLearner[] = [];
  const nowMs = Date.now();

  /* ── L1 strong ── */
  {
    const L1 = await provisionLearner(env.url, env.anon, "l1-strong");
    await enroll(L1);
    await gradeQuiz(L1, "A", true);
    await gradeQuiz(L1, "B", true);
    await gradeQuiz(L1, "C", true);
    // A correct practice_answer@1 on A + a completed content_engagement (client).
    await emitServerEvidence(L1.userId, {
      eventType: "practice_answer",
      courseId,
      publicationId,
      version,
      lessonId: lessons[0].id,
      nodeId: nodeIds.A,
      attemptOrdinal: 1,
      evidenceCorrect: true,
      practiceItemRef: crypto.randomUUID(),
    });
    await emitClientEngagement(L1, 0, "completed");
    learners.push({ email: L1.email, password: L1.password, userId: L1.userId, profile: "strong" });
  }

  /* ── L2 weak-with-upstream-gap ── */
  {
    const L2 = await provisionLearner(env.url, env.anon, "l2-weak-a");
    await enroll(L2);
    // WRONG on A twice (both attempts wrong — no recovery), CORRECT on B and C.
    await gradeQuiz(L2, "A", false);
    await gradeQuiz(L2, "A", false);
    await gradeQuiz(L2, "B", true);
    await gradeQuiz(L2, "C", true);
    // A rung-4 hint_request on A (the answer was surfaced — strongest hint
    // negative) + a negative self_report on A.
    await emitServerEvidence(L2.userId, {
      eventType: "hint_request",
      courseId,
      publicationId,
      version,
      lessonId: lessons[0].id,
      nodeId: nodeIds.A,
      hintRung: 4,
      practiceItemRef: crypto.randomUUID(),
    });
    await emitServerEvidence(L2.userId, {
      eventType: "self_report",
      courseId,
      publicationId,
      version,
      lessonId: lessons[0].id,
      nodeId: nodeIds.A,
      evidenceCorrect: false,
    });
    await emitClientEngagement(L2, 0, "rewatch");
    learners.push({ email: L2.email, password: L2.password, userId: L2.userId, profile: "weak-with-upstream-gap" });
  }

  /* ── L3 decayed-inactive ── */
  {
    const L3 = await provisionLearner(env.url, env.anon, "l3-decayed");
    await enroll(L3);
    await gradeQuiz(L3, "A", true);
    await gradeQuiz(L3, "B", true);
    await gradeQuiz(L3, "C", true);
    // A correct tutor_inference (moderate) on A, then BACKDATE all of L3's
    // evidence ~60 days so decayed_p ≪ p_learned at materialization time.
    await emitServerEvidence(L3.userId, {
      eventType: "tutor_inference",
      courseId,
      publicationId,
      version,
      lessonId: lessons[0].id,
      nodeId: nodeIds.A,
      metadata: {
        nodeId: nodeIds.A,
        direction: "positive",
        strength: "moderate",
        turnRef: "seed-l3-turn-1",
      },
    });
    await backdateLearner(admin, L3.userId, courseId, 60);
    learners.push({ email: L3.email, password: L3.password, userId: L3.userId, profile: "decayed-inactive" });
  }

  /* ── L4 retry-heavy (A1.2) ── */
  {
    const L4 = await provisionLearner(env.url, env.anon, "l4-retry");
    await enroll(L4);
    // The SAME node-A quiz across 3 attempts: wrong → right → right. The ordinal
    // is derived (created_at,id) so the sequence order IS the ordinal (1/2/3).
    await gradeQuiz(L4, "A", false); // ordinal 1, w=1.0
    await gradeQuiz(L4, "A", true); // ordinal 2, w=0.5
    await gradeQuiz(L4, "A", true); // ordinal 3, w=0.15
    // B/C correct so only A carries the retry story.
    await gradeQuiz(L4, "B", true);
    await gradeQuiz(L4, "C", true);
    learners.push({ email: L4.email, password: L4.password, userId: L4.userId, profile: "retry-heavy" });
  }

  /* ── L5 average ── */
  {
    const L5 = await provisionLearner(env.url, env.anon, "l5-avg");
    await enroll(L5);
    await gradeQuiz(L5, "A", true);
    await gradeQuiz(L5, "B", false);
    await gradeQuiz(L5, "C", true);
    await emitClientEngagement(L5, 1, "scrub_back");
    learners.push({ email: L5.email, password: L5.password, userId: L5.userId, profile: "average" });
  }

  /* ── L6 average (mirror) ── */
  {
    const L6 = await provisionLearner(env.url, env.anon, "l6-avg");
    await enroll(L6);
    await gradeQuiz(L6, "A", false);
    await gradeQuiz(L6, "B", true);
    await gradeQuiz(L6, "C", false);
    await emitServerEvidence(L6.userId, {
      eventType: "practice_answer",
      courseId,
      publicationId,
      version,
      lessonId: lessons[1].id,
      nodeId: nodeIds.B,
      attemptOrdinal: 1,
      evidenceCorrect: true,
      practiceItemRef: crypto.randomUUID(),
    });
    learners.push({ email: L6.email, password: L6.password, userId: L6.userId, profile: "average" });
  }

  void nowMs;
  return {
    courseId,
    publicationId,
    version,
    slug,
    author: { userId: fixture.author.userId },
    learners,
    nodeIds,
    quizBlockIds,
    fixture,
    admin,
  };
}

/**
 * Backdate every learning-evidence row for one (user, course) by `days` — so a
 * learner reads as INACTIVE and their folded estimate decays. We UPDATE the
 * server_ts/client_ts on their learning_events and the submitted_at/started_at
 * on their quiz_attempts + the created_at on quiz_attempt_detail. (The refold
 * derives its decay clock from the evidence timestamps; backdating them all is
 * the documented way to simulate an inactive learner without a real clock.)
 */
async function backdateLearner(admin: DB, userId: string, courseId: string, days: number): Promise<void> {
  const past = new Date(Date.now() - days * 86_400_000).toISOString();
  // learning_events (server_ts drives the evidence `at`).
  const ev = await admin
    .from("learning_events")
    .update({ server_ts: past, client_ts: past })
    .eq("user_id", userId)
    .eq("course_id", courseId);
  if (ev.error) throw new Error(`backdate events: ${ev.error.message}`);
  // quiz_attempts (submitted_at drives the historical/detail evidence `at`).
  const at = await admin
    .from("quiz_attempts")
    .update({ submitted_at: past, started_at: past })
    .eq("user_id", userId)
    .eq("course_id", courseId);
  if (at.error) throw new Error(`backdate attempts: ${at.error.message}`);
  // quiz_attempt_detail.created_at (the per-question evidence `at`). Untyped
  // table → narrow cast.
  const detail = await (admin as unknown as {
    from: (t: string) => {
      update: (v: Record<string, unknown>) => {
        eq: (c: string, v: string) => {
          eq: (c2: string, v2: string) => Promise<{ error: { message: string } | null }>;
        };
      };
    };
  })
    .from("quiz_attempt_detail")
    .update({ created_at: past })
    .eq("user_id", userId)
    .eq("course_id", courseId);
  if (detail.error) throw new Error(`backdate detail: ${detail.error.message}`);
}

/* ─────────────────────────────── CLI entry ──────────────────────────────── */

async function main() {
  const cohort = await seedMasteryCohort();
  console.log(
    JSON.stringify(
      {
        courseId: cohort.courseId,
        publicationId: cohort.publicationId,
        version: cohort.version,
        slug: cohort.slug,
        learners: cohort.learners,
        nodeIds: cohort.nodeIds,
        quizBlockIds: cohort.quizBlockIds,
      },
      null,
      2
    )
  );
  console.log("\n# throwaway users + course remain (clean the course row + users in Supabase → Auth)");
}

if (process.argv[1]?.endsWith("seed-fixture-mastery.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
