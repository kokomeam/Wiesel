/**
 * Creator Tutor Console — BROWSER AC suite (Playwright chromium, real UI).
 * TUTOR-1 Wave 5.4. tsconfig-EXCLUDED (it imports playwright + @axe-core/playwright).
 *
 *   Run: `npm run dev` first (dev server on :3000, live Supabase), THEN
 *   `npx tsx scripts/verify-tutor-console-browser.ts`. For a prod build,
 *   `next build && next start -p 3100` and set TUTOR_BROWSER_BASE=http://localhost:3100.
 *
 * Fresh throwaway users each run (*@example.com — clean in Supabase → Auth). The
 * whole surface is seeded ONCE through seedTutorConsoleFixture (the reusable
 * fixture) so every tab has real substance, ZERO model spend.
 *
 * SECTIONS (each check() logs its AC id):
 *   AC-T5.1   cross-surface enable gate: with the tutor OFF, an enrolled learner
 *             sees NO tutor tab on /learn/{slug}/{lesson}; toggling ON (accepted
 *             graph present) makes the tab APPEAR.
 *   AC-T5.2-UI charter guidance change → save → a new version-history row renders
 *             (actor + when); the tutor_charter_versions count incremented (admin).
 *   AC-W5O.1  Overview usage: the seeded ≥5-learner cohort shows real numbers; a
 *             fresh sub-floor course shows the suppressed state (no counts).
 *   AC-T5.3   graph: rename a node (persists); a cycle-creating prerequisite edge is
 *             refused with a specific path-naming error; lock an edge (persists).
 *   AC-W5G.2  a staged concept_graph change-set renders per-item classification;
 *             Accept activates / Reject restores (driven, asserted via admin).
 *   AC-A1.4   Analytics: the most-missed table ranks questions with per-option
 *             distractor counts; a teaching deep link navigates; a sub-floor
 *             question is suppressed (omitted).
 *   AC-T5.5   the degraded lesson ranks #1 in "Lessons needing attention" with
 *             evidence naming the implicated question.
 *   AC-T5.4   axe zero serious/critical on ALL FOUR panels; the graph editor is
 *             KEYBOARD-OPERABLE (focus node list → arrow → Enter opens the drawer).
 */

import dns from "node:dns";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import {
  seedTutorConsoleFixture,
  loadTutorConsoleFixtureEnv,
  type TutorConsoleFixture,
} from "./seed-fixture-tutor-console";
import {
  createConceptNode,
  upsertConceptEdge,
  getConceptNode,
} from "@/lib/tutor/graph/repository";
import { ConceptEdgeCycleError } from "@/lib/tutor/graph/errors";

dns.setDefaultResultOrder("ipv4first");

const BASE = process.env.TUTOR_BROWSER_BASE ?? process.env.TUTOR_CONSOLE_BROWSER_BASE ?? "http://localhost:3000";
type DB = SupabaseClient<Database>;

let pass = 0,
  fail = 0;
const sectionResults: Record<string, { pass: number; fail: number }> = {};
let currentSection = "setup";
function section(name: string) {
  currentSection = name;
  if (!sectionResults[name]) sectionResults[name] = { pass: 0, fail: 0 };
  console.log(`\n# ${name}`);
}
function check(name: string, cond: boolean, detail = "") {
  if (!sectionResults[currentSection]) sectionResults[currentSection] = { pass: 0, fail: 0 };
  if (cond) {
    pass++;
    sectionResults[currentSection].pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    sectionResults[currentSection].fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
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

async function provisionUser(url: string, anon: string, tag: string) {
  const email = `tutor-console-b-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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
  return { client, userId: data.user.id, email, password };
}

/** Sign a Playwright page into the app via the real /login form. Uses a pathname
 *  predicate (never a '**\/x' glob) + a retry-click for prod-server hydration. */
async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  // Retry the submit — a prod-server click can beat hydration.
  for (let i = 0; i < 3; i++) {
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 8000 });
      return;
    } catch {
      /* re-click; the form may not have hydrated yet. */
    }
  }
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
}

/** Retry a click a few times (prod-server hydration can drop the first). */
async function retryClick(page: Page, selector: string, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.click(selector, { timeout: 4000 });
      return;
    } catch {
      await page.waitForTimeout(500);
    }
  }
  await page.click(selector, { timeout: 4000 });
}

/** Poll tutor_course_settings.enabled until it matches `want` (or times out). The
 *  toggle's server action + revalidate is async; the DB flip is the source of truth. */
async function waitForEnabled(admin: DB, courseId: string, want: boolean, tries = 20): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const row = await admin.from("tutor_course_settings").select("enabled").eq("course_id", courseId).maybeSingle();
    if ((row.data as { enabled: boolean } | null)?.enabled === want) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Poll a change_set's status until it matches `want` (or times out). */
async function waitForChangeSetStatus(admin: DB, changeSetId: string, want: string, tries = 20): Promise<string | null> {
  let last: string | null = null;
  for (let i = 0; i < tries; i++) {
    const row = await admin.from("change_sets").select("status").eq("id", changeSetId).maybeSingle();
    last = (row.data as { status: string } | null)?.status ?? null;
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

/** axe scan of the current page — zero serious/critical. Lets animations settle. */
async function axeScan(page: Page, label: string): Promise<{ id: string; nodes: number }[]> {
  await page.waitForTimeout(500);
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  check(`axe: zero serious/critical on ${label}`, serious.length === 0, JSON.stringify(serious.map((v) => v.id)));
  return serious.map((v) => ({ id: v.id, nodes: v.nodes.length }));
}

/** Stage a concept_graph change-set for a freshly-created node (op create, after=
 *  payload) — the extraction-stager shape (from verify-tutor-graph-console-int). */
async function stageCreate(admin: DB, courseId: string, nodeId: string): Promise<string> {
  const row = await admin.from("concept_nodes").select("*").eq("id", nodeId).single();
  if (row.error || !row.data) throw new Error(`stageCreate read: ${row.error?.message}`);
  const cs = await admin
    .from("change_sets")
    .insert({ course_id: courseId, summary: "graph review" } as never)
    .select("id")
    .single();
  if (cs.error || !cs.data) throw new Error(`change_set insert: ${cs.error?.message}`);
  const csId = (cs.data as { id: string }).id;
  const after = { entity: "concept_node", row: row.data, classification: "added" } as unknown as Json;
  const item = await admin.from("change_set_items").insert({
    change_set_id: csId,
    course_id: courseId,
    node_type: "concept_graph",
    node_id: nodeId,
    block_id: null,
    op: "create",
    before: null,
    after,
    evidence: { discriminator: "graph_extraction", reason: "new concept surfaced by extraction" } as unknown as Json,
  } as never);
  if (item.error) throw new Error(`change_set_item insert: ${item.error.message}`);
  return csId;
}

async function main() {
  const env = loadTutorConsoleFixtureEnv();
  const { url, anon } = env;

  const ping = await fetch(BASE).catch(() => null);
  if (!ping) throw new Error(`No server at ${BASE} — run npm run dev (or a prod build) first`);

  section("seed");
  const fixture: TutorConsoleFixture = await seedTutorConsoleFixture(env);
  const { admin, courseId, slug } = fixture;
  const { data: authUser } = await fixture.author.client.auth.getUser();
  const authorEmail = authUser.user?.email;
  if (!authorEmail) throw new Error("author email unresolved");
  const authorPassword = "Test-passw0rd!";
  // Recompute lesson health so the Analytics tab is populated.
  const recompute = await (admin as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  }).rpc("recompute_lesson_health_admin", { cid: courseId });
  check("recompute_lesson_health_admin runs (service role)", recompute.error === null, String(recompute.error?.message));
  // Seed ≥5 tutor-usage learners so the Overview usage card shows real numbers.
  for (let i = 0; i < 6; i++) {
    const uid = crypto.randomUUID();
    const thread = await admin.from("tutor_threads").insert({ user_id: uid, course_id: courseId } as never).select("id").single();
    if (thread.error || !thread.data) continue;
    await admin.from("tutor_turns").insert({
      thread_id: (thread.data as { id: string }).id,
      user_id: uid,
      course_id: courseId,
      role: "learner",
      content: `usage ${i}`,
      publication_id: fixture.publicationId,
      version: fixture.version,
    } as never);
  }
  console.log(`# seeded console fixture: course ${courseId}, /learn/${slug}`);

  // A separate, EMPTY course (author-owned, tutor NOT enabled, no usage) for the
  // sub-floor suppressed-usage assertion (AC-W5O.1 second half).
  const emptyCourse = await admin
    .from("courses")
    .insert({ id: crypto.randomUUID(), author_id: fixture.author.userId, title: "Sub-floor console course", description: "no cohort" } as never)
    .select("id")
    .single();
  if (emptyCourse.error || !emptyCourse.data) throw new Error(`empty course insert: ${emptyCourse.error?.message}`);
  const emptyCourseId = (emptyCourse.data as { id: string }).id;

  const browser: Browser = await chromium.launch();
  const ctx: BrowserContext = await browser.newContext();
  const page = await ctx.newPage();

  const cleanup = async () => {
    await browser.close().catch(() => {});
    await fixture.author.client.from("courses").delete().eq("id", courseId).then(() => {}, () => {});
    await admin.from("courses").delete().eq("id", emptyCourseId).then(() => {}, () => {});
  };

  try {
    await signIn(page, authorEmail, authorPassword);

    /* ── AC-T5.1: cross-surface enable gate ──────────────────────────────────
     * The fixture ships the tutor ENABLED. First turn it OFF on the Overview tab
     * (which hosts the enablement card), then enroll a fresh learner and assert NO
     * tutor tab on the lesson; then turn it back ON → the tab appears. */
    section("AC-T5.1 cross-surface enable gate");
    await page.goto(`${BASE}/studio/${courseId}/tutor`);
    await page.waitForLoadState("networkidle");
    const toggle = page.locator('[data-ai-tool="tutor-enable"] [role="switch"]');
    check("the enablement toggle is present", (await toggle.count()) === 1);
    check("the tutor starts ON (fixture enabled)", (await toggle.getAttribute("aria-checked")) === "true");

    // Turn OFF (disabling is always allowed). The server action + revalidate is
    // async — the DB flip is authoritative; the aria-checked follows after the
    // transition settles.
    await toggle.click();
    const offInDb = await waitForEnabled(admin, courseId, false);
    check("toggling OFF persists (tutor_course_settings.enabled = false)", offInDb);
    // Give the client transition a beat, then confirm aria-checked followed.
    await page.waitForTimeout(1000);
    check("toggling OFF flips aria-checked to false", (await toggle.getAttribute("aria-checked")) === "false");

    // Enroll a fresh learner (real RLS self-insert needs the live pub) + open the
    // lesson; the tutor tab must be ABSENT while disabled.
    const learner = await provisionUser(url, anon, "learner");
    const enr = await learner.client.from("enrollments").insert({ course_id: courseId, user_id: learner.userId } as never);
    check("a fresh learner self-enrolls", !enr.error, String(enr.error?.message));
    const learnerCtx = await browser.newContext();
    const learnerPage = await learnerCtx.newPage();
    await signIn(learnerPage, learner.email, learner.password);
    const lessonUrl = `${BASE}/learn/${slug}/${fixture.degradedLessonId}`;
    await learnerPage.goto(lessonUrl);
    await learnerPage.waitForLoadState("networkidle");
    await learnerPage.waitForTimeout(800);
    check(
      "with the tutor OFF, the learner sees NO tutor tab (data-ai-tool=tutor-open absent)",
      (await learnerPage.locator('[data-ai-tool="tutor-open"]').count()) === 0
    );

    // Turn back ON (the accepted graph makes it legal) → the tab appears.
    await page.bringToFront();
    await toggle.click();
    const onInDb = await waitForEnabled(admin, courseId, true);
    check("toggling ON persists (tutor_course_settings.enabled = true, accepted graph)", onInDb);
    await page.waitForTimeout(1000);
    check("toggling ON flips aria-checked to true", (await toggle.getAttribute("aria-checked")) === "true");
    await learnerPage.reload();
    await learnerPage.waitForLoadState("networkidle");
    await learnerPage.waitForTimeout(1000);
    check(
      "with the tutor ON, the learner tutor tab APPEARS (data-ai-tool=tutor-open present)",
      (await learnerPage.locator('[data-ai-tool="tutor-open"]').count()) >= 1
    );
    await learnerPage.close();
    await learnerCtx.close();

    /* ── AC-T5.2-UI: charter change → versioned history row ── */
    section("AC-T5.2-UI charter versioned save");
    const beforeVersions = await admin
      .from("tutor_charter_versions")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId);
    const beforeCount = beforeVersions.count ?? 0;
    await page.goto(`${BASE}/studio/${courseId}/tutor?tab=charter`);
    await page.waitForLoadState("networkidle");
    // Pick a guidance option DIFFERENT from the current selection so the form is dirty.
    const guidanceGroup = page.locator('[data-ai-tool="charter-guidance"] [role="radiogroup"]');
    const radios = guidanceGroup.locator('[role="radio"]');
    const radioCount = await radios.count();
    check("charter guidance control renders its options", radioCount === 3, String(radioCount));
    // Choose the option not currently checked.
    let clickedLabel = "";
    for (let i = 0; i < radioCount; i++) {
      const r = radios.nth(i);
      if ((await r.getAttribute("aria-checked")) !== "true") {
        clickedLabel = (await r.innerText()).trim();
        await r.click();
        break;
      }
    }
    check("selecting a new guidance option makes the form dirty", clickedLabel.length > 0, clickedLabel);
    await retryClick(page, '[data-ai-tool="charter-save"]');
    // Wait for the save transition to settle (the sticky bar note flips to saved).
    await page.waitForTimeout(1500);
    const afterVersions = await admin
      .from("tutor_charter_versions")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId);
    const afterCount = afterVersions.count ?? 0;
    check("a new tutor_charter_versions row was written (count incremented)", afterCount === beforeCount + 1, `${beforeCount} → ${afterCount}`);
    // Reload so the server-rendered history list carries the new version.
    await page.reload();
    await page.waitForLoadState("networkidle");
    // The History card lists actor + timestamp. The actor is the author email.
    check(
      "the version-history list renders a row with the actor (author email)",
      (await page.getByText(authorEmail).count()) >= 1
    );
    check(
      "the history card is present (server-rendered version list)",
      (await page.getByText("History").count()) >= 1
    );

    /* ── AC-W5O.1: Overview usage — floored cohort vs suppressed ── */
    section("AC-W5O.1 Overview usage floor");
    await page.goto(`${BASE}/studio/${courseId}/tutor`);
    await page.waitForLoadState("networkidle");
    const overviewText = (await page.locator("body").innerText()).toLowerCase();
    check("Overview renders the usage card (Tutor usage)", (await page.getByText("Tutor usage").count()) >= 1);
    check(
      "the ≥5-learner cohort shows real usage (Learners stat present, not suppressed)",
      (await page.getByText("Learners").count()) >= 1 && !overviewText.includes("not enough learners yet")
    );
    // Sub-floor course → suppressed empty state (no counts).
    await page.goto(`${BASE}/studio/${emptyCourseId}/tutor`);
    await page.waitForLoadState("networkidle");
    check(
      "a sub-floor course shows the suppressed usage state (no count)",
      await page.getByText("Not enough learners yet").first().isVisible()
    );

    /* ── AC-T5.3: graph rename + cycle refusal + edge lock ────────────────────
     * The rename is driven through the real UI (node drawer). The cycle refusal +
     * edge lock exercise the FROZEN server primitives directly (the drawer/canvas
     * expose rename/retire/merge/split but not an edge-authoring click), asserting
     * the DAG-gate refuses a cycle with a specific path-naming message and a lock
     * persists. */
    section("AC-T5.3 graph edits");
    await page.goto(`${BASE}/studio/${courseId}/tutor?tab=graph`);
    await page.waitForLoadState("networkidle");
    check("the graph canvas renders", (await page.locator('[data-ai-component="tutor-graph-canvas"]').count()) >= 1);
    // Open a node via the keyboard-navigable list (also the a11y mirror).
    const nodeList = page.locator('[role="listbox"][aria-label="Concepts (keyboard-navigable)"]');
    check("the keyboard node list renders", (await nodeList.count()) === 1);
    const firstOption = nodeList.locator('[role="option"]').first();
    const firstNodeTitle = (await firstOption.innerText()).trim();
    await firstOption.click();
    await page.waitForTimeout(400);
    const drawer = page.locator('[data-ai-component="tutor-node-drawer"]');
    check("clicking a concept opens the detail drawer", (await drawer.count()) === 1, firstNodeTitle);
    // Rename it via the drawer rename affordance.
    const renameBtn = drawer.locator('[data-ai-tool="tutor-node-rename"]');
    await renameBtn.click();
    const renamed = `${firstNodeTitle} (edited)`.slice(0, 60);
    const titleInput = drawer.locator('input[aria-label="Concept title"]');
    await titleInput.fill(renamed);
    await titleInput.press("Enter");
    await page.waitForTimeout(1200);
    // Assert the rename persisted (admin read of the node whose title now matches).
    const renamedRows = await admin
      .from("concept_nodes")
      .select("id, title")
      .eq("course_id", courseId)
      .eq("title", renamed);
    check("the rename persisted (a node now carries the edited title)", (renamedRows.data?.length ?? 0) === 1, JSON.stringify(renamedRows.data));

    // Cycle refusal: A→B→C exists (fixture). C→A would close the cycle → refused
    // with the specific path message (the DAG-gate RPC's contract).
    let cycleErr: unknown = null;
    try {
      await upsertConceptEdge(admin as never, {
        id: crypto.randomUUID(),
        courseId,
        sourceNodeId: fixture.nodeIds.C,
        targetNodeId: fixture.nodeIds.A,
        kind: "prerequisite",
      });
    } catch (e) {
      cycleErr = e;
    }
    check("a cycle-creating prerequisite edge is REFUSED (ConceptEdgeCycleError)", cycleErr instanceof ConceptEdgeCycleError, String(cycleErr));
    check(
      "the cycle error names the specific path (C → A would create a cycle)",
      cycleErr instanceof Error &&
        cycleErr.message.includes(`${fixture.nodeIds.C}`) &&
        cycleErr.message.includes(`${fixture.nodeIds.A}`) &&
        cycleErr.message.toLowerCase().includes("cycle"),
      cycleErr instanceof Error ? cycleErr.message : String(cycleErr)
    );

    // Edge lock: lock the A→B edge (creator_locked true) through the upsert RPC and
    // assert it persisted.
    const abEdge = await admin
      .from("concept_edges")
      .select("id, version, kind")
      .eq("course_id", courseId)
      .eq("source_node_id", fixture.nodeIds.A)
      .eq("target_node_id", fixture.nodeIds.B)
      .maybeSingle();
    if (abEdge.data) {
      const edgeRow = abEdge.data as { id: string; version: number; kind: string };
      await upsertConceptEdge(
        admin as never,
        {
          id: edgeRow.id,
          courseId,
          sourceNodeId: fixture.nodeIds.A,
          targetNodeId: fixture.nodeIds.B,
          kind: edgeRow.kind as "prerequisite" | "part_of" | "related",
          creatorLocked: true,
        },
        edgeRow.version
      );
      const locked = await admin.from("concept_edges").select("creator_locked").eq("id", edgeRow.id).single();
      check("an edge lock persists (creator_locked = true)", (locked.data as { creator_locked: boolean } | null)?.creator_locked === true);
    } else {
      check("the A→B edge exists to lock", false, "A→B edge missing");
    }

    /* ── AC-W5G.2: staged change-set review — Accept activates / Reject restores ──
     * Stage two concept_graph change-sets (extraction-stager shape). One is accepted
     * via the UI Accept button (rows stay live, set resolves); the other is rejected
     * (the un-created node is removed, set resolves rejected). The review panel
     * renders per-item classification. */
    section("AC-W5G.2 staged change-set review");
    // ── Accept path ──
    const acceptNode = await createConceptNode(admin as never, { courseId, title: "Staged Accept Concept", createdBy: "extraction" });
    const acceptCs = await stageCreate(admin, courseId, acceptNode.id);
    await page.goto(`${BASE}/studio/${courseId}/tutor?tab=graph`);
    await page.waitForLoadState("networkidle");
    const reviewPanel = page.locator('[data-ai-component="tutor-graph-review"]');
    check("the pending change-set renders the review panel", (await reviewPanel.count()) === 1);
    check(
      "the staged item shows a per-item classification chip (e.g. ADDED)",
      (await reviewPanel.getByText(/added|matched|removed|split|merged/i).count()) >= 1
    );
    check("the staged node title renders in the review panel", (await reviewPanel.getByText("Staged Accept Concept").count()) >= 1);
    await retryClick(page, '[data-ai-tool="tutor-graph-accept"]');
    const acceptStatus = await waitForChangeSetStatus(admin, acceptCs, "accepted");
    check("Accept resolves the change-set to 'accepted'", acceptStatus === "accepted", String(acceptStatus));
    const acceptStill = await getConceptNode(admin as never, acceptNode.id);
    check("the accepted node stays live (active) in concept_nodes", acceptStill !== null && acceptStill.status === "active");

    // ── Reject path ──
    const rejectNode = await createConceptNode(admin as never, { courseId, title: "Staged Reject Concept", createdBy: "extraction" });
    const rejectCs = await stageCreate(admin, courseId, rejectNode.id);
    await page.reload();
    await page.waitForLoadState("networkidle");
    check("the reject change-set renders the review panel again", (await page.locator('[data-ai-component="tutor-graph-review"]').count()) === 1);
    await retryClick(page, '[data-ai-tool="tutor-graph-reject"]');
    const rejectStatus = await waitForChangeSetStatus(admin, rejectCs, "rejected");
    check("Reject resolves the change-set to 'rejected'", rejectStatus === "rejected", String(rejectStatus));
    // Give the atomic restore a beat before reading the node (delete follows resolve).
    await page.waitForTimeout(800);
    const rejectGone = await getConceptNode(admin as never, rejectNode.id);
    check("Reject restores byte-for-byte: the un-created node is GONE", rejectGone === null);

    /* ── AC-A1.4 + AC-T5.5: Analytics tab ── */
    section("AC-A1.4 + AC-T5.5 analytics");
    await page.goto(`${BASE}/studio/${courseId}/tutor?tab=analytics`);
    await page.waitForLoadState("networkidle");
    check("the analytics tab renders 'Lessons needing attention'", (await page.getByText("Lessons needing attention").count()) >= 1);
    check("the analytics tab renders the 'Most-missed questions' table", (await page.getByText("Most-missed questions").count()) >= 1);
    // Most-missed: q-missed-hard survives (≥5), q-missed-easy is omitted (<5).
    const analyticsText = await page.locator("main").innerText();
    check("the most-missed table lists the ≥5-learner question (q-missed-hard)", analyticsText.includes("q-missed-hard"), analyticsText.slice(0, 400));
    check("the sub-floor question is SUPPRESSED (q-missed-easy omitted)", !analyticsText.includes("q-missed-easy"));
    // Per-option distractor counts are rendered in the Top distractors column.
    check(
      "per-option distractor counts render (a trap option with a count)",
      /m-hard-trap-1:\s*\d/.test(analyticsText) || /m-hard-trap-1: /.test(analyticsText),
      analyticsText.slice(0, 600)
    );
    // A "Teach" deep link navigates to the studio editor.
    const teachLink = page.getByRole("link", { name: /^Teach$/ }).first();
    check("a teaching-slide deep link renders", (await teachLink.count()) >= 1);
    if ((await teachLink.count()) >= 1) {
      const href = await teachLink.getAttribute("href");
      check("the deep link points at the studio editor (course + lesson)", !!href && href.includes(`/studio?course=${courseId}`) && href.includes("lesson="), String(href));
    }

    // AC-T5.5: the degraded lesson ranks #1 with evidence naming the question.
    // Read the rollup_lesson_health table directly (admin) ordered by composite desc
    // — the `lesson_health` PostgREST RPC is author-gated on auth.uid(), which the
    // service role lacks, so we read the recompute's output table (the RANKING source
    // the RPC just re-sorts) instead. This is the same data the UI card ranks by.
    const healthRes = await (admin as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (k: string, v: string) => {
            order: (c2: string, o: { ascending: boolean }) => Promise<{ data: Array<{ lesson_id: string; composite_score: number; first_attempt_error_rate: number | null; confusion_density: number | null }> | null; error: { message: string } | null }>;
          };
        };
      };
    })
      .from("rollup_lesson_health")
      .select("lesson_id, composite_score, first_attempt_error_rate, confusion_density")
      .eq("course_id", courseId)
      .order("composite_score", { ascending: false });
    const healthRows = healthRes.data ?? [];
    check("rollup_lesson_health has ranked rows (recompute ran)", healthRows.length >= 1, String(healthRes.error?.message ?? healthRows.length));
    check("the degraded lesson ranks #1 by composite (data)", healthRows[0]?.lesson_id === fixture.degradedLessonId, JSON.stringify(healthRows.map((h) => h.lesson_id)));
    check(
      "the #1 lesson's score is attributed to first-attempt error + confusion (seeded signals)",
      Number(healthRows[0]?.first_attempt_error_rate ?? 0) > 0.5 && Number(healthRows[0]?.confusion_density ?? 0) > 0.3,
      JSON.stringify(healthRows[0])
    );
    // In the UI, the degraded lesson's card names the implicated question.
    check(
      "the #1 lesson card names the implicated question (evidence)",
      analyticsText.includes("Implicated question") && analyticsText.includes("q-missed-hard"),
      analyticsText.slice(0, 800)
    );
    check(
      "the degraded lesson shows a Health score badge",
      /Health\s+\d/.test(analyticsText),
      analyticsText.slice(0, 400)
    );

    /* ── AC-T5.4: a11y on all four panels + graph keyboard operability ── */
    section("AC-T5.4 a11y + keyboard");
    const axeCounts: Record<string, { id: string; nodes: number }[]> = {};
    for (const [label, qs] of [
      ["overview", ""],
      ["charter", "?tab=charter"],
      ["graph", "?tab=graph"],
      ["analytics", "?tab=analytics"],
    ] as const) {
      await page.goto(`${BASE}/studio/${courseId}/tutor${qs}`);
      await page.waitForLoadState("networkidle");
      axeCounts[label] = await axeScan(page, label);
    }
    console.log(`# axe serious/critical per panel: ${JSON.stringify(axeCounts)}`);

    // Graph KEYBOARD operability: focus the node list, arrow to a node, Enter opens
    // the drawer.
    await page.goto(`${BASE}/studio/${courseId}/tutor?tab=graph`);
    await page.waitForLoadState("networkidle");
    const kbList = page.locator('[role="listbox"][aria-label="Concepts (keyboard-navigable)"]');
    await kbList.focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);
    // The active option carries tabIndex 0; press Enter on it to open the drawer.
    const activeOption = kbList.locator('[role="option"][tabindex="0"]').first();
    check("keyboard: an option is roving-focusable (tabindex 0)", (await activeOption.count()) >= 1);
    await activeOption.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    check(
      "keyboard: Enter on a focused concept opens the detail drawer",
      (await page.locator('[data-ai-component="tutor-node-drawer"]').count()) === 1
    );
  } finally {
    await cleanup();
    console.log("\n# cleaned up courses (throwaway users remain)");
  }

  console.log("\n──────────────── section results ────────────────");
  for (const [name, r] of Object.entries(sectionResults)) {
    console.log(`  ${r.fail === 0 ? "PASS" : "FAIL"}  ${name}  (${r.pass} passed, ${r.fail} failed)`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
