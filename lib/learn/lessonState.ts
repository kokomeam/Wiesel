/**
 * PERF-1 C1 — the /learn/[slug]/[lessonId] bundle loader.
 *
 * One SECURITY DEFINER RPC (public.learn_lesson_state, migration
 * 20260717100600) returns everything the lesson player needs beyond the
 * cached immutable snapshot: the access verdict, all-course progress, this
 * lesson's stored progress_state, quiz-attempt state, homework history, the
 * review prompt, slide feedback, and the learner-player video-asset fields.
 * Zod-first: the payload contract lives HERE (the SQL builds the mirror —
 * edit together); types are inferred from the schemas.
 *
 * The loader takes the caller's Supabase client as a parameter so tests can
 * inject a counting client (AC-PERF-07). Authorization happens INSIDE the
 * RPC — a denied caller gets {"access":"denied"}, mapped to kind:"denied".
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublishedLesson } from "@/lib/course/publish/schemas";
import type { LearnerVideoData } from "@/lib/learn/media";
import { rpcJson } from "@/lib/supabase/rpcJson";
import { parseVtt } from "@/lib/video/captions";
import { thumbnailUrl } from "@/lib/video/playbackUrls";

/* ────────────────────────────── Contract ───────────────────────────────── */

export const LessonProgressRowSchema = z.object({
  lesson_id: z.string(),
  status: z.string(),
  pct: z.number(),
  last_activity_at: z.string(),
});
export type LessonProgressRow = z.infer<typeof LessonProgressRowSchema>;

export const LessonHomeworkRowSchema = z.object({
  id: z.string(),
  block_id: z.string(),
  status: z.string(),
  created_at: z.string(),
  file_paths: z.array(z.string()),
});
export type LessonHomeworkRow = z.infer<typeof LessonHomeworkRowSchema>;

/** Exactly the fields lib/learn/media.ts `learnerVideoData` consumes —
 *  `transcript` (the multi-KB plain text) is deliberately absent. */
export const LessonVideoAssetSchema = z.object({
  id: z.string(),
  mux_playback_id: z.string().nullable(),
  thumbnail_time: z.number().nullable(),
  duration_seconds: z.number().nullable(),
  mp4_url: z.string().nullable(),
  mp4_status: z.string().nullable(),
  transcript_vtt: z.string().nullable(),
});
export type LessonVideoAsset = z.infer<typeof LessonVideoAssetSchema>;

export const LessonStateSchema = z.object({
  access: z.object({
    enrolled: z.boolean(),
    enrollment_status: z.string().nullable(),
    is_author: z.boolean(),
  }),
  progress: z.array(LessonProgressRowSchema),
  /** Raw jsonb — callers parse with ProgressStateSchema (graceful on legacy). */
  lesson_progress_state: z.unknown().nullable(),
  quiz_attempt_block_ids: z.array(z.string()),
  quiz_attempt_counts: z.record(z.string(), z.number()),
  homework_submissions: z.array(LessonHomeworkRowSchema),
  /** Raw jsonb — callers parse with parseReviewPromptState (try/catch, as
   *  the page always has). Null for authors. */
  review_prompt: z.unknown().nullable(),
  /** slideId → {reaction, comment} (my_slide_feedback). Null for authors. */
  slide_feedback: z.record(z.string(), z.unknown()).nullable(),
  video_assets: z.array(LessonVideoAssetSchema),
});
export type LessonState = z.infer<typeof LessonStateSchema>;

/** RPC result: null (no session / unknown publication) · denied · the state.
 *  Denied FIRST — its `access` literal can never match the full object. */
const LessonStateResultSchema = z
  .union([z.object({ access: z.literal("denied") }), LessonStateSchema])
  .nullable();

export type LessonStateResult =
  | { kind: "unauthenticated" }
  | { kind: "denied" }
  | { kind: "ok"; state: LessonState };

/* ─────────────────────────────── Loader ────────────────────────────────── */

export async function loadLessonState(
  supabase: SupabaseClient<never> | SupabaseClient,
  args: { publicationId: string; lessonId: string; videoAssetIds: string[] }
): Promise<LessonStateResult> {
  const data = await rpcJson(
    supabase,
    "learn_lesson_state",
    {
      p_publication_id: args.publicationId,
      p_lesson_id: args.lessonId,
      p_video_asset_ids: args.videoAssetIds,
    },
    LessonStateResultSchema
  );
  if (data === null) return { kind: "unauthenticated" };
  if (data.access === "denied") return { kind: "denied" };
  return { kind: "ok", state: data };
}

/* ──────────────────────────── Pure helpers ─────────────────────────────── */

/** The video-asset ids a snapshot lesson references — the page derives these
 *  from the CACHED snapshot and hands them to the RPC. */
export function lessonVideoAssetIds(lesson: PublishedLesson): string[] {
  const ids: string[] = [];
  for (const block of lesson.blocks) {
    if (block.type === "video" && block.asset.videoAssetId) {
      ids.push(block.asset.videoAssetId);
    }
  }
  return ids;
}

/**
 * blockId → LearnerVideoData for the lesson's video blocks. PURE — the same
 * derivation as lib/learn/media.ts `learnerVideoData` / `buildVideoAssetView`
 * (poster from the Mux image API, captions parsed from the VTT), minus the
 * admin-client round trip per block.
 */
export function videoDataFromState(
  lesson: PublishedLesson,
  assets: readonly LessonVideoAsset[]
): Record<string, LearnerVideoData | null> {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const out: Record<string, LearnerVideoData | null> = {};
  for (const block of lesson.blocks) {
    if (block.type !== "video") continue;
    const row = block.asset.videoAssetId
      ? (byId.get(block.asset.videoAssetId) ?? null)
      : null;
    if (!row) {
      out[block.id] = null;
      continue;
    }
    out[block.id] = {
      mp4Url: row.mp4_url,
      mp4Status: (row.mp4_status as LearnerVideoData["mp4Status"]) ?? null,
      posterUrl: row.mux_playback_id
        ? thumbnailUrl(row.mux_playback_id, {
            time: row.thumbnail_time ?? 0,
            width: 640,
            fitMode: "smartcrop",
          })
        : (block.asset.thumbnailUrl ?? null),
      durationSeconds: row.duration_seconds ?? block.asset.durationSeconds ?? null,
      captions: row.transcript_vtt ? parseVtt(row.transcript_vtt) : null,
    };
  }
  return out;
}
