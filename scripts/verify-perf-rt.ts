/**
 * PERF-1 wave-3 — AC-PERF-07: primary data for each top-5 route loads in
 * ≤2 DATA ROUND TRIPS, proven by COUNTING (no browser, no server).
 *
 * Method: wrap a signed-in supabase-js client in a Proxy that counts every
 * `.rpc()` call and `.from()` query-builder EXECUTION — counted at await/then
 * time (a builder that is never awaited never hits the network, and one await
 * = one HTTP round trip), then call each route's bundle loader directly and
 * assert the count. Every loader Zod-parses its payload internally (rpcJson →
 * schema.parse throws on a malformed payload), so a loader returning at all
 * IS the payload-contract check.
 *
 * unstable_cache note (per loader):
 *  - loadCreatorDashboard: the ONLY loader that calls getCachedSnapshot
 *    (lib/learn/publicationCache — unstable_cache, NOT executable under bare
 *    tsx). It exposes the seam as its 2nd parameter (`loadSnapshot`) — we
 *    inject a counting stub that reads the snapshot with a separate,
 *    UNcounted client, and assert the seam is invoked ≤1 time.
 *  - loadStudioCourse / loadLessonState / loadAnalyticsDashboard /
 *    loadLearnerDetail / loadMarketingHub: never touch unstable_cache
 *    (their pages read the cached snapshot separately) — called as-is.
 *  - the learn lesson route's snapshot read is the forever-cached immutable
 *    body (zero round trips warm; not a per-view data round trip), so the
 *    route budget here is resolveLivePublicationMeta (1) + learn_lesson_state
 *    (1) = 2.
 *
 * Run: `npx tsx scripts/verify-perf-rt.ts` (not wired into package.json —
 * deliberate; see the wave-3 summary).
 *
 * Fixture: the seeded analytics fixture (scripts/seed-fixture-analytics.ts).
 * The marketing check self-provisions a FRESH creator + one bare course so
 * the "≤2 including the course resolve" claim is measured from a clean slate
 * (the course is deleted afterwards; the throwaway user remains — repo
 * convention).
 */

import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { loadCreatorDashboard } from "@/lib/analytics/creatorHomeLoader";
import { loadAnalyticsDashboard, loadLearnerDetail } from "@/lib/analytics/dashboardLoader";
import { loadStudioCourse } from "@/lib/editor/studioLoad";
import { loadLessonState } from "@/lib/learn/lessonState";
import { resolveLivePublicationMeta } from "@/lib/learn/publicationCache";
import { loadMarketingHub } from "@/lib/marketing/hubLoader";
import { selectCourseForAuthor } from "@/lib/marketing/persistence";

/* ───────────────────────────── fixture refs ─────────────────────────────── */

const FIXTURE_COURSE_ID = "1d730f8c-fc9e-4e87-9eb7-6a2a654506bd";
const FIXTURE_SLUG = "econ-fixture-d5eace";
const FIXTURE_LESSON_ID = "98e34ffe-fbe3-4b45-be37-29a1dfcc50f7";
const FIXTURE_AUTHOR = "maint-fixture-author-291556af@example.com";
const FIXTURE_STUDENT = "maint-fixture-student-8f49d4be@example.com";
const FIXTURE_PASSWORD = "Test-passw0rd!";

/* ─────────────────────────────── harness ────────────────────────────────── */

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

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
}

async function signIn(url: string, anon: string, email: string, password: string) {
  const client = createClient<Database>(url, anon);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin ${email} failed: ${error?.message}`);
  return { client, userId: data.user.id };
}

async function provisionCreator(url: string, anon: string) {
  const email = `perf-rt-creator-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  console.log(`# provisioned ${email}`);
  return signIn(url, anon, email, FIXTURE_PASSWORD);
}

/* ─────────────────────────── counting client ────────────────────────────── */

interface RoundTripCounter {
  total: number;
  /** e.g. ["rpc:creator_dashboard", "from:course_publications"] in order. */
  labels: string[];
}

/**
 * Wrap a PostgREST builder chain so the count increments when the chain is
 * EXECUTED (its `then` is invoked by an await), not when it's constructed.
 * Chained refinement methods that return the same builder keep the proxy;
 * ones that return a new (thenable) object are wrapped recursively.
 */
function wrapExecutable<T extends object>(builder: T, record: () => void): T {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "then") {
        const then = (target as { then?: unknown }).then;
        if (typeof then !== "function") return then;
        return (...args: unknown[]) => {
          record();
          return (then as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (result === target) return receiver;
        if (
          result !== null &&
          typeof result === "object" &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          return wrapExecutable(result as object, record);
        }
        return result;
      };
    },
  });
}

/** A supabase client whose `.from()`/`.rpc()` executions are counted; every
 *  other surface (auth, storage, …) passes through untouched. */
function makeCountingClient(real: SupabaseClient<Database>): {
  client: SupabaseClient<Database>;
  counter: RoundTripCounter;
} {
  const counter: RoundTripCounter = { total: 0, labels: [] };
  const client = new Proxy(real as object, {
    get(target, prop) {
      if (prop === "from") {
        return (table: string) =>
          wrapExecutable(
            (target as { from: (t: string) => object }).from(table),
            () => {
              counter.total += 1;
              counter.labels.push(`from:${table}`);
            }
          );
      }
      if (prop === "rpc") {
        return (fn: string, args?: Record<string, unknown>) =>
          wrapExecutable(
            (target as { rpc: (f: string, a?: Record<string, unknown>) => object }).rpc(fn, args),
            () => {
              counter.total += 1;
              counter.labels.push(`rpc:${fn}`);
            }
          );
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as SupabaseClient<Database>;
  return { client, counter };
}

const fmt = (c: RoundTripCounter) => `${c.total} [${c.labels.join(", ")}]`;

/* ────────────────────────────────── main ────────────────────────────────── */

async function main() {
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env (.env.local)");

  const author = await signIn(url, anon, FIXTURE_AUTHOR, FIXTURE_PASSWORD);
  const student = await signIn(url, anon, FIXTURE_STUDENT, FIXTURE_PASSWORD);

  /* ── 1. /dashboard — loadCreatorDashboard ── */
  console.log("\n1. /dashboard — loadCreatorDashboard (author)");
  {
    const { client, counter } = makeCountingClient(author.client);
    // Injected snapshot seam (see header): counts its own invocations, reads
    // via the UNcounted author client (the author may read own publications
    // under RLS) — the production default (getCachedSnapshot) is
    // unstable_cache-backed and zero-round-trip warm.
    let seamCalls = 0;
    const dash = await loadCreatorDashboard(client, async (publicationId) => {
      seamCalls += 1;
      const { data, error } = await author.client
        .from("course_publications")
        .select("snapshot")
        .eq("id", publicationId)
        .single();
      if (error) throw error;
      return { snapshot: data.snapshot };
    });
    check("dashboard: exactly 1 counted client round trip", counter.total === 1, fmt(counter));
    check(
      "dashboard: that round trip is the creator_dashboard RPC",
      counter.labels[0] === "rpc:creator_dashboard",
      fmt(counter)
    );
    check(
      "dashboard: payload Zod-parsed + fixture course present",
      dash.courses.some((c) => c.id === FIXTURE_COURSE_ID),
      `courses=${dash.courses.length}`
    );
    check("dashboard: snapshot seam invoked ≤1 time", seamCalls <= 1, `seamCalls=${seamCalls}`);
    check(
      "dashboard: spotlight funnel labels resolve through the seam (or no spotlight → seam untouched)",
      dash.spotlight && dash.spotlight.funnel.length > 0
        ? Object.keys(dash.lessonTitles).length > 0
        : seamCalls === 0,
      `spotlight=${JSON.stringify(dash.spotlight?.funnel.length ?? null)} titles=${Object.keys(dash.lessonTitles).length}`
    );
  }

  /* ── 2. /studio?course= — loadStudioCourse ── */
  console.log("\n2. /studio — loadStudioCourse (author)");
  {
    const { client, counter } = makeCountingClient(author.client);
    const bundle = await loadStudioCourse(client, FIXTURE_COURSE_ID);
    check(
      "studio: exactly 1 round trip (studio_course_bundle)",
      counter.total === 1 && counter.labels[0] === "rpc:studio_course_bundle",
      fmt(counter)
    );
    check(
      "studio: bundle parsed — course + full tree returned",
      bundle !== null &&
        (bundle.course as { id?: string }).id === FIXTURE_COURSE_ID &&
        bundle.lessons.length > 0 &&
        bundle.blocks.length > 0,
      bundle ? `lessons=${bundle.lessons.length} blocks=${bundle.blocks.length}` : "bundle=null"
    );
  }

  /* ── 3. /learn/[slug]/[lessonId] — meta resolve + lesson-state RPC ── */
  console.log("\n3. /learn lesson — resolveLivePublicationMeta + loadLessonState (student)");
  {
    const { client, counter } = makeCountingClient(student.client);
    const resolution = await resolveLivePublicationMeta(client, FIXTURE_SLUG);
    check("learn: slug resolves to the live publication", resolution.kind === "found");
    if (resolution.kind !== "found") throw new Error("fixture publication missing");
    // The immutable snapshot body is the forever-cache (zero RTs warm) — the
    // fixture lesson has no video blocks, so videoAssetIds is [] just like
    // lessonVideoAssetIds(lesson) would derive from the cached snapshot.
    const state = await loadLessonState(client, {
      publicationId: resolution.meta.id,
      lessonId: FIXTURE_LESSON_ID,
      videoAssetIds: [],
    });
    check("learn: ≤2 total data round trips for the view", counter.total <= 2, fmt(counter));
    check(
      "learn: lesson state parsed — enrolled student verdict",
      state.kind === "ok" && state.state.access.enrolled && !state.state.access.is_author,
      `kind=${state.kind}`
    );
    check(
      "learn: progress rows ride the same single RPC",
      state.kind === "ok" && state.state.progress.length >= 1,
      state.kind === "ok" ? `progress=${state.state.progress.length}` : ""
    );
  }

  /* ── 4. /studio/[courseId]/analytics — per-tab bundle + learner detail ── */
  console.log("\n4. /studio analytics — loadAnalyticsDashboard + loadLearnerDetail (author)");
  {
    const { client, counter } = makeCountingClient(author.client);
    const overview = await loadAnalyticsDashboard(client, FIXTURE_COURSE_ID, "overview", 0);
    check(
      "analytics overview: exactly 1 round trip",
      counter.total === 1 && counter.labels[0] === "rpc:course_analytics_bundle",
      fmt(counter)
    );
    check(
      "analytics overview: parsed — live publication + funnel present",
      overview !== null && overview.publication !== null && overview.analytics.funnel.length > 0,
      overview ? `funnel=${overview.analytics.funnel.length}` : "null"
    );
  }
  {
    const { client, counter } = makeCountingClient(author.client);
    const learners = await loadAnalyticsDashboard(client, FIXTURE_COURSE_ID, "learners", 0);
    check("analytics learners: exactly 1 round trip", counter.total === 1, fmt(counter));
    check(
      "analytics learners: roster includes the fixture student",
      learners !== null && learners.analytics.roster.some((r) => r.user_id === student.userId),
      learners ? `roster=${learners.analytics.roster.length}` : "null"
    );
  }
  {
    const { client, counter } = makeCountingClient(author.client);
    const detail = await loadLearnerDetail(client, FIXTURE_COURSE_ID, student.userId);
    check("learner detail: exactly 1 round trip", counter.total === 1, fmt(counter));
    check(
      "learner detail: parsed — roster row + progress for the student",
      detail !== null && detail.learner !== null && detail.progress.length >= 1,
      detail ? `progress=${detail.progress.length}` : "null"
    );
  }

  /* ── 5. /marketing — course resolve + hub bundle, fresh creator ── */
  console.log("\n5. /marketing — selectCourseForAuthor + loadMarketingHub (fresh creator)");
  {
    const creator = await provisionCreator(url, anon);
    const courseTitle = `Perf RT probe ${crypto.randomUUID().slice(0, 6)}`;
    const inserted = await creator.client
      .from("courses")
      .insert({ author_id: creator.userId, title: courseTitle })
      .select("id")
      .single();
    if (inserted.error) throw new Error(`bare course insert: ${inserted.error.message}`);
    const courseId = inserted.data.id;
    try {
      const { client, counter } = makeCountingClient(creator.client);
      // The page's exact spine: resolve the operating course (react cache()'d
      // in-app; one query here), then the ONE hub bundle RPC.
      const course = await selectCourseForAuthor(client, creator.userId, null);
      check("marketing: course resolve finds the bare course", course?.id === courseId);
      const hub = await loadMarketingHub(client, courseId);
      check(
        "marketing: ≤2 total round trips including the course resolve",
        counter.total <= 2,
        fmt(counter)
      );
      check(
        "marketing: hub bundle parsed — bare-course empty shell",
        hub !== null &&
          hub.courses.some((c) => c.id === courseId) &&
          hub.campaign === null &&
          hub.pendingApprovals.length === 0 &&
          hub.sequencesOverview.sequenceCount === 0,
        hub ? JSON.stringify(hub.sequencesOverview) : "null"
      );
    } finally {
      await creator.client.from("courses").delete().eq("id", courseId);
      console.log("# cleaned up probe course (throwaway user remains)");
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
