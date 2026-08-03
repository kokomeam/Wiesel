/**
 * TUTOR-1 Wave 2 · package D — AC-W2Q.3 BROWSER test. Drives the REAL /home
 * "Worth a review" rail through Playwright chromium against a running dev server
 * + live Supabase, proving the mastery review source lights up the student home.
 *
 * Run (dev server must already be up; the orchestrator runs this — NOT the
 * build agent):
 *   `MASTERY_HOME_BASE=http://localhost:3000 npx tsx scripts/verify-mastery-home-browser.ts`
 *
 * WHAT IT PROVES (AC-W2Q.3):
 *   • The WEAK-with-upstream-gap learner (real mastery: node A "Scarcity" below
 *     threshold, high-leverage) signs in via the REAL /login and lands on /home;
 *     the "Worth a review" section renders a seeded CONCEPT TITLE ("Scarcity") —
 *     a bare concept name the legacy quiz heuristic can NEVER produce (the
 *     heuristic surfaces quiz block titles like "Scarcity check", never the bare
 *     concept). So seeing "Scarcity" is proof the mastery source drove the rail.
 *   • The ZERO-EVIDENCE cold learner signs in → /home falls back to the legacy
 *     heuristic/empty state (no materialized mastery rows), and NO seeded concept
 *     title appears.
 *
 * DATA PREP: reuses seedMasteryCohort (the six-learner cohort) + the SAME
 * refold → writeMastery → materializeMasteryResults steps the int suite drives,
 * so the /home rail reads real materialized rows. ZERO MODEL SPEND (nothing here
 * imports a model client). A 7th zero-evidence learner is provisioned + enrolled
 * (no evidence) for the cold-start half.
 *
 * Conventions mirror verify-portal-browser.ts: base URL env, hydration-safe
 * retry-clicks (a prod/dev server can serve HTML before React hydrates so a lone
 * click no-ops), explicit pass/fail counts, nonzero exit on failure. Excluded
 * from tsconfig (the house pattern for playwright scripts — playwright is a
 * temporary dev dep).
 */

import { mkdirSync } from "node:fs";
import dns from "node:dns";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  seedMasteryCohort,
  loadMasteryEnv,
  type MasteryCohort,
} from "./seed-fixture-mastery";
import { refoldLearnerCourse } from "@/lib/tutor/mastery/loader";
import { writeMastery } from "@/lib/tutor/mastery/writer";
import { materializeMasteryResults } from "@/lib/tutor/mastery/queries";
import { resolveMasteryConfig } from "@/lib/tutor/mastery/config";

// Node prefers supabase.co's IPv6 record; pin IPv4-first on this IPv6-broken net.
dns.setDefaultResultOrder("ipv4first");


const BASE = process.env.MASTERY_HOME_BASE ?? "http://localhost:3000";
const SHOTS =
  "/private/tmp/claude-501/-Users-admin-Desktop-App/d343ebf3-d84b-44ae-910d-5a5fafa16b2e/scratchpad/shots-mastery";

const CFG = resolveMasteryConfig();

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

/** This network drops connections sporadically mid-run — retry transport errors. */
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

/** Navigate with retries — the dev server's heavy first-compiles can trip a
 *  transient net::ERR_NETWORK_IO_SUSPENDED if the machine idles mid-navigation. */
async function gotoRetry(page: Page, url: string) {
  let lastErr: unknown;
  for (let i = 0; i < 3; i += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      return;
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(1500);
    }
  }
  throw lastErr;
}

/** Sign in through the REAL /login form and wait for /home. Hydration-safe:
 *  a prod/dev server can serve the login HTML before React attaches handlers,
 *  so a lone click no-ops — retry the Sign-in click until we leave /login. */
async function signInViaLogin(page: Page, email: string, password: string): Promise<void> {
  await gotoRetry(page, `${BASE}/login?redirectTo=/home`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  // ⚠ NOT the "**/home" glob: the login URL is /login?redirectTo=/home, which
  // ENDS in "/home" and therefore MATCHES the glob — a false-positive "signed
  // in" while still sitting on the login form (found the hard way: the form
  // submitted empty → "missing email or phone" → the helper returned anyway).
  // Match the PATHNAME exactly instead.
  const onHome = (url: URL) => url.pathname === "/home";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.getByRole("button", { name: "Sign in" }).click().catch(() => {});
    try {
      await page.waitForURL(onHome, { timeout: 12000 });
      return;
    } catch {
      // Not hydrated / not navigated yet — re-fill (a re-render may have cleared
      // the fields) and click again.
      await page.fill('input[type="email"]', email).catch(() => {});
      await page.fill('input[type="password"]', password).catch(() => {});
    }
  }
  await page.waitForURL(onHome, { timeout: 60000 });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const env = loadMasteryEnv();
  const ping = await retryingFetch(BASE).catch(() => null);
  if (!ping || !ping.ok) throw new Error(`No dev server at ${BASE} — run npm run dev first`);

  // ── Data prep: seed the cohort, refold + write + materialize (same as int) ──
  console.log("# seeding the mastery cohort + refold/materialize (zero model spend)");
  const cohort: MasteryCohort = await seedMasteryCohort(env);
  const admin = cohort.admin;
  const { courseId } = cohort;
  const NOW = new Date().toISOString();

  for (const learner of cohort.learners) {
    const { rows } = await refoldLearnerCourse(admin, {
      userId: learner.userId,
      courseId,
      nowIso: NOW,
      cfg: CFG,
    });
    await writeMastery(admin, { userId: learner.userId, courseId, rows, nowIso: NOW });
  }

  // A 7th ZERO-EVIDENCE learner: enroll (real RLS insert), emit nothing → no
  // mastery rows → /home must fall back to the legacy heuristic/empty state.
  const coldEmail = `mastery-home-cold-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const coldPassword = "Test-passw0rd!";
  const coldSignup = await retryingFetch(`${env.url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: env.anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email: coldEmail, password: coldPassword }),
  });
  if (!coldSignup.ok) throw new Error(`cold signup failed: ${await coldSignup.text()}`);
  const coldClient = createClient<Database>(env.url, env.anon, { global: { fetch: retryingFetch } });
  const coldSignin = await coldClient.auth.signInWithPassword({ email: coldEmail, password: coldPassword });
  if (coldSignin.error || !coldSignin.data.user) throw new Error(`cold signin failed: ${coldSignin.error?.message}`);
  const coldUserId = coldSignin.data.user.id;
  const enrollCold = await coldClient.from("enrollments").insert({ course_id: courseId, user_id: coldUserId });
  if (enrollCold.error) throw new Error(`cold enroll failed: ${enrollCold.error.message}`);

  // Materialize AFTER the cold learner exists (their zero rows → no queue rows).
  await materializeMasteryResults(admin, { nowIso: NOW });

  const weak = cohort.learners.find((l) => l.profile === "weak-with-upstream-gap")!;
  // The mastery-sourced concept title the weak learner's queue tops out on — the
  // bare concept name (node A), which the legacy quiz heuristic can never emit
  // (it would show the quiz BLOCK title "Scarcity check", never bare "Scarcity").
  const MASTERY_CONCEPT_TITLE = "Scarcity";
  const HEURISTIC_QUIZ_TITLE = "Scarcity check";

  const browser = await chromium.launch();
  let keepCourseForPostMortem = false;
  const cleanup = async () => {
    await browser.close();
    if (keepCourseForPostMortem) {
      console.log(`# post-mortem: course ${courseId} KEPT for inspection (delete manually)`);
      return;
    }
    await cohort.fixture.author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    /* ── 1. WEAK learner → /home shows the mastery-sourced concept title ── */
    console.log("\n1. Weak learner /home — mastery review source");
    const weakCtx: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const weakPage = await weakCtx.newPage();
    weakPage.setDefaultTimeout(60000);
    await signInViaLogin(weakPage, weak.email, weak.password);
    await weakPage.getByRole("heading", { name: /Welcome back/ }).waitFor({ timeout: 60000 });

    // The "Worth a review" section header is always present; the mastery item
    // renders the bare concept title inside it.
    await weakPage.getByRole("heading", { name: "Worth a review" }).waitFor({ timeout: 60000 });
    const reviewSection = weakPage.locator('section[aria-label="Worth a review"]');
    await reviewSection.waitFor({ timeout: 60000 });
    // Give the server-rendered rail a beat to settle (it's a server component, so
    // the content is in the initial HTML — but navigation may still be compiling).
    await weakPage.getByText(MASTERY_CONCEPT_TITLE, { exact: true }).first().waitFor({ timeout: 60000 });
    const conceptCount = await reviewSection.getByText(MASTERY_CONCEPT_TITLE, { exact: true }).count();
    check(
      `weak learner's "Worth a review" shows the mastery concept title "${MASTERY_CONCEPT_TITLE}"`,
      conceptCount > 0,
      `count=${conceptCount}`
    );
    // The "Below mastery" reason label is a mastery-only secondary line (the
    // heuristic secondary line is a lesson title) — a second, independent proof
    // the mastery source drove the rail.
    check(
      'the mastery reason label "Below mastery" renders (mastery-only secondary line)',
      (await reviewSection.getByText("Below mastery").count()) > 0
    );
    // It must NOT be the heuristic quiz-block title (would mean the heuristic won).
    check(
      `the review rail does NOT show the heuristic quiz title "${HEURISTIC_QUIZ_TITLE}"`,
      (await reviewSection.getByText(HEURISTIC_QUIZ_TITLE, { exact: true }).count()) === 0
    );
    await weakPage.screenshot({ path: `${SHOTS}/weak-home-mastery.png` });

    /* ── 2. ZERO-EVIDENCE learner → heuristic/empty state, no concept title ── */
    console.log("\n2. Zero-evidence learner /home — heuristic/empty fallback");
    const coldCtx: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const coldPage = await coldCtx.newPage();
    coldPage.setDefaultTimeout(60000);
    await signInViaLogin(coldPage, coldEmail, coldPassword);
    await coldPage.getByRole("heading", { name: /Welcome back/ }).waitFor({ timeout: 60000 });
    // /home keeps the "Welcome back" h1 in ALL THREE branches (error card /
    // onboarding empty state / the real dashboard) — wait for whichever branch
    // rendered and DIAGNOSE it, so a failure names the branch instead of
    // timing out silently.
    const branch = coldPage
      .locator(
        'section[aria-label="Worth a review"], [data-cold-branch], text="Couldn\'t load your courses", text="Start your learning journey"'
      )
      .first();
    try {
      await Promise.race([
        coldPage.getByRole("heading", { name: "Worth a review" }).waitFor({ timeout: 60000 }),
        coldPage.getByText("Couldn't load your courses").waitFor({ timeout: 60000 }),
        coldPage.getByText("Start your learning journey").waitFor({ timeout: 60000 }),
      ]);
    } catch (raceErr) {
      // NONE of the three branches appeared — dump what actually rendered.
      await coldPage.screenshot({ path: `${SHOTS}/cold-home-unknown-branch.png`, fullPage: true });
      const bodyText = (await coldPage.locator("body").innerText().catch(() => "<no body>")).slice(0, 2000);
      console.log(`# COLD /home UNKNOWN BRANCH — url=${coldPage.url()}\n# body text:\n${bodyText}`);
      keepCourseForPostMortem = true;
      throw raceErr;
    }
    void branch;
    if ((await coldPage.getByText("Couldn't load your courses").count()) > 0) {
      await coldPage.screenshot({ path: `${SHOTS}/cold-home-error-branch.png` });
      throw new Error("cold /home rendered the my_learning ERROR branch — see cold-home-error-branch.png");
    }
    if ((await coldPage.getByText("Start your learning journey").count()) > 0) {
      await coldPage.screenshot({ path: `${SHOTS}/cold-home-onboarding-branch.png` });
      throw new Error(
        "cold /home rendered the ONBOARDING branch (my_learning returned zero rows despite the enrollment) — see cold-home-onboarding-branch.png"
      );
    }
    const coldReview = coldPage.locator('section[aria-label="Worth a review"]');
    await coldReview.waitFor({ timeout: 60000 });
    // No mastery rows → pickReviewSource falls to the heuristic; the enrolled
    // cold learner has NO failing quizzes, so the section shows the empty state
    // ("Nothing to review") and NEVER a seeded concept title.
    check(
      "zero-evidence learner shows the heuristic empty state (Nothing to review)",
      (await coldReview.getByText("Nothing to review").count()) > 0
    );
    check(
      `zero-evidence learner's rail shows NO seeded concept title "${MASTERY_CONCEPT_TITLE}"`,
      (await coldReview.getByText(MASTERY_CONCEPT_TITLE, { exact: true }).count()) === 0
    );
    check(
      'zero-evidence learner shows NO mastery reason label "Below mastery"',
      (await coldReview.getByText("Below mastery").count()) === 0
    );
    await coldPage.screenshot({ path: `${SHOTS}/cold-home-heuristic.png` });
  } finally {
    await cleanup();
    console.log("\n# cleaned up course (throwaway users remain — clean in Supabase → Auth)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
