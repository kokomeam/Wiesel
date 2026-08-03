/**
 * Portal-split BROWSER test — drives the NEW student/creator portal surfaces
 * through Playwright chromium against the dev server + live Supabase.
 * Run: `PORTAL_BROWSER_BASE=http://localhost:3001 npx tsx scripts/verify-portal-browser.ts`
 * (a dev server carrying the redesign must already be running).
 *
 * Covers the portal-split redesign end to end:
 *   login → role-picked signup → /home onboarding + AI-tutor preview →
 *   /explore → enroll on /learn/{slug} → /home continue hero → /my-courses
 *   filter chips → responsive 390 → lesson player → portal switching
 *   (learner ⇄ creator) → creator dashboard course card (real learner count).
 *
 * Pre-migration-safe: the roles migration (20260708000000) is NOT assumed
 * applied. Learner signup pushes to /home from client role state (works in
 * both worlds); author sign-in with no redirectTo falls back to /dashboard
 * (the profiles.role select 400s pre-migration). my_learning() may lack
 * is_live/avg_rating — the UI degrades, so nothing here asserts on ratings.
 *
 * 2026-07-11 wave (course covers + creator identity + landing redesign):
 * sections 14–16 cover the redesigned /learn landing (includes list,
 * curriculum accordion, medallions, instructor section), the Explore card
 * media zones, and the REAL /settings profile editor. A startup probe
 * detects whether migration 20260711000000 (profiles.headline/bio +
 * course_landing_extras) is applied and relaxes the new-column assertions
 * when it isn't — the suite passes in BOTH modes.
 */

import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  createBlock,
  createLesson,
  createModule,
  createSlide,
  newRowId,
} from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import type { CourseDocument, SlideDeckBlock } from "@/lib/course/types";

const BASE = process.env.PORTAL_BROWSER_BASE ?? "http://localhost:3000";
const SHOTS =
  "/private/tmp/claude-501/-Users-admin-Desktop-App/d423f8e0-e8cd-4c79-a656-61fb44a6fcbb/scratchpad/shots";

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

/** API-provisioned throwaway user (author). Fresh every run — see the reuse
 *  warning in verify-learn-browser.ts. */
async function provisionUser(url: string, anon: string, tag: string) {
  const email = `portal-btest-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  console.log(`# provisioned ${email}`);
  return { client, userId: data.user.id, email, password };
}

/**
 * Migration probe: is the 2026-07-11 covers/identity migration applied?
 * An authed select of profiles.headline errors (42703 via PostgREST) when the
 * column doesn't exist yet — that error IS the signal, not a failure.
 */
async function detectIdentityMigration(
  client: ReturnType<typeof createClient<Database>>
): Promise<boolean> {
  const { error } = await client.from("profiles").select("headline").limit(1);
  return !error;
}

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

/** Assert the page never scrolls horizontally at the current viewport. */
async function assertNoHOverflow(page: Page, label: string) {
  const { sw, iw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  check(`no horizontal overflow @ ${label}`, sw <= iw + 1, `scrollWidth=${sw} innerWidth=${iw}`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env");
  const ping = await fetch(BASE).catch(() => null);
  if (!ping || !ping.ok) throw new Error(`No dev server at ${BASE} — run npm run dev first`);

  // ── Author + fixture course (API-provisioned; student signs up via the UI) ──
  const author = await provisionUser(url, anon, "author");
  const migrated = await detectIdentityMigration(author.client);
  console.log(
    migrated
      ? "# MIGRATION MODE — 20260711 identity columns/RPC present, full assertions"
      : "# ⚠ PRE-MIGRATION MODE — new-column assertions relaxed (20260711000000 not applied)"
  );
  const studentEmail = `portal-btest-student-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const studentPassword = "Test-passw0rd!";
  const studentName = "Sam Learner";

  /* Fixture: 1 module · lesson A = 2-slide deck (Next-slide test) · B = lecture. */
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];
  const lessonA = createLesson("Watch the slides", 0);
  lessonA.blocks = [deck];
  const lessonB = createLesson("Reading only", 1);
  lessonB.blocks = [createBlock("lecture_text", 0)];
  const mod = createModule("Module 1", 0);
  mod.lessons = [lessonA, lessonB];
  const courseId = newRowId();
  const doc: CourseDocument = {
    id: courseId,
    title: `Portal itest ${crypto.randomUUID().slice(0, 6)}`,
    description: "Portal browser fixture course.",
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
  const slug = published.publication.slug;
  console.log(`# published /learn/${slug}`);

  const browser = await chromium.launch();
  const cleanup = async () => {
    await browser.close();
    await author.client.from("courses").delete().eq("id", courseId);
  };

  try {
    const studentCtx: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await studentCtx.newPage();
    // Dev server compiles each route on first hit (this is a large app), so
    // first navigations can be slow — be generous everywhere.
    page.setDefaultTimeout(60000);

    /* ── 1. Login → Create one → role cards ── */
    console.log("\n1. Login → sign-up role cards");
    await gotoRetry(page, `${BASE}/login`);
    // A prod server serves the shell fast enough that a single click can land
    // BEFORE React hydrates (no handler yet → silent no-op) — retry the
    // toggle until the signup cards actually appear.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.getByRole("button", { name: "Create one" }).click();
      try {
        await page.getByText("I'm here to learn").waitFor({ timeout: 3000 });
        break;
      } catch {
        /* not hydrated yet — click again */
      }
    }
    await page.getByText("I'm here to learn").waitFor({ timeout: 15000 });
    check(
      "both role cards render on signup",
      (await page.getByText("I'm here to learn").count()) > 0 &&
        (await page.getByText("I'm here to teach").count()) > 0
    );
    await page.screenshot({ path: `${SHOTS}/login-signup.png` });

    /* ── 2. Sign up a STUDENT (learner card) → /home onboarding + tutor ── */
    console.log("\n2. Student signup → /home onboarding");
    await page.getByRole("radio", { name: /here to learn/ }).click();
    await page.getByLabel("Your name").fill(studentName);
    await page.fill('input[type="email"]', studentEmail);
    await page.fill('input[type="password"]', studentPassword);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL("**/home", { timeout: 90000 });
    console.log(`# signed up ${studentEmail}`);
    await page.getByText("Start your learning journey").waitFor({ timeout: 60000 });
    check(
      "student lands on /home empty-state onboarding",
      (await page.getByText("Start your learning journey").count()) > 0 &&
        (await page.getByText("Find your first course").count()) > 0
    );
    check(
      "AI-tutor preview panel is present",
      (await page.getByRole("region", { name: "AI tutor preview" }).count()) > 0
    );

    /* ── 3. Tutor preview: type → canned reply ── */
    console.log("\n3. Tutor preview reply");
    await page.locator("#tutor-preview-input").fill("Can you explain this lesson simply?");
    await page.getByRole("button", { name: "Send message" }).click();
    await page
      .getByText(/asking for the simple version is how the pros learn/)
      .waitFor({ timeout: 10000 });
    check("tutor returns a canned assistant reply", true);

    /* ── 4. Explore ── */
    console.log("\n4. Explore catalog");
    await gotoRetry(page, `${BASE}/explore`);
    await page.getByRole("heading", { name: "Explore" }).waitFor({ timeout: 60000 });
    // Other tests may have left live public courses — accept cards OR the empty
    // state (learner-voiced). Wait for whichever settles.
    const hasListing = (await page.getByText("View & enroll").count()) > 0;
    const hasEmpty = (await page.getByText("No courses published yet").count()) > 0;
    if (!hasListing && !hasEmpty) {
      await page
        .getByText(/View & enroll|Enrolled — continue|No courses published yet/)
        .first()
        .waitFor({ timeout: 60000 });
    }
    check(
      "explore renders header + listings or the empty state",
      (await page.getByText(/View & enroll|Enrolled — continue|No courses published yet/).count()) >
        0
    );

    /* ── 14. Explore card structure (2026-07-11 media-zone redesign) ──
       The fixture is published+public, so ITS listing card must exist even
       when other tests left the catalog non-empty. */
    console.log("\n14. Explore card structure");
    const fixtureCard = page
      .locator('[data-ai-tool="marketplace-course-card"]', { hasText: doc.title })
      .first();
    await fixtureCard.waitFor({ timeout: 60000 });
    check("fixture listing card carries data-ai-tool=marketplace-course-card", true);
    check(
      "card title renders as text in the card BODY (h3)",
      (await fixtureCard.locator("h3").filter({ hasText: doc.title }).count()) > 0
    );
    // Media zone = the aspect-ratio box above the body: an uploaded cover
    // <img> OR the deterministic gradient CoverArt fallback (.grain root).
    const mediaZone = fixtureCard.locator('div[class*="aspect-"]').first();
    check(
      "media zone holds a cover img or the gradient fallback",
      (await mediaZone.locator("img, .grain").count()) > 0
    );
    await page.screenshot({ path: `${SHOTS}/explore.png` });

    /* ── 5. Enroll on the course landing ── */
    console.log("\n5. Enroll from /learn landing");
    await gotoRetry(page, `${BASE}/learn/${slug}`);
    await page.getByText(doc.title).first().waitFor({ timeout: 60000 });
    check("course landing shows the fixture title", true);

    // 11. Accordion aria-expanded toggles (module header button). The
    // 2026-07-11 CourseOutline renders the raw module title (no "Module N:"
    // prefix) — the fixture module is literally named "Module 1".
    const moduleBtn = page
      .getByRole("button", { name: /Module 1/ })
      .first();
    await moduleBtn.waitFor({ timeout: 15000 });
    const before = await moduleBtn.getAttribute("aria-expanded");
    await moduleBtn.click();
    // Give the state a tick to flush.
    await page.waitForTimeout(200);
    const after = await moduleBtn.getAttribute("aria-expanded");
    check(
      "module accordion aria-expanded toggles",
      before !== null && after !== null && before !== after,
      `before=${before} after=${after}`
    );
    await page.screenshot({ path: `${SHOTS}/course-landing.png` });

    // Retry-click: a prod server serves HTML before React hydrates, so a
    // single click can land handler-less and silently no-op (same class of
    // race as the login "Create one" toggle). Re-click only while the enroll
    // button is still present (post-enroll the card swaps it out).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const enrollBtn = page.locator('[data-ai-tool="learn-enroll"]').first();
      if ((await enrollBtn.count()) > 0 && (await enrollBtn.isVisible().catch(() => false))) {
        await enrollBtn.click().catch(() => {});
      }
      try {
        await page.getByText("Your progress", { exact: true }).waitFor({ timeout: 12000 });
        break;
      } catch {
        // Diagnose instead of silently looping: surface the EnrollButton's
        // inline error (rose text) and the button state.
        const rose = await page
          .locator(".text-rose-600")
          .allInnerTexts()
          .catch(() => [] as string[]);
        console.log(
          `  … enroll attempt ${attempt + 1} not enrolled yet` +
            ` (button=${await enrollBtn.count().catch(() => -1)}` +
            `${rose.length ? `, error="${rose.join(" | ")}"` : ""})`
        );
      }
    }
    // exact:true — the PRE-enroll card contains "…track your progress." and
    // getByText is a case-insensitive substring match, so a loose wait races
    // ahead of the enroll POST + refresh (and /home then correctly shows no
    // enrollment yet). The exact <p>Your progress</p> only exists enrolled;
    // the lesson link is enrolled-only too.
    await page.getByText("Your progress", { exact: true }).waitFor({ timeout: 60000 });
    await page.locator(`a[href*="/learn/${slug}/"]`).first().waitFor({ timeout: 60000 });
    check("enrolled — progress card appears on the landing", true);

    /* ── 15. Landing redesign (2026-07-11): includes list, curriculum,
       medallion, instructor section — asserted on the ENROLLED landing. ── */
    console.log("\n15. Landing redesign");
    // The fixture has content blocks (deck + lecture), so the derived
    // "This course includes" list must render in the conversion card.
    check(
      'conversion card lists "This course includes"',
      (await page.getByText("This course includes", { exact: true }).count()) > 0
    );
    check(
      'curriculum section has the "Course content" heading',
      (await page.getByRole("heading", { name: "Course content" }).count()) > 0
    );
    // "Expand all" only renders for >1 module — read the module count off the
    // page (accordion buttons aria-controls "…-module-N") so the assertion
    // stays truthful if the fixture ever grows a second module.
    const moduleCount = await page.locator('button[aria-controls*="module"]').count();
    const expandAllCount = await page
      .getByRole("button", { name: /Expand all|Collapse all/ })
      .count();
    check(
      moduleCount > 1
        ? '"Expand all" present with multiple modules'
        : '"Expand all" hidden for a single module',
      moduleCount > 1 ? expandAllCount > 0 : expandAllCount === 0,
      `modules=${moduleCount} expandAll=${expandAllCount}`
    );
    check(
      'module number medallion "1" renders in the accordion header',
      (await moduleBtn.locator("span").filter({ hasText: /^1$/ }).count()) > 0
    );
    // Instructor section rides the course_landing_extras RPC: rows exist post-
    // migration (the fixture has a live publication); pre-migration the RPC is
    // missing and the section must honestly disappear.
    if (migrated) {
      check(
        "instructor section renders post-migration",
        (await page.getByText("Meet your instructor", { exact: true }).count()) > 0
      );
    } else {
      check(
        "instructor section ABSENT pre-migration (honest degradation)",
        (await page.getByText("Meet your instructor", { exact: true }).count()) === 0
      );
    }
    await page.screenshot({ path: `${SHOTS}/landing-redesign.png` });

    /* ── 6. /home continue hero for the enrolled course ── */
    console.log("\n6. /home continue hero");
    await gotoRetry(page, `${BASE}/home`);
    await page.getByText("Pick up where you left off").waitFor({ timeout: 60000 });
    const heroTitles = await page.getByText(doc.title).count();
    const heroLinks = await page.locator(`a[href*="/learn/${slug}"]`).count();
    check(
      "continue hero shows the course + a Continue link into /learn",
      heroTitles > 0 && heroLinks > 0,
      `title=${heroTitles} link=${heroLinks}`
    );
    await page.screenshot({ path: `${SHOTS}/student-home.png` });

    /* ── 12. Responsive @ 390 on /home, /explore, /learn/{slug} ── */
    console.log("\n12. Responsive 390x844");
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoRetry(page, `${BASE}/home`);
    // Wait on the always-present greeting (data-independent) rather than the
    // hero eyebrow, so an overflow assertion never hinges on hero data.
    await page.getByRole("heading", { name: /Welcome back/ }).waitFor({ timeout: 60000 });
    await assertNoHOverflow(page, "/home");
    await page.screenshot({ path: `${SHOTS}/student-home-390.png` });
    await gotoRetry(page, `${BASE}/explore`);
    await page.getByRole("heading", { name: "Explore" }).waitFor({ timeout: 60000 });
    await assertNoHOverflow(page, "/explore");
    await gotoRetry(page, `${BASE}/learn/${slug}`);
    await page.getByText(doc.title).first().waitFor({ timeout: 60000 });
    await assertNoHOverflow(page, "/learn/{slug}");
    await page.setViewportSize({ width: 1440, height: 900 });

    /* ── 7. /my-courses list + filter chips ── */
    console.log("\n7. /my-courses filter chips");
    await gotoRetry(page, `${BASE}/my-courses`);
    await page.getByRole("heading", { name: "My courses" }).waitFor({ timeout: 60000 });
    await page.getByText(doc.title).first().waitFor({ timeout: 60000 });
    check(
      "my-courses lists the course with a progress bar",
      (await page.getByText(doc.title).count()) > 0 &&
        (await page.getByRole("progressbar").count()) > 0
    );
    const filterGroup = page.getByRole("group", { name: "Filter courses" });
    await filterGroup.getByRole("button", { name: /In progress/ }).click();
    await page.waitForTimeout(150);
    check(
      '"In progress" chip keeps the course visible',
      (await page.getByText(doc.title).count()) > 0
    );
    await filterGroup.getByRole("button", { name: /Completed/ }).click();
    await page.getByText("No completed courses yet").waitFor({ timeout: 10000 });
    check(
      '"Completed" chip hides the in-progress course',
      (await page.getByText(doc.title).count()) === 0
    );
    // Reset to All for the screenshot.
    await filterGroup.getByRole("button", { name: /All/ }).click();
    await page.getByText(doc.title).first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: `${SHOTS}/my-courses.png` });

    /* ── 13. Lesson player: sticky pill + slide advance ── */
    console.log("\n13. Lesson player");
    await gotoRetry(page, `${BASE}/learn/${slug}/${lessonA.id}`);
    await page.getByText(/Lesson 1 of 2/).first().waitFor({ timeout: 60000 });
    check("sticky lesson pill / header renders", true);
    await page.getByLabel("Next slide").last().waitFor({ timeout: 60000 });
    check("slide player rendered", (await page.getByText("1 / 2").count()) > 0);
    await page.getByLabel("Next slide").last().click();
    await page.waitForTimeout(400);
    check("slide advances to 2 / 2", (await page.getByText("2 / 2").count()) > 0);
    await page.screenshot({ path: `${SHOTS}/lesson.png` });

    /* ── 8. Student → creator studio switch → creator empty onboarding ── */
    console.log("\n8. Switch to creator studio (empty onboarding)");
    await gotoRetry(page, `${BASE}/home`);
    await page.getByText("Pick up where you left off").waitFor({ timeout: 60000 });
    await page.getByRole("link", { name: /Switch to creator studio/ }).click();
    await page.waitForURL("**/dashboard", { timeout: 60000 });
    await page.getByText("Create your first course").waitFor({ timeout: 60000 });
    check(
      "student's creator dashboard shows the empty-onboarding state",
      (await page.getByText("Create your first course").count()) > 0
    );

    /* ── 9. Author signs in (no redirectTo → /dashboard) + course card ── */
    console.log("\n9. Author dashboard (real learner count)");
    const authorCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const authorPage = await authorCtx.newPage();
    await gotoRetry(authorPage, `${BASE}/login`);
    await authorPage.fill('input[type="email"]', author.email);
    await authorPage.fill('input[type="password"]', author.password);
    await authorPage.getByRole("button", { name: "Sign in" }).click();
    await authorPage.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
    check("author sign-in lands on /dashboard (role-routed)", authorPage.url().includes("/dashboard"));
    if (!authorPage.url().includes("/dashboard")) await gotoRetry(authorPage, `${BASE}/dashboard`);
    await authorPage.getByText(doc.title).first().waitFor({ timeout: 60000 });
    check(
      "dashboard shows the fixture course card with 1 learner",
      (await authorPage.getByText(doc.title).count()) > 0 &&
        (await authorPage.getByText(/\b1 learner\b/).count()) > 0
    );
    check(
      "course card links to /studio?course= and /analytics",
      (await authorPage.locator('a[href*="/studio?course="]').count()) > 0 &&
        (await authorPage.locator('a[href*="/analytics"]').count()) > 0
    );
    await authorPage.screenshot({ path: `${SHOTS}/creator-dashboard-author.png` });

    /* ── 9b. Creator identity band (2026-07-11) — edit-in-place profile ── */
    console.log("\n9b. Dashboard identity band");
    const identityBand = authorPage.locator('[data-ai-tool="dashboard-identity"]');
    await identityBand.waitFor({ timeout: 15000 });
    check("identity band renders at the top of the dashboard", await identityBand.isVisible());
    check(
      "band has the in-place photo affordance",
      (await authorPage.getByRole("button", { name: "Change profile photo" }).count()) > 0
    );
    await authorPage.locator('[data-ai-tool="identity-edit"]').click();
    // The name field starts BLANK for a null row value (the band never seeds
    // the email-prefix display fallback into the editor — persisting it into
    // world-readable profiles.display_name would leak the email local-part),
    // and zod min(1) blocks the save until a name is typed.
    await authorPage.getByLabel("Display name").fill("Portal Band Author");
    await authorPage.getByLabel("Headline").fill("Band headline · portal suite");
    await authorPage.getByLabel("Bio").fill("Band bio typed on the dashboard.");
    await authorPage.locator('[data-ai-tool="identity-save"]').click();
    if (migrated) {
      // Editor closes and the band displays the persisted headline.
      await authorPage
        .getByText("Band headline · portal suite")
        .waitFor({ timeout: 30000 });
      check("band shows the saved headline post-migration", true);
    } else {
      // Pre-migration the editor STAYS OPEN with the unlock notice — closing
      // would display headline/bio text that never persisted.
      await authorPage
        .getByText("will unlock once the pending database migration")
        .first()
        .waitFor({ timeout: 30000 });
      check("band keeps the editor open with the unlock notice pre-migration", true);
      await authorPage.getByRole("button", { name: "Cancel" }).click();
    }
    await authorPage.screenshot({ path: `${SHOTS}/dashboard-identity-band.png` });

    /* ── 10. Creator sidebar → Switch to learner home ── */
    console.log("\n10. Creator sidebar learner-home switch");
    const learnerSwitch = authorPage.getByRole("link", { name: /Switch to learner home/ });
    await learnerSwitch.waitFor({ timeout: 15000 });
    check(
      'creator sidebar has "Switch to learner home" → /home',
      (await learnerSwitch.getAttribute("href")) === "/home"
    );

    /* ── 16. Settings — the REAL creator profile editor (2026-07-11) ── */
    console.log(`\n16. Settings profile editor${migrated ? "" : " (pre-migration)"}`);
    await gotoRetry(authorPage, `${BASE}/settings`);
    const profileForm = authorPage.locator('[data-ai-tool="settings-profile-form"]');
    await profileForm.waitFor({ timeout: 60000 });
    check("settings profile form renders", await profileForm.isVisible());
    const newDisplayName = `Portal Author ${crypto.randomUUID().slice(0, 6)}`;
    await authorPage.getByLabel("Display name").fill(newDisplayName);
    // Headline/bio are typed in BOTH modes — pre-migration the save falls back
    // to {display_name, avatar_url} and surfaces the amber unlock notice.
    await authorPage.getByLabel("Headline").fill("Fixture coach · portal suite");
    await authorPage.getByLabel("Bio").fill("Bio written by the portal browser suite.");
    check(
      "live preview mirrors the typed name before saving",
      (await authorPage.getByText(newDisplayName, { exact: true }).count()) > 0
    );
    await authorPage.locator('[data-ai-tool="settings-save"]').click();
    // exact:true — the amber notice ends in "…were saved." and getByText is a
    // case-insensitive substring match; only the flash is the bare "Saved".
    await authorPage.getByText("Saved", { exact: true }).waitFor({ timeout: 30000 });
    check("save confirms with the Saved flash", true);
    const unlockNotices = await authorPage
      .getByText("will unlock once the pending database migration")
      .count();
    if (migrated) {
      check("no pre-migration unlock notice post-migration", unlockNotices === 0);
      const { data: savedProfile } = await author.client
        .from("profiles")
        .select("display_name, headline")
        .eq("id", author.userId)
        .maybeSingle();
      check(
        "profile row persisted name + headline",
        savedProfile?.display_name === newDisplayName &&
          savedProfile?.headline === "Fixture coach · portal suite",
        JSON.stringify(savedProfile)
      );
    } else {
      check("pre-migration amber unlock notice shown", unlockNotices > 0);
      const { data: savedProfile } = await author.client
        .from("profiles")
        .select("display_name")
        .eq("id", author.userId)
        .maybeSingle();
      check(
        "display name still persisted via the legacy-column retry",
        savedProfile?.display_name === newDisplayName,
        JSON.stringify(savedProfile)
      );
    }
    await authorPage.screenshot({ path: `${SHOTS}/settings-profile.png` });
  } finally {
    await cleanup();
    console.log("\n# cleaned up course (throwaway users remain)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
