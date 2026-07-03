/**
 * GET/POST /api/comms/opt-out — the link at the bottom of every learner email.
 *
 * GET renders a tiny confirm page with a POST form (never flips on GET —
 * link-prefetchers and mail scanners follow GETs). POST verifies the signed
 * token and sets enrollments.comms_opt_out via the admin client (the token IS
 * the authorization — the learner needn't be signed in). Signed
 * List-Unsubscribe one-click POSTs land here too.
 */

import { NextResponse } from "next/server";
import { setCommsOptOut } from "@/lib/comms/service";
import { verifyOptOutToken } from "@/lib/comms/tokens";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(title: string, bodyHtml: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#faf7f1;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:480px;margin:80px auto;padding:32px;background:#ffffff;border:1px solid #e7e5e4;border-radius:16px;text-align:center;">
${bodyHtml}
</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function tokenFrom(url: string): string | null {
  return new URL(url).searchParams.get("token");
}

export async function GET(request: Request) {
  const token = tokenFrom(request.url);
  const payload = token ? verifyOptOutToken(token) : null;
  if (!payload) {
    return page(
      "Link expired",
      `<h1 style="font-size:20px;color:#1c1917;">This link isn't valid</h1>
       <p style="color:#78716c;font-size:14px;">The unsubscribe link is malformed or was signed with an old key.</p>`
    );
  }
  return page(
    "Unsubscribe from course emails",
    `<h1 style="font-size:20px;color:#1c1917;">Stop course emails?</h1>
     <p style="color:#78716c;font-size:14px;line-height:1.6;">You'll no longer receive check-ins from this course's creator. You can keep learning as usual.</p>
     <form method="POST" action="/api/comms/opt-out?token=${encodeURIComponent(token ?? "")}">
       <button type="submit" style="margin-top:12px;padding:10px 24px;border:none;border-radius:9999px;background:#1c1917;color:#ffffff;font-size:14px;font-weight:600;cursor:pointer;">Unsubscribe</button>
     </form>`
  );
}

export async function POST(request: Request) {
  const token = tokenFrom(request.url);
  const payload = token ? verifyOptOutToken(token) : null;
  if (!payload) {
    return page(
      "Link expired",
      `<h1 style="font-size:20px;color:#1c1917;">This link isn't valid</h1>
       <p style="color:#78716c;font-size:14px;">The unsubscribe link is malformed or was signed with an old key.</p>`
    );
  }
  const flipped = await setCommsOptOut(
    createAdminClient(),
    payload.courseId,
    payload.userId,
    true
  );
  return page(
    "Unsubscribed",
    `<h1 style="font-size:20px;color:#1c1917;">${flipped ? "You're unsubscribed" : "Already handled"}</h1>
     <p style="color:#78716c;font-size:14px;line-height:1.6;">${
       flipped
         ? "You won't receive further emails about this course. Your course access is unchanged."
         : "This enrollment no longer exists or was already unsubscribed."
     }</p>`
  );
}
