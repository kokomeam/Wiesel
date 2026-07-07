/**
 * TASK 0 — Reap Automation API smoke test (Phase 1.5 PRD §9.3). GATES M-B.
 *
 * Answers, against the LIVE vendor (zero cost — free tier covers 1h of
 * processing), the questions the ClipRenderProvider adapter design depends on:
 *
 *   (a) does /create-clips accept EXPLICIT in/out timestamps, or only
 *       prompt-steered topic selection? (no → adopt the pre-cut FFmpeg
 *       fallback, fully specified in M-B)
 *   (b) the webhook payload + signing scheme (pass --webhook-url to receive
 *       real deliveries; https://webhook.site is fine for the smoke test)
 *   (c) brand-template API fields (fonts/colors/logo/end-card)
 *   (d) one render per packaging preset, scored vs. an OpusClip reference
 *       render of the same span (§20 rubric — manual step, see findings doc)
 *   (e) TTFC (time-to-first-clip) + cost-minutes accounting
 *
 * Usage:
 *   REAP_API_KEY in .env.local, then:
 *     npx tsx scripts/smoke-reap.ts [--video-url <public mp4>] [--webhook-url <url>]
 *
 * Every request/response pair is dumped verbatim to
 * docs/reap-task0-findings.generated.json; transfer conclusions into
 * docs/reap-task0-findings.md (the committed findings doc) and surface
 * adapter-design changes for approval — CHECKPOINT before M-B.
 *
 * The script is EXPLORATORY and resilient: an unexpected 4xx/shape is a
 * FINDING, not a crash. It never references the publish/schedule endpoints
 * (the §3 fence — distribution is Phase 3).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/* tsx does not auto-load .env.local */
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

// A stable, public-domain lecture recording (override with --video-url).
const VIDEO_URL =
  argValue("--video-url") ??
  process.env.REAP_SMOKE_VIDEO_URL ??
  "https://archive.org/download/MIT6.00SCS11/MIT6_00SCS11_lec01_300k.mp4";
const WEBHOOK_URL = argValue("--webhook-url") ?? process.env.REAP_SMOKE_WEBHOOK_URL;

interface Probe {
  step: string;
  method: string;
  path: string;
  requestBody?: unknown;
  status?: number;
  ok?: boolean;
  responseBody?: unknown;
  latencyMs?: number;
  note?: string;
}

const findings: {
  ranAt: string;
  apiBase: string;
  videoUrl: string;
  webhookUrl: string | null;
  probes: Probe[];
  timings: Record<string, number>;
  conclusions: Record<string, string>;
} = {
  ranAt: new Date().toISOString(),
  apiBase: API_BASE,
  videoUrl: VIDEO_URL,
  webhookUrl: WEBHOOK_URL ?? null,
  probes: [],
  timings: {},
  conclusions: {},
};

async function probe(step: string, method: string, path: string, body?: unknown): Promise<Probe> {
  const started = Date.now();
  const p: Probe = { step, method, path, requestBody: body };
  try {
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
      p.responseBody = text.slice(0, 4000);
    }
  } catch (err) {
    p.note = `transport error: ${err instanceof Error ? err.message : String(err)}`;
  }
  findings.probes.push(p);
  console.log(`  [${p.status ?? "ERR"}] ${method} ${path} (${p.latencyMs ?? "-"}ms) — ${step}`);
  return p;
}

function idFrom(body: unknown): string | null {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const k of ["id", "job_id", "jobId", "project_id", "projectId", "task_id", "taskId"]) {
      if (typeof o[k] === "string") return o[k] as string;
      const data = o.data as Record<string, unknown> | undefined;
      if (data && typeof data[k] === "string") return data[k] as string;
    }
  }
  return null;
}

async function pollStatus(label: string, jobId: string, timeoutMs = 20 * 60_000): Promise<Probe | null> {
  const started = Date.now();
  // Try the plausible status paths once each, keep whichever responds 200.
  const candidates = [
    `/get-project-status?id=${jobId}`,
    `/project-status?id=${jobId}`,
    `/status?id=${jobId}`,
    `/jobs/${jobId}`,
  ];
  let statusPath: string | null = null;
  for (const c of candidates) {
    const r = await probe(`${label}: discover status endpoint`, "GET", c);
    if (r.ok) {
      statusPath = c;
      break;
    }
  }
  if (!statusPath) {
    findings.conclusions[`${label}_status_endpoint`] = "NONE of the guessed status paths responded 200 — read the dashboard/docs and record the real one.";
    return null;
  }
  findings.conclusions[`${label}_status_endpoint`] = statusPath;

  for (;;) {
    if (Date.now() - started > timeoutMs) {
      findings.conclusions[`${label}_poll`] = `timed out after ${timeoutMs / 60000}min`;
      return null;
    }
    const r = await probe(`${label}: poll`, "GET", statusPath);
    const body = JSON.stringify(r.responseBody ?? "");
    if (/complete|finished|success|ready|done/i.test(body)) {
      findings.timings[`${label}_ttfc_ms`] = Date.now() - started;
      return r;
    }
    if (/fail|error/i.test(body) && !/processing|queue/i.test(body)) {
      findings.conclusions[`${label}_poll`] = "job reported failure — see probes";
      return r;
    }
    await new Promise((res) => setTimeout(res, 15_000));
  }
}

async function main() {
  if (!API_KEY) {
    console.error(
      [
        "REAP_API_KEY is not set (.env.local).",
        "Task 0 is BLOCKED on this credential — create a free Reap account",
        "(free tier: 1 hour of processing), put the key in .env.local as",
        "REAP_API_KEY=..., then re-run:  npm run smoke:reap",
      ].join("\n")
    );
    process.exit(1);
  }

  console.log(`# Task 0 — Reap smoke test\n# base: ${API_BASE}\n# video: ${VIDEO_URL}\n`);

  /* (b) webhook registration — many APIs take it per-request; we pass it on
     every create call below AND probe a dedicated registration endpoint. */
  if (WEBHOOK_URL) {
    await probe("(b) webhook registration probe", "POST", "/register-webhook", { url: WEBHOOK_URL });
  } else {
    console.log("  (b) no --webhook-url passed — webhook capture will need a second run with one");
  }

  /* (e)/(1) transcription */
  console.log("\n## /create-transcription");
  const tx = await probe("(1) transcription", "POST", "/create-transcription", {
    video_url: VIDEO_URL,
    ...(WEBHOOK_URL ? { webhook_url: WEBHOOK_URL } : {}),
  });
  const txId = idFrom(tx.responseBody);
  if (txId) await pollStatus("transcription", txId);
  else findings.conclusions.transcription = "no job id recognized in the response — record the real field name";

  /* (a) THE gating question: explicit timestamps on /create-clips */
  console.log("\n## /create-clips — explicit timestamp probes (§9.3a)");
  const tsVariants: [string, unknown][] = [
    ["start/end seconds", { video_url: VIDEO_URL, start_time: 60, end_time: 105 }],
    ["startMs/endMs", { video_url: VIDEO_URL, start_ms: 60_000, end_ms: 105_000 }],
    ["segments array", { video_url: VIDEO_URL, segments: [{ start: 60, end: 105 }] }],
    ["prompt-steered (control)", { video_url: VIDEO_URL, prompt: "the moment defining what an algorithm is" }],
  ];
  const clipJobs: { label: string; id: string }[] = [];
  for (const [label, body] of tsVariants) {
    const r = await probe(`(a) create-clips: ${label}`, "POST", "/create-clips", {
      ...(body as Record<string, unknown>),
      ...(WEBHOOK_URL ? { webhook_url: WEBHOOK_URL } : {}),
    });
    const id = idFrom(r.responseBody);
    if (r.ok && id) clipJobs.push({ label, id });
  }
  findings.conclusions.explicit_timestamps =
    clipJobs.some((j) => !j.label.includes("control"))
      ? "at least one explicit-timestamp variant was ACCEPTED — record which; the adapter can cut precisely"
      : "NO explicit-timestamp variant accepted — ADOPT THE PRE-CUT FFMPEG FALLBACK in M-B (cut server-side, then /create-captions + /create-reframe)";

  /* (c) brand template probes */
  console.log("\n## brand templates (§9.3c)");
  await probe("(c) list templates", "GET", "/brand-templates");
  await probe("(c) create template", "POST", "/create-brand-template", {
    name: "wisesel-smoke-tofu",
    colors: { primary: "#f59e0b", secondary: "#ea580c" },
    font: "Inter",
    logo_url: null,
  });

  /* fallback building blocks (used if (a) is NO) */
  console.log("\n## caption + reframe building blocks");
  await probe("(fallback) create-captions", "POST", "/create-captions", {
    video_url: VIDEO_URL,
    ...(WEBHOOK_URL ? { webhook_url: WEBHOOK_URL } : {}),
  });
  await probe("(fallback) create-reframe", "POST", "/create-reframe", {
    video_url: VIDEO_URL,
    aspect: "9:16",
    ...(WEBHOOK_URL ? { webhook_url: WEBHOOK_URL } : {}),
  });

  /* (d)/(e) poll one clip job to completion for TTFC + result shape */
  if (clipJobs.length > 0) {
    console.log("\n## render poll (TTFC — §9.3e)");
    const done = await pollStatus("clip", clipJobs[0].id);
    if (done) {
      findings.conclusions.result_shape =
        "see the final poll probe for the result payload (download URL / duration / cost fields)";
    }
  }

  const outPath = join(HERE, "..", "docs", "reap-task0-findings.generated.json");
  writeFileSync(outPath, JSON.stringify(findings, null, 2));
  console.log(`\n# raw findings → ${outPath}`);
  console.log("# transfer conclusions into docs/reap-task0-findings.md and surface adapter decisions for approval (CHECKPOINT).");
  for (const [k, v] of Object.entries(findings.conclusions)) console.log(`  - ${k}: ${v}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
