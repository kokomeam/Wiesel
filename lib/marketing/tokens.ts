/**
 * Signed link tokens — the ONE mechanism behind click redirects, unsubscribe
 * links, and consent-confirmation links (Amendment 5's "same signing mechanism
 * ... replaces raw ?sid= for both unsubscribe and click tokens").
 *
 * Stateless HMAC-SHA256 over a JSON payload — no DB row, no lookup, verifiable
 * by recomputing the signature. Node's `crypto` only (no new dependency).
 *
 *   sign(payload)   → "base64url(json).base64url(hmac)"
 *   verify(token)   → the payload if the signature matches and it isn't
 *                     expired, else null (never throws — callers treat a bad
 *                     token as "unattributed", not a crash)
 *
 * Env: MARKETING_TOKEN_SECRET (required for production; falls back to a fixed
 * dev-only string with a console warning so mock-mode/local dev keeps working
 * without extra setup — never used for a real send, since a real send only
 * happens with RESEND_API_KEY set, at which point operators are already
 * expected to fill in the full .env).
 */

import { createHmac, timingSafeEqual } from "crypto";

export type TokenPurpose = "click" | "unsub" | "consent_confirm";

export interface TokenPayload {
  purpose: TokenPurpose;
  subscriberId: string;
  /** Attribution dimensions (click tokens only). */
  campaignId?: string;
  touchId?: string;
  /** Unix ms expiry. Omitted = no expiry (unsubscribe links must work forever). */
  exp?: number;
}

function secret(): string {
  const s = process.env.MARKETING_TOKEN_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[marketing/tokens] MARKETING_TOKEN_SECRET is not set — using an insecure dev fallback. Set it before sending real email."
    );
  }
  return "wisesel-dev-insecure-token-secret-do-not-use-in-production";
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

/** Sign a payload into a compact, URL-safe token. */
export function signToken(payload: TokenPayload): string {
  const json = b64url(JSON.stringify(payload));
  return `${json}.${hmac(json)}`;
}

/** Verify + decode a token. Returns null (never throws) on any tamper,
 *  malformed input, or expiry — the caller records an "unattributed" event
 *  rather than failing the request (a broken link must still redirect). */
export function verifyToken(token: string | null | undefined): TokenPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const json = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(json);

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(json, "base64url").toString("utf8")) as TokenPayload;
    if (typeof payload.subscriberId !== "string" || typeof payload.purpose !== "string") return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "";
}

/** A signed, permanent unsubscribe link (no expiry — must work from any old
 *  email a subscriber digs up). */
export function unsubscribeUrl(subscriberId: string): string {
  const t = signToken({ purpose: "unsub", subscriberId });
  return `${siteUrl()}/api/marketing/unsubscribe?t=${t}`;
}

/** A signed click-redirect link. `destination` is carried alongside the token
 *  (not inside it) so a tampered/expired token still degrades to an
 *  UNATTRIBUTED redirect rather than a dead link. 30-day expiry — long enough
 *  for a slow reader, short enough to bound stale attribution.
 *
 *  `courseId` rides as a PLAIN (unsigned) param, not inside the token: it's
 *  needed to course-scope even an UNATTRIBUTED click record when the token
 *  fails verification. This is deliberately not trust-sensitive — the worst a
 *  forged courseId can do is inflate that course's own unattributed-click
 *  count (the same class of exposure the existing anonymous pageview beacon
 *  already accepts); a forged/expired token can NEVER produce a fake
 *  attributed (subscriber/campaign) click, since that requires a verified
 *  signature. */
export function clickUrl(
  destination: string,
  dims: { subscriberId: string; campaignId?: string; touchId?: string; courseId: string }
): string {
  const t = signToken({
    purpose: "click",
    subscriberId: dims.subscriberId,
    campaignId: dims.campaignId,
    touchId: dims.touchId,
    exp: Date.now() + 30 * 24 * 3600 * 1000,
  });
  return `${siteUrl()}/api/marketing/click?t=${t}&u=${encodeURIComponent(destination)}&c=${dims.courseId}`;
}

/** A signed, rate-limited consent-confirmation link. 30-day expiry matches the
 *  Amendment 7 lapse window — a token that outlives the lapse is moot anyway. */
export function consentConfirmUrl(subscriberId: string): string {
  const t = signToken({
    purpose: "consent_confirm",
    subscriberId,
    exp: Date.now() + 30 * 24 * 3600 * 1000,
  });
  return `${siteUrl()}/api/marketing/consent-confirm?t=${t}`;
}
