/**
 * TUTOR-1 Wave 4 (W4.4) — the HENRY DEMO seed. ONE command that stands up a
 * fully wired, ready-to-click learner tutor so a reviewer can experience the
 * ROOT-CAUSE INTERJECTION on the first relevant question — no build steps, no
 * fixtures to assemble by hand.
 *
 * It:
 *   (a) seeds the deterministic Microeconomics tutor fixture (author auto-
 *       provisioned) via seedTutorFixture — published unlisted;
 *   (b) enables the tutor for the course (tutor_course_settings {enabled:true},
 *       inserted as the AUTHOR — author-only RLS);
 *   (c) provisions a DEMO LEARNER with a MEMORABLE password + enrolls them;
 *   (d) seeds a small prerequisite graph (Scarcity → Supply&Demand → Market
 *       Equilibrium) + a WEAK-PREREQUISITE mastery state (the learner is shaky
 *       on Scarcity but fine on the downstream concepts) and a review-queue row,
 *       so a question about the downstream concept trips the root-cause
 *       interjection back to Scarcity;
 *   (e) refolds the learner's mastery inline (the deterministic engine — no
 *       Inngest, no model) so learner_mastery is materialized before the demo;
 *   (f) prints a clean summary: learner email/password, the /learn/{slug} URL,
 *       the lesson to open, and the first question that triggers the interjection.
 *
 * Idempotent-enough: each run provisions FRESH throwaway users (the *@example.com
 * convention — can't be deleted with the anon key; clean them in Supabase → Auth).
 *
 * Run: `npm run seed:tutor-demo`  (needs the anon key + SUPABASE_SERVICE_ROLE_KEY
 * in .env.local — the graph inserts, evidence emits, and refold are admin/service).
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { seedTutorFixture, type TutorFixture } from "./seed-fixture-tutor";
import { createConceptNode, upsertConceptEdge } from "@/lib/tutor/graph/repository";
import type { ConceptAnchor } from "@/lib/tutor/graph/schemas";
import { buildTutorEvidenceEvent, mapEventToColumns } from "@/lib/analytics/events";
import { submitQuizAttempt } from "@/lib/learn/quizService";
import { parsePublicationSnapshot, resolveLivePublicationBySlug } from "@/lib/learn/resolve";
import { refoldLearnerCourse } from "@/lib/tutor/mastery/loader";
import { writeMastery } from "@/lib/tutor/mastery/writer";
import { createBlock, createQuestion } from "@/lib/course/factories";
import type { QuizBlock } from "@/lib/course/types";

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

interface DemoEnv {
  url: string;
  anon: string;
  service: string;
}

function loadDemoEnv(): DemoEnv {
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
  if (!service) throw new Error("seed:tutor-demo needs SUPABASE_SERVICE_ROLE_KEY");
  return {
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    service,
  };
}

/** Self-provision one throwaway learner (memorable password) + a signed-in
 *  RLS-scoped client. */
async function provisionLearner(
  env: DemoEnv,
  password: string
): Promise<{ client: DB; userId: string; email: string; password: string }> {
  const email = `tutor-demo-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const signup = await retryingFetch(`${env.url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: env.anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`demo learner signup failed: ${await signup.text()}`);
  const client = createClient<Database>(env.url, env.anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`demo learner signin failed: ${error?.message}`);
  return { client, userId: data.user.id, email, password };
}

/** A dedicated single-question MC quiz block for a concept (mirrors the mastery
 *  cohort's conceptQuiz — choices[1] is correct; ids stamped deterministically
 *  so the grade path can target them). */
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

async function main() {
  const env = loadDemoEnv();
  const admin = createClient<Database>(env.url, env.service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  console.log("# seeding the tutor fixture course (author auto-provisioned)…");
  const fixture: TutorFixture = await seedTutorFixture({ url: env.url, anon: env.anon });
  const courseId = fixture.courseId;

  // (b) ENABLE the tutor for the course — inserted as the AUTHOR (author-only RLS).
  const settings = await fixture.author.client
    .from("tutor_course_settings")
    .upsert({ course_id: courseId, enabled: true } as never, { onConflict: "course_id" });
  if (settings.error) throw new Error(`enable tutor: ${settings.error.message}`);
  console.log("# tutor enabled");

  // The course's real lessons (Scarcity / Supply / Market Equilibrium live in
  // module 1 + module 2). We anchor the three demo concepts onto real blocks +
  // add dedicated concept quizzes so the grade path can move mastery.
  const lessons = fixture.doc.modules
    .flatMap((m) => m.lessons)
    .filter((l) => !l.blocks.some((b) => b.type === "video"));
  const scarcityLesson = lessons[0]; // "Scarcity and Opportunity Cost"
  const marketsLesson = lessons[1]; // "How Markets Coordinate"
  const equilibriumLesson = lessons.find((l) => l.title === "Market Equilibrium") ?? lessons[4];

  // Dedicated concept quiz blocks — insert into their lessons (admin) then
  // republish so the live snapshot carries them + their answer keys.
  const quizBlockIds = {
    Scarcity: crypto.randomUUID(),
    "Supply and Demand": crypto.randomUUID(),
    "Market Equilibrium": crypto.randomUUID(),
  } as const;
  const quizFor: Record<
    "Scarcity" | "Supply and Demand" | "Market Equilibrium",
    { blockId: string; lessonId: string }
  > = {
    Scarcity: { blockId: quizBlockIds.Scarcity, lessonId: scarcityLesson.id },
    "Supply and Demand": { blockId: quizBlockIds["Supply and Demand"], lessonId: marketsLesson.id },
    "Market Equilibrium": {
      blockId: quizBlockIds["Market Equilibrium"],
      lessonId: equilibriumLesson.id,
    },
  };
  for (const concept of Object.keys(quizFor) as (keyof typeof quizFor)[]) {
    const { blockId, lessonId } = quizFor[concept];
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
    if (error) throw new Error(`concept quiz ${concept} insert: ${error.message}`);
  }

  // Republish v2 with the concept quizzes so the grade path reads their keys.
  const { publishCourse } = await import("@/lib/course/publish/service");
  const docV2 = structuredClone(fixture.doc);
  const lessonsV2 = docV2.modules.flatMap((m) => m.lessons);
  const pushQuiz = (lessonId: string, concept: keyof typeof quizFor) => {
    const l = lessonsV2.find((x) => x.id === lessonId);
    if (l) l.blocks.push(conceptQuiz(quizFor[concept].blockId, concept));
  };
  pushQuiz(scarcityLesson.id, "Scarcity");
  pushQuiz(marketsLesson.id, "Supply and Demand");
  pushQuiz(equilibriumLesson.id, "Market Equilibrium");
  const v2 = await publishCourse(fixture.author.client, docV2, { visibility: "unlisted" });
  const liveV2 = await resolveLivePublicationBySlug(fixture.author.client, v2.publication.slug);
  if (liveV2.kind !== "found") throw new Error("v2 publication not resolvable");
  const publication = liveV2.publication;
  const publicationId = publication.id;
  const version = publication.version;
  const snapshot = parsePublicationSnapshot(publication);
  const slug = v2.publication.slug;
  console.log(`# republished v2 (with concept quizzes) → /learn/${slug}`);

  // (d) The prerequisite graph: Scarcity → Supply & Demand → Market Equilibrium.
  const anchor = (lessonId: string, blockId: string): ConceptAnchor => ({ lessonId, blockId });
  const scarcityNode = await createConceptNode(admin as never, {
    courseId,
    title: "Scarcity",
    createdBy: "extraction",
    anchors: [anchor(scarcityLesson.id, quizFor.Scarcity.blockId), anchor(scarcityLesson.id, scarcityLesson.blocks[0].id)],
  });
  const supplyNode = await createConceptNode(admin as never, {
    courseId,
    title: "Supply and Demand",
    createdBy: "extraction",
    anchors: [
      anchor(marketsLesson.id, quizFor["Supply and Demand"].blockId),
      anchor(marketsLesson.id, marketsLesson.blocks[0].id),
    ],
  });
  const equilibriumNode = await createConceptNode(admin as never, {
    courseId,
    title: "Market Equilibrium",
    createdBy: "extraction",
    anchors: [
      anchor(equilibriumLesson.id, quizFor["Market Equilibrium"].blockId),
      anchor(equilibriumLesson.id, equilibriumLesson.blocks[0].id),
    ],
  });
  for (const [src, tgt] of [
    [scarcityNode, supplyNode],
    [supplyNode, equilibriumNode],
  ] as const) {
    await upsertConceptEdge(admin as never, {
      id: crypto.randomUUID(),
      courseId,
      sourceNodeId: src.id,
      targetNodeId: tgt.id,
      kind: "prerequisite",
    });
  }
  console.log("# graph: Scarcity → Supply and Demand → Market Equilibrium");

  // (c) The DEMO LEARNER (memorable password) + enrollment.
  const password = "Tutor-demo-2026!";
  const learner = await provisionLearner(env, password);
  const enrolled = await learner.client
    .from("enrollments")
    .insert({ course_id: courseId, user_id: learner.userId } as never);
  if (enrolled.error) throw new Error(`enroll: ${enrolled.error.message}`);
  console.log(`# demo learner provisioned + enrolled: ${learner.email}`);

  // Weak on Scarcity (2 wrong quiz attempts + a rung-4 hint + a negative
  // self-report), fine on Supply & Demand and Market Equilibrium → Scarcity
  // sits below threshold and is the deepest weak ancestor of Market Equilibrium.
  const pubForGrade = { id: publicationId, version, snapshot };
  const gradeQuiz = async (concept: keyof typeof quizFor, correct: boolean) => {
    const choiceId = correct ? `c-${concept}-1` : `c-${concept}-0`;
    await submitQuizAttempt(admin, {
      userId: learner.userId,
      role: "student",
      courseId,
      publication: pubForGrade,
      request: {
        publicationId,
        blockId: quizFor[concept].blockId,
        responses: [{ kind: "multiple_choice", questionId: `q-${concept}`, choiceId }],
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
  };
  const emitEvidence = async (input: Parameters<typeof buildTutorEvidenceEvent>[0]) => {
    const event = buildTutorEvidenceEvent(input, { clientEventId: crypto.randomUUID() });
    const { error } = await admin
      .from("learning_events")
      .upsert([mapEventToColumns(event, learner.userId)], {
        onConflict: "client_event_id",
        ignoreDuplicates: true,
      });
    if (error) throw new Error(`emit ${input.eventType}: ${error.message}`);
  };

  await gradeQuiz("Scarcity", false);
  await gradeQuiz("Scarcity", false);
  await gradeQuiz("Supply and Demand", true);
  await gradeQuiz("Market Equilibrium", true);
  await emitEvidence({
    eventType: "hint_request",
    courseId,
    publicationId,
    version,
    lessonId: scarcityLesson.id,
    nodeId: scarcityNode.id,
    hintRung: 4,
    practiceItemRef: crypto.randomUUID(),
  });
  await emitEvidence({
    eventType: "self_report",
    courseId,
    publicationId,
    version,
    lessonId: scarcityLesson.id,
    nodeId: scarcityNode.id,
    evidenceCorrect: false,
  });
  console.log("# evidence: weak on Scarcity, strong on Supply & Demand + Market Equilibrium");

  // (e) Refold the learner's mastery inline (the deterministic engine — NO
  // Inngest, NO model). Materializes learner_mastery so the tutor's learner-state
  // read sees Scarcity below threshold before the first question.
  const nowIso = new Date().toISOString();
  const { rows } = await refoldLearnerCourse(admin, {
    userId: learner.userId,
    courseId,
    nowIso,
  });
  await writeMastery(admin, { userId: learner.userId, courseId, rows, nowIso });
  const scarcityRow = rows.find((r) => r.nodeId === scarcityNode.id);
  console.log(
    `# refolded ${rows.length} node(s); Scarcity decayed_p = ${scarcityRow?.decayedP.toFixed(3) ?? "n/a"}`
  );

  // Seed the review queue for Scarcity so the sidebar's suggestion dot lights up
  // and "What should I review next?" is grounded (service-role write; RLS ZERO
  // policies — admin bypasses).
  const queue = await (admin as unknown as {
    from: (t: string) => {
      upsert: (rows: unknown, opts: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
    };
  })
    .from("mastery_review_queue")
    .upsert(
      [
        {
          user_id: learner.userId,
          course_id: courseId,
          node_id: scarcityNode.id,
          rank: 1,
          score: 0.9,
          reason: { kind: "weak_prerequisite", of: equilibriumNode.id },
          computed_at: nowIso,
        },
      ],
      { onConflict: "user_id,course_id,node_id" }
    );
  if (queue.error) throw new Error(`review queue upsert: ${queue.error.message}`);

  const lessonToOpen = equilibriumLesson;
  const firstQuestion =
    "I don't get why the market settles at the equilibrium price — can you explain market equilibrium?";

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("  TUTOR-1 DEMO SEED — ready to click");
  console.log("────────────────────────────────────────────────────────────");
  console.log(`  Learner email     : ${learner.email}`);
  console.log(`  Learner password  : ${password}`);
  console.log("");
  console.log(`  Sign in           : /login`);
  console.log(`  Course URL        : /learn/${slug}`);
  console.log(`  Lesson to open    : "${lessonToOpen.title}"`);
  console.log(`                      /learn/${slug}/${lessonToOpen.id}`);
  console.log("");
  console.log("  Open the tutor (right-edge tab), then ask:");
  console.log(`    “${firstQuestion}”`);
  console.log("");
  console.log("  Expected: the tutor answers Market Equilibrium but INTERJECTS the");
  console.log("  root cause — this learner is shaky on its prerequisite, Scarcity —");
  console.log("  and points back there. The suggestion dot is lit and");
  console.log("  “What should I review next?” surfaces Scarcity.");
  console.log("────────────────────────────────────────────────────────────");
  console.log("\n# throwaway users + course remain (clean in Supabase → Auth)");

  console.log(
    JSON.stringify(
      {
        learnerEmail: learner.email,
        learnerPassword: password,
        slug,
        courseId,
        publicationId,
        version,
        lessonToOpenId: lessonToOpen.id,
        firstQuestion,
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
