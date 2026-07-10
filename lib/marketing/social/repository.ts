/**
 * Repository — EVERY read/write of social_post / social_post_batch /
 * social_voice_profile lives here (plus the gate's generic entity restore in
 * lib/marketing/entities.ts). verify-social.ts greps the repo to keep it that
 * way.
 *
 * THE VERSIONED-UPDATE RULE (PRD §12.1): the only legal content update is
 * `versionedUpdateSocialPost` —
 *   update … set …, version = version + 1
 *     where id = $1 and version = $2 and deleted_at is null returning *;
 * Zero rows ⇒ SocialVersionConflictError (HTTP 409). Lifecycle columns
 * (status/posted_manually_at), performance, and image attachment are
 * deliberately NON-versioned single-column updates — they are not content
 * fields and last-write-wins is the intended semantics there.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import type { SocialPlatform, SocialPostStatus } from "./constants";
import { SocialVersionConflictError } from "./errors";
import type { PostPerformance, SocialPost, SocialVoiceProfile } from "./schemas";

type DB = SupabaseClient<Database>;
type PostRow = Database["public"]["Tables"]["social_post"]["Row"];
type PostInsert = Database["public"]["Tables"]["social_post"]["Insert"];
type BatchRow = Database["public"]["Tables"]["social_post_batch"]["Row"];
type VoiceRow = Database["public"]["Tables"]["social_voice_profile"]["Row"];

/* ────────────────────────────── mapping ─────────────────────────────── */

export function rowToSocialPost(row: PostRow): SocialPost {
  return {
    id: row.id,
    creatorId: row.creator_id,
    courseId: row.course_id,
    moduleId: row.module_id,
    lessonId: row.lesson_id,
    campaignId: row.campaign_id,
    batchId: row.batch_id,
    batchOrder: row.batch_order,
    sourceType: row.source_type as SocialPost["sourceType"],
    sourceText: row.source_text,
    platform: row.platform as SocialPost["platform"],
    postType: row.post_type,
    goal: row.goal as SocialPost["goal"],
    funnelStage: row.funnel_stage as SocialPost["funnelStage"],
    audience: row.audience,
    tone: row.tone as SocialPost["tone"],
    body: row.body,
    cta: row.cta,
    hashtags: row.hashtags ?? [],
    imageUrl: row.image_url,
    imageStoragePath: row.image_storage_path,
    imageAltText: row.image_alt_text,
    suggestedImageIdea: row.suggested_image_idea,
    plannedPostAt: row.planned_post_at,
    status: row.status as SocialPost["status"],
    postedManuallyAt: row.posted_manually_at,
    performance: (row.performance as PostPerformance | null) ?? null,
    externalRef: row.external_ref,
    version: row.version,
    aiMetadata: (row.ai_metadata as Record<string, unknown>) ?? {},
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SocialBatch {
  id: string;
  creatorId: string;
  courseId: string | null;
  sourceType: string;
  platform: SocialPlatform;
  requestedCount: number;
  funnelMix: string;
  timingPreset: string;
  aiMetadata: Record<string, unknown>;
  createdAt: string;
}

export function rowToBatch(row: BatchRow): SocialBatch {
  return {
    id: row.id,
    creatorId: row.creator_id,
    courseId: row.course_id,
    sourceType: row.source_type,
    platform: row.platform as SocialPlatform,
    requestedCount: row.requested_count,
    funnelMix: row.funnel_mix,
    timingPreset: row.timing_preset,
    aiMetadata: (row.ai_metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at,
  };
}

/* ─────────────────────────────── reads ──────────────────────────────── */

export interface ListPostsFilter {
  status?: SocialPostStatus;
  platform?: SocialPlatform;
  courseId?: string;
  funnelStage?: string;
  batchId?: string;
  /** Soft-deleted rows are excluded unless explicitly asked for. */
  includeDeleted?: boolean;
}

export interface ListPostsPage {
  posts: SocialPost[];
  /** Pass back as `cursor` for the next page (updated_at of the last row). */
  nextCursor: string | null;
}

export async function listSocialPosts(
  supabase: DB,
  filter: ListPostsFilter = {},
  opts: { cursor?: string; limit?: number } = {}
): Promise<ListPostsPage> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  let q = supabase.from("social_post").select("*").order("updated_at", { ascending: false }).limit(limit);
  if (!filter.includeDeleted) q = q.is("deleted_at", null);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.platform) q = q.eq("platform", filter.platform);
  if (filter.courseId) q = q.eq("course_id", filter.courseId);
  if (filter.funnelStage) q = q.eq("funnel_stage", filter.funnelStage);
  if (filter.batchId) q = q.eq("batch_id", filter.batchId);
  if (opts.cursor) q = q.lt("updated_at", opts.cursor);
  const { data, error } = await q;
  if (error) throw new Error(`listSocialPosts: ${error.message}`);
  const posts = (data ?? []).map(rowToSocialPost);
  return { posts, nextCursor: posts.length === limit ? posts[posts.length - 1].updatedAt : null };
}

export async function getSocialPost(supabase: DB, id: string): Promise<SocialPost | null> {
  const { data, error } = await supabase.from("social_post").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getSocialPost: ${error.message}`);
  return data ? rowToSocialPost(data) : null;
}

export async function listBatches(
  supabase: DB,
  opts: { limit?: number } = {}
): Promise<SocialBatch[]> {
  const { data, error } = await supabase
    .from("social_post_batch")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(100, opts.limit ?? 30));
  if (error) throw new Error(`listBatches: ${error.message}`);
  return (data ?? []).map(rowToBatch);
}

export async function getBatch(supabase: DB, id: string): Promise<SocialBatch | null> {
  const { data, error } = await supabase.from("social_post_batch").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getBatch: ${error.message}`);
  return data ? rowToBatch(data) : null;
}

export async function findBatchByIdempotencyKey(
  supabase: DB,
  key: string
): Promise<SocialBatch | null> {
  const { data, error } = await supabase
    .from("social_post_batch")
    .select("*")
    .eq("idempotency_key", key)
    .maybeSingle();
  if (error) throw new Error(`findBatchByIdempotencyKey: ${error.message}`);
  return data ? rowToBatch(data) : null;
}

export async function listPostsForBatch(supabase: DB, batchId: string): Promise<SocialPost[]> {
  const { data, error } = await supabase
    .from("social_post")
    .select("*")
    .eq("batch_id", batchId)
    .order("batch_order", { ascending: true });
  if (error) throw new Error(`listPostsForBatch: ${error.message}`);
  return (data ?? []).map(rowToSocialPost);
}

/** Batches created since `sinceIso` — the per-day rate-limit input (RLS
 *  scopes the count to the signed-in creator). */
export async function countBatchesSince(supabase: DB, sinceIso: string): Promise<number> {
  const { count, error } = await supabase
    .from("social_post_batch")
    .select("id", { count: "exact", head: true })
    .gte("created_at", sinceIso);
  if (error) throw new Error(`countBatchesSince: ${error.message}`);
  return count ?? 0;
}

/** Model-backed revisions today, counted on the gate ledger (every revision
 *  flows through executeMarketingTool, so each has a marketing_action row;
 *  RLS scopes the rows to the signed-in author's courses). */
export async function countRevisionActionsSince(
  supabase: DB,
  toolNames: string[],
  sinceIso: string
): Promise<number> {
  const { count, error } = await supabase
    .from("marketing_action")
    .select("id", { count: "exact", head: true })
    .in("tool_name", toolNames)
    .gte("created_at", sinceIso);
  if (error) throw new Error(`countRevisionActionsSince: ${error.message}`);
  return count ?? 0;
}

/* ────────────────────────────── writes ──────────────────────────────── */

export interface BatchPersistInput {
  courseId: string | null;
  moduleId: string | null;
  lessonId: string | null;
  sourceType: string;
  sourceText: string | null;
  platform: SocialPlatform;
  requestedCount: number;
  funnelMix: string;
  timingPreset: string;
  idempotencyKey: string | null;
  aiMetadata: Record<string, unknown>;
}

export interface PostPersistInput {
  goal: string;
  funnelStage: string;
  audience: string | null;
  tone: string;
  body: string;
  cta: string | null;
  hashtags: string[];
  suggestedImageIdea: string | null;
  plannedPostAt: string | null;
  aiMetadata: Record<string, unknown>;
}

/** Transactional batch persist via the `social_create_batch` function (all
 *  posts commit or none; idempotency replay handled in-DB). */
export async function createBatchWithPosts(
  supabase: DB,
  batch: BatchPersistInput,
  posts: PostPersistInput[]
): Promise<{ batchId: string; replayed: boolean }> {
  const { data, error } = await supabase.rpc("social_create_batch", {
    p_batch: {
      course_id: batch.courseId ?? "",
      module_id: batch.moduleId ?? "",
      lesson_id: batch.lessonId ?? "",
      source_type: batch.sourceType,
      source_text: batch.sourceText,
      platform: batch.platform,
      requested_count: batch.requestedCount,
      funnel_mix: batch.funnelMix,
      timing_preset: batch.timingPreset,
      idempotency_key: batch.idempotencyKey ?? "",
      ai_metadata: batch.aiMetadata,
    } as Json,
    p_posts: posts.map((p) => ({
      goal: p.goal,
      funnel_stage: p.funnelStage,
      audience: p.audience ?? "",
      tone: p.tone,
      body: p.body,
      cta: p.cta ?? "",
      hashtags: p.hashtags,
      suggested_image_idea: p.suggestedImageIdea ?? "",
      planned_post_at: p.plannedPostAt ?? "",
      ai_metadata: p.aiMetadata,
    })) as Json,
  });
  if (error) throw new Error(`social_create_batch: ${error.message}`);
  const out = data as { batch_id: string; replayed: boolean };
  return { batchId: out.batch_id, replayed: out.replayed };
}

/** Direct batch-row insert — used by variants on a batch-less post so the
 *  new rows always have a batch to group (and revert) under. */
export async function insertBatchRow(
  supabase: DB,
  creatorId: string,
  input: Omit<
    Database["public"]["Tables"]["social_post_batch"]["Insert"],
    "creator_id" | "id" | "created_at"
  >
): Promise<SocialBatch> {
  const { data, error } = await supabase
    .from("social_post_batch")
    .insert({ ...input, creator_id: creatorId })
    .select("*")
    .single();
  if (error || !data) throw new Error(`insertBatchRow: ${error?.message}`);
  return rowToBatch(data);
}

/** Direct insert for single posts (manual create, variants, platform
 *  rewrites). creator_id rides RLS's with-check. */
export async function insertSocialPost(
  supabase: DB,
  creatorId: string,
  input: Omit<PostInsert, "creator_id" | "id" | "version" | "created_at" | "updated_at">
): Promise<SocialPost> {
  const { data, error } = await supabase
    .from("social_post")
    .insert({ ...input, creator_id: creatorId })
    .select("*")
    .single();
  if (error || !data) throw new Error(`insertSocialPost: ${error?.message}`);
  return rowToSocialPost(data);
}

/** THE versioned content update (see the module docblock). */
export async function versionedUpdateSocialPost(
  supabase: DB,
  id: string,
  expectedVersion: number,
  set: Partial<
    Pick<
      PostRow,
      | "body"
      | "cta"
      | "hashtags"
      | "image_alt_text"
      | "audience"
      | "funnel_stage"
      | "goal"
      | "tone"
      | "platform"
      | "suggested_image_idea"
      | "planned_post_at"
      | "ai_metadata"
    >
  >
): Promise<SocialPost> {
  const { data, error } = await supabase
    .from("social_post")
    .update({ ...set, version: expectedVersion + 1 })
    .eq("id", id)
    .eq("version", expectedVersion)
    .is("deleted_at", null)
    .select("*");
  if (error) throw new Error(`versionedUpdateSocialPost: ${error.message}`);
  if (!data || data.length === 0) throw new SocialVersionConflictError(id);
  return rowToSocialPost(data[0]);
}

/** Lifecycle transition — non-versioned by design (last-write-wins is the
 *  intended semantics for status). posted_manual stamps the timestamp. */
export async function updatePostStatus(
  supabase: DB,
  id: string,
  status: SocialPostStatus,
  nowIso: string
): Promise<SocialPost> {
  const set: Partial<PostRow> = { status };
  if (status === "posted_manual") set.posted_manually_at = nowIso;
  const { data, error } = await supabase
    .from("social_post")
    .update(set)
    .eq("id", id)
    .is("deleted_at", null)
    .select("*");
  if (error) throw new Error(`updatePostStatus: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`updatePostStatus: post ${id} not found`);
  return rowToSocialPost(data[0]);
}

/** SOFT delete (PRD: archived + deletedAt; hard purge is a later-phase
 *  retention job). Reversal = unarchive (clear deleted_at). */
export async function softDeleteSocialPost(supabase: DB, id: string, nowIso: string): Promise<SocialPost> {
  const { data, error } = await supabase
    .from("social_post")
    .update({ status: "archived", deleted_at: nowIso })
    .eq("id", id)
    .select("*");
  if (error) throw new Error(`softDeleteSocialPost: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`softDeleteSocialPost: post ${id} not found`);
  return rowToSocialPost(data[0]);
}

export async function unarchiveSocialPost(supabase: DB, id: string): Promise<SocialPost> {
  const { data, error } = await supabase
    .from("social_post")
    .update({ status: "draft", deleted_at: null })
    .eq("id", id)
    .select("*");
  if (error) throw new Error(`unarchiveSocialPost: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`unarchiveSocialPost: post ${id} not found`);
  return rowToSocialPost(data[0]);
}

export async function upsertPostPerformance(
  supabase: DB,
  id: string,
  performance: PostPerformance
): Promise<SocialPost> {
  const { data, error } = await supabase
    .from("social_post")
    .update({ performance: performance as unknown as Json })
    .eq("id", id)
    .is("deleted_at", null)
    .select("*");
  if (error) throw new Error(`upsertPostPerformance: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`upsertPostPerformance: post ${id} not found`);
  return rowToSocialPost(data[0]);
}

export async function clearPostPerformance(supabase: DB, id: string): Promise<SocialPost> {
  const { data, error } = await supabase
    .from("social_post")
    .update({ performance: null })
    .eq("id", id)
    .select("*");
  if (error) throw new Error(`clearPostPerformance: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`clearPostPerformance: post ${id} not found`);
  return rowToSocialPost(data[0]);
}

export async function setPostImage(
  supabase: DB,
  id: string,
  image: { url: string; storagePath: string; altText: string | null; meta: Record<string, unknown> }
): Promise<SocialPost> {
  const post = await getSocialPost(supabase, id);
  if (!post) throw new Error(`setPostImage: post ${id} not found`);
  const aiMetadata = { ...post.aiMetadata, image: image.meta };
  const { data, error } = await supabase
    .from("social_post")
    .update({
      image_url: image.url,
      image_storage_path: image.storagePath,
      image_alt_text: image.altText,
      ai_metadata: aiMetadata as Json,
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select("*");
  if (error) throw new Error(`setPostImage: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`setPostImage: post ${id} not found`);
  return rowToSocialPost(data[0]);
}

/** Detach the reference — the storage object is RETAINED (revert-friendly)
 *  until a later retention purge. */
export async function clearPostImage(supabase: DB, id: string): Promise<SocialPost> {
  const { data, error } = await supabase
    .from("social_post")
    .update({ image_url: null, image_storage_path: null, image_alt_text: null })
    .eq("id", id)
    .select("*");
  if (error) throw new Error(`clearPostImage: ${error.message}`);
  if (!data || data.length === 0) throw new Error(`clearPostImage: post ${id} not found`);
  return rowToSocialPost(data[0]);
}

/* ─────────────────────── social voice profile ──────────────────────── */

export interface VoiceProfileRecord {
  id: string;
  creatorId: string;
  profile: SocialVoiceProfile;
  source: "derived" | "creator_edited";
  version: number;
  updatedAt: string;
}

function rowToVoice(row: VoiceRow): VoiceProfileRecord {
  return {
    id: row.id,
    creatorId: row.creator_id,
    profile: row.profile as unknown as SocialVoiceProfile,
    source: row.source as "derived" | "creator_edited",
    version: row.version,
    updatedAt: row.updated_at,
  };
}

/** `creatorId` scopes explicitly — REQUIRED under a service-role client
 *  (RLS normally scopes user clients to one row; the admin-driven render
 *  tick would otherwise see every creator's profile — found live at M-C). */
export async function loadSocialVoiceProfile(
  supabase: DB,
  creatorId?: string
): Promise<VoiceProfileRecord | null> {
  let query = supabase.from("social_voice_profile").select("*");
  if (creatorId) query = query.eq("creator_id", creatorId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`loadSocialVoiceProfile: ${error.message}`);
  return data ? rowToVoice(data) : null;
}

export async function upsertSocialVoiceProfile(
  supabase: DB,
  creatorId: string,
  profile: SocialVoiceProfile,
  source: "derived" | "creator_edited"
): Promise<VoiceProfileRecord> {
  const existing = await loadSocialVoiceProfile(supabase, creatorId);
  const { data, error } = await supabase
    .from("social_voice_profile")
    .upsert(
      {
        creator_id: creatorId,
        profile: profile as unknown as Json,
        source,
        version: (existing?.version ?? 0) + 1,
      },
      { onConflict: "creator_id" }
    )
    .select("*")
    .single();
  if (error || !data) throw new Error(`upsertSocialVoiceProfile: ${error?.message}`);
  return rowToVoice(data);
}
