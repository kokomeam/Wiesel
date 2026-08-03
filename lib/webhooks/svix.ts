/**
 * Shared Svix webhook-signature verification (Resend signs its webhooks with
 * Svix; both the marketing endpoint and the learner-comms endpoint verify
 * through this ONE function).
 *
 * Manual HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}` keyed by
 * the base64 part of the `whsec_…` secret, compared timing-safe against every
 * space-separated `v1,<sig>` entry in the `svix-signature` header — the
 * muxClient precedent (no `svix` dependency; runtime deps stay at the guarded
 * 14). Unlike the original marketing-route copy this ALSO enforces the
 * ±5-minute timestamp tolerance (replay protection) the svix library applies —
 * that gap was found and closed in the M7 audit.
 *
 * MUST be fed the RAW request body (`await req.text()` BEFORE any JSON.parse):
 * re-stringifying parsed JSON changes bytes and breaks verification.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface SvixVerifyParams {
  /** The endpoint's signing secret (`whsec_<base64>` or bare base64). */
  secret: string;
  svixId: string | null;
  svixTimestamp: string | null;
  svixSignature: string | null;
  rawBody: string;
  /** Injectable clock for tests (ms since epoch); defaults to Date.now(). */
  nowMs?: number;
  toleranceSeconds?: number;
}

export function verifySvixSignature(p: SvixVerifyParams): boolean {
  if (!p.secret || !p.svixId || !p.svixTimestamp || !p.svixSignature) return false;

  // Replay protection: `svix-timestamp` is unix seconds; reject drift beyond
  // the tolerance window in either direction.
  const ts = Number(p.svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = (p.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSec - ts) > (p.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS)) return false;

  const key = Buffer.from(p.secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${p.svixId}.${p.svixTimestamp}.${p.rawBody}`)
    .digest("base64");
  const expectedBuf = Buffer.from(expected);
  for (const part of p.svixSignature.split(" ")) {
    const sig = part.includes(",") ? part.split(",")[1] : part;
    if (!sig) continue;
    const sigBuf = Buffer.from(sig);
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}
