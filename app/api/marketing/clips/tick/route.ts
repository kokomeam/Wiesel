/**
 * Creator-scoped clip render tick — the clips page's delivery loop.
 *
 * Reap has no webhooks and dev has no cron, so job progression is a
 * reconciliation sweep someone must RUN. Prod: the cron-driven scheduler
 * tick sweeps everyone. This route sweeps only the CALLER's active jobs so
 * the clips page can poll it while renders are in flight (found live: a job
 * sat in `precutting` for hours after its Mux precut was ready because
 * nothing ever ticked again — each manual "Process renders now" click
 * advanced exactly one edge).
 *
 * Same one-edge-per-pass idempotent sweep as the cron; POST-only; signed-in
 * creator required; admin client for the sweep itself (storage writes +
 * cross-table reads), scoped hard to the caller's own creator_id.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { createReapProvider, isReapConfigured } from "@/lib/marketing/clips/provider/reapClient";
import { createMuxPrecutOps } from "@/lib/marketing/clips/render/precut";
import { processClipRenderTick } from "@/lib/marketing/clips/render/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// In-house layouts render INSIDE the tick (ffmpeg / Remotion) — give the
// sweep the same ceiling the cron tick gets.
export const maxDuration = 300;

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { error: "Render processing not configured (missing SUPABASE_SERVICE_ROLE_KEY)." },
      { status: 503 }
    );
  }

  const admin = createAdminClient();
  const services = createMarketingServices();
  const clips = await processClipRenderTick(
    {
      supabase: admin as never,
      provider: isReapConfigured() ? createReapProvider() : undefined,
      precut: createMuxPrecutOps(),
      nowIso: services.clock.now(),
    },
    { creatorId: user.id }
  );
  return NextResponse.json({ ok: true, clips });
}
