/**
 * Double opt-in confirmation (Amendment 7) — the signed link inside the
 * one-time consent-confirmation email (tools/leads.ts sendConsentConfirmation).
 * Clicking sets consent_status='confirmed', stamps provenance on the consent
 * jsonb, and emits a `consent_confirmed` event into the single stream.
 *
 * Tokens expire after 30 days — matching the consent-lapse window: a pending
 * import that never confirms within 30 days lapses from eligibility (row
 * retained, marked `lapsed`; the lapse itself is applied lazily by the
 * eligibility queries + the maintenance sweep in lib/marketing/consent.ts).
 */

import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { verifyToken } from "@/lib/marketing/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(message: string, sub?: string): Response {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirm subscription</title>
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;text-align:center;color:#1c1917">
<p style="font-size:18px">${message}</p>
${sub ? `<p style="font-size:14px;color:#78716c">${sub}</p>` : ""}
</div>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export async function GET(req: Request) {
  if (!isAdminConfigured()) return page("Confirmation is temporarily unavailable.");
  const payload = verifyToken(new URL(req.url).searchParams.get("t"));
  if (!payload || payload.purpose !== "consent_confirm") {
    return page("This confirmation link is invalid or has expired.", "Ask the course creator to send a fresh one.");
  }

  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriber")
    .select("id,email,course_id,campaign_id,contact_id,consent_status,consent")
    .eq("id", payload.subscriberId)
    .maybeSingle();
  if (!sub) return page("This confirmation link is invalid or has expired.");
  if (sub.consent_status === "confirmed") return page("You're already confirmed ✓", "No further action needed.");

  const now = new Date().toISOString();
  const prevConsent = (sub.consent as Record<string, unknown>) ?? {};
  await admin
    .from("subscriber")
    .update({
      consent_status: "confirmed",
      consent: { ...prevConsent, confirmedAt: now, confirmedVia: "double_opt_in" },
    })
    .eq("id", sub.id);
  await admin.from("analytics_event").insert({
    course_id: sub.course_id,
    campaign_id: sub.campaign_id,
    subscriber_id: sub.id,
    contact_id: sub.contact_id,
    type: "consent_confirmed",
    source: "double_opt_in",
    props: { confirmedAt: now },
  });

  return page("You're confirmed ✓", "You'll receive course emails from this creator. Unsubscribe anytime — one click, in every email.");
}
