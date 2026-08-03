// Test 1 — LinkedIn: result retrieval + idempotency + FIRST COMMENT. BUDGET: 2 uploads.
// Fires the IDENTICAL payload twice back-to-back (second the moment the first returns),
// INCLUDING the first-comment parameter (note: /upload_text has only the GENERIC
// `first_comment` — `linkedin_first_comment` exists only on the video endpoint; whether
// the generic one lands on LinkedIn text posts is exactly what we're verifying).
// Then reads /uploadposts/history to resolve platform_post_id + post_url per row.
// DISQUALIFYING (exit 1) if the platform post ID/URL cannot be retrieved via API.
// NEVER re-fires a publish call — verification is GET-only.
import fs from "node:fs";
import path from "node:path";
import { call, logStep, capture, sleep, PROFILE, SPIKE_DIR } from "./lib/api.mjs";

const stamp = new Date().toISOString();
const TITLE = `WiseSel API verification test ${stamp} — please ignore, will be removed.`;
const FIRST_COMMENT = `First comment via API 🧪 (${stamp}) — part of the same verification test.`;

function buildForm() {
  const form = new FormData();
  form.set("user", PROFILE);
  form.append("platform[]", "linkedin");
  form.set("title", TITLE);
  form.set("first_comment", FIRST_COMMENT); // generic param — the live question
  return form;
}

logStep("Upload 1/2 — POST /upload_text (linkedin, with first_comment)");
const first = await call("POST", "/upload_text", { form: buildForm(), captureAs: "test1-upload-text-call1" });
console.log("status:", first.status, `(${first.elapsedMs}ms)`);
console.log(JSON.stringify(first.body, null, 2).slice(0, 2500));

if (first.status !== 200 || first.body?.success !== true) {
  console.error("KILL: first LinkedIn text post failed — stopping per kill-order. NOT retrying.");
  process.exit(1);
}

logStep("Upload 2/2 — IDENTICAL payload, immediately (idempotency probe)");
const second = await call("POST", "/upload_text", { form: buildForm(), captureAs: "test1-upload-text-call2-identical" });
console.log("status:", second.status, `(${second.elapsedMs}ms)`);
console.log(JSON.stringify(second.body, null, 2).slice(0, 2500));

// ---- resolve post IDs/URLs — sync response first, then history ---------
function linkedinResult(body) {
  const r = body?.results?.linkedin ?? body?.results?.LinkedIn;
  return r ? { url: r.url ?? null, post_id: r.post_id ?? r.publish_id ?? null, raw: r } : null;
}
const syncR1 = linkedinResult(first.body);
const syncR2 = linkedinResult(second.body);
console.log("\nsync response 1 linkedin:", JSON.stringify(syncR1)?.slice(0, 400));
console.log("sync response 2 linkedin:", JSON.stringify(syncR2)?.slice(0, 400));

logStep("GET /uploadposts/history — platform_post_id + post_url for both rows");
await sleep(8000); // let history settle
const history = await call("GET", "/uploadposts/history", { query: { limit: "10", page: "1" }, captureAs: "test1-history-after-text" });
const rows = (history.body?.history ?? []).filter((h) => h.post_title === TITLE || h.post_caption === TITLE || h.title === TITLE);
console.log(`history rows matching this test: ${rows.length}`);
for (const r of rows) {
  console.log(` platform=${r.platform} success=${r.success} platform_post_id=${r.platform_post_id} post_url=${r.post_url}`);
}
capture("test1-history-matching-rows", rows);

const ids = [
  ...[syncR1, syncR2].filter(Boolean).map((r) => ({ source: "sync", post_id: r.post_id, url: r.url })),
  ...rows.map((r) => ({ source: "history", post_id: r.platform_post_id ?? null, url: r.post_url ?? null })),
].filter((x) => x.post_id || x.url);

const usage1 = first.body?.usage ?? null;
const usage2 = second.body?.usage ?? null;

const summary = {
  title: TITLE,
  firstComment: FIRST_COMMENT,
  firstCommentParamNote: "generic first_comment (linkedin_first_comment only exists on /api/upload video) — visual check of the live post decides whether it landed",
  call1: { status: first.status, elapsedMs: first.elapsedMs, linkedin: syncR1, usage: usage1 },
  call2: { status: second.status, elapsedMs: second.elapsedMs, linkedin: syncR2, usage: usage2 },
  usageDelta: usage1 && usage2 ? usage2.count - usage1.count : null,
  historyMatches: rows.length,
  retrievedRefs: ids,
  verdict: {
    resultRetrieval: ids.length > 0 ? "PASS — post ID/URL retrievable via API" : "FAIL — DISQUALIFYING",
    idempotency:
      rows.length >= 2 || (syncR1?.post_id && syncR2?.post_id && syncR1.post_id !== syncR2.post_id)
        ? "DOUBLE-POSTED (no dedupe)"
        : second.status !== 200 || second.body?.success !== true
          ? `second call rejected (status ${second.status}) — see samples`
          : "AMBIGUOUS — check samples/history",
  },
};
capture("test1-summary", summary);

// hand post refs to 03/05 (delete probes)
const statePath = path.join(SPIKE_DIR, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
state.linkedin = { title: TITLE, refs: ids, at: stamp };
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

console.log("\n" + JSON.stringify(summary.verdict, null, 2));
if (ids.length === 0) {
  console.error("\nDISQUALIFYING: no platform post ID/URL retrievable from sync response OR history.");
  process.exit(1);
}
console.log("\nTest 1 done — 2/3 budget consumed.");
