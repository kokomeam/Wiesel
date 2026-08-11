/**
 * TUTOR-1 Amendment A4, Wave 5 — the A4 BROWSER suite (Playwright chromium).
 *
 * Verifies the A4 UI DETERMINISTICALLY — the conversation state is SEEDED via the
 * service role (no live model), so the assertions are stable:
 *   • A4-2   open the tutor on two lessons → SEPARATE threads (different history)
 *   • A4-23  a cross-lesson citation renders a "Go to {label}" link that RESOLVES
 *   • A4-22  no lesson id / UUID appears anywhere in the tutor panel
 *   • D-9    the derived suggestion chips render (vary with the active lesson)
 *
 * The MODEL-GENERATED flows (the tutor writing a cross-lesson answer / a forward
 * decline) are covered at the loop/int level (verify-tutor-scope-int,
 * verify-tutor-wave4) + the live-model cross-lesson citation nav in
 * verify-tutor-browser.ts (T4.1/T4.3).
 *
 *   Run: `next build && next start -p 3100` (or `npm run dev`), THEN
 *        `TUTOR_BROWSER_BASE=http://localhost:3100 npx tsx scripts/verify-tutor-a4-browser.ts`
 *   Fresh throwaway users each run (*@example.com — clean in Supabase → Auth).
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { chromium, type Browser, type Page } from "playwright";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

dns.setDefaultResultOrder("ipv4first");
const retryingFetch: typeof fetch = async (input, init) => {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await fetch(input, init); } catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); }
  }
  throw lastErr;
};

import type { Database } from "@/lib/database.types";
import { createBlock, createLesson, createModule, createSlide, newRowId } from "@/lib/course/factories";
import { courseDocToRows, defaultCourseTheme } from "@/lib/course/persistence";
import { publishCourse } from "@/lib/course/publish/service";
import type { CourseDocument, SlideDeckBlock, Slide } from "@/lib/course/types";
import { resolveLivePublicationBySlug } from "@/lib/learn/resolve";

const BASE = process.env.TUTOR_BROWSER_BASE ?? "http://localhost:3000";
type DB = SupabaseClient<Database>;
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  return { url: env.NEXT_PUBLIC_SUPABASE_URL, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, service: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SECRET_KEY };
}
async function provisionUser(url: string, anon: string, tag: string) {
  const email = `tutor-a4b-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const password = "Test-passw0rd!";
  const signup = await retryingFetch(`${url}/auth/v1/signup`, { method: "POST", headers: { apikey: anon, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!signup.ok) throw new Error(`signup failed: ${await signup.text()}`);
  const client = createClient<Database>(url, anon, { global: { fetch: retryingFetch } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`signin failed: ${error?.message}`);
  return { client: client as DB, userId: data.user.id, email, password };
}
async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.click('button[type="submit"]').catch(() => {});
    if (await page.waitForURL((u) => new URL(u).pathname !== "/login", { timeout: 8000 }).then(() => true).catch(() => false)) return;
  }
  throw new Error("sign-in did not leave /login");
}

function seedSlide(title: string, body: string): Slide {
  const slide = createSlide("title");
  slide.title = title;
  const el = slide.elements.find((e) => e.type === "text" || e.type === "heading");
  if (el && (el.type === "text" || el.type === "heading")) el.text = body;
  else slide.elements.push({ id: newRowId(), type: "text", text: body, x: 100, y: 100, width: 600, height: 200, zIndex: 0, style: {}, ai: { formattingRules: [], qualityChecks: [], allowedActions: [] } } as unknown as Slide["elements"][number]);
  return slide;
}
function makeDoc(courseId: string, ownerId: string, title: string): CourseDocument {
  const deck = (t: string, b: string) => { const d = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock; d.slides = [seedSlide(t, b)]; return d; };
  const l1 = createLesson("Equilibrium", 0); l1.blocks = [deck("Equilibrium", "Price is set where supply meets demand.")];
  const l2 = createLesson("Elasticity", 1); l2.blocks = [deck("Elasticity", "Elasticity measures responsiveness to price.")];
  const mod = createModule("Foundations", 0); mod.lessons = [l1, l2];
  return { id: courseId, title, description: "A4 browser fixture.", plan: { outcomes: [], prerequisites: [] }, modules: [mod], theme: defaultCourseTheme(), metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ownerId, aiReadableVersion: "1.0" } };
}
async function seedCourse(client: DB, doc: CourseDocument, ownerId: string) {
  const rows = courseDocToRows(doc, ownerId);
  for (const [table, data] of [["courses", rows.course], ["modules", rows.modules], ["lessons", rows.lessons], ["blocks", rows.blocks]] as const) {
    const { error } = await client.from(table).insert(data as never);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function main() {
  const { url, anon, service } = loadEnv();
  if (!url || !anon || !service) throw new Error("Missing Supabase env");
  const admin = createClient<Database>(url, service, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: retryingFetch } });
  const author = await provisionUser(url, anon, "author");
  const learner = await provisionUser(url, anon, "learner");

  const courseId = newRowId();
  const doc = makeDoc(courseId, author.userId, `A4 browser ${crypto.randomUUID().slice(0, 6)}`);
  await seedCourse(author.client, doc, author.userId);
  const l1 = doc.modules[0].lessons[0];
  const l2 = doc.modules[0].lessons[1];

  const cleanup = async () => {
    await admin.from("tutor_turns").delete().eq("course_id", courseId);
    await admin.from("tutor_threads").delete().eq("course_id", courseId);
    await author.client.from("courses").delete().eq("id", courseId);
  };

  const browser: Browser = await chromium.launch();
  try {
    const v1 = await publishCourse(author.client, doc, { visibility: "public" });
    const found = await resolveLivePublicationBySlug(learner.client, v1.publication.slug);
    if (found.kind !== "found") throw new Error("publication not resolvable");
    const pub = found.publication;
    await learner.client.from("enrollments").insert({ course_id: courseId, user_id: learner.userId });
    const slug = pub.slug;

    // Seed two lesson threads with DISTINCT turns (via service role).
    const now = Date.now();
    const iso = (ms: number) => new Date(now + ms).toISOString();
    const [threadA, threadB] = [newRowId(), newRowId()];
    await admin.from("tutor_threads").insert([
      { id: threadA, user_id: learner.userId, course_id: courseId, lesson_id: l1.id },
      { id: threadB, user_id: learner.userId, course_id: courseId, lesson_id: l2.id },
    ] as never);
    const turn = (thread: string, lesson: string, role: string, content: string, ms: number, grounding: unknown = {}) => ({
      id: newRowId(), thread_id: thread, user_id: learner.userId, course_id: courseId, role, content,
      publication_id: pub.id, version: pub.version, lesson_id: lesson, grounding, created_at: iso(ms),
    });
    await admin.from("tutor_turns").insert([
      turn(threadA, l1.id, "learner", "AQUESTION about equilibrium", 0),
      turn(threadA, l1.id, "assistant", "AANSWER equilibrium is where supply meets demand", 1),
      turn(threadB, l2.id, "learner", "BQUESTION about elasticity", 2),
      // The lesson-B assistant turn cites LESSON A (a cross-lesson citation) with a LABEL.
      turn(threadB, l2.id, "assistant", "BANSWER elasticity relates to the earlier lesson", 3, {
        citations: [{ lessonId: l1.id, blockId: l1.blocks[0].id, slideId: null, label: l1.title }],
        spans: [], flags: [],
      }),
    ] as never);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signIn(page, learner.email, learner.password);

    // ── A4-2 · thread separation ──
    console.log("\n# A4-2 · open the tutor on two lessons → separate threads");
    await page.goto(`${BASE}/learn/${slug}/${l1.id}?tutor=open`);
    await page.getByText("AANSWER", { exact: false }).first().waitFor({ timeout: 25000 });
    const aVisible = await page.getByText("AANSWER", { exact: false }).count();
    const bLeakedOnA = await page.getByText("BANSWER", { exact: false }).count();
    check("lesson A shows thread A's turn (AANSWER)", aVisible > 0);
    check("lesson A does NOT show thread B's turn (BANSWER)", bLeakedOnA === 0);

    await page.goto(`${BASE}/learn/${slug}/${l2.id}`);
    await page.getByText("BANSWER", { exact: false }).first().waitFor({ timeout: 25000 });
    const bVisible = await page.getByText("BANSWER", { exact: false }).count();
    const aLeakedOnB = await page.getByText("AANSWER", { exact: false }).count();
    check("lesson B shows thread B's turn (BANSWER) — a DIFFERENT thread", bVisible > 0);
    check("A4-2: lesson B does NOT show thread A's turn (separate threads)", aLeakedOnB === 0);

    // ── A4-23 · labeled cross-lesson link resolves ──
    console.log("\n# A4-23 · the cross-lesson citation renders a labeled, resolvable link");
    const chip = page.locator('[data-ai-tool="tutor-citation"]');
    await chip.first().waitFor({ timeout: 15000 });
    const chipText = (await chip.first().innerText()).trim();
    check("the nav affordance NAMES its destination (the lesson-A title)", chipText.includes(l1.title), chipText);
    check("A4-24: exactly one nav affordance renders for the message", (await chip.count()) === 1, `count=${await chip.count()}`);

    // ── A4-22 · no id / UUID in the tutor panel ──
    console.log("\n# A4-22 · no lesson id / UUID in learner-facing tutor output");
    const panelText = await page.locator('[aria-label="Course tutor"]').first().innerText();
    const uuidInPanel = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(panelText);
    check("A4-22: no UUID appears anywhere in the tutor panel", !uuidInPanel);

    // ── D-9 · derived chips render + vary with the lesson ──
    console.log("\n# D-9 · derived suggestion chips render (vary with the active lesson)");
    const chips = page.locator('[data-ai-tool="tutor-suggestion"]');
    await chips.first().waitFor({ timeout: 15000 });
    const chipLabels = await chips.allInnerTexts();
    check("suggestion chips render", chipLabels.length >= 3, chipLabels.join(" | "));
    check("the 'Explain' chip is derived from the active lesson title (Elasticity)", chipLabels.some((t) => /Explain Elasticity/i.test(t)), chipLabels.join(" | "));
    check("the pinned 'Quiz me on this lesson' chip is present", chipLabels.some((t) => t.trim() === "Quiz me on this lesson"));

    // ── the link RESOLVES (click navigates to lesson A) ──
    console.log("\n# the labeled link resolves to a real destination");
    await chip.first().click();
    const navigated = await page.waitForURL((u) => new URL(u).pathname.endsWith(`/${l1.id}`), { timeout: 15000 }).then(() => true).catch(() => false);
    check("clicking the nav affordance navigates to the cited lesson (A)", navigated);

    console.log(`\n${pass} passed, ${fail} failed`);
  } finally {
    await browser.close();
    await cleanup();
    console.log("# cleaned up (throwaway users remain — clean in Supabase → Auth)");
  }
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
