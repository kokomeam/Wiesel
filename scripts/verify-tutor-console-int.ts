/**
 * Creator Tutor Console — INTEGRATION suite (live Supabase; no OpenAI key).
 * TUTOR-1 Wave 5 (P5.1). Self-provisions throwaway users each run. WRITE-ONLY in
 * this package: the orchestrator applies 20260805100000_tutor_console_rpcs.sql
 * BEFORE running it. DO NOT run before the migration.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) — tutor_threads/
 * tutor_turns are learner-owned + assistant turns are service-role writes; the
 * cohort-floor test seeds them via the admin client.
 *
 * The AC matrix:
 *   1. AUTHOR reads the bundle for their course (overview + charter) — non-null.
 *   2. A NON-author (enrolled learner AND a stranger) gets NULL from the RPC
 *      (author-gate; the page 404s) — the RLS matrix half of W5O.1/T5.6.
 *   3. Cohort floor (W5O.1): with 3 learners' tutor activity, overview.usage is
 *      NULL + usageSuppressed true (no count disclosed). With ≥5, usage is
 *      present with real counts.
 *   4. Charter save (AC-T5.2 schema+history): saveCharter via applyCharterChange
 *      writes a tutor_charter_versions row (actor=author) + moves the settings
 *      pointer; the bundle's enablement.charter reflects the change AND
 *      charterVersions lists it with the actor's email.
 *   5. Enablement is DEFAULT-ON and NOT graph-gated: enabling via
 *      setTutorEnabledAction SUCCEEDS with no concept graph (the tutor answers
 *      lesson-grounded without one). hasAcceptedGraph is a STATUS signal — false
 *      with no concept nodes, true after inserting active nodes (no pending
 *      change-set) — and does NOT block enabling.
 *   6. An unknown tab RAISES.
 *
 * Run (AFTER the migration): `npx tsx scripts/verify-tutor-console-int.ts`
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
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";
import { resolveLivePublicationBySlug, type PublicationRow } from "@/lib/learn/resolve";
import { applyCharterChange } from "@/lib/tutor/runtime/charter";
import { loadTutorConsole } from "@/lib/studio/tutorConsole";

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
  const email = `tutor-console-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

function makeDoc(courseId: string, ownerId: string, title: string): CourseDocument {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];
  const lesson = createLesson("Lesson A", 0);
  lesson.blocks = [deck];
  const mod = createModule("Foundations", 0);
  mod.lessons = [lesson];
  return {
    id: courseId,
    title,
    description: "Tutor console integration fixture.",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId,
      aiReadableVersion: "1.0",
    },
  };
}

async function seedCourse(client: DB, doc: CourseDocument, ownerId: string): Promise<void> {
  const rows = courseDocToRows(doc, ownerId);
  for (const [table, data] of [
    ["courses", rows.course],
    ["modules", rows.modules],
    ["lessons", rows.lessons],
    ["blocks", rows.blocks],
  ] as const) {
    const { error } = await client.from(table).insert(data as never);
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }
}

/** Seed N learners' tutor threads + one turn each (admin — assistant/thread rows
 *  are service-role writes for this test's purposes). Returns the learner ids. */
async function seedTutorActivity(
  admin: DB,
  courseId: string,
  publication: PublicationRow,
  n: number
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const userId = crypto.randomUUID();
    ids.push(userId);
    const thread = await admin
      .from("tutor_threads")
      .insert({ user_id: userId, course_id: courseId })
      .select("id")
      .single();
    if (thread.error) throw new Error(`thread insert: ${thread.error.message}`);
    const turn = await admin.from("tutor_turns").insert({
      thread_id: thread.data!.id,
      user_id: userId,
      course_id: courseId,
      role: "learner",
      content: `Learner ${i} question.`,
      publication_id: publication.id,
      version: publication.version,
    });
    if (turn.error) throw new Error(`turn insert: ${turn.error.message}`);
  }
  return ids;
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env in .env.local");
  if (!service) throw new Error("verify:tutor-console:int needs SUPABASE_SERVICE_ROLE_KEY");

  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");
  const stranger = await provisionUser(url, anon, "stranger");
  const admin = createClient<Database>(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: retryingFetch },
  });

  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, `Tutor console itest ${crypto.randomUUID().slice(0, 6)}`);
  await seedCourse(author.client, doc, author.userId);
  console.log("# seeded course");

  const cleanup = async () => {
    // tutor_threads/turns cascade on course delete; concept_nodes + settings too.
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ── publish + enroll the learner ── */
    console.log("\n# publish + enroll");
    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    check("published v1 live", v1.publication.version === 1 && v1.publication.status === "live");
    const found = await resolveLivePublicationBySlug(learner.client, v1.publication.slug);
    if (found.kind !== "found") throw new Error("publication not resolvable");
    const publication: PublicationRow = found.publication;

    const enrolled = await learner.client
      .from("enrollments")
      .insert({ course_id: courseId, user_id: learner.userId });
    check("learner self-enrolls", !enrolled.error, String(enrolled.error?.message));

    /* ── 1. AUTHOR reads the bundle (overview + charter) ── */
    console.log("\n# 1. author reads the bundle");
    const authOverview = await loadTutorConsole(author.client, courseId, "overview");
    check("author reads the overview bundle (non-null)", authOverview !== null);
    check(
      "the overview bundle carries the course title + enablement + overview blocks",
      !!authOverview &&
        authOverview.course.id === courseId &&
        authOverview.enablement !== undefined &&
        authOverview.overview !== null
    );
    check(
      "a fresh course is ON BY DEFAULT with the default charter (no settings row ⇒ enabled)",
      !!authOverview &&
        authOverview.enablement.enabled === true &&
        authOverview.enablement.charter.guidanceStyle === "guided_default"
    );

    const authCharter = await loadTutorConsole(author.client, courseId, "charter");
    check(
      "author reads the charter bundle (overview null on the charter tab)",
      authCharter !== null && authCharter.overview === null && authCharter.enablement !== undefined
    );

    /* ── 2. a NON-author gets NULL (author-gate; RLS matrix) ── */
    console.log("\n# 2. non-authors get NULL from the RPC (author-gate)");
    const learnerBundle = await loadTutorConsole(learner.client, courseId, "overview");
    check("an ENROLLED learner gets NULL (never sees the console)", learnerBundle === null);
    const strangerBundle = await loadTutorConsole(stranger.client, courseId, "overview");
    check("a STRANGER gets NULL", strangerBundle === null);

    /* ── 3. cohort floor (W5O.1): 3 learners → suppressed ── */
    console.log("\n# 3. cohort floor — sub-floor usage is suppressed");
    await seedTutorActivity(admin, courseId, publication, 3);
    const below = await loadTutorConsole(author.client, courseId, "overview");
    check(
      "with 3 learners: usage is NULL + usageSuppressed true (no count disclosed)",
      !!below && below.overview?.usage === null && below.overview?.usageSuppressed === true
    );

    console.log("\n# 3b. cohort floor — at/above ≥5, usage is present");
    await seedTutorActivity(admin, courseId, publication, 2); // now 5 total
    const above = await loadTutorConsole(author.client, courseId, "overview");
    check(
      "with 5 learners: usage is present + usageSuppressed false",
      !!above && above.overview?.usage !== null && above.overview?.usageSuppressed === false
    );
    check(
      "usage counts are the real aggregates (5 learners, 5 sessions, 5 turns)",
      !!above &&
        above.overview?.usage?.uniqueLearners === 5 &&
        above.overview?.usage?.sessions === 5 &&
        above.overview?.usage?.turns === 5,
      JSON.stringify(above?.overview?.usage)
    );

    /* ── 4. charter save (AC-T5.2 schema+history) ── */
    console.log("\n# 4. charter save writes a version row + the bundle reflects it");
    const beforeCharter = await loadTutorConsole(author.client, courseId, "charter");
    const beforeVersionCount = beforeCharter?.enablement.charterVersions.length ?? 0;

    const { versionId } = await applyCharterChange(author.client, courseId, author.userId, {
      guidanceStyle: "socratic_strict",
      toneNotes: "Be rigorous and precise.",
    });
    check("applyCharterChange returned a versionId", typeof versionId === "string" && versionId.length > 0);

    const afterCharter = await loadTutorConsole(author.client, courseId, "charter");
    check(
      "the bundle's enablement.charter reflects the change (guidanceStyle=socratic_strict)",
      afterCharter?.enablement.charter.guidanceStyle === "socratic_strict"
    );
    check(
      "the changed tone note is reflected",
      afterCharter?.enablement.charter.toneNotes === "Be rigorous and precise."
    );
    check(
      "charterVersions grew by one",
      (afterCharter?.enablement.charterVersions.length ?? 0) === beforeVersionCount + 1
    );
    const newest = afterCharter?.enablement.charterVersions[0];
    check(
      "the newest version has the author's email + the new version id",
      !!newest && newest.id === versionId && newest.actorEmail === author.email,
      JSON.stringify(newest)
    );
    check("the current version pointer moved", afterCharter?.enablement.currentVersionId === versionId);

    /* ── 5. enablement is default-ON and NOT graph-gated ── */
    console.log("\n# 5. enablement is default-on — enabling with NO graph succeeds");
    check(
      "with no concept nodes: hasAcceptedGraph is false (STATUS only — enabling is NOT blocked)",
      afterCharter?.enablement.hasAcceptedGraph === false &&
        afterCharter?.enablement.nodeCount === 0
    );

    // The un-gated enable write (mirrors setTutorEnabledAction after its author
    // gate): upsert enabled=true with NO concept graph present. This must SUCCEED —
    // enabling never depends on an accepted graph anymore.
    const enableNoGraph = await author.client
      .from("tutor_course_settings")
      .upsert({ course_id: courseId, enabled: true }, { onConflict: "course_id" });
    check(
      "enabling the tutor with NO concept graph SUCCEEDS (default-on, un-gated)",
      !enableNoGraph.error,
      String(enableNoGraph.error?.message)
    );
    const enabledNoGraph = await loadTutorConsole(author.client, courseId, "overview");
    check(
      "the bundle reflects enabled=true even though hasAcceptedGraph is still false",
      enabledNoGraph?.enablement.enabled === true &&
        enabledNoGraph?.enablement.hasAcceptedGraph === false
    );

    console.log("\n# 5b. hasAcceptedGraph is a STATUS signal — flips true once nodes exist");
    const nodeInsert = await author.client.from("concept_nodes").insert([
      { course_id: courseId, title: "Concept A", status: "active" },
      { course_id: courseId, title: "Concept B", status: "active" },
    ]);
    check("author inserts active concept nodes", !nodeInsert.error, String(nodeInsert.error?.message));

    const withGraph = await loadTutorConsole(author.client, courseId, "overview");
    check(
      "with active nodes + no pending change-set: hasAcceptedGraph is true, nodeCount=2",
      withGraph?.enablement.hasAcceptedGraph === true && withGraph?.enablement.nodeCount === 2
    );

    /* ── 6. unknown tab raises (the loader collapses it to null) ── */
    console.log("\n# 6. an unknown tab raises inside the RPC");
    const bad = await (author.client as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    }).rpc("tutor_console_bundle", { p_course_id: courseId, p_tab: "bogus" });
    check("an unknown p_tab raises (RPC error surfaced)", bad.error !== null, String(bad.error?.message));
  } finally {
    await cleanup();
    console.log("\n# cleaned up");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
