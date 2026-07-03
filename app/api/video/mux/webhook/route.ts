/**
 * POST /api/video/mux/webhook — Mux asset/upload lifecycle events.
 *
 * Robustness posture: rather than trust each event's payload, we verify the
 * signature, route to the `video_assets` row by passthrough/asset/upload id, and
 * RE-FETCH the asset from Mux to recompute status (so we're immune to event-name
 * churn between Mux API versions). The webhook is an OPTIMIZATION over the client
 * poll — if it's not set up, polling still converges. Uses the service-role client
 * (no user session), which bypasses RLS by design.
 *
 * Set MUX_WEBHOOK_SIGNING_SECRET to enforce signatures. Without it, verification
 * is skipped (dev) and we log that fact — do NOT run unsigned in production.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createAdminClient } from "@/lib/supabase/admin";
import { getVideoProvider } from "@/lib/video/provider";
import { findVideoAssetByMuxId, syncVideoAssetFromMux } from "@/lib/video/videoService";

export async function POST(req: Request): Promise<Response> {
  const provider = getVideoProvider();
  const rawBody = await req.text();
  const signature = req.headers.get("mux-signature");

  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    return new Response("Invalid signature.", { status: 401 });
  }
  if (!process.env.MUX_WEBHOOK_SIGNING_SECRET) {
    console.log(JSON.stringify({ tag: "video_webhook_unsigned", note: "no MUX_WEBHOOK_SIGNING_SECRET set" }));
  }

  const event = provider.parseWebhookEvent(rawBody);
  if (!event) return new Response("Ignored.", { status: 200 });

  // We only care about asset/upload events; anything else is a no-op 200.
  const relevant = event.type.startsWith("video.asset.") || event.type.startsWith("video.upload.");
  if (!relevant) return new Response("Ignored.", { status: 200 });

  let admin;
  try {
    admin = createAdminClient();
  } catch (err) {
    // No service key configured — can't process without RLS bypass. 200 so Mux
    // doesn't retry-storm; the client poll still converges.
    console.log(JSON.stringify({ tag: "video_webhook_no_admin", message: (err as Error).message }));
    return new Response("No admin client.", { status: 200 });
  }

  const row = await findVideoAssetByMuxId(admin, {
    rowId: event.passthrough,
    assetId: event.assetId,
    uploadId: event.uploadId,
  });
  if (!row) {
    console.log(JSON.stringify({ tag: "video_webhook_no_row", type: event.type }));
    return new Response("No matching asset.", { status: 200 });
  }

  await syncVideoAssetFromMux(admin, provider, row);
  return new Response("ok", { status: 200 });
}
