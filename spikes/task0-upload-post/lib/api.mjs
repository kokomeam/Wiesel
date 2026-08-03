// THROWAWAY SPIKE — raw fetch helper for the Upload-Post API.
// Captures every request/response (redacted) into samples/ as evidence for FINDINGS.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SPIKE_DIR = path.join(__dirname, "..");
export const SAMPLES_DIR = path.join(SPIKE_DIR, "samples");

export const API_BASE = "https://api.upload-post.com/api";
export const APP_BASE = "https://app.upload-post.com/api"; // notifications endpoint lives here per OpenAPI `servers` override

// Live account reality (2026-07-17): the one existing profile is "henry", not the brief's "test".
export const PROFILE = process.env.UPLOAD_POST_PROFILE ?? "henry";

export function apiKey() {
  const key = process.env.UPLOAD_POST_API_KEY;
  if (!key) {
    console.error("FATAL: UPLOAD_POST_API_KEY is not set. Add it to the repo .env.local and re-run with --env-file.");
    process.exit(2);
  }
  return key;
}

// ---- redaction ----------------------------------------------------------
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function redact(value) {
  let s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const key = process.env.UPLOAD_POST_API_KEY;
  if (key) s = s.split(key).join("[REDACTED_API_KEY]");
  s = s.replace(JWT_RE, "[REDACTED_JWT]");
  s = s.replace(EMAIL_RE, "[REDACTED_EMAIL]");
  return typeof value === "string" ? s : JSON.parse(s);
}

// ---- sample capture ------------------------------------------------------
let seq = 0;
export function capture(name, payload) {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  const file = path.join(SAMPLES_DIR, `${String(++seq).padStart(2, "0")}-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(redact(payload), null, 2));
  console.log(`  [sample] ${path.basename(file)}`);
  return file;
}

// Response headers we care about for the rate-limit hunt (criterion 6) — but keep ALL of them.
function headersToObject(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) out[k] = v;
  return out;
}

/**
 * Fire a request against the Upload-Post API and capture the exchange.
 * opts: { base, json, form (FormData), query, captureAs, method }
 */
export async function call(method, pathname, opts = {}) {
  const base = opts.base ?? API_BASE;
  const url = new URL(base + pathname);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const headers = { Authorization: `Apikey ${apiKey()}` };
  let body;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    body = opts.form; // fetch sets multipart boundary itself
  }

  const startedAt = Date.now();
  const res = await fetch(url, { method, headers, body });
  const elapsedMs = Date.now() - startedAt;
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 2000); }

  const record = {
    request: {
      method,
      url: url.toString(),
      headers: { Authorization: "Apikey [REDACTED_API_KEY]", ...(opts.json ? { "Content-Type": "application/json" } : {}) },
      body: opts.json ?? (opts.form ? describeForm(opts.form) : undefined),
    },
    response: { status: res.status, headers: headersToObject(res.headers), body: parsed },
    elapsedMs,
    at: new Date(startedAt).toISOString(),
  };
  if (opts.captureAs) capture(opts.captureAs, record);
  return { status: res.status, body: parsed, headers: headersToObject(res.headers), elapsedMs, record };
}

function describeForm(form) {
  const out = {};
  for (const [k, v] of form.entries()) {
    out[k] = typeof v === "string" ? v : `<binary ${v.name ?? "file"} ${v.size} bytes ${v.type}>`;
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function logStep(msg) {
  console.log(`\n=== ${msg} ===`);
}
