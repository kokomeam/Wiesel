/**
 * clip_moment_candidate persistence. Candidates are regenerable AI artifacts
 * (not creator content): status is a last-write-wins lifecycle column (the
 * Phase 1 lifecycle rule) and there is NO versioned-write path here — content
 * never mutates after insert (a different moment = a new selection run).
 * The gate's revert unit is the request_id SET (see lib/marketing/entities.ts).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { ClipCandidateStatus } from "./constants";
import type { ClipMomentCandidate, ModelMoment, RubricScores } from "./schemas";
import type { ClipPlatform } from "./constants";

type DB = SupabaseClient<Database>;
type CandidateRow = Database["public"]["Tables"]["clip_moment_candidate"]["Row"];

export function rowToCandidate(row: CandidateRow): ClipMomentCandidate {
  return {
    id: row.id,
    creatorId: row.creator_id,
    courseId: row.course_id,
    lessonId: row.lesson_id,
    transcriptId: row.transcript_id,
    requestId: row.request_id,
    rank: row.rank,
    startMs: row.start_ms,
    endMs: row.end_ms,
    segments: (row.segments as ClipMomentCandidate["segments"]) ?? null,
    stitchedScript: row.stitched_script,
    momentType: row.moment_type as ClipMomentCandidate["momentType"],
    hookText: row.hook_text,
    altHooks: (row.alt_hooks as string[]) ?? [],
    funnelStage: row.funnel_stage as ClipMomentCandidate["funnelStage"],
    targetPlatformFit: (row.target_platform_fit as ClipPlatform[]) ?? [],
    rubricScores: row.rubric_scores as unknown as RubricScores,
    rationale: row.rationale,
    captionDraft: row.caption_draft,
    endCardCta: row.end_card_cta,
    status: row.status as ClipCandidateStatus,
    promptVersion: row.prompt_version,
    aiMetadata: (row.ai_metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CandidatePersistInput {
  moment: ModelMoment & { spanTranscript?: string };
  rank: number;
  aiMetadata: Record<string, unknown>;
}

/** One multi-row insert (atomic in a single statement). ⚠ PostgREST unifies
 *  columns across rows — every row carries EVERY column explicitly. */
export async function insertCandidates(
  supabase: DB,
  args: {
    creatorId: string;
    courseId: string | null;
    lessonId: string;
    transcriptId: string;
    requestId: string;
    promptVersion: string;
  },
  inputs: CandidatePersistInput[]
): Promise<ClipMomentCandidate[]> {
  const rows = inputs.map(({ moment, rank, aiMetadata }) => ({
    creator_id: args.creatorId,
    course_id: args.courseId,
    lesson_id: args.lessonId,
    transcript_id: args.transcriptId,
    request_id: args.requestId,
    rank,
    start_ms: moment.startMs,
    end_ms: moment.endMs,
    segments: (moment.segments as unknown as Json) ?? null,
    stitched_script: moment.stitchedScript,
    moment_type: moment.momentType,
    hook_text: moment.hookText,
    alt_hooks: moment.altHooks as unknown as Json,
    funnel_stage: moment.funnelStage,
    target_platform_fit: moment.targetPlatformFit as unknown as Json,
    rubric_scores: moment.rubricScores as unknown as Json,
    rationale: moment.rationale,
    caption_draft: moment.captionDraft,
    end_card_cta: moment.endCardCta,
    status: "candidate" as const,
    prompt_version: args.promptVersion,
    ai_metadata: aiMetadata as Json,
  }));
  const { data, error } = await supabase
    .from("clip_moment_candidate")
    .insert(rows)
    .select("*");
  if (error) throw new Error(`clip_moment_candidate insert: ${error.message}`);
  return (data ?? []).map(rowToCandidate).sort((a, b) => a.rank - b.rank);
}

export async function getCandidate(supabase: DB, id: string): Promise<ClipMomentCandidate | null> {
  const { data, error } = await supabase
    .from("clip_moment_candidate")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`clip_moment_candidate read: ${error.message}`);
  return data ? rowToCandidate(data) : null;
}

export async function listCandidatesForLesson(
  supabase: DB,
  lessonId: string,
  opts: { includeDismissed?: boolean } = {}
): Promise<ClipMomentCandidate[]> {
  let query = supabase
    .from("clip_moment_candidate")
    .select("*")
    .eq("lesson_id", lessonId)
    .order("created_at", { ascending: false })
    .order("rank", { ascending: true });
  if (!opts.includeDismissed) query = query.neq("status", "dismissed");
  const { data, error } = await query;
  if (error) throw new Error(`clip_moment_candidate list: ${error.message}`);
  return (data ?? []).map(rowToCandidate);
}

export async function updateCandidateStatus(
  supabase: DB,
  id: string,
  status: ClipCandidateStatus
): Promise<ClipMomentCandidate> {
  const { data, error } = await supabase
    .from("clip_moment_candidate")
    .update({ status })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`clip_moment_candidate status update: ${error.message}`);
  return rowToCandidate(data);
}
