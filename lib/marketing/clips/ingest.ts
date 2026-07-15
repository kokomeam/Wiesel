/**
 * Clip ingest (M-C) — a COMPLETED render becomes a `social_post` row
 * (`post_type='clip'`) so the one social queue holds text posts and clips.
 * Called from the render tick's completion step (admin client — the tick is
 * the machine actor; creator edits afterwards ride the SAME versioned-write
 * rule as every social post).
 *
 * - platform = the candidate's best target (its first surviving platform);
 *   the DB gate keeps TEXT posts closed at LinkedIn+Facebook while clips use
 *   the extended enum.
 * - body = captionDraft (falls back to the hook); hashtags ride from the
 *   posting kit at M-D (empty now); video_path = the clip-media storage path.
 * - LINEAGE: re-rendering the same candidate stamps
 *   `regenerated_from_post_id` on the new row — the prior post stays; the
 *   creator decides what to keep.
 * - idempotent per job: one post per clip_job_id (a re-run tick never
 *   duplicates).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { insertSocialPost } from "@/lib/marketing/social/repository";
import { CLIP_PROMPT_VERSION } from "./prompt";
import { emitClipEvent } from "./events";
import type { ClipMomentCandidate } from "./schemas";
import type { ClipRenderJob } from "./render/jobs";

type DB = SupabaseClient<Database>;

export async function ingestCompletedClipJob(
  supabase: DB,
  job: ClipRenderJob,
  candidate: ClipMomentCandidate
): Promise<{ postId: string; regeneratedFrom: string | null } | null> {
  if (job.status !== "completed" || !job.output) return null;

  // Idempotency: one post per job.
  const { data: existing } = await supabase
    .from("social_post")
    .select("id")
    .eq("clip_job_id", job.id)
    .maybeSingle();
  if (existing) return { postId: existing.id, regeneratedFrom: null };

  // Lineage: the latest prior post for this candidate (any preset/job).
  const { data: prior } = await supabase
    .from("social_post")
    .select("id, clip_job_id, created_at")
    .eq("creator_id", job.creatorId)
    .eq("post_type", "clip")
    .contains("ai_metadata", { candidateId: candidate.id })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const platform = candidate.targetPlatformFit[0] ?? "instagram";
  // The insert rides the social REPOSITORY (the single social_post write
  // module — verify-social greps every other write down), same as UI edits.
  const post = await insertSocialPost(supabase, job.creatorId, {
    course_id: job.courseId,
    lesson_id: job.lessonId,
    source_type: "lesson",
    source_text: null,
    platform,
    post_type: "clip",
    goal: candidate.funnelStage === "bofu" ? "promo_cta" : "value",
    funnel_stage: candidate.funnelStage,
    tone: "educational",
    body: candidate.captionDraft ?? candidate.hookText,
    cta: candidate.endCardCta,
    hashtags: [],
    status: "draft",
    clip_job_id: job.id,
    video_path: job.output.storagePath,
    regenerated_from_post_id: prior?.id ?? null,
    ai_metadata: {
      candidateId: candidate.id,
      layout: job.layout,
      preset: job.preset,
      provider: job.provider,
      recordingFormat: job.source.recordingFormat,
      hookText: candidate.hookText,
      promptVersion: candidate.promptVersion ?? CLIP_PROMPT_VERSION,
      costMinutes: job.costMinutes,
      durationSeconds: job.output.durationSeconds,
    } as unknown as Json,
  });

  await emitClipEvent(supabase, job.courseId ?? "", "clip_ingested", {
    postId: post.id,
    jobId: job.id,
    candidateId: candidate.id,
    lessonId: job.lessonId,
    layout: job.layout,
    recordingFormat: job.source.recordingFormat,
    platform,
    regeneratedFrom: prior?.id ?? null,
  });
  return { postId: post.id, regeneratedFrom: prior?.id ?? null };
}
