// PERF-1 Phase A lab baseline harness (Playwright, desktop unthrottled).
// Lighthouse (throttled mobile + desktop) runs separately — see perf-lighthouse.mjs.
// Run from the repo root: node <this file>
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const { chromium } = createRequire("/Users/admin/Desktop/App/package.json")("playwright");

const BASE = "http://localhost:3100";
const OUT = process.env.OUT ?? "/private/tmp/claude-501/-Users-admin-Desktop-App/a4e43ce0-4489-4da4-8779-5555aa69b00e/scratchpad";
const envRaw = readFileSync(new URL("/Users/admin/Desktop/App/.env.local", import.meta.url), "utf8");
const SUPA = envRaw.match(/NEXT_PUBLIC_SUPABASE_URL\s*=\s*["']?([^\s"']+)/)[1];

const PASSWORD = "Test-passw0rd!";
const AUTHOR = "maint-fixture-author-291556af@example.com";
const STUDENT = "maint-fixture-student-8f49d4be@example.com";
const COURSE_ID = "1d730f8c-fc9e-4e87-9eb7-6a2a654506bd";
const SLUG = "econ-fixture-d5eace";
const LESSON_A = "98e34ffe-fbe3-4b45-be37-29a1dfcc50f7";

const ROUTES = [
  { name: "dashboard", path: "/dashboard", role: "author", ready: "text-heuristic" },
  { name: "studio", path: "/studio", role: "author", ready: "text-heuristic" },
  { name: "learn-lesson", path: `/learn/${SLUG}/${LESSON_A}`, role: "student", ready: '[aria-label="Next slide"]' },
  { name: "studio-analytics", path: `/studio/${COURSE_ID}/analytics`, role: "author", ready: "text-heuristic" },
  { name: "marketing", path: "/marketing", role: "author", ready: "text-heuristic" },
];

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Buffered vitals + resource collector, injected before nav.
const INIT = `(() => {
  window.__perf = { lcp: 0, cls: 0, fcp: 0, events: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime; })
    .observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; })
    .observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__perf.fcp = e.startTime; })
    .observe({ type: "paint", buffered: true });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.events.push({ name: e.name, dur: e.duration }); })
      .observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch {}
})()`;

async function signIn(browser, email) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "load" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  // prod-server clicks can beat hydration — retry the submit until navigation happens
  for (let i = 0; i < 10; i++) {
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL(/dashboard|home/, { timeout: 6000 });
      break;
    } catch {
      if (i === 9) throw new Error(`login stuck for ${email}; page text: ${(await page.innerText("body")).slice(0, 300)}`);
    }
  }
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function waitReady(page, ready, timeout = 45000) {
  if (ready === "text-heuristic") {
    await page.waitForFunction(
      () => (document.querySelector("main") ?? document.body).innerText.trim().length > 80,
      undefined, { timeout },
    );
  } else {
    await page.waitForSelector(ready, { timeout });
  }
}

async function coldLoad(browser, state, route) {
  const ctx = await browser.newContext({ storageState: state });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  const dataReqs = [];
  page.on("request", (r) => {
    if (r.url().startsWith(SUPA)) dataReqs.push({ url: r.url().slice(SUPA.length, SUPA.length + 90), t: Date.now() });
  });
  await page.goto(BASE + route.path, { waitUntil: "commit" });
  await waitReady(page, route.ready);
  await page.waitForLoadState("load");
  await page.waitForTimeout(2500); // CLS/LCP settle + late client fetches
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const res = performance.getEntriesByType("resource");
    const scripts = res.filter((r) => r.initiatorType === "script" || r.name.endsWith(".js") || r.name.includes("/_next/static/chunks/"));
    return {
      ttfb: nav.responseStart,
      fcp: window.__perf.fcp,
      lcp: window.__perf.lcp,
      cls: window.__perf.cls,
      domInteractive: nav.domInteractive,
      load: nav.loadEventEnd,
      docBytes: nav.encodedBodySize,
      jsWireBytes: scripts.reduce((s, r) => s + (r.encodedBodySize || 0), 0),
      jsCount: scripts.length,
      totalWireBytes: res.reduce((s, r) => s + (r.encodedBodySize || 0), 0) + nav.encodedBodySize,
    };
  });
  m.clientDataRequests = dataReqs.length;
  m.dataReqSample = dataReqs.slice(0, 12);
  await ctx.close();
  return m;
}

// Transition: dashboard -> target via real <a> click if one exists, plus back-nav timing.
async function transitions(browser, state, route) {
  const ctx = await browser.newContext({ storageState: state });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  const from = route.role === "student" ? `/learn/${SLUG}` : "/dashboard";
  await page.goto(BASE + from, { waitUntil: "load" });
  await page.waitForTimeout(800);

  const href = route.path;
  const link = page.locator(`a[href="${href}"]`).first();
  const hasLink = (await link.count()) > 0 && route.path !== from;
  let clickToUrl = null, clickToContent = null, clickFeedback = null;
  if (hasLink) {
    const t0 = await page.evaluate(() => performance.now());
    await link.click();
    await page.waitForURL("**" + href, { timeout: 45000 });
    const t1 = await page.evaluate(() => performance.now());
    await waitReady(page, route.ready);
    const t2 = await page.evaluate(() => performance.now());
    clickToUrl = t1 - t0;
    clickToContent = t2 - t0;
    // First visual feedback after the click: longest captured click interaction duration
    clickFeedback = await page.evaluate(() => {
      const clicks = window.__perf.events.filter((e) => e.name.includes("click") || e.name.includes("pointerup"));
      return clicks.length ? Math.max(...clicks.map((e) => e.dur)) : null;
    });
  } else {
    await page.goto(BASE + href, { waitUntil: "commit" });
    await waitReady(page, route.ready);
  }
  await page.waitForTimeout(500);

  // Back-nav to the previous view, then forward again to the route (warm revisit)
  const b0 = await page.evaluate(() => performance.now());
  await page.goBack();
  await page.waitForFunction(() => (document.querySelector("main") ?? document.body).innerText.trim().length > 80);
  const b1 = await page.evaluate(() => performance.now());
  const f0 = await page.evaluate(() => performance.now());
  await page.goForward();
  await waitReady(page, route.ready);
  const f1 = await page.evaluate(() => performance.now());
  await ctx.close();
  return { hasLink, clickToUrl, clickToContent, clickFeedback, backNav: b1 - b0, forwardRevisit: f1 - f0 };
}

async function slideAdvance(browser, state) {
  const ctx = await browser.newContext({ storageState: state });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/learn/${SLUG}/${LESSON_A}`, { waitUntil: "load" });
  await page.waitForSelector('[aria-label="Next slide"]', { timeout: 45000 });
  await page.waitForTimeout(1000);
  const times = [];
  for (let i = 0; i < 1; i++) {
    const dt = await page.evaluate(async () => {
      const btn = [...document.querySelectorAll('[aria-label="Next slide"]')].pop();
      const stage = btn.closest("section") ?? document.querySelector("main") ?? document.body;
      const before = stage.innerHTML.length;
      const t0 = performance.now();
      btn.click();
      return await new Promise((resolve) => {
        const check = () => {
          if (stage.innerHTML.length !== before) resolve(performance.now() - t0);
          else if (performance.now() - t0 > 5000) resolve(-1);
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
    });
    times.push(dt);
    await page.waitForTimeout(400);
  }
  await ctx.close();
  return { advanceMs: times };
}

const RUNS = Number(process.env.RUNS ?? 3);
const browser = await chromium.launch();
const states = {
  author: await signIn(browser, AUTHOR),
  student: await signIn(browser, STUDENT),
};
writeFileSync(`${OUT}/state-author.json`, JSON.stringify(states.author));
writeFileSync(`${OUT}/state-student.json`, JSON.stringify(states.student));
console.log("signed in: author + student");

const results = {};
for (const route of ROUTES) {
  const cold = [];
  for (let i = 0; i < RUNS; i++) cold.push(await coldLoad(browser, states[route.role], route));
  const med = {};
  for (const k of ["ttfb", "fcp", "lcp", "cls", "domInteractive", "load", "docBytes", "jsWireBytes", "jsCount", "totalWireBytes", "clientDataRequests"])
    med[k] = median(cold.map((c) => c[k]));
  med.dataReqSample = cold[0].dataReqSample;
  let trans = null;
  try { trans = await transitions(browser, states[route.role], route); } catch (e) { trans = { error: String(e).slice(0, 200) }; }
  results[route.name] = { path: route.path, cold: med, coldRuns: cold.map((c) => { const r = { ...c }; delete r.dataReqSample; return r; }), transitions: trans };
  console.log(`${route.name}: TTFB ${med.ttfb.toFixed(0)}ms FCP ${med.fcp.toFixed(0)}ms LCP ${med.lcp.toFixed(0)}ms CLS ${med.cls.toFixed(3)} JS ${(med.jsWireBytes / 1024).toFixed(0)}KB(gz) reqs ${med.clientDataRequests}`);
}
try { results["learn-lesson"].slideAdvance = await slideAdvance(browser, states.student); } catch (e) { results["learn-lesson"].slideAdvance = { error: String(e).slice(0, 200) }; }

await browser.close();
writeFileSync(`${OUT}/lab-results.json`, JSON.stringify(results, null, 2));
console.log("\nwrote lab-results.json");
