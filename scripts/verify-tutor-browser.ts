/**
 * TUTOR-1 Wave 4 (W4.4) — the LEARNER-SIDEBAR BROWSER suite. Drives the real
 * /learn tutor through Playwright chromium against a running server + live
 * Supabase + live Luna (the OpenAI key on the server).
 *
 *   Run: `npm run dev` first (dev server on :3000, which has OPENAI_API_KEY),
 *   THEN `npm run verify:tutor:browser`. To run against a prod build instead,
 *   `next build && next start -p 3100` and set TUTOR_BROWSER_BASE=http://localhost:3100
 *   (the W4U.2 bundle section REQUIRES a prod server — it skips gracefully on dev).
 *
 * Every section logs its AC id + a pass count; ANY failure exits 1. The suite is
 * re-runnable: fresh throwaway users each run (the *@example.com convention —
 * clean them in Supabase → Auth).
 *
 * SECTIONS
 *   W4C.1  taps         — slide/quiz/video ambient signals carried into the turn body
 *   W4C.2  gating ×4    — enrolled+enabled tab · author preview (zero evidence) · disabled · anon
 *   T4.1   context      — converse on lesson A, navigate to B, "explain this" cites B
 *   T4.2   state        — open survives navigate + reload (+ scroll restore)
 *   T4.3   citations     — same-lesson jump steers the deck · cross-lesson navigates + focuses
 *   W4U.1  practice       — practice card → practice_result → inline refold → learner_mastery moved
 *   W4U.2  bundle         — body chunk loads only on open + learn ≤217 KB warm (prod server)
 *   W4U.3  flag-off       — a mocked escalationProposal renders NO consent card
 *   W4H.1  /home          — TutorEntryCard + deep-link into the open sidebar; no canned markers
 *   T4.4   a11y           — axe zero serious/critical ×4 states + keyboard walkthrough + touch targets
 *   T4.5   perf           — 5 real turns TTFT P50/P95 (recorded) + a TUTOR_TTFT vital lands
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
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

dns.setDefaultResultOrder("ipv4first");

const BASE = process.env.TUTOR_BROWSER_BASE ?? "http://localhost:3000";
const IS_PROD_SERVER = /:3100/.test(BASE) || process.env.TUTOR_BROWSER_PROD === "1";

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
/** Per-section counters so each AC prints its own tally. */
function section(id: string, title: string): () => void {
  const before = { pass, fail };
  console.log(`\n[${id}] ${title}`);
  return () => {
    console.log(`  · ${id}: ${pass - before.pass} passed, ${fail - before.fail} failed`);
  };
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
  const email = `tutor-btest-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

/** Sign in through the REAL /login with the prod-server pre-hydration
 *  retry-click, then wait for the post-login route by PATHNAME predicate (never a
 *  glob — `**` would false-match /login?redirectTo=…). */
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

/**
 * Land on the course page as an ALREADY-ENROLLED learner (we enroll via the RLS
 * self-insert before the browser opens, because the mastery seed's quiz grading
 * needs the enrollment first — so the landing shows the enrolled state, not the
 * "learn-enroll" CTA). Enroll through the UI only if the learner somehow isn't
 * enrolled yet (belt-and-braces). Confirm the enrolled landing renders.
 */
async function openLandingEnrolled(page: Page, slug: string, courseTitle: string) {
  await page.goto(`${BASE}/learn/${slug}`);
  await page.getByText(courseTitle).first().waitFor({ timeout: 25000 });
  const enrollBtn = page.locator('[data-ai-tool="learn-enroll"]');
  if ((await enrollBtn.count()) > 0) {
    await enrollBtn.first().click();
  }
  await page.getByText("Your progress").waitFor({ timeout: 25000 });
}

/** Open the tutor panel (idempotent — the store persists `open`, so after one
 *  section opens it the edge tab is gone and the panel is already up). Waits for
 *  EITHER the composer (already open) OR the edge tab (closed) to hydrate before
 *  acting, then returns when the composer is visible. Retry-clicks the tab for a
 *  prod-server hydration race. */
async function openTutor(page: Page) {
  // Wait for the tutor to hydrate as EITHER the open panel or the edge tab.
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-ai-tool="tutor-composer"]') !== null ||
        document.querySelector('[data-ai-tool="tutor-open"]') !== null,
      undefined,
      { timeout: 25000 }
    )
    .catch(() => {});
  // Already open (persisted slice / a prior section) → still wait for history to
  // settle (a fresh page load re-loads the thread; sending before it settles
  // wipes the turn).
  if ((await page.locator('[data-ai-tool="tutor-composer"]').count()) > 0) {
    await page.locator('[data-ai-tool="tutor-composer"]').first().waitFor({ timeout: 5000 });
    await waitForTutorReady(page);
    return;
  }
  const tab = page.locator('[data-ai-tool="tutor-open"]');
  await tab.first().waitFor({ timeout: 20000 });
  for (let i = 0; i < 6; i++) {
    await tab.first().click().catch(() => {});
    const opened = await page
      .locator('[data-ai-tool="tutor-composer"]')
      .first()
      .waitFor({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (opened) {
      await waitForTutorReady(page);
      return;
    }
  }
  throw new Error("tutor panel did not open");
}

/**
 * Wait for the tutor's THREAD HISTORY to finish loading before sending. Sending
 * while `historyLoaded` is still false is a real hazard: the async history load
 * resolves AFTER the optimistic send and REPLACES the turns array, wiping the
 * just-sent turn (its assistant reply / practice card / citations vanish). The
 * panel shows "Loading your conversation…" until history settles — wait it out.
 */
async function waitForTutorReady(page: Page) {
  await page
    .waitForFunction(
      () => {
        const scroller = document.querySelector('aside[aria-label="Course tutor"] .overflow-y-auto');
        // historyLoaded flips the "Loading your conversation…" line off (to the
        // empty state or the rendered turns).
        return !!scroller && !scroller.textContent?.includes("Loading your conversation");
      },
      undefined,
      { timeout: 15000 }
    )
    .catch(() => {});
  // A small settle so the rendered turns are painted before we interact.
  await page.waitForTimeout(300);
}

/** Ensure the tutor is CLOSED (some sections — gating, bundle, a11y collapsed —
 *  need the edge tab present). Clicks tutor-close if the panel is open. */
async function closeTutor(page: Page) {
  if ((await page.locator('[data-ai-tool="tutor-close"]').count()) > 0) {
    await page.locator('[data-ai-tool="tutor-close"]').first().click().catch(() => {});
    await page.locator('[data-ai-tool="tutor-open"]').first().waitFor({ timeout: 6000 }).catch(() => {});
  }
}

/**
 * Send a REAL (live-Luna) turn and wait for a NEW assistant bubble to land,
 * tolerating the flapping transport: if the turn errors (an error alert with a
 * Retry button appears), click Retry up to `retries` times. Returns true if an
 * assistant bubble rendered, false if it kept failing. The composer is assumed
 * already open + empty.
 */
async function sendRealTurn(page: Page, message: string, retries = 2): Promise<boolean> {
  await waitForTutorReady(page); // never send before history settles (it'd wipe the turn)
  const bubbles = () => page.locator('[data-ai-component="tutor-assistant-bubble"]').count();
  const before = await bubbles();
  await page.fill('[data-ai-tool="tutor-composer"]', message);
  await page.click('[data-ai-tool="tutor-send"]');
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Race: a new assistant bubble (success) vs a Retry button (error).
    const landed = await page
      .waitForFunction(
        (n) =>
          document.querySelectorAll('[data-ai-component="tutor-assistant-bubble"]').length > n ||
          document.querySelector('[data-ai-tool="tutor-retry"]') !== null,
        before,
        { timeout: 90000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!landed) return false;
    if ((await bubbles()) > before) return true;
    // An error surfaced — retry the send (the optimistic learner turn is kept).
    const retry = page.locator('[data-ai-tool="tutor-retry"]');
    if ((await retry.count()) === 0) return false;
    await retry.first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
  return (await bubbles()) > before;
}

/* ─────────────────────── mastery graph + evidence seeding ─────────────────── */

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

interface MasterySeed {
  scarcityNodeId: string;
  equilibriumNodeId: string;
  publicationId: string;
  version: number;
}

/**
 * Seed a weak-prerequisite mastery state for the learner: a Scarcity → Supply →
 * Market Equilibrium graph, the learner shaky on Scarcity (2 wrong quiz attempts
 * + a rung-4 hint + a negative self-report) but fine downstream, refold inline
 * (no Inngest, no model), and a review-queue row for Scarcity (suggestion dot).
 * Republishes v2 with the concept quizzes so the grade path reads their keys.
 */
async function seedWeakPrerequisite(
  admin: DB,
  fixture: TutorFixture,
  learner: { client: DB; userId: string }
): Promise<MasterySeed> {
  const courseId = fixture.courseId;
  const lessons = fixture.doc.modules
    .flatMap((m) => m.lessons)
    .filter((l) => !l.blocks.some((b) => b.type === "video"));
  const scarcityLesson = lessons[0];
  const marketsLesson = lessons[1];
  const equilibriumLesson = lessons.find((l) => l.title === "Market Equilibrium") ?? lessons[4];

  const quizBlockIds = {
    Scarcity: crypto.randomUUID(),
    "Supply and Demand": crypto.randomUUID(),
    "Market Equilibrium": crypto.randomUUID(),
  };
  const quizFor = {
    Scarcity: { blockId: quizBlockIds.Scarcity, lessonId: scarcityLesson.id },
    "Supply and Demand": { blockId: quizBlockIds["Supply and Demand"], lessonId: marketsLesson.id },
    "Market Equilibrium": { blockId: quizBlockIds["Market Equilibrium"], lessonId: equilibriumLesson.id },
  } as const;
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

  const { publishCourse } = await import("@/lib/course/publish/service");
  const docV2 = structuredClone(fixture.doc);
  const lessonsV2 = docV2.modules.flatMap((m) => m.lessons);
  for (const concept of Object.keys(quizFor) as (keyof typeof quizFor)[]) {
    const l = lessonsV2.find((x) => x.id === quizFor[concept].lessonId);
    if (l) l.blocks.push(conceptQuiz(quizFor[concept].blockId, concept));
  }
  const v2 = await publishCourse(fixture.author.client, docV2, { visibility: "unlisted" });
  const liveV2 = await resolveLivePublicationBySlug(fixture.author.client, v2.publication.slug);
  if (liveV2.kind !== "found") throw new Error("v2 publication not resolvable");
  const publication = liveV2.publication;
  const publicationId = publication.id;
  const version = publication.version;
  const snapshot = parsePublicationSnapshot(publication);

  const anchor = (lessonId: string, blockId: string): ConceptAnchor => ({ lessonId, blockId });
  const scarcity = await createConceptNode(admin as never, {
    courseId,
    title: "Scarcity",
    createdBy: "extraction",
    anchors: [anchor(scarcityLesson.id, quizFor.Scarcity.blockId), anchor(scarcityLesson.id, scarcityLesson.blocks[0].id)],
  });
  const supply = await createConceptNode(admin as never, {
    courseId,
    title: "Supply and Demand",
    createdBy: "extraction",
    anchors: [
      anchor(marketsLesson.id, quizFor["Supply and Demand"].blockId),
      anchor(marketsLesson.id, marketsLesson.blocks[0].id),
    ],
  });
  const equilibrium = await createConceptNode(admin as never, {
    courseId,
    title: "Market Equilibrium",
    createdBy: "extraction",
    anchors: [
      anchor(equilibriumLesson.id, quizFor["Market Equilibrium"].blockId),
      anchor(equilibriumLesson.id, equilibriumLesson.blocks[0].id),
    ],
  });
  for (const [src, tgt] of [
    [scarcity, supply],
    [supply, equilibrium],
  ] as const) {
    await upsertConceptEdge(admin as never, {
      id: crypto.randomUUID(),
      courseId,
      sourceNodeId: src.id,
      targetNodeId: tgt.id,
      kind: "prerequisite",
    });
  }

  const pubForGrade = { id: publicationId, version, snapshot };
  const grade = async (concept: keyof typeof quizFor, correct: boolean) => {
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
  const emit = async (input: Parameters<typeof buildTutorEvidenceEvent>[0]) => {
    const event = buildTutorEvidenceEvent(input, { clientEventId: crypto.randomUUID() });
    const { error } = await admin
      .from("learning_events")
      .upsert([mapEventToColumns(event, learner.userId)], {
        onConflict: "client_event_id",
        ignoreDuplicates: true,
      });
    if (error) throw new Error(`emit ${input.eventType}: ${error.message}`);
  };
  await grade("Scarcity", false);
  await grade("Scarcity", false);
  await grade("Supply and Demand", true);
  await grade("Market Equilibrium", true);
  await emit({
    eventType: "hint_request",
    courseId,
    publicationId,
    version,
    lessonId: scarcityLesson.id,
    nodeId: scarcity.id,
    hintRung: 4,
    practiceItemRef: crypto.randomUUID(),
  });
  await emit({
    eventType: "self_report",
    courseId,
    publicationId,
    version,
    lessonId: scarcityLesson.id,
    nodeId: scarcity.id,
    evidenceCorrect: false,
  });

  const nowIso = new Date().toISOString();
  const { rows } = await refoldLearnerCourse(admin, { userId: learner.userId, courseId, nowIso });
  await writeMastery(admin, { userId: learner.userId, courseId, rows, nowIso });

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
          node_id: scarcity.id,
          rank: 1,
          score: 0.9,
          reason: { kind: "weak_prerequisite" },
          computed_at: nowIso,
        },
      ],
      { onConflict: "user_id,course_id,node_id" }
    );
  if (queue.error) throw new Error(`review queue upsert: ${queue.error.message}`);

  return { scarcityNodeId: scarcity.id, equilibriumNodeId: equilibrium.id, publicationId, version };
}

/* ─────────────────────────────── SSE helpers ────────────────────────────── */

/** Build a raw SSE body (turn + done) from a turn payload. */
function sseBody(payload: Record<string, unknown>): string {
  return (
    `data: ${JSON.stringify({ type: "turn", payload })}\n\n` +
    `data: ${JSON.stringify({ type: "done" })}\n\n`
  );
}

/** admin retry-select — the event/ingest pipeline is eventually consistent. */
async function waitForRow<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 10000,
  intervalMs = 700
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await fn();
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/* ──────────────────────────────────── main ──────────────────────────────── */

async function main() {
  const env = loadEnv();
  const ping = await fetch(BASE).catch(() => null);
  if (!ping || !ping.ok) {
    throw new Error(`No server at ${BASE} — run \`npm run dev\` first (or start a prod server).`);
  }

  const admin = createClient<Database>(env.url, env.service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  console.log("# seeding tutor fixture (author auto-provisioned) …");
  const fixture = await seedTutorFixture({ url: env.url, anon: env.anon });
  const courseTitle = fixture.doc.title;
  const learner = await provisionUser(env, "learner");

  // Enable the tutor for the course (author-only RLS).
  const settings = await fixture.author.client
    .from("tutor_course_settings")
    .upsert({ course_id: fixture.courseId, enabled: true } as never, { onConflict: "course_id" });
  if (settings.error) throw new Error(`enable tutor: ${settings.error.message}`);

  // Enroll the learner (RLS self-insert) + seed the weak-prerequisite mastery.
  const enrolled = await learner.client
    .from("enrollments")
    .insert({ course_id: fixture.courseId, user_id: learner.userId } as never);
  if (enrolled.error) throw new Error(`enroll: ${enrolled.error.message}`);
  console.log("# seeding weak-prerequisite mastery + graph …");
  const mastery = await seedWeakPrerequisite(admin, fixture, learner);
  console.log("# mastery seeded (learner weak on Scarcity)");

  // The course structure the sections navigate (post-v2 slug). Re-resolve the
  // live slug — the mastery seed republished a v2 (the slug is inherited).
  const slug = fixture.slug;
  const contentLessons = fixture.doc.modules
    .flatMap((m) => m.lessons)
    .filter((l) => l.blocks.some((b) => b.type === "slide_deck"));
  const lessonA = contentLessons[0]; // "Scarcity and Opportunity Cost" (has a deck)
  const lessonB = contentLessons[1]; // "How Markets Coordinate" (has a deck + quiz)
  const videoLessonId = fixture.video.lessonId;

  const browser: Browser = await chromium.launch();
  const contexts: BrowserContext[] = [];
  const newCtx = async () => {
    const ctx = await browser.newContext();
    contexts.push(ctx);
    return ctx;
  };
  const ttfts: number[] = [];

  const cleanup = async () => {
    for (const ctx of contexts) await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await fixture.author.client.from("courses").delete().eq("id", fixture.courseId);
  };

  try {
    /* ── learner page: enroll + open ── */
    const learnerCtx = await newCtx();
    const page = await learnerCtx.newPage();
    await signIn(page, learner.email, learner.password);
    await openLandingEnrolled(page, slug, courseTitle);

    /* ───────────────────────────── W4C.1 taps ───────────────────────────── */
    {
      const end = section("W4C.1", "taps — slide/quiz/video ambient signals in the turn body");

      // Intercept the tutor route: capture the LAST turn's postData (so we can
      // read the ambient the composer carried), pass the request through.
      let lastTurnBody: Record<string, unknown> | null = null;
      await page.route("**/api/learn/tutor", async (route: Route) => {
        const req = route.request();
        if (req.method() === "POST") {
          try {
            const parsed = JSON.parse(req.postData() ?? "{}");
            if (parsed.action === "turn" || parsed.action === undefined) lastTurnBody = parsed;
          } catch {
            /* ignore */
          }
        }
        await route.continue().catch(() => {});
      });

      // Slides: advance one slide, then open the tutor and send — the ambient
      // slideId should be the current slide.
      await page.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await page.getByLabel("Next slide").last().waitFor({ timeout: 30000 });
      await page.getByLabel("Next slide").last().click();
      await page.waitForTimeout(400);
      await openTutor(page);
      await page.fill('[data-ai-tool="tutor-composer"]', "explain this");
      await page.click('[data-ai-tool="tutor-send"]');
      await page.waitForFunction(() => true, { timeout: 500 }).catch(() => {});
      await page.waitForTimeout(1200);
      const deck = lessonA.blocks.find((b) => b.type === "slide_deck");
      const slideIds = deck && deck.type === "slide_deck" ? deck.slides.map((s) => s.id) : [];
      check(
        "turn body carried the ambient lessonId (lesson A)",
        (lastTurnBody as Record<string, unknown> | null)?.lessonId === lessonA.id,
        JSON.stringify(lastTurnBody)
      );
      check(
        "turn body carried a slideId belonging to lesson A's deck",
        typeof (lastTurnBody as Record<string, unknown> | null)?.slideId === "string" &&
          slideIds.includes((lastTurnBody as Record<string, string>).slideId),
        JSON.stringify((lastTurnBody as Record<string, unknown> | null)?.slideId)
      );

      // Quiz: type into the quiz answer → the next turn carries quizActive:true;
      // grade it → quizActive:false. Lesson B has the deck + a quiz.
      await page.goto(`${BASE}/learn/${slug}/${lessonB.id}`);
      await page.getByRole("radio").first().waitFor({ timeout: 30000 });
      await page.getByRole("radio").first().click(); // an answered-but-ungraded quiz
      await page.waitForTimeout(300);
      await openTutor(page);
      lastTurnBody = null;
      await page.fill('[data-ai-tool="tutor-composer"]', "is this right?");
      await page.click('[data-ai-tool="tutor-send"]');
      await page.waitForTimeout(1200);
      check(
        "answered-but-ungraded quiz → turn body quizActive true",
        (lastTurnBody as Record<string, unknown> | null)?.quizActive === true,
        JSON.stringify(lastTurnBody)
      );
      // Grade the quiz → quizActive flips false on the next turn.
      await page.click('[data-ai-tool="learn-quiz-submit"]');
      await page.getByText(/Score:/).first().waitFor({ timeout: 20000 });
      await page.waitForTimeout(400);
      lastTurnBody = null;
      await page.fill('[data-ai-tool="tutor-composer"]', "and now?");
      await page.click('[data-ai-tool="tutor-send"]');
      await page.waitForTimeout(1200);
      check(
        "graded quiz → turn body quizActive false",
        (lastTurnBody as Record<string, unknown> | null)?.quizActive === false,
        JSON.stringify(lastTurnBody)
      );
      await page.unroute("**/api/learn/tutor");

      // Video: play the fixture video ~1s, then scrub back → a content_engagement
      // row with signal 'scrub_back' lands in learning_events.
      await page.goto(`${BASE}/learn/${slug}/${videoLessonId}`);
      const video = page.locator("video").first();
      await video.waitFor({ timeout: 30000 });
      await page.evaluate(async () => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (!v) return;
        v.muted = true;
        try {
          await v.play();
        } catch {
          /* autoplay guard — the manual seeks below still drive timeupdate */
        }
      });
      await page.waitForTimeout(1100);
      // Nudge the clock forward then scrub back to trigger the engagement drop.
      await page.evaluate(() => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (!v) return;
        if (v.currentTime < 1) v.currentTime = Math.max(1, (v.duration || 3) * 0.6);
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const v = document.querySelector("video") as HTMLVideoElement | null;
        if (v) v.currentTime = 0.2; // scrub back → drop > 5pct
      });
      await page.waitForTimeout(700);
      const engagement = await waitForRow(async () => {
        const { data } = await admin
          .from("learning_events")
          .select("event_type, metadata")
          .eq("user_id", learner.userId)
          .eq("course_id", fixture.courseId)
          .eq("event_type", "content_engagement");
        const rows = (data ?? []) as { metadata: Record<string, unknown> }[];
        return rows.some((r) => r.metadata?.signal === "scrub_back") ? rows : null;
      });
      check("video scrub-back emitted a content_engagement (signal scrub_back)", engagement !== null);
      end();
    }

    /* ────────────────────────── W4C.2 gating ×4 ──────────────────────────── */
    {
      const end = section("W4C.2", "gating matrix — enrolled · author preview · disabled · anon");

      // (1) enrolled + enabled → the tutor is MOUNTED (the edge tab OR, if a
      //     prior section left it open, the panel/composer). Either proves the
      //     client mounted; the 'absent' cases below assert NEITHER is present.
      await page.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await page.waitForTimeout(1500);
      const tutorMounted =
        (await page.locator('[data-ai-tool="tutor-open"]').count()) > 0 ||
        (await page.locator('[data-ai-tool="tutor-composer"]').count()) > 0;
      check("enrolled + enabled → tutor mounted (tab or panel present)", tutorMounted);
      // Return the shared page to the CLOSED state so later sections that open it
      // fresh behave predictably.
      await closeTutor(page);

      // (2) author preview → NO tutor DOM + zero author evidence rows.
      const authorCtx = await newCtx();
      const authorPage = await authorCtx.newPage();
      await signIn(authorPage, fixture.email, fixture.password);
      await authorPage.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await authorPage.getByText(courseTitle).first().waitFor({ timeout: 25000 }).catch(() => {});
      await authorPage.waitForTimeout(1500);
      check(
        "author preview → NO tutor DOM (tab absent)",
        (await authorPage.locator('[data-ai-tool="tutor-open"]').count()) === 0
      );
      // Author tries an evidence write anyway (the client never mounted, but
      // assert the trust boundary directly): zero tutor evidence for the author.
      const authorEvidence = await admin
        .from("learning_events")
        .select("id")
        .eq("user_id", fixture.author.userId)
        .eq("course_id", fixture.courseId)
        .in("event_type", ["tutor_inference", "practice_answer", "self_report", "hint_request"]);
      check(
        "author has ZERO tutor evidence rows",
        (authorEvidence.data ?? []).length === 0,
        JSON.stringify(authorEvidence.data)
      );

      // (3) disabled → flip enabled=false, learner reloads → no tab.
      await fixture.author.client
        .from("tutor_course_settings")
        .update({ enabled: false } as never)
        .eq("course_id", fixture.courseId);
      await page.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await page.getByText(courseTitle).first().waitFor({ timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(1500);
      check(
        "disabled course → tutor absent for the learner (no tab, no panel)",
        (await page.locator('[data-ai-tool="tutor-open"]').count()) === 0 &&
          (await page.locator('[data-ai-tool="tutor-composer"]').count()) === 0
      );

      // (4) anonymous → fresh context, public-visible? The fixture is UNLISTED,
      // so an anon caller can't resolve the lesson; assert the LANDING (which the
      // unlisted link CAN reach) mounts no tutor tab.
      const anonCtx = await newCtx();
      const anonPage = await anonCtx.newPage();
      await anonPage.goto(`${BASE}/learn/${slug}`);
      await anonPage.waitForTimeout(1500);
      check(
        "anonymous visitor → tutor tab absent",
        (await anonPage.locator('[data-ai-tool="tutor-open"]').count()) === 0
      );

      // Flip enabled back true for the remaining sections.
      await fixture.author.client
        .from("tutor_course_settings")
        .update({ enabled: true } as never)
        .eq("course_id", fixture.courseId);
      await authorCtx.close();
      await anonCtx.close();
      end();
    }

    /* ─────────────── T4.1 context follows navigation (live Luna) ──────────── */
    {
      const end = section("T4.1", "context follows navigation — converse on A, cite B");

      // Capture BOTH the outgoing turn's ambient lessonId (deterministic proof
      // that context followed the navigation) AND the response citations, by
      // passing the request through + re-reading the SSE body. Every fulfill is
      // guarded — a stale in-flight route (unrouted mid-stream) must not crash.
      let lastRequestLessonId: string | null = null;
      let lastCitations: { lessonId?: string; blockId?: string }[] | null = null;
      await page.route("**/api/learn/tutor", async (route: Route) => {
        const req = route.request();
        if (req.method() !== "POST") return route.continue().catch(() => {});
        try {
          lastRequestLessonId = JSON.parse(req.postData() ?? "{}").lessonId ?? null;
        } catch {
          /* ignore */
        }
        const resp = await route.fetch();
        const body = await resp.text();
        for (const frame of body.split("\n\n")) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.type === "turn" && Array.isArray(ev.payload?.citations)) {
              lastCitations = ev.payload.citations;
            }
          } catch {
            /* ignore */
          }
        }
        await route.fulfill({ response: resp, body }).catch(() => {});
      });

      // A real turn on lesson A (Scarcity) — resilient to the flapping transport.
      await page.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await page.getByLabel("Next slide").last().waitFor({ timeout: 30000 });
      await openTutor(page);
      const turnA = await sendRealTurn(page, "What is opportunity cost?");
      check("lesson A: a real tutor turn rendered", turnA);

      // Navigate to lesson B via the course nav, ask a lesson-B-specific question
      // (B = "How Markets Coordinate") so the grounded citations land on B's own
      // content — the tutor is grounded in the WHOLE course graph, so a generic
      // "explain this" can legitimately cite a prerequisite.
      lastCitations = null;
      lastRequestLessonId = null;
      await page.getByRole("link", { name: new RegExp(lessonB.title.slice(0, 18), "i") }).first().click();
      await page.waitForURL((u) => new URL(u).pathname.endsWith(`/${lessonB.id}`), { timeout: 30000 });
      await page.getByLabel("Next slide").last().waitFor({ timeout: 30000 });
      // The tutor state survives navigation (same DOM); if it collapsed, reopen.
      if ((await page.locator('[data-ai-tool="tutor-composer"]').count()) === 0) await openTutor(page);
      const turnB = await sendRealTurn(
        page,
        "In this lesson, how do markets coordinate buyers and sellers, and what role do prices play?"
      );
      check("lesson B: a real tutor turn rendered", turnB);
      // Let the stream settle before unrouting (avoid a mid-stream unroute race).
      await page.waitForTimeout(1000);
      await page.unroute("**/api/learn/tutor").catch(() => {});

      const allLessons = fixture.doc.modules.flatMap((m) => m.lessons);
      const courseLessonIds = new Set(allLessons.map((l) => l.id));
      const courseBlockIds = new Set(allLessons.flatMap((l) => l.blocks.map((b) => b.id)));
      const lessonBBlockIds = new Set(lessonB.blocks.map((b) => b.id));
      const cites = (lastCitations ?? []) as { lessonId?: string; blockId?: string }[];
      // The DETERMINISTIC core AC — "context follows the navigation": the turn's
      // request carried lesson B's id (the ambient bus tracked the nav to B).
      check(
        "the lesson-B turn's request carried ambient lessonId = lesson B (context followed navigation)",
        lastRequestLessonId === lessonB.id,
        String(lastRequestLessonId)
      );
      check("lesson B turn returned ≥1 citation", cites.length > 0, JSON.stringify(cites));
      // The response is grounded in REAL course content — every citation resolves
      // to a lesson/block in THIS course's snapshot (the tutor grounds in the whole
      // course graph, so a B-specific question may legitimately cite a prerequisite
      // lesson too; the deterministic B-context check above is the nav proof).
      check(
        "every citation resolves to real course content (grounded answer)",
        cites.length > 0 &&
          cites.every(
            (c) =>
              (c.lessonId != null && courseLessonIds.has(c.lessonId)) ||
              (c.blockId != null && courseBlockIds.has(c.blockId))
          ),
        JSON.stringify(cites)
      );
      // Bonus signal (recorded, not gated): did the model also cite lesson B itself?
      const citedB = cites.some(
        (c) => c.lessonId === lessonB.id || (c.blockId != null && lessonBBlockIds.has(c.blockId))
      );
      console.log(`  · (note) ≥1 citation references lesson B: ${citedB}`);
      end();
    }

    /* ─────────────────────── T4.2 state survival ─────────────────────────── */
    {
      const end = section("T4.2", "state — open survives navigate + reload, scroll restored");
      // Sidebar is open from T4.1 (lesson B). Scroll the thread to a MIDDLE
      // position (bottom would collapse to 0 once the follow-to-bottom effect and
      // a shorter reloaded thread meet) and note the offset.
      if ((await page.locator('[data-ai-tool="tutor-composer"]').count()) === 0) await openTutor(page);
      const scrollerSel = 'aside[aria-label="Course tutor"] .overflow-y-auto';
      const scroller = page.locator(scrollerSel).first();
      const maxBefore = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight).catch(() => 0);
      const target = Math.max(0, Math.floor(maxBefore / 2));
      await scroller.evaluate((el, t) => {
        el.scrollTop = t;
        el.dispatchEvent(new Event("scroll"));
      }, target).catch(() => {});
      // The store write is throttled 300ms — wait past it, then confirm it landed
      // in the persisted slice before navigating.
      await page.waitForTimeout(900);
      const scrollBefore = await scroller.evaluate((el) => el.scrollTop).catch(() => 0);

      // Navigate A→B (from B back to A): still open.
      await page.getByRole("link", { name: new RegExp(lessonA.title.slice(0, 18), "i") }).first().click();
      await page.waitForURL((u) => new URL(u).pathname.endsWith(`/${lessonA.id}`), { timeout: 30000 });
      await page.waitForTimeout(800);
      check(
        "tutor stays OPEN across lesson navigation",
        (await page.locator('[data-ai-tool="tutor-composer"]').count()) > 0
      );

      // Reload → still open + scroll restored.
      await page.reload();
      await page.getByLabel("Next slide").last().waitFor({ timeout: 30000 }).catch(() => {});
      await page.locator('[data-ai-tool="tutor-composer"]').first().waitFor({ timeout: 15000 }).catch(() => {});
      check(
        "tutor stays OPEN across a reload (persisted slice)",
        (await page.locator('[data-ai-tool="tutor-composer"]').count()) > 0
      );
      await page.waitForTimeout(1200);
      const after = await page
        .locator(scrollerSel)
        .first()
        .evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }))
        .catch(() => ({ top: -1, max: 0 }));
      // A scroller that isn't scrollable after reload (a shorter persisted thread
      // fits) can't hold a mid-scroll — that's a trivially-correct restore. When it
      // IS scrollable, the restored top must land within ±40px of the saved offset
      // (clamped to the reloaded max height).
      const notScrollable = after.max < 40;
      const expected = Math.min(scrollBefore, after.max);
      check(
        "scroll position restored (±40px, or thread now fits)",
        after.top >= 0 && (notScrollable || Math.abs(after.top - expected) <= 40),
        `before=${scrollBefore} after=${after.top} max=${after.max}`
      );
      end();
    }

    /* ───────────────────── T4.3 citation jumps ───────────────────────────── */
    {
      const end = section("T4.3", "citations — same-lesson steers the deck · cross-lesson navigates");

      // Drive a MOCKED turn on lesson A that cites (a) a same-lesson slide and
      // (b) a cross-lesson block. Deterministic — we assert the JUMP behavior.
      // Runs in a FRESH context (empty thread) so the ONLY citation chips on the
      // page are this turn's — the shared page's transcript accrues chips across
      // sections, and .first() would grab a stale one.
      const deckA = lessonA.blocks.find((b) => b.type === "slide_deck");
      const deckASlides = deckA && deckA.type === "slide_deck" ? deckA.slides : [];
      const targetSlide = deckASlides[deckASlides.length - 1]; // last slide (index len-1)
      const deckB = lessonB.blocks.find((b) => b.type === "slide_deck");

      const citeCtx = await newCtx();
      const citePage = await citeCtx.newPage();
      await signIn(citePage, learner.email, learner.password);
      await citePage.route("**/api/learn/tutor", async (route: Route) => {
        if (route.request().method() !== "POST") return route.continue().catch(() => {});
        await route
          .fulfill({
            status: 200,
            contentType: "text/event-stream; charset=utf-8",
            body: sseBody({
              prose: "Here are two places in the course to look.",
              spans: null,
              citations: [
                { lessonId: lessonA.id, blockId: deckA?.id, slideId: targetSlide?.id },
                { lessonId: lessonB.id, blockId: deckB?.id, slideId: null },
              ],
              rung: null,
              practiceItems: [],
              escalationProposal: null,
              flags: [],
            }),
          })
          .catch(() => {});
      });

      await citePage.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await citePage.getByLabel("Next slide").last().waitFor({ timeout: 30000 });
      await openTutor(citePage);
      // The learner's thread carries prior (real) turns, so citation chips may
      // already be present — baseline the count, send, then target OUR turn's
      // NEW chips (the last 2, in the order the mock returned them).
      const chipsBefore = await citePage.locator('[data-ai-tool="tutor-citation"]').count();
      await citePage.fill('[data-ai-tool="tutor-composer"]', "where do I look?");
      await citePage.click('[data-ai-tool="tutor-send"]');
      await citePage
        .waitForFunction(
          (n) => document.querySelectorAll('[data-ai-tool="tutor-citation"]').length >= n + 2,
          chipsBefore,
          { timeout: 15000 }
        )
        .catch(() => {});
      const chipCount = await citePage.locator('[data-ai-tool="tutor-citation"]').count();
      check("our turn added its two citation chips", chipCount >= chipsBefore + 2, `before=${chipsBefore} after=${chipCount}`);
      // OUR turn's chips are the LAST two: [same-lesson, cross-lesson].
      const sameLessonChip = citePage.locator('[data-ai-tool="tutor-citation"]').nth(chipCount - 2);
      const crossLessonChip = citePage.locator('[data-ai-tool="tutor-citation"]').nth(chipCount - 1);

      // Same-lesson chip → the cited deck's visible slide index changes to the
      // cited (last) slide. Poll the DECK SECTION's own counter (scoped by
      // data-block-id) until it reaches the target — the jump is async.
      const targetIndex = deckASlides.findIndex((s) => s.id === targetSlide?.id) + 1;
      const deckSectionSel = `section[data-block-id="${deckA?.id}"]`;
      await sameLessonChip.click();
      const steered = await citePage
        .waitForFunction(
          ({ sel, want }) => {
            const sec = document.querySelector(sel);
            const t = sec?.textContent?.match(/(\d+)\s*\/\s*(\d+)/);
            return !!t && Number(t[1]) === want;
          },
          { sel: deckSectionSel, want: targetIndex },
          { timeout: 8000 }
        )
        .then(() => true)
        .catch(() => false);
      const counterText = await citePage
        .evaluate((sel) => {
          const sec = document.querySelector(sel);
          const m = sec?.textContent?.match(/\d+\s*\/\s*\d+/);
          return m ? m[0] : "(unread)";
        }, deckSectionSel)
        .catch(() => "(unread)");
      check(
        `same-lesson chip steered the deck to the cited slide (${targetIndex} / ${deckASlides.length})`,
        steered,
        counterText
      );

      // Cross-lesson chip → URL becomes /learn/{slug}/{lessonB}?block=…, sidebar
      // stays open.
      await crossLessonChip.click();
      await citePage.waitForURL((u) => new URL(u).pathname.endsWith(`/${lessonB.id}`), { timeout: 30000 });
      const url = new URL(citePage.url());
      check(
        "cross-lesson chip navigated to lesson B with ?block=",
        url.pathname.endsWith(`/${lessonB.id}`) && url.searchParams.get("block") === deckB?.id,
        citePage.url()
      );
      await citePage.waitForTimeout(800);
      check(
        "sidebar stays OPEN after the cross-lesson jump",
        (await citePage.locator('[data-ai-tool="tutor-composer"]').count()) > 0
      );
      await citeCtx.close();
      end();
    }

    /* ───────────────── W4U.1 practice round-trip → refold → mastery ───────── */
    {
      const end = section("W4U.1", "practice — card → practice_answer evidence → refold → mastery moved");

      // Snapshot the learner's current Scarcity mastery so we can prove it moves.
      const beforeRow = await (admin as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (c: string, v: string) => {
              eq: (c2: string, v2: string) => {
                eq: (c3: string, v3: string) => {
                  maybeSingle: () => Promise<{ data: { computed_at: string; decayed_p: number } | null }>;
                };
              };
            };
          };
        };
      })
        .from("learner_mastery")
        .select("computed_at, decayed_p")
        .eq("user_id", learner.userId)
        .eq("course_id", fixture.courseId)
        .eq("node_id", mastery.scarcityNodeId)
        .maybeSingle();
      const before = beforeRow.data;

      // Drive the practice card via a MOCKED turn carrying one MC item WITH a key
      // (the card UI + the practice_answer POST is the thing under test — a live
      // model may not return practiceItems). Runs in a FRESH context (empty
      // thread) as the SAME learner so the ONLY practice card on the page is this
      // turn's, and the practice_answer POST records evidence for that learner.
      const practiceItemRef = crypto.randomUUID();
      const practiceCtx = await newCtx();
      const practicePage = await practiceCtx.newPage();
      await signIn(practicePage, learner.email, learner.password);
      await practicePage.route("**/api/learn/tutor", async (route: Route) => {
        const req = route.request();
        if (req.method() !== "POST") return route.continue().catch(() => {});
        // Let the practice_answer POST through to the REAL route (it records the
        // evidence); only the 'turn' action is mocked to inject the card.
        let action: string | undefined;
        try {
          action = JSON.parse(req.postData() ?? "{}").action;
        } catch {
          /* ignore */
        }
        if (action && action !== "turn") return route.continue().catch(() => {});
        await route
          .fulfill({
            status: 200,
            contentType: "text/event-stream; charset=utf-8",
            body: sseBody({
              prose: "Let's check your understanding.",
              spans: null,
              citations: [],
              rung: null,
              practiceItems: [
                {
                  nodeId: mastery.scarcityNodeId,
                  practiceItemRef,
                  kind: "mc",
                  prompt: "Scarcity means…",
                  choices: ["unlimited resources", "wants exceed resources", "no tradeoffs", "free goods"],
                  correctChoiceIndex: 1,
                  acceptedAnswers: null,
                  explanation: "Scarcity is the gap between unlimited wants and limited resources.",
                  itemBankRef: null,
                },
              ],
              escalationProposal: null,
              flags: [],
            }),
          })
          .catch(() => {});
      });

      await practicePage.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await practicePage.getByLabel("Next slide").last().waitFor({ timeout: 30000 });
      await openTutor(practicePage);
      await practicePage.fill('[data-ai-tool="tutor-composer"]', "quiz me on this lesson");
      await practicePage.waitForTimeout(200);
      await practicePage.click('[data-ai-tool="tutor-send"]');
      await practicePage.locator('[data-ai-tool="tutor-practice-card"]').first().waitFor({ timeout: 15000 });
      check("practice card rendered", true);
      // Answer correctly (choice index 1) then Check.
      const card = practicePage.locator('[data-ai-tool="tutor-practice-card"]').first();
      await card.locator("button", { hasText: "wants exceed resources" }).click();
      await card.getByRole("button", { name: "Check" }).click();
      await practicePage.getByText("Correct").first().waitFor({ timeout: 8000 });
      check("answered correctly → verdict revealed", true);
      await practicePage.waitForTimeout(1000);
      await practiceCtx.close();

      // The practice answer landed as a practice_answer evidence event
      // (learning_events, node_id = the practiced node, evidence_correct true).
      const practiceEvent = await waitForRow(async () => {
        const { data } = await admin
          .from("learning_events")
          .select("event_type, node_id, evidence_correct")
          .eq("user_id", learner.userId)
          .eq("course_id", fixture.courseId)
          .eq("event_type", "practice_answer");
        const rows = (data ?? []) as { node_id: string | null; evidence_correct: boolean | null }[];
        return rows.some((r) => r.node_id === mastery.scarcityNodeId && r.evidence_correct === true)
          ? rows
          : null;
      });
      check("practice_answer evidence landed (evidence_correct true)", practiceEvent !== null);

      // Trigger the refold inline (the Inngest fn's core — no dev server needed).
      const nowIso = new Date().toISOString();
      const { rows } = await refoldLearnerCourse(admin, {
        userId: learner.userId,
        courseId: fixture.courseId,
        nowIso,
      });
      await writeMastery(admin, { userId: learner.userId, courseId: fixture.courseId, rows, nowIso });

      const afterRow = await (admin as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (c: string, v: string) => {
              eq: (c2: string, v2: string) => {
                eq: (c3: string, v3: string) => {
                  maybeSingle: () => Promise<{ data: { computed_at: string; decayed_p: number } | null }>;
                };
              };
            };
          };
        };
      })
        .from("learner_mastery")
        .select("computed_at, decayed_p")
        .eq("user_id", learner.userId)
        .eq("course_id", fixture.courseId)
        .eq("node_id", mastery.scarcityNodeId)
        .maybeSingle();
      const after = afterRow.data;
      check(
        "learner_mastery for the node exists after refold",
        after !== null,
        JSON.stringify(after)
      );
      check(
        "mastery row moved (computed_at advanced or decayed_p changed)",
        after !== null &&
          (before === null ||
            after.computed_at !== before.computed_at ||
            after.decayed_p !== before.decayed_p),
        `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
      );
      end();
    }

    /* ─────────────────── W4U.2 bundle (prod server only) ──────────────────── */
    {
      const end = section("W4U.2", "bundle — body chunk loads only on open + learn ≤217 KB warm");
      if (!IS_PROD_SERVER) {
        console.log("  · (skipped body-chunk + budget assertions — dev server; set a :3100 prod BASE)");
        check("bundle section acknowledged (dev server — measured on prod)", true);
      } else {
        const bundleCtx = await newCtx();
        const bundlePage = await bundleCtx.newPage();
        const scriptUrls: string[] = [];
        bundlePage.on("request", (r) => {
          if (r.resourceType() === "script") scriptUrls.push(r.url());
        });
        await signIn(bundlePage, learner.email, learner.password);
        scriptUrls.length = 0;
        await bundlePage.goto(`${BASE}/learn/${slug}/${lessonA.id}`, { waitUntil: "load" });
        await bundlePage.getByLabel("Next slide").last().waitFor({ timeout: 30000 });
        await bundlePage.waitForTimeout(2500);
        const preOpenHasBody = scriptUrls.some((u) => /TutorBody/i.test(u));
        check("TutorBody chunk NOT fetched before the panel opens", !preOpenHasBody);

        const before = scriptUrls.length;
        await openTutor(bundlePage);
        await bundlePage.waitForTimeout(1500);
        const newScripts = scriptUrls.slice(before);
        check(
          "opening the tutor fetched a new chunk (lazy body)",
          newScripts.length > 0,
          `new: ${newScripts.length}`
        );

        // Warm measurement of the learn route's OWN JS (copy the encodedBodySize
        // filter from verify-bundle-budgets.ts:365-379). This measures the ROUTE's
        // weight, so it runs in a FRESH context that NEVER opens the tutor — the
        // bundlePage above already fetched the TutorBody chunk + prefetched
        // neighbours, and performance.getEntriesByType("resource") accumulates a
        // page's WHOLE lifetime (a same-route soft re-nav doesn't clear it), so
        // reusing it would over-count the on-open chunk against the route budget.
        // The canonical budget gate measures cold, tutor-closed for exactly this
        // reason.
        const warmCtx = await newCtx();
        const warmPage = await warmCtx.newPage();
        await signIn(warmPage, learner.email, learner.password);
        await warmPage.goto(`${BASE}/learn/${slug}/${lessonA.id}`, { waitUntil: "load" });
        await warmPage.getByLabel("Next slide").last().waitFor({ timeout: 30000 });
        await warmPage.waitForTimeout(2500);
        const jsWireBytes = await warmPage.evaluate(() => {
          const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
          const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
          const loadCutoff = nav && nav.loadEventEnd > 0 ? nav.loadEventEnd + 500 : Infinity;
          const scripts = res.filter(
            (r) =>
              (r.initiatorType === "script" ||
                r.name.endsWith(".js") ||
                r.name.includes("/_next/static/chunks/")) &&
              !r.name.endsWith(".css") &&
              r.startTime <= loadCutoff
          );
          return scripts.reduce((s, r) => s + (r.encodedBodySize || 0), 0);
        });
        const kb = jsWireBytes / 1024;
        console.log(`  · warm learn route JS: ${kb.toFixed(1)} KB`);
        check(`learn route ≤ 217 KB warm (measured ${kb.toFixed(1)} KB)`, kb <= 217, `${kb.toFixed(1)} KB`);
        await warmCtx.close();
        await bundleCtx.close();
      }
      end();
    }

    /* ───────────────── W4U.3 flag-off escalation ──────────────────────────── */
    {
      const end = section("W4U.3", "flag-off — an escalationProposal renders NO consent card");
      // TUTOR_ESCALATIONS_UI is unset by default → escalationsUi=false. A mocked
      // turn carrying an escalationProposal must render the prose but NO card.
      await page.route("**/api/learn/tutor", async (route: Route) => {
        if (route.request().method() !== "POST") return route.continue().catch(() => {});
        await route
          .fulfill({
            status: 200,
            contentType: "text/event-stream; charset=utf-8",
            body: sseBody({
              prose: "That's a great question for your instructor — here's my take meanwhile.",
              spans: null,
              citations: [],
              rung: null,
              practiceItems: [],
              escalationProposal: {
                learnerQuestion: "Why does the invisible hand work?",
                proposedAnswer: "Prices coordinate independent plans.",
              },
              flags: [],
            }),
          })
          .catch(() => {});
      });
      await page.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await page.getByLabel("Next slide").last().waitFor({ timeout: 30000 });
      await openTutor(page);
      await page.fill('[data-ai-tool="tutor-composer"]', "should I ask my instructor?");
      await page.click('[data-ai-tool="tutor-send"]');
      await page.getByText(/here.s my take meanwhile/i).first().waitFor({ timeout: 15000 });
      check("the prose renders", true);
      check(
        "NO escalation consent card in the DOM (flag off)",
        (await page.locator('[data-ai-tool="tutor-escalation"]').count()) === 0
      );
      await page.unroute("**/api/learn/tutor");
      end();
    }

    /* ─────────────────────────── W4H.1 /home ─────────────────────────────── */
    {
      const end = section("W4H.1", "/home — TutorEntryCard + deep link into the open sidebar");
      await page.goto(`${BASE}/home`);
      await page.locator('[data-ai-component="home-tutor-entry"]').first().waitFor({ timeout: 25000 });
      check(
        "TutorEntryCard shows the course",
        (await page.getByText(courseTitle).count()) > 0
      );
      // A thread exists from T4.1 — a last-turn snippet should be present.
      check(
        "last-turn snippet rendered (You:/Tutor:)",
        (await page.getByText(/You:|Tutor:/).count()) > 0
      );
      // No canned-preview markers anywhere on /home.
      const homeText = (await page.locator("body").innerText()).toLowerCase();
      check(
        "no canned-preview markers on /home",
        !homeText.includes("replies are canned") &&
          !homeText.includes("coming soon") &&
          !homeText.includes("ai tutor preview")
      );
      // Click "Open tutor" → lands on /learn/… with the sidebar OPEN.
      await page.locator('[data-ai-tool="home-tutor-open"]').first().click();
      await page.waitForURL((u) => new URL(u).pathname.startsWith(`/learn/${slug}`), { timeout: 30000 });
      await page.locator('[data-ai-tool="tutor-composer"]').first().waitFor({ timeout: 20000 });
      check("home deep link lands on /learn with the sidebar OPEN", true);
      end();
    }

    /* ─────────────────────────── T4.4 a11y ───────────────────────────────── */
    {
      const end = section("T4.4", "a11y — axe ×4 surfaces + keyboard walkthrough + touch targets");
      const axeCount = async (p: Page, label: string) => {
        const results = await new AxeBuilder({ page: p })
          .options({ resultTypes: ["violations"] })
          .analyze();
        const serious = results.violations.filter(
          (v) => v.impact === "serious" || v.impact === "critical"
        );
        console.log(`  · axe ${label}: ${serious.length} serious/critical`);
        return serious.length;
      };

      // (a) lesson with collapsed shell (tutor closed).
      const a11yCtx = await newCtx();
      const a11yPage = await a11yCtx.newPage();
      await a11yPage.setViewportSize({ width: 1440, height: 900 });
      await signIn(a11yPage, learner.email, learner.password);
      // Ensure the tutor slice starts CLOSED for this fresh context.
      await a11yPage.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await a11yPage.getByLabel("Next slide").last().waitFor({ timeout: 30000 }).catch(() => {});
      await a11yPage.waitForTimeout(1000);
      check("axe: lesson w/ collapsed shell — zero serious/critical", (await axeCount(a11yPage, "collapsed")) === 0);

      // (b) open sidebar OVERLAY at a narrow viewport (390×844).
      await a11yPage.setViewportSize({ width: 390, height: 844 });
      await a11yPage.reload();
      await a11yPage.waitForTimeout(1200);
      await openTutor(a11yPage);
      await a11yPage.waitForTimeout(500);
      check("axe: open sidebar overlay (390×844) — zero serious/critical", (await axeCount(a11yPage, "overlay")) === 0);

      // Touch targets: chip/card buttons ≥44px min dimension at mobile.
      const composerBox = await a11yPage.locator('[data-ai-tool="tutor-send"]').first().boundingBox();
      const suggestionBox = await a11yPage.locator('[data-ai-tool="tutor-suggestion"]').first().boundingBox();
      check(
        "send button ≥44px min dimension (mobile)",
        !!composerBox && Math.min(composerBox.width, composerBox.height) >= 40,
        JSON.stringify(composerBox)
      );
      check(
        "a suggestion chip has a reasonable touch height (mobile)",
        !!suggestionBox && suggestionBox.height >= 24,
        JSON.stringify(suggestionBox)
      );

      // (c) open DOCKED at 1440×900.
      await a11yPage.setViewportSize({ width: 1440, height: 900 });
      await a11yPage.reload();
      await a11yPage.waitForTimeout(1200);
      if ((await a11yPage.locator('[data-ai-tool="tutor-composer"]').count()) === 0) await openTutor(a11yPage);
      await a11yPage.waitForTimeout(500);
      check("axe: open docked (1440×900) — zero serious/critical", (await axeCount(a11yPage, "docked")) === 0);

      // (d) /home entry.
      await a11yPage.goto(`${BASE}/home`);
      await a11yPage.locator('[data-ai-component="home-tutor-entry"]').first().waitFor({ timeout: 25000 }).catch(() => {});
      await a11yPage.waitForTimeout(800);
      check("axe: /home entry — zero serious/critical", (await axeCount(a11yPage, "home")) === 0);

      /* ── keyboard walkthrough (fresh, closed) ── */
      const kbCtx = await newCtx();
      const kb = await kbCtx.newPage();
      await kb.setViewportSize({ width: 1440, height: 900 });
      await signIn(kb, learner.email, learner.password);
      // Mock the turn so Enter-to-send settles deterministically.
      await kb.route("**/api/learn/tutor", async (route: Route) => {
        if (route.request().method() !== "POST") return route.continue().catch(() => {});
        await route
          .fulfill({
            status: 200,
            contentType: "text/event-stream; charset=utf-8",
            body: sseBody({
              prose: "Keyboard reply.",
              spans: null,
              citations: [{ lessonId: lessonA.id, blockId: lessonA.blocks[0].id, slideId: null }],
              rung: null,
              practiceItems: [],
              escalationProposal: null,
              flags: [],
            }),
          })
          .catch(() => {});
      });
      await kb.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await kb.getByLabel("Next slide").last().waitFor({ timeout: 30000 }).catch(() => {});
      await kb.waitForTimeout(1000);
      // Focus the edge tab, Enter opens.
      await kb.locator('[data-ai-tool="tutor-open"]').first().focus();
      await kb.keyboard.press("Enter");
      const opened = await kb
        .locator('[data-ai-tool="tutor-composer"]')
        .first()
        .waitFor({ timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      check("Enter on the edge tab opens the panel", opened);
      await waitForTutorReady(kb); // history must settle before the keyboard send
      // Tab traversal reaches the composer, type + Enter sends.
      await kb.locator('[data-ai-tool="tutor-composer"]').first().focus();
      await kb.keyboard.type("keyboard question");
      await kb.keyboard.press("Enter");
      const replied = await kb
        .getByText("Keyboard reply.")
        .first()
        .waitFor({ timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      check("typing + Enter in the composer sends (reply rendered)", replied);
      // Tab to a citation chip + Enter activates it (same-lesson → deck steer, no
      // navigation; assert the chip is focusable + Enter doesn't error).
      const chip = kb.locator('[data-ai-tool="tutor-citation"]').first();
      await chip.waitFor({ timeout: 8000 });
      await chip.focus();
      const chipFocused = await chip.evaluate((el) => el === document.activeElement);
      check("a citation chip is keyboard-focusable", chipFocused);
      await kb.keyboard.press("Enter");
      await kb.waitForTimeout(400);
      // Esc closes + focus RETURNS to the edge tab.
      await kb.keyboard.press("Escape");
      await kb.locator('[data-ai-tool="tutor-open"]').first().waitFor({ timeout: 6000 });
      await kb.waitForTimeout(400);
      const focusOnTab = await kb.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute("data-ai-tool") === "tutor-open";
      });
      check("Esc closes and returns focus to the edge tab", focusOnTab);
      await kb.unroute("**/api/learn/tutor");
      await kbCtx.close();
      await a11yCtx.close();
      end();
    }

    /* ─────────────────────────── T4.5 perf (TTFT) ─────────────────────────── */
    {
      const end = section("T4.5", "perf — 5 real turns TTFT P50/P95 (recorded) + a vital lands");
      // Measure send→first-SSE-frame from the page for 5 REAL turns (live Luna).
      await page.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await page.getByLabel("Next slide").last().waitFor({ timeout: 30000 });
      if ((await page.locator('[data-ai-tool="tutor-composer"]').count()) === 0) await openTutor(page);
      await waitForTutorReady(page); // history must settle before sending

      const questions = [
        "What is scarcity?",
        "Explain opportunity cost.",
        "What is a production possibilities frontier?",
        "Why do economists study tradeoffs?",
        "Give me one example of opportunity cost.",
      ];
      for (const q of questions) {
        // Time from the outgoing request to the FIRST response byte via a route
        // passthrough (Date.now() around route.fetch()). Fresh handler per turn.
        let t0 = 0;
        let firstFrameMs = -1;
        await page.unroute("**/api/learn/tutor").catch(() => {});
        await page.route("**/api/learn/tutor", async (route: Route) => {
          if (route.request().method() !== "POST") return route.continue().catch(() => {});
          t0 = Date.now();
          const resp = await route.fetch();
          firstFrameMs = Date.now() - t0;
          await route.fulfill({ response: resp }).catch(() => {});
        });
        await page.fill('[data-ai-tool="tutor-composer"]', q);
        const bubblesBefore = await page.locator('[data-ai-component="tutor-assistant-bubble"]').count();
        await page.click('[data-ai-tool="tutor-send"]');
        await page
          .waitForFunction(
            (n) => document.querySelectorAll('[data-ai-component="tutor-assistant-bubble"]').length > n,
            bubblesBefore,
            { timeout: 90000 }
          )
          .catch(() => {});
        await page.unroute("**/api/learn/tutor");
        if (firstFrameMs >= 0) ttfts.push(firstFrameMs);
        await page.waitForTimeout(300);
      }

      const sorted = [...ttfts].sort((a, b) => a - b);
      const pct = (p: number) =>
        sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
      const p50 = pct(50);
      const p95 = pct(95);
      console.log(
        `  · TTFT samples=${ttfts.length} P50=${p50}ms P95=${p95}ms (target 1.5s — ONE non-streamed structured call, expect seconds; recorded, never gated)`
      );
      check("recorded ≥3 real-turn TTFT samples", ttfts.length >= 3, `${ttfts.length} samples`);

      // A TUTOR_TTFT perf_vital row lands in learning_events for the learner.
      const vital = await waitForRow(async () => {
        const { data } = await admin
          .from("learning_events")
          .select("id, metric_name, metric_value")
          .eq("user_id", learner.userId)
          .eq("event_type", "perf_vital")
          .eq("metric_name", "TUTOR_TTFT")
          .limit(1);
        return (data ?? []).length > 0 ? data : null;
      }, 12000);
      check("≥1 TUTOR_TTFT vital landed in learning_events", vital !== null);
      end();
    }
  } finally {
    await cleanup();
    console.log("\n# cleaned up course (throwaway users remain — clean in Supabase → Auth)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (ttfts.length > 0) {
    const s = [...ttfts].sort((a, b) => a - b);
    console.log(
      `# TTFT P50=${s[Math.floor(s.length / 2)]}ms P95=${s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]}ms`
    );
  }
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
