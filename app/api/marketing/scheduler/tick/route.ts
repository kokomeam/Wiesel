/**
 * Scheduler tick — processes due sends in the outbox. The PROD trigger: a cron
 * hits it on an interval (Vercel Cron uses GET; an external cron can POST with
 * `x-cron-secret`). In dev you can POST it manually. It runs the SAME
 * `runSchedulerTick` the tests drive — only the trigger differs.
 *
 * Uses the service-role client (cron has no user session). Guarded by CRON_SECRET
 * when set. 503s cleanly when the service-role key isn't configured.
 */

import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { runSchedulerTick } from "@/lib/marketing/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<Response> {
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Scheduler not configured (missing SUPABASE_SERVICE_ROLE_KEY)." },
      { status: 503 }
    );
  }
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided =
      req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (provided !== secret) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const admin = createAdminClient();
  const services = createMarketingServices();
  const result = await runSchedulerTick(admin, services, { limit: 200 });
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
