// Test 2 — YouTube Shorts E2E. BUDGET: 1 upload (YouTube ONLY — TikTok/IG/FB deferred to Task 0b).
// 5s 1080x1920 clip → POST /upload async → poll status (stopwatch vs the 120s P95 target;
// single sample, labelled as such) → resolve video ID + URL via status/history → curl until
// live → Shorts-registration check (youtube.com/shorts/{id} serves directly for a Short,
// redirects to /watch for a non-Short). NEVER re-fires the publish call.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { call, logStep, capture, sleep, SPIKE_DIR, PROFILE } from "./lib/api.mjs";

const execFileP = promisify(execFile);
const CLIP = path.join(SPIKE_DIR, "media", "test-clip-1080x1920-5s.mp4");
const stamp = new Date().toISOString();
const TITLE = `WiseSel vertical test ${stamp} #Shorts`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// curl-based URL check (follows redirects, reports final URL). Tries direct first; on a
// TRANSPORT failure retries through a proxy candidate (this dev machine sometimes needs
// Clash for Google properties — same class of issue as the OpenAI SDK proxy memory).
const PROXY = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.OPENAI_PROXY_URL ?? "http://127.0.0.1:7890";
let transportUsed = "direct";
async function curlCheck(url) {
  const args = ["-sS", "-o", "/dev/null", "-w", "%{http_code} %{url_effective}", "-L", "--max-time", "25", "-A", UA, url];
  try {
    const { stdout } = await execFileP("curl", transportUsed === "direct" ? args : ["--proxy", PROXY, ...args]);
    const [code, ...rest] = stdout.trim().split(" ");
    return { code: Number(code), effectiveUrl: rest.join(" "), transport: transportUsed };
  } catch (e) {
    if (transportUsed === "direct") {
      transportUsed = "proxy";
      console.log(`  (direct curl failed: ${String(e.message).slice(0, 120)} — switching to proxy ${PROXY})`);
      return curlCheck(url);
    }
    return { code: 0, error: String(e.message).slice(0, 200), transport: transportUsed };
  }
}

function buildForm() {
  const form = new FormData();
  form.set("user", PROFILE);
  form.append("platform[]", "youtube");
  form.set("video", new Blob([fs.readFileSync(CLIP)], { type: "video/mp4" }), "test-clip-1080x1920-5s.mp4");
  form.set("title", TITLE);
  form.set("youtube_title", TITLE);
  form.set("async_upload", "true");
  return form;
}

logStep("Upload 3/3 — POST /upload async (youtube only)");
const t0 = Date.now();
const res = await call("POST", "/upload", { form: buildForm(), captureAs: "test2-upload-youtube-async" });
console.log("status:", res.status, `(${res.elapsedMs}ms)`);
console.log(JSON.stringify(res.body, null, 2).slice(0, 2000));

if (res.status !== 200 || res.body?.success === false) {
  console.error("KILL: YouTube upload call failed — stopping per kill-order. NOT retrying.");
  process.exit(1);
}
const requestId = res.body?.request_id ?? null;
const syncYt = res.body?.results?.youtube ?? null; // in case async_upload was ignored and it ran sync

// ---- poll /uploadposts/status (only if async) ---------------------------
let statusEntry = syncYt ? { ...syncYt, platform: "youtube", from: "sync-response" } : null;
let apiCompleteMs = syncYt ? res.elapsedMs : null;
let finalStatusRecord = null;
if (requestId && !syncYt) {
  console.log(`\nrequest_id=${requestId} — polling status every 5s (t0=${new Date(t0).toISOString()})`);
  for (let i = 0; i < 144; i++) { // up to 12 min
    await sleep(5000);
    const st = await call("GET", "/uploadposts/status", { query: { request_id: requestId } });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const results = st.body?.results ?? [];
    const list = Array.isArray(results) ? results : Object.entries(results).map(([platform, r]) => ({ platform, ...r }));
    const yt = list.find((r) => (r.platform ?? "").toLowerCase() === "youtube");
    if (yt && yt.success !== undefined && !statusEntry) {
      statusEntry = yt;
      apiCompleteMs = Date.now() - t0;
      console.log(`  [${elapsed}s] youtube: success=${yt.success} ${JSON.stringify(yt).slice(0, 400)}`);
    }
    if (i % 6 === 0) console.log(`  [${elapsed}s] aggregate=${st.body?.status} completed=${st.body?.completed}/${st.body?.total}`);
    if (st.body?.status === "completed" || (st.body?.completed != null && st.body.completed >= (st.body.total ?? 1))) {
      finalStatusRecord = st.record;
      break;
    }
  }
  if (finalStatusRecord) capture("test2-status-final", finalStatusRecord);
  else {
    const st = await call("GET", "/uploadposts/status", { query: { request_id: requestId }, captureAs: "test2-status-timeout" });
    console.log("TIMEOUT after 12min of polling; last status:", JSON.stringify(st.body).slice(0, 1500));
  }
}
if (statusEntry?.success === false) {
  console.error("KILL: YouTube reported failure in status:", JSON.stringify(statusEntry).slice(0, 500));
  capture("test2-summary", { verdict: "FAIL — platform-side failure", statusEntry });
  process.exit(1);
}

// ---- history: video id + post_url ---------------------------------------
logStep("GET /uploadposts/history — resolve video id/url");
await sleep(8000);
const history = await call("GET", "/uploadposts/history", { query: { limit: "10", page: "1" }, captureAs: "test2-history" });
const mine = (history.body?.history ?? []).filter((h) => h.request_id === requestId || h.post_title === TITLE || h.post_caption === TITLE);
for (const r of mine) {
  console.log(` ${r.platform}: success=${r.success} platform_post_id=${r.platform_post_id} post_url=${r.post_url} transcoded=${r.video_was_transcoded} changes=${JSON.stringify(r.changes)}`);
}
capture("test2-history-matching-rows", mine);

function extractVideoId(...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === "string" && /^[A-Za-z0-9_-]{11}$/.test(c)) return c;
    const m = String(c).match(/(?:watch\?v=|shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }
  return null;
}
const histRow = mine.find((r) => (r.platform ?? "").toLowerCase() === "youtube") ?? null;
const videoId = extractVideoId(
  histRow?.platform_post_id, statusEntry?.post_id, statusEntry?.video_id, syncYt?.video_id, syncYt?.post_id,
  histRow?.post_url, statusEntry?.url, syncYt?.url,
);
const postUrl = histRow?.post_url ?? statusEntry?.url ?? syncYt?.url ?? (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);
console.log(`\nvideoId=${videoId} postUrl=${postUrl}`);

if (!videoId && !postUrl) {
  console.error("DISQUALIFYING-ADJACENT: no video ID or URL retrievable via API (status+history). Stopping.");
  capture("test2-summary", { verdict: "FAIL — no video id/url via API", statusEntry, historyRow: histRow });
  process.exit(1);
}

// ---- live check + Shorts registration -----------------------------------
logStep("Live-on-platform check (curl until <400, 15 min cap)");
let live = null;
const deadline = t0 + 15 * 60 * 1000;
while (Date.now() < deadline) {
  const r = await curlCheck(postUrl);
  if (r.code >= 200 && r.code < 400) { live = { ...r, liveAtSeconds: +((Date.now() - t0) / 1000).toFixed(1) }; break; }
  console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${r.code || r.error}`);
  await sleep(10000);
}
console.log("live:", JSON.stringify(live));

logStep("Shorts registration check — does /shorts/{id} serve directly?");
let shorts = null;
if (videoId) {
  shorts = await curlCheck(`https://www.youtube.com/shorts/${videoId}`);
  const staysOnShorts = shorts.effectiveUrl?.includes("/shorts/");
  shorts.registeredAsShort = shorts.code >= 200 && shorts.code < 400 ? (staysOnShorts ? true : "NO — redirected to " + shorts.effectiveUrl) : "UNKNOWN (http " + shorts.code + ")";
  console.log("shorts check:", JSON.stringify(shorts));
}

// ---- webhook inbox -------------------------------------------------------
logStep("Webhook inbox payloads (upload_completed)");
let webhookPayloads = [];
try {
  const inbox = JSON.parse(fs.readFileSync(path.join(SPIKE_DIR, "webhook-inbox.json"), "utf8"));
  const wres = await fetch(`https://webhook.site/token/${inbox.uuid}/requests`);
  const wjson = await wres.json();
  webhookPayloads = (wjson.data ?? []).map((r) => { try { return JSON.parse(r.content); } catch { return r.content; } });
  capture("test2-webhook-payloads", webhookPayloads);
  console.log(`received ${webhookPayloads.length} webhook payload(s)`);
} catch (e) {
  console.log("no webhook inbox / fetch failed:", String(e).slice(0, 200));
}

const summary = {
  title: TITLE, requestId, videoId, postUrl,
  uploadCallMs: res.elapsedMs,
  apiCompleteSeconds: apiCompleteMs != null ? +(apiCompleteMs / 1000).toFixed(1) : null,
  liveOnPlatform: live,
  shortsCheck: shorts,
  statusEntry, historyRow: histRow,
  transcoded: histRow?.video_was_transcoded ?? null,
  webhookCount: webhookPayloads.length,
  p95Note: "single sample — indicative, not a P95",
  verdict: {
    idAndUrlViaApi: videoId || postUrl ? "PASS" : "FAIL",
    liveWithin120s: live ? (live.liveAtSeconds <= 120 ? "PASS" : `SLOW (${live.liveAtSeconds}s)`) : "NOT CONFIRMED LIVE in 15min",
    registeredAsShort: shorts?.registeredAsShort ?? "UNKNOWN",
  },
};
capture("test2-summary", summary);

const statePath = path.join(SPIKE_DIR, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
state.youtube = { title: TITLE, videoId, postUrl, requestId, at: stamp };
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

console.log("\n" + JSON.stringify(summary.verdict, null, 2));
console.log("\nTest 2 done — 3/3 budget consumed. NO further publish calls allowed.");
