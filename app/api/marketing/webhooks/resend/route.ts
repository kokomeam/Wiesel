/**
 * Resend delivery webhooks (Amendment 8 + the foundation's "Resend webhooks"
 * follow-up, closed) — real delivered / opened / clicked / bounced /
 * complained events land in the SAME `analytics_event` stream the mock
 * simulates, advancing the SAME subscriber reducer. With this route live, the
 * mock's synthetic engagement and Resend's real engagement are two sources
 * feeding one pipeline — nothing downstream knows the difference.
 *
 * Security: Resend signs webhooks with Svix. Signature = HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}` keyed by the base64 part of
 * RESEND_WEBHOOK_SECRET (`whsec_<base64>`), compared against every signature
 * in the `svix-signature` header (space-separated `v1,<sig>` entries).
 * Verified manually with Node crypto — no new dependency. Unsigned requests
 * are rejected when the secret is set; when it's NOT set, the route 503s
 * (never processes unverified events silently).
 *
 * Idempotency: the `svix-id` header is stored in props and duplicate webhook
 * deliveries are dropped by checking for an existing event with the same id —
 * the PRD's "duplicate webhook event received → use idempotency key" edge case.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { applyEventToSubscriber } from "@/lib/marketing/stateMachine";
import type { AnalyticsEventType } from "@/lib/marketing/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifySvixSignature(secret: string, id: string, timestamp: string, rawBody: string, signatureHeader: string): boolean {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", key).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected);
  for (const part of signatureHeader.split(" ")) {
    const sig = part.includes(",") ? part.split(",")[1] : part;
    if (!sig) continue;
    const sigBuf = Buffer.from(sig);
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) return true;
  }
  return false;
}

/** Resend event type → our stream's event type (+ hard/soft classification for
 *  bounces — Resend's payload carries `bounce.type`: 'Permanent' = hard). */
function mapEventType(resendType: string, data: Record<string, unknown>): { type: AnalyticsEventType; bounceType?: "hard" | "soft" } | null {
  switch (resendType) {
    case "email.delivered":
      return { type: "email_delivered" };
    case "email.opened":
      return { type: "email_open" };
    case "email.clicked":
      return { type: "email_click" };
    case "email.bounced": {
      const bounce = (data.bounce as Record<string, unknown>) ?? {};
      const hard = String(bounce.type ?? "").toLowerCase().includes("permanent");
      return { type: "email_bounce", bounceType: hard ? "hard" : "soft" };
    }
    case "email.complained":
      return { type: "spam_complaint" };
    default:
      return null; // sent/delivery_delayed/etc — not tracked as stream events.
  }
}

export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!isAdminConfigured() || !secret) {
    return NextResponse.json({ ok: false, error: "Webhook not configured (SUPABASE_SERVICE_ROLE_KEY + RESEND_WEBHOOK_SECRET required)." }, { status: 503 });
  }

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  const rawBody = await req.text();
  if (!svixId || !svixTimestamp || !svixSignature || !verifySvixSignature(secret, svixId, svixTimestamp, rawBody, svixSignature)) {
    return NextResponse.json({ ok: false, error: "Invalid signature" }, { status: 401 });
  }

  let payload: { type?: string; data?: Record<string, unknown> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const mapped = payload.type ? mapEventType(payload.type, payload.data ?? {}) : null;
  if (!mapped) return NextResponse.json({ ok: true, ignored: true });

  const admin = createAdminClient();

  // Correlate back to our send via provider_message_id (the Resend email id).
  const emailId = String((payload.data as Record<string, unknown> | undefined)?.email_id ?? "");
  if (!emailId) return NextResponse.json({ ok: true, ignored: true });
  const { data: send } = await admin
    .from("scheduled_send")
    .select("id,course_id,sequence_id,touch_id,subscriber_id,soft_bounce_count")
    .eq("provider_message_id", emailId)
    .maybeSingle();
  if (!send) return NextResponse.json({ ok: true, ignored: true });

  // Idempotency — drop a duplicate delivery of the same svix event.
  const { data: dup } = await admin
    .from("analytics_event")
    .select("id")
    .eq("subscriber_id", send.subscriber_id)
    .eq("type", mapped.type)
    .contains("props", { svixId })
    .limit(1);
  if (dup && dup.length > 0) return NextResponse.json({ ok: true, duplicate: true });

  const { data: sub } = await admin.from("subscriber").select("campaign_id").eq("id", send.subscriber_id).maybeSingle();
  await admin.from("analytics_event").insert({
    course_id: send.course_id,
    campaign_id: sub?.campaign_id ?? null,
    subscriber_id: send.subscriber_id,
    type: mapped.type,
    source: "resend_webhook",
    props: { svixId, touchId: send.touch_id, sequenceId: send.sequence_id, ...(mapped.bounceType ? { bounceType: mapped.bounceType } : {}) },
  });

  if (mapped.type === "email_bounce") {
    if (mapped.bounceType === "hard") {
      await admin.from("scheduled_send").update({ bounce_type: "hard" }).eq("id", send.id);
      await applyEventToSubscriber(admin, send.subscriber_id, "email_bounce");
    } else {
      await admin.from("scheduled_send").update({ bounce_type: "soft", soft_bounce_count: send.soft_bounce_count + 1 }).eq("id", send.id);
    }
  } else if (mapped.type === "email_delivered" || mapped.type === "email_open" || mapped.type === "email_click") {
    await applyEventToSubscriber(admin, send.subscriber_id, mapped.type);
  }
  // spam_complaint doesn't advance the reducer directly — it feeds the
  // guardrail metrics, which auto-pause the campaign at threshold.

  return NextResponse.json({ ok: true });
}
