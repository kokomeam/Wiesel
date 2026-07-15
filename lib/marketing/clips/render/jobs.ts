/**
 * clip_render_job repository — createRenderJob is the ONLY insert and
 * `transitionRenderJob` is the ONLY status write in the repo (the single
 * legal write path — PRD invariant, reasserted by amendment FR-6 for the
 * M-F local worker, which uses these SAME functions). Transitions are
 * guarded by an allowed-transition table AND an optimistic `eq(status,
 * from)` — a concurrent tick racing the same job loses cleanly (0 rows →
 * ClipJobTransitionError) instead of double-advancing.
 *
 * State machine:
 *   queued → precutting → submitted        → completed | failed    (reap)
 *   queued → precutting → rendering_local  → completed | failed    (in-house)
 *   any non-terminal → cancelled | failed
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { ClipLayout, RecordingFormat } from "../schemas";
import type { RenderProviderId } from "../provider/types";

type DB = SupabaseClient<Database>;
type JobRow = Database["public"]["Tables"]["clip_render_job"]["Row"];

export const CLIP_JOB_STATUSES = [
  "queued",
  "precutting",
  "submitted",
  "rendering_local",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ClipJobStatus = (typeof CLIP_JOB_STATUSES)[number];

export const CLIP_JOB_TRANSITIONS: Record<ClipJobStatus, ClipJobStatus[]> = {
  queued: ["precutting", "cancelled", "failed"],
  precutting: ["submitted", "rendering_local", "cancelled", "failed"],
  submitted: ["completed", "failed", "cancelled"],
  rendering_local: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalJobStatus(s: ClipJobStatus): boolean {
  return CLIP_JOB_TRANSITIONS[s].length === 0;
}

export class ClipJobTransitionError extends Error {
  constructor(
    readonly jobId: string,
    readonly from: ClipJobStatus,
    readonly to: ClipJobStatus,
    detail: string
  ) {
    super(`clip job ${jobId}: ${from} → ${to} refused (${detail})`);
    this.name = "ClipJobTransitionError";
  }
}

/** The exact span + source facts stamped at creation. */
export interface ClipJobSource {
  videoAssetRowId: string;
  sourceMuxAssetId: string;
  playbackId: string | null;
  startMs: number;
  endMs: number;
  recordingFormat: RecordingFormat;
  /** The PiP rect for stacked_split (source pixels) when derivable. */
  pipRect?: { x: number; y: number; w: number; h: number } | null;
  /** D-4: the raw camera dual-track (full-res face band) when captured. */
  dualCamera?: { videoAssetRowId: string; sourceMuxAssetId: string } | null;
}

export interface ClipJobPrecut {
  muxAssetId: string;
  playbackId?: string | null;
  mp4Url?: string | null;
  /** D-4: the camera track's own precut asset (stacked_split dual path). */
  cameraMuxAssetId?: string | null;
  cameraMp4Url?: string | null;
}

export interface ClipJobOutput {
  storagePath: string;
  width: number;
  height: number;
  durationSeconds: number;
}

export interface ClipRenderJob {
  id: string;
  creatorId: string;
  courseId: string | null;
  lessonId: string;
  candidateId: string;
  layout: ClipLayout;
  provider: RenderProviderId | "wisesel_ffmpeg";
  preset: string;
  status: ClipJobStatus;
  source: ClipJobSource;
  precut: ClipJobPrecut | null;
  providerRef: string | null;
  uploadRef: string | null;
  cropProvenance: "deterministic" | "detected" | null;
  output: ClipJobOutput | null;
  costMinutes: number | null;
  error: string | null;
  attempts: number;
  idempotencyKey: string | null;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function rowToRenderJob(row: JobRow): ClipRenderJob {
  return {
    id: row.id,
    creatorId: row.creator_id,
    courseId: row.course_id,
    lessonId: row.lesson_id,
    candidateId: row.candidate_id,
    layout: row.layout as ClipLayout,
    provider: row.provider as ClipRenderJob["provider"],
    preset: row.preset,
    status: row.status as ClipJobStatus,
    source: row.source as unknown as ClipJobSource,
    precut: (row.precut as unknown as ClipJobPrecut) ?? null,
    providerRef: row.provider_ref,
    uploadRef: row.upload_ref,
    cropProvenance: row.crop_provenance as ClipRenderJob["cropProvenance"],
    output: (row.output as unknown as ClipJobOutput) ?? null,
    costMinutes: row.cost_minutes === null ? null : Number(row.cost_minutes),
    error: row.error,
    attempts: row.attempts,
    idempotencyKey: row.idempotency_key,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateRenderJobInput {
  creatorId: string;
  courseId: string | null;
  lessonId: string;
  candidateId: string;
  layout: ClipLayout;
  provider: ClipRenderJob["provider"];
  preset: string;
  source: ClipJobSource;
  cropProvenance?: "deterministic" | "detected" | null;
  idempotencyKey?: string | null;
}

/** Idempotent create: a replayed idempotency key returns the existing job. */
export async function createRenderJob(supabase: DB, input: CreateRenderJobInput): Promise<ClipRenderJob> {
  const { data, error } = await supabase
    .from("clip_render_job")
    .insert({
      creator_id: input.creatorId,
      course_id: input.courseId,
      lesson_id: input.lessonId,
      candidate_id: input.candidateId,
      layout: input.layout,
      provider: input.provider,
      preset: input.preset,
      source: input.source as unknown as Json,
      crop_provenance: input.cropProvenance ?? null,
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select("*")
    .single();
  if (!error) return rowToRenderJob(data);

  // unique violation on (creator, idempotency_key) → replay. The index is
  // PARTIAL over live/completed jobs (failed/cancelled don't consume the
  // key — retry must stay possible), so the replay read filters the same
  // way: exactly one such row can exist.
  if (input.idempotencyKey && /duplicate key|23505/.test(error.message + (error.code ?? ""))) {
    const { data: existing, error: readErr } = await supabase
      .from("clip_render_job")
      .select("*")
      .eq("creator_id", input.creatorId)
      .eq("idempotency_key", input.idempotencyKey)
      .not("status", "in", '("failed","cancelled")')
      .single();
    if (readErr) throw new Error(`clip_render_job idempotent replay read: ${readErr.message}`);
    return rowToRenderJob(existing);
  }
  throw new Error(`clip_render_job insert: ${error.message}`);
}

export interface TransitionPatch {
  precut?: ClipJobPrecut | null;
  providerRef?: string | null;
  uploadRef?: string | null;
  cropProvenance?: "deterministic" | "detected" | null;
  output?: ClipJobOutput | null;
  costMinutes?: number | null;
  error?: string | null;
  bumpAttempts?: boolean;
  submittedAt?: string | null;
}

/** THE single status write path. Optimistic on `from`; refuses illegal
 *  edges before touching the DB. */
export async function transitionRenderJob(
  supabase: DB,
  jobId: string,
  from: ClipJobStatus,
  to: ClipJobStatus,
  patch: TransitionPatch = {}
): Promise<ClipRenderJob> {
  if (!CLIP_JOB_TRANSITIONS[from]?.includes(to)) {
    throw new ClipJobTransitionError(jobId, from, to, "illegal transition");
  }
  const update: Database["public"]["Tables"]["clip_render_job"]["Update"] = { status: to };
  if (patch.precut !== undefined) update.precut = patch.precut as unknown as Json;
  if (patch.providerRef !== undefined) update.provider_ref = patch.providerRef;
  if (patch.uploadRef !== undefined) update.upload_ref = patch.uploadRef;
  if (patch.cropProvenance !== undefined) update.crop_provenance = patch.cropProvenance;
  if (patch.output !== undefined) update.output = patch.output as unknown as Json;
  if (patch.costMinutes !== undefined) update.cost_minutes = patch.costMinutes;
  if (patch.error !== undefined) update.error = patch.error;
  if (patch.submittedAt !== undefined) update.submitted_at = patch.submittedAt;

  const query = supabase.from("clip_render_job").update(update).eq("id", jobId).eq("status", from);
  const { data, error } = await query.select("*").maybeSingle();
  if (error) throw new Error(`clip_render_job transition: ${error.message}`);
  if (!data) throw new ClipJobTransitionError(jobId, from, to, "row moved (concurrent transition)");
  if (patch.bumpAttempts) {
    const { data: bumped, error: bumpErr } = await supabase
      .from("clip_render_job")
      .update({ attempts: (data.attempts ?? 0) + 1 })
      .eq("id", jobId)
      .select("*")
      .single();
    if (bumpErr) throw new Error(`clip_render_job attempts bump: ${bumpErr.message}`);
    return rowToRenderJob(bumped);
  }
  return rowToRenderJob(data);
}

export async function getRenderJob(supabase: DB, id: string): Promise<ClipRenderJob | null> {
  const { data, error } = await supabase.from("clip_render_job").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`clip_render_job read: ${error.message}`);
  return data ? rowToRenderJob(data) : null;
}

export async function listActiveRenderJobs(
  supabase: DB,
  limit: number,
  creatorId?: string
): Promise<ClipRenderJob[]> {
  let query = supabase
    .from("clip_render_job")
    .select("*")
    .in("status", ["queued", "precutting", "submitted", "rendering_local"])
    .order("created_at", { ascending: true })
    .limit(limit);
  if (creatorId) query = query.eq("creator_id", creatorId);
  const { data, error } = await query;
  if (error) throw new Error(`clip_render_job active list: ${error.message}`);
  return (data ?? []).map(rowToRenderJob);
}

export async function listRenderJobsForLesson(supabase: DB, lessonId: string): Promise<ClipRenderJob[]> {
  const { data, error } = await supabase
    .from("clip_render_job")
    .select("*")
    .eq("lesson_id", lessonId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`clip_render_job lesson list: ${error.message}`);
  return (data ?? []).map(rowToRenderJob);
}

/* ─────────────────────── quotas + token bucket ─────────────────────────── */

/** Provider submissions in the trailing 60s (the PRD's 10/min token bucket —
 *  counted from submitted_at, the stamp the submit transition writes). */
export async function submissionsInLastMinute(supabase: DB, creatorId: string, nowIso: string): Promise<number> {
  const cutoff = new Date(new Date(nowIso).getTime() - 60_000).toISOString();
  const { count, error } = await supabase
    .from("clip_render_job")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", creatorId)
    .gte("submitted_at", cutoff);
  if (error) throw new Error(`clip_render_job bucket count: ${error.message}`);
  return count ?? 0;
}

/** Jobs created today (UTC) — the CLIP_JOBS_PER_DAY quota input. */
export async function jobsCreatedToday(supabase: DB, creatorId: string, nowIso: string): Promise<number> {
  const dayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
  const { count, error } = await supabase
    .from("clip_render_job")
    .select("id", { count: "exact", head: true })
    .eq("creator_id", creatorId)
    .gte("created_at", dayStart);
  if (error) throw new Error(`clip_render_job daily count: ${error.message}`);
  return count ?? 0;
}

/** Cost-minutes accrued this calendar month (UTC) — CLIP_MINUTES_PER_MONTH. */
export async function costMinutesThisMonth(supabase: DB, creatorId: string, nowIso: string): Promise<number> {
  const monthStart = `${nowIso.slice(0, 7)}-01T00:00:00.000Z`;
  const { data, error } = await supabase
    .from("clip_render_job")
    .select("cost_minutes")
    .eq("creator_id", creatorId)
    .gte("created_at", monthStart)
    .not("cost_minutes", "is", null);
  if (error) throw new Error(`clip_render_job month cost: ${error.message}`);
  return (data ?? []).reduce((s, r) => s + Number(r.cost_minutes ?? 0), 0);
}
