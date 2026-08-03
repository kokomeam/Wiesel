/**
 * PERF-1 E3 — Lighthouse assertion gate (AC-PERF-13 + the CI-stable subset
 * of the §2 targets).
 *
 * Runs Lighthouse (DESKTOP preset) against the top-5 routes on a prod build
 * and asserts the lab-stable checks:
 *   - CLS ≤ 0.1 (a §2 CI target — layout stability is machine-independent)
 *   - TBT ≤ 300 ms (the lab proxy for INP; real INP comes from RUM —
 *     perf_vital events → perf_vitals_daily, alerts-not-gates)
 *   - image audits (AC-PERF-13): modern-image-formats ≥ 0.9,
 *     uses-responsive-images ≥ 0.5, offscreen-images ≥ 0.9, and the LCP
 *     element is never lazy-loaded
 *   - render-blocking-resources ≥ 0.9
 * LCP / TTFB absolute values are PRINTED but NOT asserted: localhost lab
 * numbers are not field P75 (machine/CI variance would make them flaky
 * gates); the production targets are monitored via RUM per the standing
 * "alerts, never gates" rule. Trend tracking lives in the checkpoint
 * reports' before/after tables.
 *
 * DESKTOP preset (not mobile) is deliberate: CI runners vary wildly in CPU,
 * and the 4× mobile throttle amplifies that variance into flaky assertions.
 * Mobile numbers are tracked in the checkpoint reports.
 *
 * Chrome: whatever chrome-launcher finds (system Chrome / CI's preinstalled
 * google-chrome). Do NOT point CHROME_PATH at Playwright's chromium — it
 * does not paint under Lighthouse on this machine (NO_FCP, learned the hard
 * way). LIGHTHOUSE_BIN overrides the binary (defaults to `npx --yes
 * lighthouse@12` so neither the repo nor CI needs a dependency).
 *
 * Reuses the budget gate's self-provisioning helpers — fresh throwaway
 * users + a minimal published course; runs against any Supabase project.
 *
 * Run: `npm run verify:budgets:lh`
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import {
  ensureBuild,
  ensureServer,
  loadEnv,
  provisionCourse,
  provisionUser,
  storageStateFor,
} from "./verify-bundle-budgets";

const BASE = process.env.PERF_BROWSER_BASE ?? "http://localhost:3100";

/* ──────────────────── THRESHOLDS (the ONE place) ───────────────────────── */

export const THRESHOLDS = {
  cls: 0.1, // §2 CI target
  tbtMs: 300, // lab INP proxy
  modernImageFormats: 0.9, // AC-PERF-13
  usesResponsiveImages: 0.5, // AC-PERF-13 (score 0.5 = minor savings only)
  offscreenImages: 0.9, // AC-PERF-13
  renderBlockingResources: 0.9,
} as const;

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

interface LhResult {
  finalDisplayedUrl: string;
  categories: { performance: { score: number | null } };
  audits: Record<string, { score: number | null; numericValue?: number } | undefined>;
}

function runLighthouse(url: string, cookieHeader: string, outPath: string): LhResult {
  const bin = process.env.LIGHTHOUSE_BIN;
  const lhArgs = [
    url,
    "--output=json",
    `--output-path=${outPath}`,
    "--only-categories=performance",
    "--preset=desktop",
    "--quiet",
    `--extra-headers=${JSON.stringify({ Cookie: cookieHeader })}`,
    "--chrome-flags=--headless=new --no-sandbox",
    "--max-wait-for-load=60000",
  ];
  const res = bin
    ? spawnSync(bin, lhArgs, { stdio: "pipe", timeout: 240_000 })
    : spawnSync("npx", ["--yes", "lighthouse@12", ...lhArgs], { stdio: "pipe", timeout: 300_000 });
  if (res.status !== 0) {
    throw new Error(
      `lighthouse failed for ${url}: ${res.stderr?.toString().slice(-400) ?? res.status}`
    );
  }
  return JSON.parse(readFileSync(outPath, "utf8")) as LhResult;
}

async function main() {
  const { url, anon } = loadEnv();
  if (!url || !anon) throw new Error("Missing Supabase env (process.env or .env.local)");
  ensureBuild();
  const server = await ensureServer();
  const tmp = mkdtempSync(path.join(tmpdir(), "lh-gate-"));
  const cleanup = () => {
    if (server && server.exitCode === null) server.kill("SIGTERM");
    rmSync(tmp, { recursive: true, force: true });
  };
  process.on("exit", cleanup);

  const author = await provisionUser(url, anon, "lh-author");
  const student = await provisionUser(url, anon, "lh-student");
  const fixture = await provisionCourse(author);
  const { error: enrollErr } = await student.client
    .from("enrollments")
    .insert({ course_id: fixture.courseId, user_id: student.userId });
  if (enrollErr) throw new Error(`enrollment insert: ${enrollErr.message}`);

  const browser = await chromium.launch();
  let cookies: Record<"author" | "student", string>;
  try {
    const cookieHeaderOf = async (email: string) => {
      const state = await storageStateFor(browser, email);
      return state.cookies
        .filter((c) => c.domain.includes("localhost"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
    };
    cookies = {
      author: await cookieHeaderOf(author.email),
      student: await cookieHeaderOf(student.email),
    };
  } finally {
    await browser.close();
  }

  const routes: { key: string; path: string; role: "author" | "student" }[] = [
    { key: "/dashboard", path: "/dashboard", role: "author" },
    { key: "/studio", path: `/studio?course=${fixture.courseId}`, role: "author" },
    {
      key: "/learn/[slug]/[lessonId]",
      path: `/learn/${fixture.slug}/${fixture.lessonId}`,
      role: "student",
    },
    {
      key: "/studio/[courseId]/analytics",
      path: `/studio/${fixture.courseId}/analytics`,
      role: "author",
    },
    { key: "/marketing", path: "/marketing", role: "author" },
  ];

  try {
    for (const route of routes) {
      console.log(`\n# lighthouse (desktop): ${route.key}`);
      const out = path.join(tmp, `${route.key.replace(/\W+/g, "_")}.json`);
      const lhr = runLighthouse(BASE + route.path, cookies[route.role], out);

      const landedRight = !lhr.finalDisplayedUrl.includes("/login");
      check(`${route.key}: measured the intended page`, landedRight, lhr.finalDisplayedUrl);
      if (!landedRight) continue;

      const a = lhr.audits;
      const cls = a["cumulative-layout-shift"]?.numericValue ?? NaN;
      const tbt = a["total-blocking-time"]?.numericValue ?? NaN;
      const lcp = a["largest-contentful-paint"]?.numericValue ?? NaN;
      const ttfb = a["server-response-time"]?.numericValue ?? NaN;
      check(`${route.key}: CLS ≤ ${THRESHOLDS.cls}`, cls <= THRESHOLDS.cls, cls.toFixed(4));
      check(`${route.key}: TBT ≤ ${THRESHOLDS.tbtMs}ms`, tbt <= THRESHOLDS.tbtMs, `${tbt.toFixed(0)}ms`);

      const score = (id: string) => a[id]?.score;
      const auditOk = (id: string, min: number) => {
        const s = score(id);
        // null = not applicable (e.g. no images on the page) — that PASSES.
        return s === null || s === undefined || s >= min;
      };
      check(
        `${route.key}: modern image formats`,
        auditOk("modern-image-formats", THRESHOLDS.modernImageFormats),
        `score ${score("modern-image-formats") ?? "n/a"}`
      );
      check(
        `${route.key}: properly sized images`,
        auditOk("uses-responsive-images", THRESHOLDS.usesResponsiveImages),
        `score ${score("uses-responsive-images") ?? "n/a"}`
      );
      check(
        `${route.key}: offscreen images deferred`,
        auditOk("offscreen-images", THRESHOLDS.offscreenImages),
        `score ${score("offscreen-images") ?? "n/a"}`
      );
      check(
        `${route.key}: LCP image not lazy-loaded`,
        auditOk("lcp-lazy-loaded", 1),
        `score ${score("lcp-lazy-loaded") ?? "n/a"}`
      );
      check(
        `${route.key}: no render-blocking resources`,
        auditOk("render-blocking-resources", THRESHOLDS.renderBlockingResources),
        `score ${score("render-blocking-resources") ?? "n/a"}`
      );
      console.log(
        `  · unasserted (RUM owns field targets): LCP ${(lcp / 1000).toFixed(2)}s · TTFB ${ttfb.toFixed(0)}ms · perf score ${((lhr.categories.performance.score ?? 0) * 100).toFixed(0)}`
      );
    }
  } finally {
    await author.client.from("courses").delete().eq("id", fixture.courseId);
    cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

if (process.argv[1]?.includes("verify-lighthouse-budgets")) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
