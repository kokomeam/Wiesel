/**
 * One-click unsubscribe (compliance — every marketing email links here).
 *
 * Suppression is CREATOR-WIDE (Amendment 6): opt-out legally attaches to the
 * sender, not the product — unsubscribing from any campaign suppresses the
 * contact across ALL of that creator's courses (via the audience_contact tier,
 * which exists for exactly this). A per-course preference center is a later
 * seam.
 *
 * Links are SIGNED (`?t=` HMAC token, lib/marketing/tokens.ts) — closing the
 * "signed unsubscribe tokens" deferred item. The legacy raw `?sid=` form is
 * still accepted so links in any already-sent (mock) email keep working.
 */

import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { globalUnsubscribe } from "@/lib/marketing/ingest";
import { verifyToken } from "@/lib/marketing/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(message: string, sub?: string): Response {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe</title>
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;text-align:center;color:#1c1917">
<p style="font-size:18px">${message}</p>
${sub ? `<p style="font-size:14px;color:#78716c">${sub}</p>` : ""}
</div>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export async function GET(req: Request) {
  if (!isAdminConfigured()) return page("Unsubscribe is temporarily unavailable.");
  const url = new URL(req.url);

  // Signed token (current) with legacy ?sid= fallback for already-sent emails.
  const payload = verifyToken(url.searchParams.get("t"));
  const sid = payload?.purpose === "unsub" ? payload.subscriberId : url.searchParams.get("sid");
  if (!sid) return page("Invalid unsubscribe link.");

  const admin = createAdminClient();

  // Resolve the creator's display name so the confirmation states the true
  // (creator-wide) scope of the opt-out.
  const { data: sub } = await admin
    .from("subscriber")
    .select("course_id")
    .eq("id", sid)
    .maybeSingle();
  let creatorName = "this creator";
  if (sub) {
    const { data: course } = await admin.from("courses").select("author_id").eq("id", sub.course_id).maybeSingle();
    if (course) {
      const { data: profile } = await admin.from("profiles").select("display_name").eq("id", course.author_id).maybeSingle();
      if (profile?.display_name) creatorName = profile.display_name;
    }
  }

  const res = await globalUnsubscribe(admin, sid);
  if (!res.ok) return page("You're already unsubscribed.");
  return page(
    `You're unsubscribed — you won't receive further marketing emails from ${creatorName}.`,
    "This covers all of their courses. Changed your mind? Sign up again from any of their course pages."
  );
}

/** RFC 8058 one-click unsubscribe: mail clients POST to the List-Unsubscribe
 *  URL with `List-Unsubscribe=One-Click` — same effect as the GET. */
export const POST = GET;
