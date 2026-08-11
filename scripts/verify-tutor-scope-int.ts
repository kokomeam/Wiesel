/**
 * TUTOR-1 — Amendment A4, Wave 3 · scope-policy INTEGRATION suite.
 * Live Supabase + the deterministic mock model (no key). Self-provisions users.
 *
 * Proves the scope policy end-to-end over REAL data: eligibility from real
 * learn_progress, retrieval from real tutor_chunks, in a real
 * runTutorTurnForRequest turn.
 *   • loadCompletedLessonIds returns exactly the completed lessons (ordinal-blind)
 *   • A4-14: eligible = active ∪ completed; the INCOMPLETE lesson is never eligible
 *     and never retrieved from
 *   • Tier-1 retrieval over the active lesson works in a real turn
 *   • A4-15: an explicit cross-lesson request expands (code explicit_request) +
 *     emits tutor.retrieval.expanded
 *   • A4-21: the turn makes ONE chat model call; retrieval added EMBED calls
 *     (separate un-pooled client), never chat calls
 *
 * Run (after the migrations): `npx tsx scripts/verify-tutor-scope-int.ts`
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
import { createBlock, createLesson, createModule, createSlide, newRowId } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import type { CourseDocument, SlideDeckBlock, Slide } from "@/lib/course/types";
import { resolveLivePublicationBySlug, type PublicationRow } from "@/lib/learn/resolve";
import { PublicationSnapshotSchema, type PublicationSnapshot } from "@/lib/course/publish/schemas";
import { createMockModelClient } from "@/lib/ai/providers/mock";
import { embedAndStoreChunks } from "@/lib/tutor/retrieval/embedStore";
import { loadCompletedLessonIds } from "@/lib/tutor/retrieval/eligibility";
import { runTutorTurnForRequest, loadTutorContext, type TurnEnvelope } from "@/lib/tutor/runtime/service";
import type { TutorRuntimeEvent } from "@/lib/tutor/runtime/runtimeEvents";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
type DB = SupabaseClient<Database>;

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, service: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY };
}

async function provisionUser(url: string, anon: string, tag: string) {
  const email = `tutor-scope-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  console.log(`# provisioned ${email}`);
  return { client: client as DB, userId: data.user.id, email };
}

function seedSlide(layoutId: string, title: string, body: string): Slide {
  const slide = createSlide(layoutId);
  slide.title = title;
  const textEl = slide.elements.find((e) => e.type === "text" || e.type === "heading");
  if (textEl && (textEl.type === "text" || textEl.type === "heading")) textEl.text = body;
  else slide.elements.push({ id: newRowId(), type: "text", text: body, x: 100, y: 100, width: 600, height: 200, zIndex: slide.elements.length, style: {}, ai: { formattingRules: [], qualityChecks: [], allowedActions: [] } } as unknown as Slide["elements"][number]);
  return slide;
}

/** 3 lessons: L1 (active), L2 (completed), L3 (incomplete) — each a 1-slide deck. */
function makeDoc(courseId: string, ownerId: string, title: string): CourseDocument {
  const deck = (t: string, b: string) => {
    const d = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
    d.slides = [seedSlide("title", t, b)];
    return d;
  };
  const l1 = createLesson("Equilibrium", 0); l1.blocks = [deck("Equilibrium", "Price is set where supply meets demand at equilibrium.")];
  const l2 = createLesson("Scarcity", 1); l2.blocks = [deck("Scarcity", "Scarcity is the fundamental economic problem of limited resources.")];
  const l3 = createLesson("Elasticity", 2); l3.blocks = [deck("Elasticity", "Elasticity measures how quantity responds to a price change.")];
  const mod = createModule("Foundations", 0); mod.lessons = [l1, l2, l3];
  return {
    id: courseId, title, description: "Scope int fixture.", plan: { outcomes: [], prerequisites: [] },
    modules: [mod], theme: defaultCourseTheme(),
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ownerId, aiReadableVersion: "1.0" },
  };
}

async function seedCourse(client: DB, doc: CourseDocument, ownerId: string) {
  const rows = courseDocToRows(doc, ownerId);
  for (const [table, data] of [["courses", rows.course], ["modules", rows.modules], ["lessons", rows.lessons], ["blocks", rows.blocks]] as const) {
    const { error } = await client.from(table).insert(data as never);
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }
}

function makeSnapshotLoader(admin: DB): (id: string) => Promise<{ snapshot: PublicationSnapshot }> {
  return async (publicationId: string) => {
    const { data, error } = await admin.from("course_publications").select("snapshot").eq("id", publicationId).single();
    if (error || !data) throw new Error(`snapshot load: ${error?.message}`);
    return { snapshot: PublicationSnapshotSchema.parse((data as { snapshot: unknown }).snapshot) };
  };
}

/** A valid, short tutor_turn_output (uncited prose settles ok). */
const TURN_OUTPUT = { tutor_turn_output: { proseWithSpanMarkers: "Here is a brief recap.", citations: [], rung: 2, evidence: [] } };

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon || !service) throw new Error("Missing Supabase env (need SUPABASE_SERVICE_ROLE_KEY)");
  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");
  const admin = createClient<Database>(url, service, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: retryingFetch } });

  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, `Scope itest ${crypto.randomUUID().slice(0, 6)}`);
  await seedCourse(author.client, doc, author.userId);
  const l1 = doc.modules[0].lessons[0].id;
  const l2 = doc.modules[0].lessons[1].id;
  const l3 = doc.modules[0].lessons[2].id;
  const savedTau = process.env.TUTOR_RETRIEVAL_TAU;

  const cleanup = async () => {
    await admin.from("tutor_chunks").delete().eq("course_id", courseId);
    await admin.from("tutor_turns").delete().eq("course_id", courseId);
    await admin.from("tutor_threads").delete().eq("course_id", courseId);
    await admin.from("learn_progress").delete().eq("course_id", courseId);
    await admin.from("concept_nodes").delete().eq("course_id", courseId);
    await admin.from("tutor_course_settings").delete().eq("course_id", courseId);
    await author.client.from("courses").delete().eq("id", courseId);
    if (savedTau === undefined) delete process.env.TUTOR_RETRIEVAL_TAU;
    else process.env.TUTOR_RETRIEVAL_TAU = savedTau;
  };

  try {
    console.log("\n# publish + enroll + embed + seed completion");
    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    const found = await resolveLivePublicationBySlug(learner.client, v1.publication.slug);
    if (found.kind !== "found") throw new Error("publication not resolvable");
    const publication: PublicationRow = found.publication;
    await learner.client.from("enrollments").insert({ course_id: courseId, user_id: learner.userId });

    // Embed chunks (setup embed client — separate from the turn's).
    const setupSnap = PublicationSnapshotSchema.parse(
      (await admin.from("course_publications").select("snapshot").eq("id", publication.id).single()).data?.snapshot
    );
    const embedRes = await embedAndStoreChunks(admin, createMockModelClient([], {}), {
      courseId, publicationId: publication.id, version: publication.version, contentHash: v1.publication.contentHash, snapshot: setupSnap,
    });
    check("chunks embedded for the published course", embedRes.embedded > 0, JSON.stringify(embedRes));

    // Completion: L2 completed, L1 in_progress, L3 has NO row (incomplete).
    const now = new Date().toISOString();
    await admin.from("learn_progress").insert([
      { id: newRowId(), course_id: courseId, user_id: learner.userId, lesson_id: l2, status: "completed", pct: 100, progress_state: {}, last_activity_at: now, created_at: now, updated_at: now },
      { id: newRowId(), course_id: courseId, user_id: learner.userId, lesson_id: l1, status: "in_progress", pct: 40, progress_state: {}, last_activity_at: now, created_at: now, updated_at: now },
    ] as never);

    console.log("\n# loadCompletedLessonIds (real learn_progress)");
    const completed = await loadCompletedLessonIds(learner.client, learner.userId, courseId);
    check("loadCompletedLessonIds returns EXACTLY {L2} (L1 in_progress excluded; ordinal-blind)", completed.size === 1 && completed.has(l2) && !completed.has(l1) && !completed.has(l3), JSON.stringify([...completed]));

    process.env.TUTOR_RETRIEVAL_TAU = "0"; // mock vectors are meaningless; τ=0 ⇒ any retrieved chunk is "relevant"
    const envelope: TurnEnvelope = { courseId, publicationId: publication.id, version: publication.version, lessonId: l1 };
    const loadSnapshot = makeSnapshotLoader(admin);
    const context = await loadTutorContext(admin, courseId);

    // ── a NORMAL turn on the active lesson (A4-14 + Tier 1) ──
    console.log("\n# A4-14 + Tier-1 · a normal active-lesson turn");
    {
      const chat = createMockModelClient([], { structured: TURN_OUTPUT });
      const embed = createMockModelClient([], {});
      const events: TutorRuntimeEvent[] = [];
      const res = await runTutorTurnForRequest(
        { learnerClient: learner.client, admin, model: chat, embedModel: embed, loadSnapshot, onRuntimeEvent: (e: TutorRuntimeEvent) => events.push(e) },
        { userId: learner.userId, envelope, learnerMessage: "what is equilibrium in this lesson", access: { kind: "ok" }, context }
      );
      const scope = res.turn?.scope;
      check("the turn ran the scope policy (scope surfaced)", !!scope, JSON.stringify({ ok: res.turn?.ok, scope }));
      check("A4-14: eligible = active ∪ completed = {L1, L2}", !!scope && new Set(scope.eligibleLessonIds).size === 2 && scope.eligibleLessonIds.includes(l1) && scope.eligibleLessonIds.includes(l2), JSON.stringify(scope?.eligibleLessonIds));
      check("A4-14: the INCOMPLETE lesson L3 is NOT eligible", !!scope && !scope.eligibleLessonIds.includes(l3));
      check("Tier-1 retrieved chunks from the active lesson", !!scope && scope.tier1Count > 0, JSON.stringify(scope));
      check("A4-21: the turn made exactly ONE chat model call", chat.getCalls().length === 1, `calls=${chat.getCalls().length}`);
      check("A4-21: retrieval added EMBED calls on the SEPARATE un-pooled client (not chat)", embed.getEmbedCalls().length >= 1, `embeds=${embed.getEmbedCalls().length}`);
    }

    // ── an EXPLICIT cross-lesson request (A4-15 expansion + event) ──
    console.log("\n# A4-15 · explicit cross-lesson request expands + emits the event");
    {
      const chat = createMockModelClient([], { structured: TURN_OUTPUT });
      const embed = createMockModelClient([], {});
      const events: TutorRuntimeEvent[] = [];
      const res = await runTutorTurnForRequest(
        { learnerClient: learner.client, admin, model: chat, embedModel: embed, loadSnapshot, onRuntimeEvent: (e: TutorRuntimeEvent) => events.push(e) },
        { userId: learner.userId, envelope, learnerMessage: "compare this with the earlier lesson on scarcity", access: { kind: "ok" }, context }
      );
      const scope = res.turn?.scope;
      check("explicit request → expansionCode 'explicit_request'", scope?.expansionCode === "explicit_request", JSON.stringify(scope));
      check("expansion drew Tier-2 (from the completed lesson)", !!scope && scope.tier2Count >= 0 && scope.expansionCode === "explicit_request");
      check("tutor.retrieval.expanded emitted during the real turn", events.some((e) => e.name === "tutor.retrieval.expanded" && e.fields.code === "explicit_request"));
      check("A4-14 holds under expansion: L3 still not eligible", !!scope && !scope.eligibleLessonIds.includes(l3));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
  } finally {
    await cleanup();
    console.log("# cleaned up (throwaway users remain — clean in Supabase → Auth)");
  }
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
