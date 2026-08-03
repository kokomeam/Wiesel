// PERF-1 Phase A — Lighthouse baseline (throttled mobile default + desktop preset)
// Auth via Cookie header extracted from the Playwright storageState files.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const require = createRequire("/Users/admin/Desktop/App/package.json");
const { chromium } = require("playwright");

const OUT = "/private/tmp/claude-501/-Users-admin-Desktop-App/a4e43ce0-4489-4da4-8779-5555aa69b00e/scratchpad";
const BASE = "http://localhost:3100";
const COURSE_ID = "1d730f8c-fc9e-4e87-9eb7-6a2a654506bd";
const SLUG = "econ-fixture-d5eace";
const LESSON_A = "98e34ffe-fbe3-4b45-be37-29a1dfcc50f7";

const cookieHeader = (stateFile) => {
  const state = JSON.parse(readFileSync(`${OUT}/${stateFile}`, "utf8"));
  return state.cookies.filter((c) => c.domain.includes("localhost")).map((c) => `${c.name}=${c.value}`).join("; ");
};
const COOKIES = { author: cookieHeader("state-author.json"), student: cookieHeader("state-student.json") };

const ROUTES = [
  { name: "dashboard", path: "/dashboard", role: "author" },
  { name: "studio", path: "/studio", role: "author" },
  { name: "learn-lesson", path: `/learn/${SLUG}/${LESSON_A}`, role: "student" },
  { name: "studio-analytics", path: `/studio/${COURSE_ID}/analytics`, role: "author" },
  { name: "marketing", path: "/marketing", role: "author" },
];

const CHROME = chromium.executablePath();
const LH = `${process.env.HOME}/.npm-lighthouse/node_modules/.bin/lighthouse`;

const results = {};
for (const ff of ["mobile", "desktop"]) {
  for (const r of ROUTES) {
    const out = `${OUT}/lh-${r.name}-${ff}.json`;
    const args = [
      BASE + r.path, "--output=json", `--output-path=${out}`, "--only-categories=performance",
      "--quiet", `--extra-headers=${JSON.stringify({ Cookie: COOKIES[r.role] })}`,
      "--chrome-flags=--headless=new --no-sandbox",
      "--max-wait-for-load=60000",
    ];
    if (ff === "desktop") args.push("--preset=desktop");
    try {
      execFileSync(LH, args, { env: { ...process.env, CHROME_PATH: CHROME }, stdio: "pipe", timeout: 180000 });
      const j = JSON.parse(readFileSync(out, "utf8"));
      const a = j.audits;
      const pick = (id) => a[id] ? { v: a[id].numericValue, score: a[id].score } : null;
      results[`${r.name}:${ff}`] = {
        finalUrl: j.finalDisplayedUrl,
        perfScore: j.categories.performance.score,
        lcpMs: pick("largest-contentful-paint")?.v,
        fcpMs: pick("first-contentful-paint")?.v,
        cls: pick("cumulative-layout-shift")?.v,
        tbtMs: pick("total-blocking-time")?.v,
        ttfbMs: pick("server-response-time")?.v,
        interactiveMs: pick("interactive")?.v,
        totalBytes: pick("total-byte-weight")?.v,
        imgAudits: {
          modernFormats: a["modern-image-formats"]?.score,
          properlySized: a["uses-responsive-images"]?.score,
          offscreenLazy: a["offscreen-images"]?.score,
          lcpLazyLoaded: a["lcp-lazy-loaded"]?.score,
          prioritizeLcp: a["prioritize-lcp-image"]?.score,
          fontDisplay: a["font-display"]?.score,
          renderBlocking: a["render-blocking-resources"]?.score,
        },
      };
      const x = results[`${r.name}:${ff}`];
      console.log(`${r.name}:${ff} score=${(x.perfScore * 100).toFixed(0)} LCP=${(x.lcpMs / 1000).toFixed(1)}s CLS=${x.cls?.toFixed(3)} TBT=${x.tbtMs?.toFixed(0)}ms TTFB=${x.ttfbMs?.toFixed(0)}ms url=${x.finalUrl}`);
    } catch (e) {
      results[`${r.name}:${ff}`] = { error: String(e).slice(0, 300) };
      console.log(`${r.name}:${ff} FAILED: ${String(e).slice(0, 160)}`);
    }
  }
}
writeFileSync(`${OUT}/lighthouse-summary.json`, JSON.stringify(results, null, 2));
console.log("wrote lighthouse-summary.json");
