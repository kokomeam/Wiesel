// Tests 3+4 — ZERO uploads.
// Test 3: probe plausible delete endpoints for the LinkedIn post(s) AND the YouTube video
//         (the OpenAPI spec documents NO published-post deletion — expect 404/405; probing
//         proves it live and captures the response shapes).
// Test 4 (live part): one deliberate 400 (invalid platform value is rejected pre-quota)
//         + final usage read to confirm exactly 3 uploads consumed.
// Post refs auto-load from state.json (written by tests 1+2); argv overrides.
import fs from "node:fs";
import path from "node:path";
import { call, logStep, capture, PROFILE, SPIKE_DIR } from "./lib/api.mjs";

const statePath = path.join(SPIKE_DIR, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const LINKEDIN_ID = process.argv[2] ?? state.linkedin?.refs?.find((r) => r.post_id)?.post_id ?? "URN_PLACEHOLDER";
const YOUTUBE_ID = process.argv[3] ?? state.youtube?.videoId ?? "VIDEO_ID_PLACEHOLDER";
console.log(`refs: linkedin=${LINKEDIN_ID} youtube=${YOUTUBE_ID}`);

logStep("Test 3 — delete probes (spec documents NO published-post deletion)");
const probes = [
  // LinkedIn post
  ["DELETE", `/uploadposts/posts/${encodeURIComponent(LINKEDIN_ID)}`, null],
  ["DELETE", `/upload/${encodeURIComponent(LINKEDIN_ID)}`, null],
  ["DELETE", `/uploadposts/history/${encodeURIComponent(LINKEDIN_ID)}`, null],
  ["POST", `/uploadposts/posts/delete`, { post_id: LINKEDIN_ID, profile_username: PROFILE, platform: "linkedin" }],
  // YouTube video (same coverage question, per-platform)
  ["DELETE", `/uploadposts/posts/${encodeURIComponent(YOUTUBE_ID)}`, null],
  ["DELETE", `/uploadposts/videos/${encodeURIComponent(YOUTUBE_ID)}`, null],
  ["POST", `/uploadposts/posts/delete`, { post_id: YOUTUBE_ID, profile_username: PROFILE, platform: "youtube" }],
];
const probeResults = [];
for (const [method, p, json] of probes) {
  const r = await call(method, p, json ? { json } : {});
  console.log(` ${method} ${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  probeResults.push({ method, path: p, requestBody: json ?? undefined, status: r.status, body: r.body });
}
capture("test3-delete-probes", probeResults);
const anyDeleteWorked = probeResults.some((r) => r.status >= 200 && r.status < 300);
console.log(anyDeleteWorked
  ? "!! a delete probe returned 2xx — inspect samples (unexpected vs spec)"
  : "confirmed: no delete endpoint responded 2xx — deletion is manual, per spec");

logStep("Test 4 — deliberate 400 (invalid platform, rejected before quota)");
const form = new FormData();
form.set("user", PROFILE);
form.append("platform[]", "myspace"); // invalid on purpose
form.set("title", "error-shape probe — never posts");
const bad = await call("POST", "/upload_text", { form, captureAs: "test4-deliberate-400" });
console.log("status:", bad.status, "| body:", JSON.stringify(bad.body).slice(0, 500));

logStep("Test 4 — final usage/limits read (expect exactly 3 consumed)");
const me = await call("GET", "/uploadposts/me", { captureAs: "test4-final-me" });
console.log("me:", JSON.stringify(me.body).slice(0, 800));
const hist = await call("GET", "/uploadposts/history", { query: { limit: "5", page: "1" }, captureAs: "test4-final-history-head" });
console.log(`history head: ${(hist.body?.history ?? []).length} rows (usage rides in upload responses; history is the audit trail)`);

console.log("\nTests 3+4 (live parts) done — 0 additional uploads.");
