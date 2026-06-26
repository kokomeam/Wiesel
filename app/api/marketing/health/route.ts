/**
 * Marketing health probe — answers "is the server's env actually loaded?"
 * without having to submit a form and read a 503. GET → { adminConfigured,
 * emailMode }. (adminConfigured=false ⇒ SUPABASE_SERVICE_ROLE_KEY isn't in the
 * RUNNING server's env — save .env.local and RESTART the dev server.)
 */

import { NextResponse } from "next/server";
import { isAdminConfigured } from "@/lib/supabase/admin";
import { isEmailConfigured } from "@/lib/marketing/services/factory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    adminConfigured: isAdminConfigured(),
    emailMode: isEmailConfigured() ? "resend" : "mock",
  });
}
