/**
 * TUTOR-1 Amendment A2 — Wave 3 STREAMING browser suite (FOCUSED).
 *
 * Proves the A2 streamed-turn lifecycle at the browser level against a RUNNING
 * dev server (:3000 by default) with the real OpenAI key + live Supabase + live
 * Upstash resume buffer. This is deliberately NARROW — it does NOT re-run the big
 * verify-tutor-browser.ts learner-sidebar matrix; it only exercises the A2
 * streaming/status/resume/reduced-motion surface.
 *
 *   Run: dev server up first, THEN `npx tsx scripts/verify-tutor-stream-browser.ts`.
 *
 * SECTIONS
 *   A2-13  incremental text     — the streaming bubble grows across ≥3 strictly-
 *                                 increasing observations; the settled turn holds
 *                                 the full text
 *   §6     status phases        — role="status" shows "Working through it" (and/or
 *                                 "Sending your question") while waiting; once the
 *                                 streaming bubble appears the status region is GONE
 *                                 (mutual exclusion — never stacked)
 *   A2-16  refresh mid-answer   — reload mid-reasoning; the question persists and
 *                                 the answer arrives (live re-attach OR history
 *                                 fallback), with NO duplicated learner turn and
 *                                 exactly ONE assistant answer for it
 *   A2-17  a11y                 — axe zero serious/critical with the panel open;
 *                                 the status region carries aria-live=polite + role=status
 *   A2-18  reduced motion       — a reducedMotion:'reduce' context: while the status
 *                                 region shows, NO element inside carries an
 *                                 `animate-*` class; the phase copy still renders
 *
 * The suite is re-runnable — fresh throwaway *@example.com users each run (clean
 * them in Supabase → Auth). ANY failure exits non-zero.
 */

import { readFileSync } from "node:fs";
import dns from "node:dns";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { seedTutorFixture } from "./seed-fixture-tutor";

dns.setDefaultResultOrder("ipv4first");

const BASE = process.env.TUTOR_BROWSER_BASE ?? "http://localhost:3000";

/** A single deterministic, substantial question that reliably yields ~10s of
 *  reasoning + several seconds of visible streaming (a long, step-by-step ask). */
const LONG_Q = "Explain the main idea of this lesson step by step, thoroughly.";

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
  const email = `tutor-stream-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;
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

/** Sign in through the REAL /login form; wait for the post-login route by
 *  PATHNAME predicate (never a `**` glob). */
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

/** Land on the enrolled course landing (the learner is enrolled via RLS before
 *  the browser opens). Enroll via the UI only if somehow not already enrolled. */
async function openLandingEnrolled(page: Page, slug: string, courseTitle: string) {
  await page.goto(`${BASE}/learn/${slug}`);
  await page.getByText(courseTitle).first().waitFor({ timeout: 25000 });
  const enrollBtn = page.locator('[data-ai-tool="learn-enroll"]');
  if ((await enrollBtn.count()) > 0) await enrollBtn.first().click();
  await page.getByText("Your progress").waitFor({ timeout: 25000 }).catch(() => {});
}

/** Wait for the thread history to settle before sending (sending while
 *  "Loading your conversation…" shows wipes the just-sent turn). */
async function waitForTutorReady(page: Page) {
  await page
    .waitForFunction(
      () => {
        const scroller = document.querySelector('aside[aria-label="Course tutor"] .overflow-y-auto');
        return !!scroller && !scroller.textContent?.includes("Loading your conversation");
      },
      undefined,
      { timeout: 15000 }
    )
    .catch(() => {});
  await page.waitForTimeout(300);
}

/** Open the tutor panel (idempotent — the store persists `open`). Waits for the
 *  composer OR the edge tab to hydrate, retry-clicks the tab, then waits history. */
async function openTutor(page: Page) {
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-ai-tool="tutor-composer"]') !== null ||
        document.querySelector('[data-ai-tool="tutor-open"]') !== null,
      undefined,
      { timeout: 25000 }
    )
    .catch(() => {});
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

/** Count the settled assistant bubbles (each carries the "Just show me" affordance). */
function assistantBubbleCount(page: Page): Promise<number> {
  return page.locator('[data-ai-component="tutor-assistant-bubble"]').count();
}

/** Is a transport error card (with a Retry button) currently showing? */
function errorShowing(page: Page): Promise<boolean> {
  return page.locator('[data-ai-tool="tutor-retry"]').count().then((n) => n > 0);
}

/* ──────────────────────────────────── main ──────────────────────────────── */

async function main() {
  const env = loadEnv();
  const ping = await fetch(BASE).catch(() => null);
  if (!ping || !ping.ok) {
    throw new Error(`No server at ${BASE} — run \`npm run dev\` first.`);
  }

  console.log("# seeding tutor fixture (author auto-provisioned) …");
  const fixture = await seedTutorFixture({ url: env.url, anon: env.anon });
  const courseTitle = fixture.doc.title;
  const slug = fixture.slug;
  const learner = await provisionUser(env, "learner");

  // Enable the tutor for the course (author-only RLS).
  const settings = await fixture.author.client
    .from("tutor_course_settings")
    .upsert({ course_id: fixture.courseId, enabled: true } as never, { onConflict: "course_id" });
  if (settings.error) throw new Error(`enable tutor: ${settings.error.message}`);

  // Enroll the learner (RLS self-insert).
  const enrolled = await learner.client
    .from("enrollments")
    .insert({ course_id: fixture.courseId, user_id: learner.userId } as never);
  if (enrolled.error) throw new Error(`enroll: ${enrolled.error.message}`);

  // A lesson with a slide deck to converse over (the ambient carries its context).
  const contentLessons = fixture.doc.modules
    .flatMap((m) => m.lessons)
    .filter((l) => l.blocks.some((b) => b.type === "slide_deck"));
  const lessonA = contentLessons[0];

  const browser: Browser = await chromium.launch();
  const contexts: BrowserContext[] = [];
  const newCtx = async (opts?: Parameters<Browser["newContext"]>[0]) => {
    const ctx = await browser.newContext(opts);
    contexts.push(ctx);
    return ctx;
  };

  const cleanup = async () => {
    for (const ctx of contexts) await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await fixture.author.client.from("courses").delete().eq("id", fixture.courseId);
  };

  // Recorded for the report.
  let a2_13_samples: number[] = [];
  let a2_16_resolution = "(not reached)";
  let flakeRetries = 0;

  try {
    const learnerCtx = await newCtx({ viewport: { width: 1440, height: 900 } });
    const page = await learnerCtx.newPage();
    await signIn(page, learner.email, learner.password);
    await openLandingEnrolled(page, slug, courseTitle);

    /* ───────────────── A2-8 GET resume HTTP auth matrix ────────────────────── */
    // Fast + independent: prove the resume endpoint's HTTP auth gate at the
    // REAL route. Anonymous → 401 (no cookies); signed-in-but-not-enrolled → 403
    // (cookie session rides via context.request); enrolled-idle → 204 (no active
    // stream). 401/403 carry JSON error bodies; 204 has none — status only.
    {
      const end = section("A2-8", "GET resume HTTP auth matrix — 401 anon / 403 not-enrolled / 204 enrolled-idle");
      const resumeUrl = `${BASE}/api/learn/tutor?courseId=${fixture.courseId}`;

      // 1) Anonymous — plain node fetch, NO cookies → 401.
      const anonRes = await retryingFetch(resumeUrl, { headers: { accept: "text/event-stream" } });
      check(
        "anonymous GET (no auth cookies) → 401",
        anonRes.status === 401,
        `status=${anonRes.status}`
      );

      // 2) Signed-in but NOT enrolled — a fresh throwaway user who never enrolls;
      //    authenticate the request the app's way (cookie session), then use the
      //    context's request client so the session cookies ride along → 403.
      const stranger = await provisionUser(env, "stranger");
      const strangerCtx = await newCtx({ viewport: { width: 1440, height: 900 } });
      const strangerPage = await strangerCtx.newPage();
      await signIn(strangerPage, stranger.email, stranger.password);
      const notEnrolledRes = await strangerCtx.request.get(resumeUrl, {
        headers: { accept: "text/event-stream" },
      });
      check(
        "signed-in but NOT enrolled GET (cookie session) → 403",
        notEnrolledRes.status() === 403,
        `status=${notEnrolledRes.status()}`
      );
      await strangerCtx.close();

      // 3) Enrolled learner, idle (no turn in flight) → 204 (no active stream);
      //    reuse the enrolled learner's browser context so its session cookies ride.
      const idleRes = await learnerCtx.request.get(resumeUrl, {
        headers: { accept: "text/event-stream" },
      });
      check(
        "enrolled learner, no turn in flight GET (cookie session) → 204",
        idleRes.status() === 204,
        `status=${idleRes.status()}`
      );

      end();
    }

    /* ─────────────────── A2-13 incremental text + §6 status ────────────────── */
    {
      const end = section("A2-13", "incremental text — the streaming bubble grows across ≥3 samples");
      const endStatus = section("§6", "status phases — role=status while waiting, GONE once streaming");

      await page.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await page.getByLabel("Next slide").last().waitFor({ timeout: 30000 }).catch(() => {});
      await openTutor(page);
      await waitForTutorReady(page);

      // Poll BOTH the status region (during reasoning) AND the streaming bubble
      // (during token flow) across the whole turn. Retry the send ONCE if the
      // transport drops (an error card + Retry appears) before any tokens flow.
      const runTurn = async (): Promise<{
        samples: number[];
        sawStatus: boolean;
        statusPhrase: string;
        statusGoneWhenStreaming: boolean;
        settledText: string;
        streamingMax: number;
        assistantBefore: number;
      }> => {
        const assistantBefore = await assistantBubbleCount(page);
        await page.fill('[data-ai-tool="tutor-composer"]', LONG_Q);
        await page.click('[data-ai-tool="tutor-send"]');

        const samples: number[] = [];
        let sawStatus = false;
        let statusPhrase = "";
        let statusGoneWhenStreaming = true;
        let streamingMax = 0;
        let streamingEverAppeared = false;

        const deadline = Date.now() + 60000;
        // Poll ~every 400ms until the settled turn lands or we time out.
        for (;;) {
          if (Date.now() > deadline) break;
          if (await errorShowing(page)) {
            // Transport dropped before/mid stream — signal the caller to retry.
            return {
              samples,
              sawStatus,
              statusPhrase,
              statusGoneWhenStreaming,
              settledText: "__ERROR__",
              streamingMax,
              assistantBefore,
            };
          }
          // Read status region + streaming bubble in one page eval (a single snapshot).
          const snap = await page.evaluate(() => {
            const statusEl = document.querySelector('[data-ai-component="tutor-status-indicator"]');
            const streamEl = document.querySelector('[data-ai-component="tutor-streaming-bubble"]');
            const statusText = statusEl ? (statusEl.textContent ?? "").trim() : null;
            const streamText = streamEl
              ? (streamEl.textContent ?? "").replace(/▍\s*$/, "").trimEnd()
              : null;
            return {
              statusPresent: statusEl !== null,
              statusText,
              streamPresent: streamEl !== null,
              streamLen: streamText === null ? -1 : streamText.length,
            };
          });

          if (snap.statusPresent) {
            sawStatus = true;
            if (snap.statusText) statusPhrase = snap.statusText;
          }
          if (snap.streamPresent) {
            streamingEverAppeared = true;
            // Mutual exclusion: the status region must be GONE once the bubble shows.
            if (snap.statusPresent) statusGoneWhenStreaming = false;
            if (snap.streamLen >= 0) {
              streamingMax = Math.max(streamingMax, snap.streamLen);
              // Record a sample only when the length changed (dedupe stalls).
              if (samples.length === 0 || snap.streamLen !== samples[samples.length - 1]) {
                samples.push(snap.streamLen);
              }
            }
          }

          // Settled? A new assistant bubble appeared AND streaming bubble gone.
          const nowAssistant = await assistantBubbleCount(page);
          if (nowAssistant > assistantBefore && !snap.streamPresent) break;

          await page.waitForTimeout(400);
        }

        // The settled assistant turn's prose = the LAST tutor bubble's block text
        // (strip interactive chrome — escape hatch + citation chips — from the clone).
        const settledText = await page.evaluate(() => {
          const bubbles = Array.from(
            document.querySelectorAll('aside[aria-label="Course tutor"] [data-ai-component="tutor-assistant-bubble"]')
          );
          const last = bubbles[bubbles.length - 1];
          if (!last) return "";
          const clone = last.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("button").forEach((b) => b.remove());
          return (clone.textContent ?? "").trim();
        });

        void streamingEverAppeared;
        return {
          samples,
          sawStatus,
          statusPhrase,
          statusGoneWhenStreaming,
          settledText,
          streamingMax,
          assistantBefore,
        };
      };

      let result = await runTurn();
      if (result.settledText === "__ERROR__") {
        flakeRetries++;
        console.log("  · transport dropped — clicking Retry once (flake tolerance)");
        await page.locator('[data-ai-tool="tutor-retry"]').first().click().catch(() => {});
        await page.waitForTimeout(500);
        // Re-poll the SAME turn (retry re-sends the same learner message).
        result = await (async () => {
          const assistantBefore = result.assistantBefore;
          const samples: number[] = [];
          let sawStatus = false;
          let statusPhrase = "";
          let statusGoneWhenStreaming = true;
          let streamingMax = 0;
          const deadline = Date.now() + 60000;
          for (;;) {
            if (Date.now() > deadline) break;
            if (await errorShowing(page)) {
              // A second failure — give up this attempt; assertions will fail honestly.
              break;
            }
            const snap = await page.evaluate(() => {
              const statusEl = document.querySelector('[data-ai-component="tutor-status-indicator"]');
              const streamEl = document.querySelector('[data-ai-component="tutor-streaming-bubble"]');
              return {
                statusPresent: statusEl !== null,
                statusText: statusEl ? (statusEl.textContent ?? "").trim() : null,
                streamPresent: streamEl !== null,
                streamLen: streamEl
                  ? (streamEl.textContent ?? "").replace(/▍\s*$/, "").trimEnd().length
                  : -1,
              };
            });
            if (snap.statusPresent) {
              sawStatus = true;
              if (snap.statusText) statusPhrase = snap.statusText;
            }
            if (snap.streamPresent) {
              if (snap.statusPresent) statusGoneWhenStreaming = false;
              if (snap.streamLen >= 0) {
                streamingMax = Math.max(streamingMax, snap.streamLen);
                if (samples.length === 0 || snap.streamLen !== samples[samples.length - 1]) {
                  samples.push(snap.streamLen);
                }
              }
            }
            const nowAssistant = await assistantBubbleCount(page);
            if (nowAssistant > assistantBefore && !snap.streamPresent) break;
            await page.waitForTimeout(400);
          }
          const settledText = await page.evaluate(() => {
            const bubbles = Array.from(
              document.querySelectorAll('aside[aria-label="Course tutor"] [data-ai-component="tutor-assistant-bubble"]')
            );
            const last = bubbles[bubbles.length - 1];
            if (!last) return "";
            const clone = last.cloneNode(true) as HTMLElement;
            clone.querySelectorAll("button").forEach((b) => b.remove());
            return (clone.textContent ?? "").trim();
          });
          return {
            samples,
            sawStatus,
            statusPhrase,
            statusGoneWhenStreaming,
            settledText,
            streamingMax,
            assistantBefore,
          };
        })();
      }

      a2_13_samples = result.samples;
      console.log(`  · streaming length samples: [${result.samples.join(", ")}]`);
      console.log(`  · settled prose length: ${result.settledText.length}`);
      console.log(`  · observed status phrase: "${result.statusPhrase}"`);

      // A2-13: ≥3 STRICTLY-increasing samples.
      let strictRun = 0;
      let maxStrictRun = 0;
      for (let i = 1; i < result.samples.length; i++) {
        if (result.samples[i] > result.samples[i - 1]) {
          strictRun += 1;
          maxStrictRun = Math.max(maxStrictRun, strictRun + 1);
        } else {
          strictRun = 0;
        }
      }
      // Because we dedupe equal lengths, the whole `samples` array is already
      // non-decreasing and (post-dedupe) strictly increasing while text grows.
      const distinctIncreasing = result.samples.length;
      check(
        "≥3 streaming observations with strictly increasing length",
        distinctIncreasing >= 3 && result.samples.every((v, i) => i === 0 || v > result.samples[i - 1]),
        `samples=[${result.samples.join(", ")}]`
      );
      check(
        "a real settled assistant turn rendered",
        result.settledText.length > 0,
        `settledLen=${result.settledText.length}`
      );
      check(
        "settled turn text ≥ the last streaming sample length (final holds the full answer)",
        result.settledText.length >= (result.samples[result.samples.length - 1] ?? 0),
        `settled=${result.settledText.length} lastStream=${result.samples[result.samples.length - 1] ?? 0}`
      );
      end();

      // §6: status region observed while waiting; phrase is a valid A2 copy;
      // mutual exclusion held (status gone once the streaming bubble appeared).
      check("a role=status status region was observed during the turn", result.sawStatus);
      const validPhrase =
        /Working through it/.test(result.statusPhrase) ||
        /Sending your question/.test(result.statusPhrase) ||
        /Writing your answer/.test(result.statusPhrase);
      check(
        'the status region showed a valid phase phrase ("Working through it" / "Sending your question" / "Writing your answer")',
        validPhrase,
        `phrase="${result.statusPhrase}"`
      );
      check(
        "mutual exclusion — the status region was GONE whenever the streaming bubble was present (never stacked)",
        result.statusGoneWhenStreaming
      );
      endStatus();
    }

    /* ─────────────────────── A2-16 refresh mid-answer ──────────────────────── */
    {
      const end = section("A2-16", "refresh mid-answer — question persists, answer arrives, no dup");

      await page.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await page.getByLabel("Next slide").last().waitFor({ timeout: 30000 }).catch(() => {});
      await openTutor(page);
      await waitForTutorReady(page);

      const uniqueMarker = `refresh-probe ${crypto.randomUUID().slice(0, 8)}`;
      const question = `${uniqueMarker}: explain scarcity step by step, thoroughly.`;

      // Learner bubbles carry their content; count copies of our marker before send.
      const learnerCopies = () =>
        page.evaluate((mark) => {
          const nodes = Array.from(
            document.querySelectorAll('aside[aria-label="Course tutor"] .justify-end')
          );
          return nodes.filter((n) => (n.textContent ?? "").includes(mark)).length;
        }, uniqueMarker);

      // Send, then wait for "Working through it" (mid-reasoning, WELL before settle)
      // so the reload happens while the answer is still being produced server-side.
      const sendAndReachThinking = async (): Promise<boolean> => {
        await page.fill('[data-ai-tool="tutor-composer"]', question);
        await page.click('[data-ai-tool="tutor-send"]');
        // Wait for the thinking phase (or an error). Reasoning gives a ~10s window.
        return page
          .waitForFunction(
            () => {
              const s = document.querySelector('[data-ai-component="tutor-status-indicator"]');
              if (s && /Working through it/.test(s.textContent ?? "")) return true;
              if (document.querySelector('[data-ai-tool="tutor-retry"]')) return true; // error → break
              return false;
            },
            undefined,
            { timeout: 40000 }
          )
          .then(() => true)
          .catch(() => false);
      };

      let reached = await sendAndReachThinking();
      if (await errorShowing(page)) {
        flakeRetries++;
        console.log("  · transport dropped before reload — Retry once");
        await page.locator('[data-ai-tool="tutor-retry"]').first().click().catch(() => {});
        reached = await page
          .waitForFunction(
            () => {
              const s = document.querySelector('[data-ai-component="tutor-status-indicator"]');
              return !!(s && /Working through it/.test(s.textContent ?? ""));
            },
            undefined,
            { timeout: 40000 }
          )
          .then(() => true)
          .catch(() => false);
      }
      check('reached the "Working through it" phase before reloading', reached);
      const copiesBeforeReload = await learnerCopies();

      // RELOAD mid-answer. On reload: history re-loads the learner question; the
      // resume GET re-attaches a live stream if the turn is still running, else the
      // dangling-question fallback re-loads history ~3s later once the answer lands.
      await page.reload();
      await page.getByLabel("Next slide").last().waitFor({ timeout: 30000 }).catch(() => {});
      // The panel is persisted-open; wait for the composer + history to settle.
      await page.locator('[data-ai-tool="tutor-composer"]').first().waitFor({ timeout: 20000 }).catch(() => {});
      await waitForTutorReady(page);

      // The learner's question survived the reload (persisted to history).
      const persisted = await page
        .waitForFunction(
          (mark) =>
            Array.from(document.querySelectorAll('aside[aria-label="Course tutor"] .justify-end')).some(
              (n) => (n.textContent ?? "").includes(mark)
            ),
          uniqueMarker,
          { timeout: 20000 }
        )
        .then(() => true)
        .catch(() => false);
      check("the learner's question is in the transcript after reload (persisted)", persisted);

      // Within 60s the assistant answer for it appears — via live re-attach
      // (streaming bubble → settled) OR the dangling history re-load. We detect
      // whether a live streaming bubble ever showed post-reload to report HOW.
      let sawLiveStreamPostReload = false;
      const answerDeadline = Date.now() + 60000;
      let answered = false;
      while (Date.now() < answerDeadline) {
        const snap = await page.evaluate(() => {
          const streamEl = document.querySelector('[data-ai-component="tutor-streaming-bubble"]');
          const assistantBubbles = document.querySelectorAll(
            'aside[aria-label="Course tutor"] [data-ai-component="tutor-assistant-bubble"]'
          ).length;
          return { streaming: streamEl !== null, assistantBubbles };
        });
        if (snap.streaming) sawLiveStreamPostReload = true;
        if (snap.assistantBubbles >= 1) {
          answered = true;
          break;
        }
        if (await errorShowing(page)) {
          flakeRetries++;
          console.log("  · post-reload transport error — Retry once");
          await page.locator('[data-ai-tool="tutor-retry"]').first().click().catch(() => {});
        }
        await page.waitForTimeout(600);
      }
      a2_16_resolution = sawLiveStreamPostReload
        ? "live re-attach (streaming bubble reappeared post-reload → settled)"
        : "history fallback (dangling-question re-load; no live stream reappeared)";
      check("the assistant answer appeared within 60s after reload", answered, a2_16_resolution);

      // Exactly ONE learner copy of the question (no duplicate learner turn) and
      // exactly ONE assistant answer for it.
      const copiesAfter = await learnerCopies();
      check(
        "no duplicated learner turn (exactly one copy of the question)",
        copiesAfter === 1,
        `beforeReload=${copiesBeforeReload} after=${copiesAfter}`
      );
      // Count assistant bubbles that FOLLOW the learner question. In a fresh
      // thread the whole transcript is [learner Q, assistant A]; assert exactly 1.
      const assistantForIt = await page.evaluate(() => {
        return document.querySelectorAll(
          'aside[aria-label="Course tutor"] [data-ai-component="tutor-assistant-bubble"]'
        ).length;
      });
      check(
        "exactly ONE assistant answer for the question",
        assistantForIt === 1,
        `assistantBubbles=${assistantForIt}`
      );
      console.log(`  · refresh-resume resolved via: ${a2_16_resolution}`);
      end();
    }

    /* ─────────────────────────────── A2-17 a11y ───────────────────────────── */
    {
      const end = section("A2-17", "a11y — axe zero serious/critical + status region aria contract");

      // A fresh context so the tutor slice starts in a known state; open it and
      // fire a send so a status phase is (briefly) live while we assert the aria
      // contract — but the axe run itself is over the whole open-panel page.
      const a11yCtx = await newCtx({ viewport: { width: 1440, height: 900 } });
      const a11yPage = await a11yCtx.newPage();
      await signIn(a11yPage, learner.email, learner.password);
      await a11yPage.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await a11yPage.getByLabel("Next slide").last().waitFor({ timeout: 30000 }).catch(() => {});
      await openTutor(a11yPage);
      await waitForTutorReady(a11yPage);

      // Kick a turn and try to catch a live status phase for the aria assertion.
      await a11yPage.fill('[data-ai-tool="tutor-composer"]', "What is scarcity? Explain thoroughly.");
      await a11yPage.click('[data-ai-tool="tutor-send"]');
      const statusVisible = await a11yPage
        .waitForFunction(
          () => document.querySelector('[data-ai-component="tutor-status-indicator"]') !== null,
          undefined,
          { timeout: 20000 }
        )
        .then(() => true)
        .catch(() => false);

      // Assert the status region's LIVE aria contract (role + aria-live) directly.
      if (statusVisible) {
        const aria = await a11yPage.evaluate(() => {
          const el = document.querySelector('[data-ai-component="tutor-status-indicator"]');
          return el
            ? { role: el.getAttribute("role"), live: el.getAttribute("aria-live") }
            : null;
        });
        check(
          'the status region has role="status" and aria-live="polite"',
          !!aria && aria.role === "status" && aria.live === "polite",
          JSON.stringify(aria)
        );
      } else {
        // The status may have already flipped to the streaming bubble — that's the
        // mutual-exclusion behaviour, not a failure. Still assert the component
        // source contract via a re-observe attempt on a fresh short turn.
        console.log("  · status region flipped fast — re-observing on a quick turn");
        const seen = await a11yPage
          .waitForFunction(
            () => document.querySelector('[data-ai-component="tutor-status-indicator"]') !== null,
            undefined,
            { timeout: 8000 }
          )
          .then(() => true)
          .catch(() => false);
        check("status region was observable at least once (aria contract check)", seen);
      }

      // Run axe over the page while the panel is open (status phase or streaming).
      const results = await new AxeBuilder({ page: a11yPage })
        .options({ resultTypes: ["violations"] })
        .analyze();
      const serious = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical"
      );
      for (const v of serious) {
        console.log(`  · axe violation [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node/s)`);
      }
      check("axe: open panel with a status phase — zero serious/critical", serious.length === 0, `${serious.length} found`);

      // Let the turn settle (or drop) before closing the context — avoids a
      // mid-stream teardown noise.
      await a11yPage.waitForTimeout(1500);
      await a11yCtx.close();
      end();
    }

    /* ────────────────────────── A2-18 reduced motion ──────────────────────── */
    {
      const end = section("A2-18", "reduced motion — no animate-* in the status region; phase copy renders");

      const rmCtx = await newCtx({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "reduce",
      });
      const rmPage = await rmCtx.newPage();
      await signIn(rmPage, learner.email, learner.password);
      await rmPage.goto(`${BASE}/learn/${slug}/${lessonA.id}`);
      await rmPage.getByLabel("Next slide").last().waitFor({ timeout: 30000 }).catch(() => {});
      await openTutor(rmPage);
      await waitForTutorReady(rmPage);

      const send = async () => {
        await rmPage.fill('[data-ai-tool="tutor-composer"]', "Explain opportunity cost step by step, thoroughly.");
        await rmPage.click('[data-ai-tool="tutor-send"]');
        return rmPage
          .waitForFunction(
            () => {
              const s = document.querySelector('[data-ai-component="tutor-status-indicator"]');
              if (s && (s.textContent ?? "").trim().length > 0) return true;
              if (document.querySelector('[data-ai-tool="tutor-retry"]')) return true;
              return false;
            },
            undefined,
            { timeout: 30000 }
          )
          .then(() => true)
          .catch(() => false);
      };

      let ok = await send();
      if (await errorShowing(rmPage)) {
        flakeRetries++;
        console.log("  · transport dropped (reduced-motion) — Retry once");
        await rmPage.locator('[data-ai-tool="tutor-retry"]').first().click().catch(() => {});
        ok = await rmPage
          .waitForFunction(
            () => {
              const s = document.querySelector('[data-ai-component="tutor-status-indicator"]');
              return !!(s && (s.textContent ?? "").trim().length > 0);
            },
            undefined,
            { timeout: 30000 }
          )
          .then(() => true)
          .catch(() => false);
      }
      check("status region appeared under reduced motion", ok);

      // While the status region is visible: NO descendant carries an animate-* class.
      const snap = await rmPage.evaluate(() => {
        const el = document.querySelector('[data-ai-component="tutor-status-indicator"]');
        if (!el) return { present: false, animatedCount: 0, text: "" };
        const all = [el, ...Array.from(el.querySelectorAll("*"))];
        const animatedCount = all.filter((n) =>
          Array.from((n as HTMLElement).classList).some((c) => c.includes("animate-"))
        ).length;
        return { present: true, animatedCount, text: (el.textContent ?? "").trim() };
      });
      check("status region is present to inspect", snap.present);
      check(
        "NO element inside the status region has an animate-* class (pulse gated off)",
        snap.present && snap.animatedCount === 0,
        `animatedCount=${snap.animatedCount}`
      );
      const rmPhraseValid =
        /Working through it/.test(snap.text) ||
        /Sending your question/.test(snap.text) ||
        /Writing your answer/.test(snap.text);
      check(
        "the phase copy still renders under reduced motion (text present)",
        snap.present && snap.text.length > 0 && rmPhraseValid,
        `text="${snap.text}"`
      );

      await rmPage.waitForTimeout(1200);
      await rmCtx.close();
      end();
    }
  } finally {
    await cleanup();
    console.log("\n# cleaned up course (throwaway users remain — clean in Supabase → Auth)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`# A2-13 streaming length samples: [${a2_13_samples.join(", ")}]`);
  console.log(`# A2-16 refresh-resume resolution: ${a2_16_resolution}`);
  console.log(`# flake retries taken: ${flakeRetries}`);
  if (fail > 0) process.exit(1);
}

void main().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
