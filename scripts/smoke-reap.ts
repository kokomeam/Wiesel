/**
 * TASK 0 — Reap Automation API smoke test (Phase 1.5 PRD §9.3). GATES M-B.
 *
 * Corrected against Reap's REAL, live OpenAPI spec
 * (`https://public.reap.video/openapi.json` — not on any public docs page;
 * discovered by probing, not documented anywhere obvious). Field names are
 * **camelCase** (`sourceUrl`/`uploadId`, not `video_url`/`upload_id`) — the
 * first version of this script guessed wrong; see docs/reap-task0-findings.md
 * for the full writeup of what's now confirmed vs. still open.
 *
 * Confirmed so far (see the findings doc for detail):
 *   (a) create-clips DOES take explicit `selectedStart`/`selectedEnd` (secs)
 *       — but Reap enforces a ≥60s window, and whether it cuts EXACTLY that
 *       window or re-picks its own moment inside it is still UNCONFIRMED
 *       (every render attempt has failed on video-source fetching, not on
 *       request shape — see the "Unable to process video" finding).
 *   (b) no webhook field/endpoint exists anywhere in the API — check the
 *       Reap DASHBOARD for an account-level setting before assuming M-B
 *       must go poll-only.
 *   (c) no brand-template create API — `get-all-presets` is read-only,
 *       system-provided caption styles only.
 *   (d)/(e) NOT YET DONE — need one real ≥90s video Reap can actually fetch.
 *
 * Usage:
 *   REAP_API_KEY in .env.local, then:
 *     npx tsx scripts/smoke-reap.ts [--video-url <public mp4/YouTube/Vimeo url>]
 *
 * If --video-url is omitted, the script only does the safe, cost-free
 * discovery calls (get-upload-url, get-all-presets, get-all-projects) and
 * SKIPS submitting a render (rendering needs a video Reap can fetch — the
 * default placeholder URL in the previous version of this script was
 * rejected by Reap's fetcher). Pass a real URL, or use the upload flow
 * documented in the output, to actually exercise (a)/(d)/(e).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

try {
  const raw = readFileSync(join(HERE, "..", ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* fine */
}

const API_KEY = process.env.REAP_API_KEY;
const API_BASE = process.env.REAP_API_BASE ?? "https://public.reap.video/api/v1/automation";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const VIDEO_URL = argValue("--video-url") ?? process.env.REAP_SMOKE_VIDEO_URL;

interface Probe {
  step: string;
  method: string;
  path: string;
  requestBody?: unknown;
  status?: number;
  ok?: boolean;
  responseBody?: unknown;
  latencyMs?: number;
}
const findings: { ranAt: string; probes: Probe[]; conclusions: Record<string, string> } = {
  ranAt: new Date().toISOString(),
  probes: [],
  conclusions: {},
};

async function call(step: string, method: string, path: string, body?: unknown): Promise<Probe> {
  const started = Date.now();
  const p: Probe = { step, method, path, requestBody: body };
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  p.status = res.status;
  p.ok = res.ok;
  p.latencyMs = Date.now() - started;
  const text = await res.text();
  try {
    p.responseBody = JSON.parse(text);
  } catch {
    p.responseBody = text.slice(0, 2000);
  }
  findings.probes.push(p);
  console.log(`  [${p.status}] ${method} ${path} (${p.latencyMs}ms) — ${step}`);
  return p;
}

async function pollProjectStatus(projectId: string, timeoutMs = 25 * 60_000): Promise<Probe | null> {
  const started = Date.now();
  for (;;) {
    const r = await call("poll status", "GET", `/get-project-status?projectId=${projectId}`);
    const status = (r.responseBody as Record<string, unknown> | undefined)?.status;
    if (status === "completed") {
      findings.conclusions.ttfc_ms = String(Date.now() - started);
      return r;
    }
    if (["cancelled", "invalid", "expired", "failed", "error"].includes(String(status))) {
      findings.conclusions.render_failure = `terminal status: ${status}`;
      return r;
    }
    if (Date.now() - started > timeoutMs) {
      findings.conclusions.render_timeout = `no completion after ${timeoutMs / 60000}min`;
      return null;
    }
    await new Promise((res) => setTimeout(res, 15_000));
  }
}

async function main() {
  if (!API_KEY) {
    console.error(
      "REAP_API_KEY is not set (.env.local). Create a free Reap account (1h free processing), set REAP_API_KEY, re-run."
    );
    process.exit(1);
  }
  console.log(`# Task 0 — Reap smoke test\n# base: ${API_BASE}\n`);

  console.log("## (c) presets — read-only, system-provided caption styles");
  await call("(c) list presets", "GET", "/get-all-presets");

  console.log("\n## (d)/(e) upload flow (the robust path — sidesteps sourceUrl host compatibility)");
  const upload = await call("(d) get-upload-url", "POST", "/get-upload-url", {
    filename: "wisesel-smoke-test.mp4",
  });
  const uploadId = (upload.responseBody as Record<string, unknown> | undefined)?.id as string | undefined;
  const uploadUrl = (upload.responseBody as Record<string, unknown> | undefined)?.uploadUrl as
    | string
    | undefined;
  if (uploadId) {
    console.log(
      `  → PUT your video bytes to the uploadUrl above (Content-Type: video/mp4), then pass uploadId="${uploadId}" to create-clips/create-transcription/create-reframe instead of sourceUrl.`
    );
  }

  if (!VIDEO_URL) {
    console.log(
      "\n# No --video-url passed — skipping the render submission (needs a video Reap can actually fetch)."
    );
    console.log("# To finish (a)/(d)/(e): either");
    console.log("#   1. re-run with --video-url <a public mp4 / YouTube / Vimeo url your network can reach>, or");
    console.log(`#   2. PUT bytes to the uploadUrl above, then pass uploadId="${uploadId}" manually.`);
  } else {
    console.log(`\n## (a) create-clips with an explicit window (video: ${VIDEO_URL})`);
    const create = await call("(a) create-clips", "POST", "/create-clips", {
      sourceUrl: VIDEO_URL,
      selectedStart: 50,
      selectedEnd: 120, // ≥60s — Reap's confirmed minimum
      reframeClips: true,
      exportOrientation: "portrait",
      exportResolution: 720,
      genre: "talking",
      enableAutoHook: true,
      enableHighlights: true,
    });
    const projectId = (create.responseBody as Record<string, unknown> | undefined)?.projectId as
      | string
      | undefined;
    if (projectId) {
      console.log(`\n## polling get-project-status?projectId=${projectId}`);
      const done = await pollProjectStatus(projectId);
      if (done?.responseBody && (done.responseBody as Record<string, unknown>).status === "completed") {
        console.log("\n## (d) fetching the rendered clip(s) — compare .segments to the requested window");
        await call("(d) get-project-clips", "GET", `/get-project-clips?projectId=${projectId}`);
        await call("(e) get-project-details", "GET", `/get-project-details?projectId=${projectId}`);
      }
    } else {
      findings.conclusions.create_clips_failed = JSON.stringify(create.responseBody);
    }
  }

  const outPath = join(HERE, "..", "docs", "reap-task0-findings.generated.json");
  writeFileSync(outPath, JSON.stringify(findings, null, 2));
  console.log(`\n# raw findings → ${outPath}`);
  console.log("# transfer conclusions into docs/reap-task0-findings.md.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
