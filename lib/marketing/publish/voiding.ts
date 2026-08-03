/**
 * Edit-voids-approval (M-C invariant, both directions) — the ONE
 * orchestration for invalidating publish artifacts when a post's content
 * changes: open approvals void, live-but-unsent (queued/held) manifests
 * void (through the single transition path; the DB trigger then makes them
 * immutable), each voided manifest's durable fire function is released
 * (cancel-by-event), and one telemetry event records the cause.
 *
 * Called from versionedUpdateSocialPost (the single content-write path —
 * every content edit, including a hook re-burn's video_path rotation, flows
 * through it) and from the pre-submit staleness abort. The Inngest sender is
 * lazy-imported so the social repository never pulls the Inngest SDK into a
 * client bundle.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { voidOpenApprovalsForPost } from "./approvalRepository";
import { voidLiveManifestsForPost } from "./manifestRepository";
import { emitPublishEvent } from "./events";

type DB = SupabaseClient<Database>;

export type VoidCause = "post_edited" | "approval_stale";

export async function voidPublishArtifactsForPost(
  supabase: DB,
  post: { id: string; course_id: string | null },
  cause: VoidCause,
  nowIso: string
): Promise<{ voidedApprovals: string[]; voidedManifests: string[] }> {
  const voidedApprovals = await voidOpenApprovalsForPost(supabase, post.id, nowIso);
  const manifests = await voidLiveManifestsForPost(supabase, post.id, cause);
  if (manifests.length > 0) {
    const { sendPublishReleased } = await import("@/lib/inngest/publishEvents");
    for (const m of manifests) await sendPublishReleased(m.id);
  }
  if (voidedApprovals.length > 0 || manifests.length > 0) {
    await emitPublishEvent(supabase, post.course_id, "social_publish_approval_voided", {
      postId: post.id,
      cause,
      voidedApprovals,
      voidedManifests: manifests.map((m) => m.id),
    });
  }
  return { voidedApprovals, voidedManifests: manifests.map((m) => m.id) };
}
