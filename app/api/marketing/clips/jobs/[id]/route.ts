/**
 * /api/marketing/clips/jobs/[id] (M-E)
 *   POST {action:"cancel"} — cancel an in-flight render (cancel_clip_job).
 *   GET  ?media=1          — creator-gated SIGNED playback URL for a
 *        completed clip (the learner-media precedent: ownership verified on
 *        the USER client, then the admin client signs over the private
 *        clip-media bucket — the bucket has zero user policies by design).
 */

import { NextResponse } from "next/server";
import { executeMarketingTool } from "@/lib/marketing/tools";
import { socialRouteAuth } from "@/lib/marketing/social/routeHelpers";
import { clipErrorResponse } from "@/lib/marketing/clips/routeHelpers";
import { getRenderJob } from "@/lib/marketing/clips/render/jobs";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // action defaults below
  }
  const auth = await socialRouteAuth((body.courseId as string | undefined) ?? null);
  if (auth instanceof NextResponse) return auth;
  if (body.action !== "cancel") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }
  try {
    const outcome = await executeMarketingTool("cancel_clip_job", { jobId: id }, auth.ctx);
    return NextResponse.json({ summary: outcome.summary, data: outcome.data ?? null });
  } catch (err) {
    return clipErrorResponse(err);
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const auth = await socialRouteAuth(url.searchParams.get("courseId"));
  if (auth instanceof NextResponse) return auth;

  // Ownership gate on the USER client (RLS returns only the creator's rows).
  const job = await getRenderJob(auth.ctx.supabase, id);
  if (!job || !job.output) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Media signing unavailable" }, { status: 503 });
  }
  const admin = createAdminClient();
  const { data: signed, error } = await admin.storage
    .from("clip-media")
    .createSignedUrl(job.output.storagePath, 3600);
  if (error || !signed?.signedUrl) {
    return NextResponse.json({ error: "Could not sign the clip" }, { status: 502 });
  }
  return NextResponse.json({ url: signed.signedUrl, output: job.output });
}
