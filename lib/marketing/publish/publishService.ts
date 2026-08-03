/**
 * Publish service — M-B's IO orchestration over the pure manifest domain.
 * SERVER ONLY (decrypts the provider profile ref). Provider, clock, and the
 * video-bytes loader are injected (the accountsService/clips render `deps`
 * precedent) so the int suite drives the whole path with fakes.
 *
 * THE WORKFLOW (one edge per tick; reconciliation IS delivery — poll-only):
 *   queued|held → guards (due → health → quota → window) → submitting →
 *   ONE publish(clientRef = manifest id) → refs persisted IMMEDIATELY as
 *   their own durable transition → submitted → live (sync refs) |
 *   verifying → live/platform_failed. Guard failures self-heal in `held`.
 *
 * CRASH SEMANTICS (M-B decision 2): the manifest row exists BEFORE the call;
 * a row FOUND in `submitting` at tick start is a crashed/ambiguous prior
 * run — recovery adopts refs from history (conservative title match) or
 * fails after RECOVERY_GRACE_ATTEMPTS. The publish call is NEVER re-fired.
 *
 * LEDGER (decision 4): one row per provider-ACCEPT, written idempotently
 * (check-before-insert on client_ref); a platformError inside the accept
 * envelope writes nothing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { PublishAccepted, SocialPublishProvider } from "./provider/types";
import { isPermanentPublishError } from "./provider/types";
import { decryptSecret } from "@/lib/marketing/accounts/crypto";
import { accountsUsageConfig } from "@/lib/marketing/accounts/constants";
import {
  countUploadsThisMonth,
  getProviderProfile,
  ledgerRowExistsForClientRef,
  insertLedgerRow,
  listAccounts,
  type SocialAccount,
} from "@/lib/marketing/accounts/accountsRepository";
import {
  canRetryManifest,
  composePublishText,
  evaluatePublishGuards,
  matchRecentPost,
  RECOVERY_GRACE_ATTEMPTS,
  shouldWriteLedgerRow,
  VERIFY_MAX_ATTEMPTS,
} from "./manifest";
import { contentHashForPost } from "./contentHash";
import { clipSourceSuperseded } from "./sourceCheck";
import {
  bumpManifestAttempt,
  createPublishManifest,
  getPublishManifest,
  listActivePublishManifests,
  listPublishManifestsForPost,
  transitionPublishManifest,
  type PublishManifest,
} from "./manifestRepository";
import {
  createApprovalRequest,
  getApproval,
  voidOpenApprovalsForPost,
  type PublishApproval,
} from "./approvalRepository";
import { emitPublishEvent } from "./events";
import { updatePostStatus } from "@/lib/marketing/social/repository";

type DB = SupabaseClient<Database>;
type PostRow = Database["public"]["Tables"]["social_post"]["Row"];

export interface VideoSource {
  bytes: Buffer;
  filename: string;
}

export interface PublishTickDeps {
  supabase: DB;
  provider: SocialPublishProvider;
  nowIso?: () => string;
  /** Injected for tests; the default downloads video_path from clip-media. */
  loadVideoBytes?: (post: PostRow) => Promise<VideoSource>;
}

const now = () => new Date().toISOString();

async function defaultLoadVideoBytes(supabase: DB, post: PostRow): Promise<VideoSource> {
  if (!post.video_path) throw new Error("post has no video_path");
  const { data, error } = await supabase.storage.from("clip-media").download(post.video_path);
  if (error || !data) throw new Error(`clip-media download: ${error?.message}`);
  return {
    bytes: Buffer.from(await data.arrayBuffer()),
    filename: post.video_path.split("/").pop() ?? `${post.id}.mp4`,
  };
}

async function loadPost(supabase: DB, socialPostId: string): Promise<PostRow | null> {
  const { data, error } = await supabase
    .from("social_post")
    .select("*")
    .eq("id", socialPostId)
    .maybeSingle();
  if (error) throw new Error(`publish post read: ${error.message}`);
  return data;
}

/* ─────────────────────────── manifest creation ────────────────────────── */

/**
 * The SOLE way a manifest is born (M-C card-sole-path): a CONSUMED card (or
 * retry-clone) approval. approvalService.approvePublishCard is the only
 * production caller (grep-fenced); the target matrix (post/account/platform/
 * health/frozen-source) was validated there against the SAME content hash
 * this manifest is stamped with. Throws on an unconsumed/foreign approval —
 * this is the runtime assert behind AC-MC.1; the DB's NOT NULL + UNIQUE
 * approval_id backs it below the code.
 */
export async function requestPublish(
  supabase: DB,
  creatorId: string,
  approval: PublishApproval,
  scheduledFor: string | null
): Promise<PublishManifest> {
  if (approval.creatorId !== creatorId) throw new Error("requestPublish: approval belongs to another creator");
  if (!approval.consumedAt) throw new Error("requestPublish: approval was never consumed (card-sole-path)");
  if (approval.declinedAt || approval.voidedAt) throw new Error("requestPublish: approval is not approvable");
  return createPublishManifest(supabase, {
    creatorId,
    socialPostId: approval.socialPostId,
    socialAccountId: approval.socialAccountId,
    platform: approval.platform,
    approvalId: approval.id,
    contentHash: approval.contentHash,
    scheduledFor,
  });
}

/* ─────────────────────────── ledger (decision 4) ──────────────────────── */

async function ensureLedgerRow(
  supabase: DB,
  manifest: PublishManifest,
  providerRequestId: string | null
): Promise<void> {
  if (await ledgerRowExistsForClientRef(supabase, manifest.creatorId, manifest.id)) return;
  await insertLedgerRow(supabase, {
    creator_id: manifest.creatorId,
    social_account_id: manifest.socialAccountId,
    platform: manifest.platform,
    client_ref: manifest.id,
    provider_request_id: providerRequestId,
  });
}

/* ─────────────────────────────── the edges ────────────────────────────── */

export type AdvanceOutcome =
  | "noop"
  | "advanced"
  | "held"
  | "live"
  | "platform_failed"
  | "failed"
  | "voided";

/** Connected-publish success stamps the post row: posted_api (deliberately
 *  distinct from posted_manual — amendment 3) + the telemetry event. Runs
 *  through the social repository (its single-writer fence). */
async function markPostedApi(deps: PublishTickDeps, manifest: PublishManifest): Promise<void> {
  const nowIso = (deps.nowIso ?? now)();
  try {
    await updatePostStatus(deps.supabase, manifest.socialPostId, "posted_api", nowIso);
    const post = await loadPost(deps.supabase, manifest.socialPostId);
    await emitPublishEvent(deps.supabase, post?.course_id ?? null, "social_post_published_api", {
      postId: manifest.socialPostId,
      manifestId: manifest.id,
      platform: manifest.platform,
    });
  } catch (err) {
    // The manifest's `live` status is the source of truth; the post stamp is
    // derived state — the sweep may retry, never fail the publish on it.
    console.log(
      JSON.stringify({
        tag: "publish_post_stamp_failed",
        manifestId: manifest.id,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      })
    );
  }
}

async function profileRefFor(deps: PublishTickDeps, creatorId: string): Promise<string | null> {
  const profile = await getProviderProfile(deps.supabase, creatorId, deps.provider.id);
  return profile ? decryptSecret(profile.profileRefEnc) : null;
}

async function composedTitleFor(deps: PublishTickDeps, manifest: PublishManifest): Promise<{
  post: PostRow;
  title: string;
} | null> {
  const post = await loadPost(deps.supabase, manifest.socialPostId);
  if (!post) return null;
  return {
    post,
    title: composePublishText({ body: post.body, cta: post.cta, hashtags: post.hashtags ?? [] }),
  };
}

/** queued|held → guards (incl. frozen-source, amendment 2) → the approval-
 *  staleness re-check (amendment 1: content hash vs the CURRENT row —
 *  mismatch VOIDS, it never publishes) → the ONE publish call → refs. */
async function advanceQueued(
  deps: PublishTickDeps,
  manifest: PublishManifest,
  account: SocialAccount
): Promise<AdvanceOutcome> {
  const nowIso = (deps.nowIso ?? now)();

  const composed = await composedTitleFor(deps, manifest);
  if (!composed || composed.post.deleted_at) {
    await transitionPublishManifest(deps.supabase, manifest, manifest.status, "failed", {
      lastError: { message: "post deleted before publish" },
    });
    return "failed";
  }

  const cfg = accountsUsageConfig();
  const counts = await countUploadsThisMonth(deps.supabase, manifest.creatorId, nowIso);
  const decision = evaluatePublishGuards({
    scheduledFor: manifest.scheduledFor,
    nowIso,
    accountStatus: account.status,
    sourceSuperseded: await clipSourceSuperseded(deps.supabase, composed.post),
    uploadsThisMonth: counts.get(manifest.socialAccountId) ?? 0,
    uploadsPerMonth: cfg.uploadsPerMonth,
  });
  if (decision.kind === "not_due") return "noop";
  if (decision.kind === "hold") {
    if (manifest.status === "held" && manifest.holdReason === decision.reason) return "noop";
    if (manifest.status === "held") {
      // reason changed — record it without a state change
      await bumpManifestAttempt(deps.supabase, manifest);
      return "noop";
    }
    await transitionPublishManifest(deps.supabase, manifest, "queued", "held", {
      holdReason: decision.reason,
    });
    return "held";
  }

  // Approval-staleness abort — the belt to the edit-voids suspenders: an
  // edit that raced past the eager void still can't publish stale-approved
  // content. Voided is terminal + trigger-immutable.
  if (contentHashForPost(composed.post) !== manifest.contentHash) {
    await transitionPublishManifest(deps.supabase, manifest, manifest.status, "voided", {
      lastError: { message: "approval voided (approval_stale): the post changed after approval" },
    });
    await voidOpenApprovalsForPost(deps.supabase, manifest.socialPostId, nowIso);
    await emitPublishEvent(deps.supabase, composed.post.course_id, "social_publish_approval_voided", {
      postId: manifest.socialPostId,
      cause: "approval_stale",
      voidedManifests: [manifest.id],
    });
    return "voided";
  }
  const profileRef = await profileRefFor(deps, manifest.creatorId);
  if (!profileRef) {
    await transitionPublishManifest(deps.supabase, manifest, manifest.status, "failed", {
      lastError: { message: "no provider profile for creator" },
    });
    return "failed";
  }

  // Durable marker FIRST (decision 2): the row is in `submitting` before any
  // provider traffic, so a crash is always recoverable — never re-fired.
  const submitting = await transitionPublishManifest(deps.supabase, manifest, manifest.status, "submitting", {
    holdReason: null,
  });

  let video: VideoSource | undefined;
  if (composed.post.post_type === "clip") {
    try {
      video = deps.loadVideoBytes
        ? await deps.loadVideoBytes(composed.post)
        : await defaultLoadVideoBytes(deps.supabase, composed.post);
    } catch (err) {
      await transitionPublishManifest(deps.supabase, submitting, "submitting", "failed", {
        lastError: { message: `video load: ${err instanceof Error ? err.message : String(err)}` },
      });
      return "failed";
    }
  }

  let accepted: PublishAccepted;
  try {
    accepted = await deps.provider.publish({
      profileRef,
      platform: manifest.platform,
      kind: composed.post.post_type === "clip" ? "video" : "text",
      title: composed.title,
      clientRef: manifest.id,
      firstComment: composed.post.first_comment,
      videoBytes: video?.bytes,
      filename: video?.filename,
    });
  } catch (err) {
    if (isPermanentPublishError(err)) {
      // A permanent 4xx means the provider REJECTED the request — nothing
      // was published, so failing here cannot orphan a live post.
      await transitionPublishManifest(deps.supabase, submitting, "submitting", "failed", {
        lastError: { message: err.message.slice(0, 500), permanent: true },
      });
      return "failed";
    }
    // Transient/ambiguous (timeout, 5xx, network): the call may or may not
    // have reached the provider. Leave the row in `submitting` — the next
    // tick runs RECOVERY (adopt-or-fail via history), never a re-fire.
    return "noop";
  }

  if (accepted.platformError !== null) {
    // Accept envelope carrying a per-platform failure (e.g. LinkedIn's
    // duplicate rejection) — decision 4: NO ledger row.
    await transitionPublishManifest(deps.supabase, submitting, "submitting", "platform_failed", {
      lastError: { message: accepted.platformError.slice(0, 500) },
      providerRequestId: accepted.providerRequestId,
    });
    return "platform_failed";
  }

  // Refs are their own durable step IMMEDIATELY after the call returns —
  // the primary crash-recovery handle (decision 2).
  const submitted = await transitionPublishManifest(deps.supabase, submitting, "submitting", "submitted", {
    providerRequestId: accepted.providerRequestId,
    platformPostId: accepted.platformPostId,
    postUrl: accepted.postUrl,
  });
  if (shouldWriteLedgerRow(accepted)) {
    await ensureLedgerRow(deps.supabase, submitted, accepted.providerRequestId);
  }
  return "advanced";
}

/** A row FOUND in `submitting` = a crashed/ambiguous prior run. Adopt refs
 *  from history (conservative match) or fail after grace. NEVER re-fire. */
async function recoverSubmitting(deps: PublishTickDeps, manifest: PublishManifest): Promise<AdvanceOutcome> {
  const composed = await composedTitleFor(deps, manifest);
  const profileRef = await profileRefFor(deps, manifest.creatorId);
  if (composed && profileRef) {
    const recent = await deps.provider.listRecentPosts(profileRef);
    const refs = matchRecentPost(recent, { platform: manifest.platform, title: composed.title });
    if (refs) {
      const submitted = await transitionPublishManifest(deps.supabase, manifest, "submitting", "submitted", {
        providerRequestId: refs.providerRequestId,
        platformPostId: refs.platformPostId,
        postUrl: refs.postUrl,
      });
      // The call evidently reached the provider — the accepted upload gets
      // its ledger row (idempotent).
      await ensureLedgerRow(deps.supabase, submitted, refs.providerRequestId);
      return "advanced";
    }
  }
  if (manifest.attempt + 1 >= RECOVERY_GRACE_ATTEMPTS) {
    await transitionPublishManifest(deps.supabase, manifest, "submitting", "failed", {
      lastError: {
        message:
          "ambiguous submit: the publish call's outcome could not be confirmed — retry creates a new manifest (never re-fired)",
      },
      bumpAttempt: true,
    });
    return "failed";
  }
  await bumpManifestAttempt(deps.supabase, manifest);
  return "noop";
}

async function advanceSubmitted(deps: PublishTickDeps, manifest: PublishManifest): Promise<AdvanceOutcome> {
  // Belt-and-braces: a crash between the submitted transition and the ledger
  // write replays here (idempotent by client_ref).
  await ensureLedgerRow(deps.supabase, manifest, manifest.providerRequestId);
  if (manifest.platformPostId || manifest.postUrl) {
    await transitionPublishManifest(deps.supabase, manifest, "submitted", "live", {});
    await markPostedApi(deps, manifest);
    return "live";
  }
  if (manifest.providerRequestId) {
    await transitionPublishManifest(deps.supabase, manifest, "submitted", "verifying", {});
    return "advanced";
  }
  // Accepted with neither refs nor a request id (never observed live) — the
  // verify budget decides via the same grace counter.
  if (manifest.attempt + 1 >= RECOVERY_GRACE_ATTEMPTS) {
    await transitionPublishManifest(deps.supabase, manifest, "submitted", "failed", {
      lastError: { message: "accepted without refs or request id — unverifiable" },
      bumpAttempt: true,
    });
    return "failed";
  }
  await bumpManifestAttempt(deps.supabase, manifest);
  return "noop";
}

async function advanceVerifying(deps: PublishTickDeps, manifest: PublishManifest): Promise<AdvanceOutcome> {
  const profileRef = await profileRefFor(deps, manifest.creatorId);
  if (!profileRef || !manifest.providerRequestId) {
    await transitionPublishManifest(deps.supabase, manifest, "verifying", "failed", {
      lastError: { message: "verify prerequisites missing" },
    });
    return "failed";
  }
  const verdict = await deps.provider.verifyPost({
    profileRef,
    platform: manifest.platform,
    providerRequestId: manifest.providerRequestId,
  });
  if (verdict.state === "live") {
    await transitionPublishManifest(deps.supabase, manifest, "verifying", "live", {
      platformPostId: verdict.platformPostId ?? manifest.platformPostId,
      postUrl: verdict.postUrl ?? manifest.postUrl,
    });
    await markPostedApi(deps, manifest);
    return "live";
  }
  if (verdict.state === "failed") {
    await transitionPublishManifest(deps.supabase, manifest, "verifying", "platform_failed", {
      lastError: { message: (verdict.error ?? "platform reported failure").slice(0, 500) },
    });
    return "platform_failed";
  }
  if (manifest.attempt + 1 >= VERIFY_MAX_ATTEMPTS) {
    await transitionPublishManifest(deps.supabase, manifest, "verifying", "failed", {
      lastError: { message: "verify budget exhausted (provider never reported a terminal state)" },
      bumpAttempt: true,
    });
    return "failed";
  }
  await bumpManifestAttempt(deps.supabase, manifest);
  return "noop";
}

/** One edge for one manifest. Unexpected errors leave the row where it is —
 *  the next tick retries the same edge (terminal failures only through the
 *  explicit paths above). */
export async function advancePublishManifest(
  deps: PublishTickDeps,
  manifest: PublishManifest
): Promise<AdvanceOutcome> {
  try {
    switch (manifest.status) {
      case "queued":
      case "held": {
        const accounts = await listAccounts(deps.supabase, manifest.creatorId);
        const account = accounts.find((a) => a.id === manifest.socialAccountId);
        if (!account) {
          await transitionPublishManifest(deps.supabase, manifest, manifest.status, "failed", {
            lastError: { message: "connected account row missing" },
          });
          return "failed";
        }
        return await advanceQueued(deps, manifest, account);
      }
      case "submitting":
        return await recoverSubmitting(deps, manifest);
      case "submitted":
        return await advanceSubmitted(deps, manifest);
      case "verifying":
        return await advanceVerifying(deps, manifest);
      default:
        return "noop";
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        tag: "publish_step_error",
        manifestId: manifest.id,
        status: manifest.status,
        error: err instanceof Error ? err.message.slice(0, 300) : String(err),
      })
    );
    return "noop";
  }
}

/* ─────────────────────────────── the tick ─────────────────────────────── */

export interface PublishTickResult {
  processed: number;
  advanced: number;
  live: number;
  held: number;
  platformFailed: number;
  failed: number;
  voided: number;
}

/** One pass over active manifests (the scheduler-tick entry point). */
export async function processPublishTick(
  deps: PublishTickDeps,
  opts: { limit?: number; creatorId?: string } = {}
): Promise<PublishTickResult> {
  const manifests = await listActivePublishManifests(deps.supabase, opts.limit ?? 25, opts.creatorId);
  const result: PublishTickResult = {
    processed: 0,
    advanced: 0,
    live: 0,
    held: 0,
    platformFailed: 0,
    failed: 0,
    voided: 0,
  };
  for (const manifest of manifests) {
    result.processed++;
    const outcome = await advancePublishManifest(deps, manifest);
    if (outcome === "advanced") result.advanced++;
    else if (outcome === "live") result.live++;
    else if (outcome === "held") result.held++;
    else if (outcome === "platform_failed") result.platformFailed++;
    else if (outcome === "failed") result.failed++;
    else if (outcome === "voided") result.voided++;
  }
  return result;
}

/* ───────────────────────── cancel / reschedule ────────────────────────── */

export type CancelPublishResult =
  | { cancelled: true; manifest: PublishManifest }
  | { cancelled: false; reason: "not_found" | "already_terminal" | "past_submission" };

/**
 * Cancel — legal only while queued/held. Once `submitting` begins there is
 * no recall (decision 1: the provider has no delete/unpublish) — the refusal
 * is honest, not best-effort.
 */
export async function cancelPublishManifest(
  supabase: DB,
  manifestId: string
): Promise<CancelPublishResult> {
  const manifest = await getPublishManifest(supabase, manifestId);
  if (!manifest) return { cancelled: false, reason: "not_found" };
  if (manifest.status === "queued" || manifest.status === "held") {
    const cancelled = await transitionPublishManifest(supabase, manifest, manifest.status, "cancelled", {});
    // Release the durable fire function's sleep (cancel-by-event).
    const { sendPublishReleased } = await import("@/lib/inngest/publishEvents");
    await sendPublishReleased(manifest.id);
    return { cancelled: true, manifest: cancelled };
  }
  if (
    manifest.status === "live" ||
    manifest.status === "failed" ||
    manifest.status === "platform_failed" ||
    manifest.status === "cancelled" ||
    manifest.status === "voided"
  ) {
    return { cancelled: false, reason: "already_terminal" };
  }
  return { cancelled: false, reason: "past_submission" };
}

/* ─────────────── retry (amendment: approval-linked clone) ─────────────── */

export type RetryPublishResult =
  | { ok: true; manifest: PublishManifest }
  | { ok: false; reason: "not_found" | "not_retryable" | "needs_fresh_card" };

/**
 * Retry a transiently-failed publish WITHOUT a fresh card: legal only from
 * `failed` (ambiguous submit / verify timeout — platform_failed needs an
 * edit, which voids, which re-cards). The clone rides a SYSTEM approval
 * (kind='retry', born consumed, chained to the human card approval), valid
 * only while the content hash still matches the current post.
 */
export async function retryPublishManifest(
  supabase: DB,
  creatorId: string,
  manifestId: string,
  nowIso = now()
): Promise<RetryPublishResult> {
  const manifest = await getPublishManifest(supabase, manifestId);
  if (!manifest || manifest.creatorId !== creatorId) return { ok: false, reason: "not_found" };
  if (!canRetryManifest(manifest.status)) return { ok: false, reason: "not_retryable" };
  const post = await loadPost(supabase, manifest.socialPostId);
  if (!post || post.deleted_at || contentHashForPost(post) !== manifest.contentHash) {
    return { ok: false, reason: "needs_fresh_card" };
  }
  const original = await getApproval(supabase, manifest.approvalId);
  const retryApproval = await createApprovalRequest(supabase, {
    creatorId,
    socialPostId: manifest.socialPostId,
    socialAccountId: manifest.socialAccountId,
    platform: manifest.platform,
    contentHash: manifest.contentHash,
    kind: "retry",
    requestedBy: original?.requestedBy ?? "creator",
    parentApprovalId: original?.parentApprovalId ?? manifest.approvalId,
    consumedAt: nowIso,
  });
  const clone = await createPublishManifest(supabase, {
    creatorId,
    socialPostId: manifest.socialPostId,
    socialAccountId: manifest.socialAccountId,
    platform: manifest.platform,
    approvalId: retryApproval.id,
    contentHash: manifest.contentHash,
    scheduledFor: null,
  });
  const { sendPublishRequested } = await import("@/lib/inngest/publishEvents");
  await sendPublishRequested({ manifestId: clone.id, creatorId, scheduledFor: null });
  return { ok: true, manifest: clone };
}

/* ───────────── reschedule (fresh sleep via cancel-by-event) ───────────── */

export async function reschedulePublishAndRefire(
  supabase: DB,
  creatorId: string,
  manifest: Pick<PublishManifest, "id" | "version" | "status" | "creatorId">,
  scheduledFor: string | null
): Promise<PublishManifest> {
  if (manifest.creatorId !== creatorId) throw new Error("reschedule: not the manifest owner");
  const { reschedulePublishManifest } = await import("./manifestRepository");
  const updated = await reschedulePublishManifest(supabase, manifest, scheduledFor);
  const { sendPublishReleased, sendPublishRequested } = await import("@/lib/inngest/publishEvents");
  await sendPublishReleased(updated.id); // kill the old sleep
  await sendPublishRequested({ manifestId: updated.id, creatorId, scheduledFor: updated.scheduledFor });
  return updated;
}

/* ───────────────── unpublish valve (honest refusal form) ──────────────── */

export type UnpublishLocallyResult =
  | {
      ok: true;
      postUrl: string | null;
      platform: PublishManifest["platform"];
    }
  | { ok: false; reason: "not_found" | "not_published_api" };

/**
 * Marks a connected-published post unpublished LOCALLY and records the
 * honest state: the platform copy REMAINS LIVE (Task 0a: no provider
 * deletion API exists — zero provider calls happen here, guaranteed by
 * construction: this function has no provider dependency at all). The card
 * surfaces the platform link + per-platform manual-deletion guidance.
 */
export async function unpublishLocally(
  supabase: DB,
  creatorId: string,
  socialPostId: string,
  nowIso = now()
): Promise<UnpublishLocallyResult> {
  const post = await loadPost(supabase, socialPostId);
  if (!post || post.creator_id !== creatorId) return { ok: false, reason: "not_found" };
  if (post.status !== "posted_api") return { ok: false, reason: "not_published_api" };
  const manifests = await listPublishManifestsForPost(supabase, socialPostId);
  const live = manifests.find((m) => m.status === "live");
  await updatePostStatus(supabase, socialPostId, "unpublished_local", nowIso);
  await emitPublishEvent(supabase, post.course_id, "social_post_unpublished_local", {
    postId: socialPostId,
    manifestId: live?.id ?? null,
    platform: live?.platform ?? null,
    platformCopyRemainsLive: true,
  });
  return { ok: true, postUrl: live?.postUrl ?? null, platform: live?.platform ?? "linkedin" };
}
