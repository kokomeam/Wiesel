/**
 * Signed click-redirect (Amendment 5) — every CTA link in a marketing email is
 * wrapped through here at send time (lib/marketing/scheduler.ts). Verifies the
 * HMAC token, records an ATTRIBUTED `email_click` (campaign_id/touch_id/
 * subscriber_id), and 302s to the real destination. A broken/expired/tampered
 * token still redirects — it just records the click UNATTRIBUTED rather than
 * failing the request (a dead link is worse than an unattributed click).
 */

import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { recordAttributedClick, recordUnattributedClick } from "@/lib/marketing/attribution";
import { verifyToken } from "@/lib/marketing/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const destination = url.searchParams.get("u");
  const token = url.searchParams.get("t");
  if (!destination) return NextResponse.json({ ok: false, error: "Missing destination" }, { status: 400 });

  const safeDestination = destination.startsWith("/") || destination.startsWith("http") ? destination : "/";

  if (!isAdminConfigured()) return NextResponse.redirect(safeDestination, { status: 302 });

  const payload = verifyToken(token);
  const admin = createAdminClient();

  if (payload && payload.purpose === "click") {
    const { data: sub } = await admin.from("subscriber").select("course_id").eq("id", payload.subscriberId).maybeSingle();
    if (sub) {
      await recordAttributedClick(admin, {
        courseId: sub.course_id,
        campaignId: payload.campaignId,
        touchId: payload.touchId,
        subscriberId: payload.subscriberId,
      });
    }
  } else {
    // Broken/expired/tampered token — still redirect, but record an
    // UNATTRIBUTED click scoped only by the plain (non-sensitive) course id
    // param, never by anything from the unverified token.
    const courseId = url.searchParams.get("c");
    if (courseId) await recordUnattributedClick(admin, courseId);
  }

  return NextResponse.redirect(safeDestination, { status: 302 });
}
