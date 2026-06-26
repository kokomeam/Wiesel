/**
 * One-click unsubscribe (compliance — every marketing email links here). Marks
 * the subscriber `unsubscribed` (terminal, suppressed) via the lifecycle reducer
 * and records an `email_unsubscribe` event. Service-role (the clicker is anon).
 *
 * MVP uses the subscriber id as the token; a signed token is the obvious
 * hardening when this gets real traffic.
 */

import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { globalUnsubscribe } from "@/lib/marketing/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(message: string): Response {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;text-align:center;color:#1c1917">
<p style="font-size:18px">${message}</p>
</div>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export async function GET(req: Request) {
  if (!isAdminConfigured()) return page("Unsubscribe is temporarily unavailable.");
  const sid = new URL(req.url).searchParams.get("sid");
  if (!sid) return page("Invalid unsubscribe link.");

  const admin = createAdminClient();
  const res = await globalUnsubscribe(admin, sid);
  if (!res.ok) return page("You're already unsubscribed.");
  return page("You've been unsubscribed. You won't receive any more emails.");
}
