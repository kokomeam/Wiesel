/**
 * Signed opt-out tokens (Milestone 6). Stateless HMAC-SHA256 over
 * {courseId, userId} — the link in every learner email flips
 * enrollments.comms_opt_out without requiring a sign-in.
 *
 * The payload carries a versioned purpose prefix so these tokens can never be
 * replayed against the marketing branch's unsubscribe surface (which shares
 * MARKETING_TOKEN_SECRET) or any future token consumer.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const PURPOSE = "wisesel.comms-optout.v1";

interface OptOutPayload {
  p: typeof PURPOSE;
  courseId: string;
  userId: string;
}

function secret(): string {
  const value = process.env.MARKETING_TOKEN_SECRET;
  if (!value) {
    throw new Error("MARKETING_TOKEN_SECRET is required for comms opt-out links.");
  }
  return value;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payload: string): string {
  return b64url(createHmac("sha256", secret()).update(payload).digest());
}

export function createOptOutToken(courseId: string, userId: string): string {
  const payload: OptOutPayload = { p: PURPOSE, courseId, userId };
  const encoded = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${encoded}.${sign(encoded)}`;
}

/** Returns the payload iff the signature verifies AND the purpose matches. */
export function verifyOptOutToken(
  token: string
): { courseId: string; userId: string } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const givenSig = token.slice(dot + 1);
  let expected: string;
  try {
    expected = sign(encoded);
  } catch {
    return null; // no secret configured — nothing verifies
  }
  const a = Buffer.from(givenSig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as Partial<OptOutPayload>;
    if (payload.p !== PURPOSE) return null;
    if (typeof payload.courseId !== "string" || typeof payload.userId !== "string") {
      return null;
    }
    return { courseId: payload.courseId, userId: payload.userId };
  } catch {
    return null;
  }
}

export function optOutUrl(courseId: string, userId: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return `${base}/api/comms/opt-out?token=${encodeURIComponent(
    createOptOutToken(courseId, userId)
  )}`;
}
