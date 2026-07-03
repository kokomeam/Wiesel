/**
 * Learner-runtime BROWSER test — drives the real /learn pages through
 * Playwright chromium against the dev server (localhost:3000) + live Supabase.
 * Run: `npm run verify:learn:browser` (dev server must be running).
 *
 * The full student happy path through the actual UI:
 *   sign in → course landing → enroll → lesson player (slides paged, quiz
 *   answered + graded, homework submitted, mark-complete) → course completion
 *   on the landing → "My learning" on the marketplace — plus the author's
 *   landing preview and the submissions review API with real cookie auth.
 */

import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";
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

const BASE = process.env.LEARN_BROWSER_BASE ?? "http://localhost:3000";

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

async function provisionUser(url: string, anon: string, tag: string) {
  const email = `learn-btest-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 30000 });
}

async function main() {
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env");
  const ping = await fetch(BASE).catch(() => null);
  if (!ping || !ping.ok) throw new Error(`No dev server at ${BASE} — run npm run dev first`);

  const author = await provisionUser(url, anon, "author");
  const student = await provisionUser(url, anon, "student");

  /* Fixture course: A = 2 slides + quiz(mc) · B = lecture (mark complete) · C = homework. */
  const deck = createBlock("slide_deck", 0, { emptySlideDeck: true }) as SlideDeckBlock;
  deck.slides = [createSlide("title"), createSlide("title_bullets")];
  const quiz = createBlock("quiz", 1) as QuizBlock;
  const mc = createQuestion("multiple_choice");
  if (mc.kind !== "multiple_choice") throw new Error("unreachable");
  mc.prompt = "Pick the FIRST option.";
  mc.correctChoiceId = mc.choices[0].id;
  mc.explanation = "The first option was correct.";
  quiz.questions = [mc];
  const lessonA = createLesson("Watch and check", 0);
  lessonA.blocks = [deck, quiz];
  const lessonB = createLesson("Reading only", 1);
  lessonB.blocks = [createBlock("lecture_text", 0)];
  const homework = createBlock("homework", 0) as HomeworkBlock;
  homework.deliverableType = "text_response";
  const lessonC = createLesson("Hand something in", 2);
  lessonC.blocks = [homework];
  const mod = createModule("Module 1", 0);
  mod.lessons = [lessonA, lessonB, lessonC];
  const courseId = newRowId();
  const doc: CourseDocument = {
    id: courseId,
    title: `Browser itest ${crypto.randomUUID().slice(0, 6)}`,
    description: "Browser fixture course.",
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
    /* ── student: enroll + consume ── */
    console.log("\n1. Student enrolls from the landing");
    const page = await (await browser.newContext()).newPage();
    await signIn(page, student.email, student.password);
    await page.goto(`${BASE}/learn/${slug}`);
    check("landing shows the course title", await page.getByText(doc.title).first().isVisible());
    await page.click('[data-ai-tool="learn-enroll"] >> nth=0');
    await page.getByText("Your progress").waitFor({ timeout: 20000 });
    check("enrolled state shows progress card", true);
    check(
      "outline lists all three lessons",
      (await page.getByText("Watch and check").count()) > 0 &&
        (await page.getByText("Reading only").count()) > 0
    );

    console.log("\n2. Lesson A: slides + graded quiz");
    await page.getByRole("link", { name: /Watch and check/ }).click();
    await page.waitForURL(`**/learn/${slug}/${lessonA.id}`, { timeout: 30000 });
    await page.getByLabel("Next slide").last().waitFor({ timeout: 30000 });
    check("slide player rendered", true);
    await page.waitForTimeout(1600); // slide 1 report debounce
    await page.getByLabel("Next slide").last().click();
    await page.waitForTimeout(600); // last-slide flush
    check(
      "slide position advances",
      (await page.getByText("2 / 2").count()) > 0
    );
    await page.getByRole("radio", { name: /Option A/ }).click();
    await page.click('[data-ai-tool="learn-quiz-submit"]');
    await page.getByText(/Score: 1\/1/).waitFor({ timeout: 20000 });
    check("quiz graded server-side (score shown)", true);
    check(
      "explanation surfaced",
      (await page.getByText("The first option was correct.").count()) > 0
    );
    await page.getByText("Lesson complete").waitFor({ timeout: 20000 });
    check("lesson A completes after slides + attempt", true);

    console.log("\n3. Lesson B: explicit mark complete");
    await page.goto(`${BASE}/learn/${slug}/${lessonB.id}`);
    await page.click('[data-ai-tool="learn-mark-complete"]');
    await page.getByText("Lesson complete").waitFor({ timeout: 20000 });
    check("untrackable lesson marked complete", true);

    console.log("\n4. Lesson C: homework submission");
    await page.goto(`${BASE}/learn/${slug}/${lessonC.id}`);
    await page.fill("textarea", "Here is my homework essay.");
    await page.click('[data-ai-tool="learn-homework-submit"]');
    await page.getByText(/Submitted — your instructor/).waitFor({ timeout: 20000 });
    check("homework submitted through the UI", true);
    await page.click('[data-ai-tool="learn-mark-complete"]');
    await page.getByText("Lesson complete").waitFor({ timeout: 20000 });

    console.log("\n5. Course completion + My learning");
    await page.goto(`${BASE}/learn/${slug}`);
    try {
      await page.getByText(/Course complete/).waitFor({ timeout: 20000 });
      check("landing celebrates course completion", true);
    } catch (err) {
      const rows = await student.client
        .from("learn_progress")
        .select("lesson_id, status, pct")
        .eq("course_id", courseId);
      const enr = await student.client
        .from("enrollments")
        .select("status")
        .eq("course_id", courseId);
      console.log("DEBUG learn_progress:", JSON.stringify(rows.data));
      console.log("DEBUG enrollment:", JSON.stringify(enr.data));
      console.log("DEBUG page text:", (await page.locator("main").innerText()).slice(0, 800));
      throw err;
    }
    await page.goto(`${BASE}/marketplace`);
    await page.getByText("My learning").waitFor({ timeout: 30000 });
    check(
      "marketplace shows the course under My learning as completed",
      (await page.getByText(doc.title).count()) > 0 &&
        (await page.getByText("Completed").count()) > 0
    );

    /* ── author: preview + submissions review ── */
    console.log("\n6. Author preview + submissions review");
    const authorPage = await (await browser.newContext()).newPage();
    await signIn(authorPage, author.email, author.password);
    await authorPage.goto(`${BASE}/learn/${slug}`);
    check(
      "author sees the creator card",
      (await authorPage.getByText("You created this course").count()) > 0
    );
    const subs = await authorPage.request.get(
      `${BASE}/api/learn/submissions?courseId=${courseId}`
    );
    const subsBody = (await subs.json()) as {
      submissions?: { id: string; text: string; status: string }[];
    };
    check(
      "submissions API returns the student's homework",
      subs.ok() && (subsBody.submissions ?? []).some((s) => s.text.includes("homework essay"))
    );
    const first = (subsBody.submissions ?? [])[0];
    const reviewedRes = await authorPage.request.patch(`${BASE}/api/learn/submissions`, {
      data: { submissionId: first.id },
    });
    const reviewed = (await reviewedRes.json()) as { submission?: { status: string } };
    check("author marks it reviewed", reviewed.submission?.status === "reviewed");
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
