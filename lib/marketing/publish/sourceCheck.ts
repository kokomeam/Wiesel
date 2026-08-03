/**
 * Frozen-source fence (M-C amendment 2) — a clip post whose source lesson
 * has been RE-RECORDED since the clip rendered must not publish: its render
 * job's videoAssetRowId is compared against the lesson's CURRENT take (the
 * shared pickCurrentVideoRow rule). Enforced at BOTH token mint (the card
 * refuses with a re-render message) AND the pre-submit guard (held,
 * hold_reason='source_superseded' — self-heals if the creator re-renders +
 * re-cards). Text posts and clip posts without a job link pass (nothing to
 * validate). Read errors THROW — the fence never fails silently open.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { getRenderJob } from "@/lib/marketing/clips/render/jobs";
import { pickCurrentVideoRow } from "@/lib/marketing/clips/transcripts";

type DB = SupabaseClient<Database>;

export async function clipSourceSuperseded(
  supabase: DB,
  post: { post_type: string; clip_job_id: string | null }
): Promise<boolean> {
  if (post.post_type !== "clip" || !post.clip_job_id) return false;
  const job = await getRenderJob(supabase, post.clip_job_id);
  if (!job) return false;
  const { data, error } = await supabase
    .from("video_assets")
    .select("id,mux_asset_id,transcript_vtt,metadata,created_at")
    .eq("lesson_id", job.lessonId)
    .eq("status", "ready");
  if (error) throw new Error(`sourceCheck video_assets read: ${error.message}`);
  const current = pickCurrentVideoRow((data ?? []).filter((r) => r.mux_asset_id));
  return current !== null && current.id !== job.source.videoAssetRowId;
}
