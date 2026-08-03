/**
 * POST /api/comms/webhooks/resend — LEARNER-COMMS delivery events (M7).
 *
 * A SEPARATE Resend webhook endpoint from the marketing suite's
 * (/api/marketing/webhooks/resend), with its own Svix signing secret
 * (RESEND_COMMS_WEBHOOK_SECRET — Resend endpoints are account-wide, so each
 * endpoint sees every send's events and each ignores what isn't its own,
 * filtered by the send_source tag / comms-record lookup).
 *
 * Posture (mirrors the Mux webhook where applicable, deviates deliberately
 * where Svix differs — see docs/comms-delivery-tracking.md):
 *   • RAW body read before any parsing (signature covers exact bytes).
 *   • Svix signature verified with the shared verifier (timestamp tolerance
 *     included). Secret unset → 503, never process-unsigned-silently.
 *   • Idempotency is ID-based on `svix-id` (delivery events are deltas, not
 *     re-fetchable state — reconciliation à la Mux doesn't apply).
 *   • Unattributable / foreign events → 200 (Svix must not retry-storm);
 *     infrastructure failures → 500 (Svix retries).
 *   • Lean handler: verification + persistence only — no model calls, no
 *     rollup work inline.
 */

import { NextResponse } from "next/server";
import { processResendCommsEvent, type ResendWebhookPayload } from "@/lib/comms/webhook";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { verifySvixSignature } from "@/lib/webhooks/svix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.RESEND_COMMS_WEBHOOK_SECRET;
  if (!isAdminConfigured() || !secret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Webhook not configured (SUPABASE_SERVICE_ROLE_KEY + RESEND_COMMS_WEBHOOK_SECRET required).",
      },
      { status: 503 }
    );
  }

  const svixId = req.headers.get("svix-id");
  const rawBody = await req.text();
  if (
    !svixId ||
    !verifySvixSignature({
      secret,
      svixId,
      svixTimestamp: req.headers.get("svix-timestamp"),
      svixSignature: req.headers.get("svix-signature"),
      rawBody,
    })
  ) {
    return NextResponse.json({ ok: false, error: "Invalid signature" }, { status: 401 });
  }

  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as ResendWebhookPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const result = await processResendCommsEvent(createAdminClient(), payload, svixId);
    console.log(
      JSON.stringify({ tag: "comms_webhook", type: payload.type, svixId, ...result })
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Infrastructure failure — 500 so Svix redelivers (side effects are
    // idempotent, so the retry completes whatever half was missed).
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ tag: "comms_webhook", outcome: "error", svixId, message }));
    return NextResponse.json({ ok: false, error: "Processing failed" }, { status: 500 });
  }
}
