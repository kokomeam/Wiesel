/**
 * PERF-1 E3 — per-route JS BUNDLE BUDGET gate (AC-PERF-11/15).
 *
 * Measures each top-5 route's JS wire bytes — the sum of script-resource
 * `encodedBodySize` (gzip transfer size) via Playwright, the SAME definition
 * the Phase-A baseline used (docs/perf/baseline/perf-baseline.mjs) — and
 * asserts it against the budget table below. Median of 2 cold loads per
 * route (fresh browser context each run, so nothing is served from the HTTP
 * cache); with an even run count the median helper picks the UPPER value
 * (conservative for a gate).
 *
 * Budgets live in ONE place: the exported `BUDGETS` map right below (KB =
 * 1024 bytes, gzip wire). Change budgets there and nowhere else — the CI
 * workflow and docs/perf/README.md both point here.
 *
 * Run: `npm run verify:budgets` (top-5 only) · `npm run verify:budgets -- --all`
 * additionally asserts every OTHER measured route (marketplace, settings,
 * portals, learn landing, public pages …) against the 250 KB default.
 *
 * Deterministic + CI-safe:
 *   - requires a prod build (.next/BUILD_ID); runs `npm run build` if absent;
 *   - reuses a server already listening on :3100, otherwise starts
 *     `next start -p 3100` itself and kills ONLY that self-started process
 *     (port 3000 — the dev server — is never touched);
 *   - SELF-PROVISIONS throwaway users + one minimal published course (the
 *     verify-learn-browser.ts pattern) instead of assuming the local seeded
 *     fixture, so it runs against any Supabase project (CI portability);
 *     the course is deleted afterwards, the throwaway `*@example.com` users
 *     remain (repo convention — they can't be deleted with the anon key);
 *   - env comes from process.env first, `.env.local` as the local fallback.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  createBlock,
  createLesson,
  createModule,
  createQuestion,
  createSlide,
  newRowId,
} from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import type { CourseDocument, HomeworkBlock, QuizBlock, SlideDeckBlock } from "@/lib/course/types";

/* ─────────────────────────── BUDGETS (the ONE place) ────────────────────── */

/** Per-route JS budgets in KB (1024 bytes), gzip WIRE bytes over script
 *  resources. Approved at PERF-1 Checkpoint 1 (diagnosis §A6 / budget
 *  proposal): studio carries a 400 KB exception (full authoring editor,
 *  modal subsystems split), marketing 300 KB (hub + dock shell). Everything
 *  not named here is held to DEFAULT_BUDGET_KB when `--all` is passed. */
export const BUDGETS: Readonly<Record<string, number>> = {
  "/dashboard": 250,
  // Studio renegotiated 400 → 550 at Checkpoint 3 (the D-phase chunk
  // decomposition showed the editor's legitimate core — react runtime +
  // patch pipeline/zod schemas + dnd-kit + autosave supabase-js +
  // react-dom/server for the load-bearing auto-grow text measurer — is
  // ~490 KB before feature code; every modal subsystem is already
  // dynamic-imported). Making the measurer async risks one-undo-per-commit
  // semantics for 77 KB on a desktop-first creator surface. Revisit if the
  // measurer is ever rebuilt without react-dom/server.
  //
  // Renegotiated 550 → 600 on 2026-08-04 (TUTOR-1 W3.0 gate, Henry-approved):
  // the worktree reconciliation merged the ratified recorder/clips editor
  // surfaces (measured 589.8 post-merge vs 544 at PERF-1 close — feature
  // weight, not a leak). A decomposition pass over the recorder/clips chunks
  // is the flagged PERF-2 candidate before this number moves again.
  "/studio": 600,
  "/learn/[slug]/[lessonId]": 250,
  "/studio/[courseId]/analytics": 250,
  // Renegotiated 300 → 315 on 2026-08-04 (same gate/approval): the UI-1 hub
  // overhaul + connected-publishing cards merged in at 308.1. Revisit with
  // the same PERF-2 pass (ChatPublishCards is the first dynamic-import
  // candidate if the hub grows again).
  "/marketing": 315,
};

export const DEFAULT_BUDGET_KB = 250;

/* ─────────────────────────────── config ─────────────────────────────────── */

const BASE = process.env.PERF_BROWSER_BASE ?? "http://localhost:3100";
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNS_PER_ROUTE = 2;
const PASSWORD = "Test-passw0rd!";

// This machine's supabase endpoints occasionally stall on IPv6 — prefer v4
// (repo convention for live-Supabase suites; harmless elsewhere/CI).
try {
  setDefaultResultOrder("ipv4first");
} catch {
  /* older node — fine */
}

/* ─────────────────────────────── harness ────────────────────────────────── */

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

/** process.env first (CI), .env.local as the local fallback. */
export function loadEnv() {
  const fileEnv: Record<string, string> = {};
  const envPath = path.join(ROOT, ".env.local");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const get = (k: string) => process.env[k] ?? fileEnv[k];
  return { url: get("NEXT_PUBLIC_SUPABASE_URL"), anon: get("NEXT_PUBLIC_SUPABASE_ANON_KEY") };
}

/** Median matching the Phase-A baseline helper: sorted[floor(n/2)] — for the
 *  2-run gate this picks the LARGER measurement (conservative). */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/* ───────────────────── prod build + server lifecycle ────────────────────── */

export function ensureBuild() {
  if (existsSync(path.join(ROOT, ".next", "BUILD_ID"))) return;
  console.log("# no prod build found (.next/BUILD_ID missing) — running `npm run build`…");
  const res = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`npm run build failed (${res.status})`);
}

async function ping(): Promise<boolean> {
  try {
    const res = await fetch(BASE, { redirect: "manual" });
    return res.status > 0;
  } catch {
    return false;
  }
}

/** Reuse a listening server; else start `next start -p 3100` (killed on exit
 *  ONLY when we started it — never someone else's server, never port 3000). */
export async function ensureServer(): Promise<ChildProcess | null> {
  if (await ping()) {
    console.log(`# reusing server at ${BASE}`);
    return null;
  }
  if (!BASE.includes("localhost:3100")) {
    throw new Error(`No server at ${BASE} and it isn't the default port — start it yourself`);
  }
  ensureBuild();
  console.log("# starting `next start -p 3100` (prod build from .next)…");
  const proc = spawn(path.join(ROOT, "node_modules", ".bin", "next"), ["start", "-p", "3100"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString();
    if (/error/i.test(line)) console.error(`[next] ${line.trim()}`);
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await ping()) {
      console.log(`# server up at ${BASE}`);
      return proc;
    }
    if (proc.exitCode !== null) throw new Error(`next start exited early (${proc.exitCode})`);
  }
  proc.kill("SIGTERM");
  throw new Error("server did not come up within 60s");
}

/* ─────────────────── self-provisioned fixture (no seeds) ────────────────── */

export async function provisionUser(url: string, anon: string, tag: string) {
  const email = `budget-gate-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const signup = await fetch(`${url}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: anon, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }).catch((err) => {
      lastErr = String(err);
      return null;
    });
    if (signup?.ok) {
      const client = createClient<Database>(url, anon);
      const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
      if (error || !data.user) throw new Error(`signin failed for ${email}: ${error?.message}`);
      console.log(`# provisioned ${email}`);
      return { client, userId: data.user.id, email };
    }
    if (signup) lastErr = await signup.text();
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`signup failed after retries: ${lastErr}`);
}

/** Minimal-but-real course (deck ×2 slides + quiz · lecture · homework — the
 *  verify-learn-browser fixture shape), inserted under the author's RLS and
 *  published live so /learn and enrollment gating behave like production. */
export async function provisionCourse(author: Awaited<ReturnType<typeof provisionUser>>) {
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];
  const quiz = createBlock("quiz", 1) as QuizBlock;
  const mc = createQuestion("multiple_choice");
  if (mc.kind !== "multiple_choice") throw new Error("unreachable");
  mc.prompt = "Pick the FIRST option.";
  mc.correctChoiceId = mc.choices[0].id;
  mc.explanation = "The first option was correct.";
  quiz.questions = [mc];
  const lessonA = createLesson("Budget lesson A", 0);
  lessonA.blocks = [deck, quiz];
  const lessonB = createLesson("Budget lesson B", 1);
  lessonB.blocks = [createBlock("lecture_text", 0)];
  const homework = createBlock("homework", 0) as HomeworkBlock;
  homework.deliverableType = "text_response";
  const lessonC = createLesson("Budget lesson C", 2);
  lessonC.blocks = [homework];
  const mod = createModule("Module 1", 0);
  mod.lessons = [lessonA, lessonB, lessonC];
  const courseId = newRowId();
  const doc: CourseDocument = {
    id: courseId,
    title: `Budget gate fixture ${crypto.randomUUID().slice(0, 6)}`,
    description: "Self-provisioned course for the JS budget gate.",
    plan: { outcomes: [], prerequisites: [] },
    modules: [mod],
    theme: defaultCourseTheme(),
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerId: author.userId,
      aiReadableVersion: "1.0",
    },
  };
  const rows = courseDocToRows(doc, author.userId);
  for (const [table, data] of [
    ["courses", rows.course],
    ["modules", rows.modules],
    ["lessons", rows.lessons],
    ["blocks", rows.blocks],
  ] as const) {
    const { error } = await author.client.from(table).insert(data as never);
    if (error) throw new Error(`${table} insert: ${error.message}`);
  }
  const published = await publishCourse(author.client, doc, { visibility: "public" });
  console.log(`# published /learn/${published.publication.slug}`);
  return { courseId, slug: published.publication.slug, lessonId: lessonA.id };
}

/* ─────────────────────────── browser auth states ────────────────────────── */

/** /login sign-in with the repo's retry-click convention (a prod server can
 *  serve the shell before React hydrates — the first submit click may be a
 *  silent no-op; see scripts/verify-perf-browser.ts). */
export async function storageStateFor(browser: Browser, email: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(1500);
    }
  }
  if (lastErr) throw lastErr;
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  let navigated = false;
  for (let attempt = 0; attempt < 8 && !navigated; attempt++) {
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 8000 });
      navigated = true;
    } catch {
      /* not hydrated yet — click again */
    }
  }
  if (!navigated) throw new Error(`login as ${email} never navigated`);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

/* ─────────────────────────────── measurement ────────────────────────────── */

type Role = "author" | "student" | "anon";

interface RouteSpec {
  /** Budget-table key (route pattern). */
  key: string;
  /** Concrete path to load. */
  path: string;
  role: Role;
  /** Named budget, else DEFAULT_BUDGET_KB (only asserted with --all). */
  top5: boolean;
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** One cold load in a FRESH context (empty HTTP cache) → gzip wire bytes of
 *  every script resource, per the baseline definition. */
async function measureOnce(
  browser: Browser,
  state: StorageState | null,
  routePath: string
): Promise<{ jsWireBytes: number; jsCount: number }> {
  const ctx = await browser.newContext(state ? { storageState: state } : undefined);
  const page = await ctx.newPage();
  page.setDefaultTimeout(90_000);
  try {
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        await page.goto(BASE + routePath, { waitUntil: "load", timeout: 90_000 });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await page.waitForTimeout(1500);
      }
    }
    if (lastErr) throw lastErr;
    // Content-readiness heuristic + settle window for late/lazy chunks —
    // the same convention as docs/perf/baseline/perf-baseline.mjs.
    await page
      .waitForFunction(
        () => ((document.querySelector("main") ?? document.body) as HTMLElement).innerText.trim().length > 40,
        undefined,
        { timeout: 45_000 }
      )
      .catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    return await page.evaluate(() => {
      const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      // The route's OWN JS = scripts whose fetch started before the load event
      // settled (initial chunks + hydration-critical imports). Scripts fetched
      // AFTER load are B4's idle-time viewport/hover prefetches of OTHER
      // routes' chunks — counting those would make every route pay its
      // neighbors' budgets and penalize prefetching, which §2 mandates. The
      // +500ms grace catches dynamic imports kicked off during hydration.
      const loadCutoff = nav && nav.loadEventEnd > 0 ? nav.loadEventEnd + 500 : Infinity;
      const scripts = res.filter(
        (r) =>
          (r.initiatorType === "script" ||
            r.name.endsWith(".js") ||
            r.name.includes("/_next/static/chunks/")) &&
          !r.name.endsWith(".css") && // stylesheet chunks are not JS
          r.startTime <= loadCutoff
      );
      return {
        jsWireBytes: scripts.reduce((s, r) => s + (r.encodedBodySize || 0), 0),
        jsCount: scripts.length,
      };
    });
  } finally {
    await ctx.close();
  }
}

/* ────────────────────────────────── main ────────────────────────────────── */

async function main() {
  const all = process.argv.includes("--all");
  const { url, anon } = loadEnv();
  if (!url || !anon) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (process.env or .env.local)"
    );
  }

  ensureBuild();
  const server = await ensureServer();
  const killServer = () => {
    if (server && server.exitCode === null) server.kill("SIGTERM");
  };
  process.on("exit", killServer);

  const author = await provisionUser(url, anon, "author");
  const student = await provisionUser(url, anon, "student");
  const fixture = await provisionCourse(author);

  // Enrollment (own-row insert under RLS; requires the live publication —
  // same shape as /api/learn/enroll).
  {
    const { error } = await student.client
      .from("enrollments")
      .insert({ course_id: fixture.courseId, user_id: student.userId });
    if (error) throw new Error(`enrollment insert: ${error.message}`);
  }

  const routes: RouteSpec[] = [
    { key: "/dashboard", path: "/dashboard", role: "author", top5: true },
    { key: "/studio", path: `/studio?course=${fixture.courseId}`, role: "author", top5: true },
    {
      key: "/learn/[slug]/[lessonId]",
      path: `/learn/${fixture.slug}/${fixture.lessonId}`,
      role: "student",
      top5: true,
    },
    {
      key: "/studio/[courseId]/analytics",
      path: `/studio/${fixture.courseId}/analytics`,
      role: "author",
      top5: true,
    },
    { key: "/marketing", path: "/marketing", role: "author", top5: true },
    // ── measured only with --all (DEFAULT_BUDGET_KB each) ──
    { key: "/marketplace", path: "/marketplace", role: "author", top5: false },
    { key: "/settings", path: "/settings", role: "author", top5: false },
    { key: "/analytics", path: "/analytics", role: "author", top5: false },
    { key: "/exports", path: "/exports", role: "author", top5: false },
    { key: "/home", path: "/home", role: "student", top5: false },
    { key: "/my-courses", path: "/my-courses", role: "student", top5: false },
    { key: "/explore", path: "/explore", role: "student", top5: false },
    { key: "/learn/[slug]", path: `/learn/${fixture.slug}`, role: "student", top5: false },
    { key: "/ (intro)", path: "/", role: "anon", top5: false },
    { key: "/educators", path: "/educators", role: "anon", top5: false },
    { key: "/login", path: "/login", role: "anon", top5: false },
  ];
  const toMeasure = routes.filter((r) => r.top5 || all);

  const browser = await chromium.launch();
  const results: {
    key: string;
    budgetKb: number;
    runsKb: number[];
    medianKb: number;
    ok: boolean;
  }[] = [];
  try {
    const states: Record<Role, StorageState | null> = {
      author: await storageStateFor(browser, author.email),
      student: await storageStateFor(browser, student.email),
      anon: null,
    };
    console.log(`\n# measuring ${toMeasure.length} route(s), ${RUNS_PER_ROUTE} cold runs each…`);

    for (const route of toMeasure) {
      const budgetKb = BUDGETS[route.key] ?? DEFAULT_BUDGET_KB;
      const runs: number[] = [];
      // Warmup (un-measured): the server's FIRST render of a route is slow
      // (module init), which delays loadEventEnd enough for post-load
      // deferred chunks to race into the cutoff window — a cold-SERVER
      // artifact, not route JS. Measured runs are browser-cold/server-warm,
      // matching the Phase-A baseline conditions.
      await measureOnce(browser, states[route.role], route.path);
      for (let i = 0; i < RUNS_PER_ROUTE; i++) {
        const m = await measureOnce(browser, states[route.role], route.path);
        if (m.jsCount === 0) throw new Error(`${route.key}: zero script resources measured`);
        runs.push(m.jsWireBytes);
      }
      const med = median(runs);
      const medKb = med / 1024;
      const ok = medKb <= budgetKb;
      results.push({
        key: route.key,
        budgetKb,
        runsKb: runs.map((b) => b / 1024),
        medianKb: medKb,
        ok,
      });
      console.log(
        `  ${ok ? "·" : "✗"} ${route.key}: ${medKb.toFixed(1)} KB gz (budget ${budgetKb})`
      );
    }
  } finally {
    await browser.close();
    // Cleanup: the course cascades modules/lessons/blocks/publications.
    await author.client.from("courses").delete().eq("id", fixture.courseId);
    killServer();
    if (server) console.log("# stopped the self-started next server (port 3100)");
  }

  /* ── report ── */
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`\nROUTE JS BUDGETS — gzip wire bytes (script resources), median of ${RUNS_PER_ROUTE}\n`);
  console.log(
    pad("route", 34) + pad("budget", 10) + pad("run1", 10) + pad("run2", 10) + pad("median", 10) + "status"
  );
  console.log("-".repeat(84));
  for (const r of results) {
    console.log(
      pad(r.key, 34) +
        pad(`${r.budgetKb} KB`, 10) +
        pad(`${r.runsKb[0].toFixed(0)} KB`, 10) +
        pad(`${(r.runsKb[1] ?? r.runsKb[0]).toFixed(0)} KB`, 10) +
        pad(`${r.medianKb.toFixed(1)} KB`, 10) +
        (r.ok ? "PASS" : `FAIL (+${(r.medianKb - r.budgetKb).toFixed(1)} KB over)`)
    );
  }
  console.log("");
  for (const r of results) {
    check(
      `${r.key} ≤ ${r.budgetKb} KB`,
      r.ok,
      `${r.medianKb.toFixed(1)} KB${r.ok ? "" : ` — over by ${(r.medianKb - r.budgetKb).toFixed(1)} KB`}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(
      "\nBUDGET BREACH — a route ships more JS than its budget (BUDGETS map, scripts/verify-bundle-budgets.ts)." +
        "\nEither cut the regression (dynamic-import the heavy dep, move it server-side) or renegotiate the" +
        "\nbudget explicitly in that ONE map (never silently)."
    );
    process.exit(1);
  }
}

// Run only as a CLI — verify-lighthouse-budgets.ts imports the helpers above
// (BUDGETS, ensureServer, provisionUser, provisionCourse, storageStateFor).
if (process.argv[1]?.includes("verify-bundle-budgets")) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
