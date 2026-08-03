/**
 * Hook re-burn (directive H-3) — editing a clip post's hook text, animation,
 * timing, or captions re-runs the H-2 burn from the CLEAN MASTER:
 *
 *   - NO provider job, NO clip minutes, render quota untouched — the only
 *     guard is a cheap `CLIP_REBURNS_PER_DAY` bound (default 50), counted on
 *     the gate ledger (marketing_action rows for update_clip_hook — the
 *     social revision-budget precedent).
 *   - VERSIONED write: video_path + ai_metadata.textBurn ride
 *     `versionedUpdateSocialPost` (0 rows ⇒ SocialVersionConflictError ⇒
 *     the caller re-reads — the ONE social content-write rule).
 *   - ARTIFACT ROTATION: each re-burn lands at `…/{jobId}.burn{seq}.mp4`;
 *     the post keeps references to the last CLIP_BURN_HISTORY_KEEP burned
 *     artifacts (current + priors, so the gate's revert restores a prior
 *     video_path whose file still exists); older re-burn files purge from
 *     storage. The job's ORIGINAL burn ({jobId}.mp4 — the job card's media)
 *     and the clean master are never purged.
 *
 * Clients: the USER-scoped client does every row read/write (RLS ownership
 * is the gate); the ADMIN client touches only the zero-policy clip-media
 * bucket AFTER ownership is proven (the signed-URL route's precedent).
 *
 * slide_short posts have no clean master (their text is native Remotion) —
 * refused with the remedy (re-render via generate_lesson_clips).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { countRevisionActionsSince, versionedUpdateSocialPost } from "@/lib/marketing/social/repository";
import { CLIP_BURN_HISTORY_KEEP, clipRenderConfig, CLIP_PLATFORMS, type ClipPlatform } from "../constants";
import { emitClipEvent } from "../events";
import type { ClipCaptionStyle, ClipHookAnimation } from "../textStyles";
import { buildJobTextSpec, burnClipText, type TextBurnMeta } from "./burn";
import { getRenderJob } from "./jobs";
import type { runFfmpeg } from "./localRender";

type DB = SupabaseClient<Database>;

export const UPDATE_CLIP_HOOK_TOOL_NAME = "update_clip_hook";

export class ClipReburnError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_clip"
      | "no_master"
      | "no_job"
      | "quota"
      | "storage",
    message: string
  ) {
    super(message);
    this.name = "ClipReburnError";
  }
}

/** The persisted textBurn metadata incl. the H-3 rotation fields. */
export interface StoredTextBurn extends TextBurnMeta {
  /** Monotonic re-burn counter (0 = the original render-time burn). */
  seq?: number;
  /** Prior burned artifact paths, oldest→newest (≤ KEEP−1 entries). */
  history?: string[];
}

export interface ReburnChanges {
  /** undefined = keep the current hook text. */
  hookText?: string;
  animation?: ClipHookAnimation;
  holdSeconds?: number;
  captionsEnabled?: boolean;
  captionStyle?: ClipCaptionStyle;
}

export interface ReburnDeps {
  /** User-scoped client (RLS = ownership). */
  supabase: DB;
  /** Admin client — clip-media storage only (zero user policies). */
  admin: DB;
  nowIso: string;
  runFfmpegImpl?: typeof runFfmpeg;
}

export interface ReburnResult {
  postId: string;
  version: number;
  videoPath: string;
  burn: StoredTextBurn;
  reburnsToday: number;
  reburnsPerDay: number;
}

function utcDayStart(nowIso: string): string {
  return `${nowIso.slice(0, 10)}T00:00:00.000Z`;
}

export async function reburnClipPost(
  deps: ReburnDeps,
  args: { postId: string; expectedVersion: number; changes: ReburnChanges }
): Promise<ReburnResult> {
  const { data: post, error } = await deps.supabase
    .from("social_post")
    .select("*")
    .eq("id", args.postId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`reburn post read: ${error.message}`);
  if (!post) throw new ClipReburnError("not_found", `Clip post ${args.postId} not found`);
  if (post.post_type !== "clip") {
    throw new ClipReburnError("not_clip", "Hook re-burns are for rendered clips — this is a text post.");
  }
  const meta = (post.ai_metadata as Record<string, unknown>) ?? {};
  const currentBurn = (meta.textBurn as StoredTextBurn | null) ?? null;
  if (!post.clean_video_path) {
    const isSlideShort = meta.layout === "slide_short";
    throw new ClipReburnError(
      "no_master",
      isSlideShort
        ? "Slide shorts draw their hook and captions natively — re-render the clip (generate_lesson_clips) to change them."
        : "This clip has no clean master (rendered before the text-burn stage) — re-render it once and hook edits become free."
    );
  }
  if (!post.clip_job_id) {
    throw new ClipReburnError("no_job", "This clip post lost its render job reference — re-render the candidate.");
  }

  // Quota (H-3): counted on the gate ledger — the row for THIS call is
  // written after execute, so the bound admits exactly N per UTC day.
  const cfg = clipRenderConfig();
  const reburnsToday = await countRevisionActionsSince(
    deps.supabase,
    [UPDATE_CLIP_HOOK_TOOL_NAME],
    utcDayStart(deps.nowIso)
  );
  if (reburnsToday >= cfg.reburnsPerDay) {
    throw new ClipReburnError(
      "quota",
      `Daily re-burn budget reached (${cfg.reburnsPerDay}/day — it resets at midnight UTC).`
    );
  }

  const job = await getRenderJob(deps.supabase, post.clip_job_id);
  if (!job?.output) {
    throw new ClipReburnError("no_job", "This clip's render job is gone — re-render the candidate.");
  }

  // Effective text config: current burn values, overridden by the changes.
  const platform: ClipPlatform = (CLIP_PLATFORMS as readonly string[]).includes(post.platform)
    ? (post.platform as ClipPlatform)
    : (currentBurn?.platform ?? "instagram");
  const hookText =
    args.changes.hookText !== undefined
      ? args.changes.hookText
      : (currentBurn?.hookText ?? (meta.hookText as string | undefined) ?? null);
  const spec = await buildJobTextSpec(
    deps.supabase,
    job,
    { hookText: hookText ?? "", targetPlatformFit: [platform] },
    { width: job.output.width, height: job.output.height },
    {
      hookText,
      animation: args.changes.animation ?? currentBurn?.animation ?? null,
      holdSeconds: args.changes.holdSeconds ?? currentBurn?.holdSeconds ?? null,
      captionsEnabled: args.changes.captionsEnabled ?? currentBurn?.captionsEnabled ?? true,
      captionStyle: args.changes.captionStyle ?? currentBurn?.captionStyle ?? null,
    }
  );

  // Clean master → local burn → new artifact.
  const { data: masterBlob, error: dlError } = await deps.admin.storage
    .from("clip-media")
    .download(post.clean_video_path);
  if (dlError || !masterBlob) {
    throw new ClipReburnError("storage", `Could not read the clean master: ${dlError?.message ?? "missing"}`);
  }
  const seq = (currentBurn?.seq ?? 0) + 1;
  const newPath = `${post.creator_id}/clips/${job.id}.burn${seq}.mp4`;
  const dir = mkdtempSync(join(tmpdir(), "wisesel-reburn-"));
  let burn: TextBurnMeta;
  let burnedBytes: Buffer;
  try {
    const cleanPath = join(dir, "clean.mp4");
    const burnedPath = join(dir, "burned.mp4");
    writeFileSync(cleanPath, Buffer.from(await masterBlob.arrayBuffer()));
    burn = await burnClipText({
      inputPath: cleanPath,
      outputPath: burnedPath,
      spec,
      runFfmpegImpl: deps.runFfmpegImpl,
    });
    burnedBytes = readFileSync(burnedPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const { error: upError } = await deps.admin.storage
    .from("clip-media")
    .upload(newPath, burnedBytes, { contentType: "video/mp4", upsert: true });
  if (upError) throw new ClipReburnError("storage", `Could not store the re-burned clip: ${upError.message}`);

  // Rotation: keep the last KEEP references (current + priors); purge older
  // RE-BURN files. The job's original burn + the clean master never purge.
  const protectedPaths = new Set([job.output.storagePath, post.clean_video_path]);
  const allPriors = [...(currentBurn?.history ?? []), ...(post.video_path ? [post.video_path] : [])];
  const keepPriors = allPriors.slice(-(CLIP_BURN_HISTORY_KEEP - 1));
  const purge = allPriors.slice(0, -(CLIP_BURN_HISTORY_KEEP - 1)).filter((p) => !protectedPaths.has(p));
  if (purge.length > 0) {
    // Best-effort — a leftover file costs pennies; a failed purge must not
    // fail the creator's edit.
    await deps.admin.storage.from("clip-media").remove(purge);
  }

  const storedBurn: StoredTextBurn = { ...burn, seq, history: keepPriors };
  const updated = await versionedUpdateSocialPost(deps.supabase, args.postId, args.expectedVersion, {
    video_path: newPath,
    ai_metadata: { ...meta, textBurn: storedBurn } as unknown as Json,
  });

  await emitClipEvent(deps.supabase, post.course_id ?? "", "clip_hook_reburned", {
    postId: post.id,
    jobId: job.id,
    seq,
    hookText: storedBurn.hookText,
    animation: storedBurn.animation,
    captionStyle: storedBurn.captionStyle,
    captionsEnabled: storedBurn.captionsEnabled,
    styleVersion: storedBurn.styleVersion,
    assHash: storedBurn.assHash,
    findings: storedBurn.findings.map((f) => f.kind),
  });

  return {
    postId: updated.id,
    version: updated.version,
    videoPath: newPath,
    burn: storedBurn,
    reburnsToday: reburnsToday + 1,
    reburnsPerDay: cfg.reburnsPerDay,
  };
}
