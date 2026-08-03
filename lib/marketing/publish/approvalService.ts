/**
 * Approval token flow (M-C, the card-SOLE-path) — SERVER ONLY.
 *
 *   requestPublishCard  → validates the target (same matrix as M-B's
 *                         requestPublish, PLUS the frozen-source fence) and
 *                         files an approval request. No token yet.
 *   mintCardToken       → at CARD RENDER: single-use token (plaintext
 *                         returned once, sha256 stored), 15-min expiry;
 *                         re-render re-mints; content drift at mint voids +
 *                         refuses (a stale card is never shown).
 *   approvePublishCard  → atomic token consume → content hash re-validated →
 *                         manifest created (the ONLY requestPublish caller)
 *                         → the durable fire event. Every failure is typed.
 *   rejectPublishCard   → declines; the post stays `ready`.
 *
 * AC-MC.1's enforcement points: token replay/expiry lose inside
 * consumeByTokenHash's guarded UPDATE; a foreign token can't consume (RLS +
 * creator check); createPublishManifest refuses without an approval id and
 * the DB backs it (NOT NULL + UNIQUE approval_id).
 */

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import {
  APPROVAL_TOKEN_TTL_MINUTES,
  postPlatformToPublishPlatform,
  PROVEN_PUBLISH_PLATFORMS,
} from "./manifest";
import { contentHashForPost } from "./contentHash";
import { clipSourceSuperseded } from "./sourceCheck";
import { listAccounts } from "@/lib/marketing/accounts/accountsRepository";
import {
  createApprovalRequest,
  consumeByTokenHash,
  declineApproval,
  getApproval,
  stampMintedToken,
  voidOpenApprovalsForPost,
  type PublishApproval,
} from "./approvalRepository";
import { requestPublish } from "./publishService";
import type { PublishManifest } from "./manifestRepository";
import { emitPublishEvent } from "./events";

type DB = SupabaseClient<Database>;
type PostRow = Database["public"]["Tables"]["social_post"]["Row"];

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const now = () => new Date().toISOString();

export type CardRefusalReason =
  | "post_not_found"
  | "post_deleted"
  | "clip_missing_video"
  | "platform_unmapped"
  | "platform_not_yet_publishable"
  | "account_not_found"
  | "platform_mismatch"
  | "account_not_linked"
  | "source_superseded";

async function loadPost(supabase: DB, id: string): Promise<PostRow | null> {
  const { data, error } = await supabase.from("social_post").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`card post read: ${error.message}`);
  return data;
}

async function validateTarget(
  supabase: DB,
  creatorId: string,
  socialPostId: string,
  socialAccountId: string
): Promise<
  | { ok: true; post: PostRow; platform: PublishApproval["platform"] }
  | { ok: false; reason: CardRefusalReason }
> {
  const post = await loadPost(supabase, socialPostId);
  if (!post || post.creator_id !== creatorId) return { ok: false, reason: "post_not_found" };
  if (post.deleted_at) return { ok: false, reason: "post_deleted" };
  if (post.post_type === "clip" && !post.video_path) return { ok: false, reason: "clip_missing_video" };
  const platform = postPlatformToPublishPlatform(post.platform);
  if (!platform) return { ok: false, reason: "platform_unmapped" };
  if (!PROVEN_PUBLISH_PLATFORMS.includes(platform)) {
    return { ok: false, reason: "platform_not_yet_publishable" };
  }
  const account = (await listAccounts(supabase, creatorId)).find((a) => a.id === socialAccountId);
  if (!account) return { ok: false, reason: "account_not_found" };
  if (account.platform !== platform) return { ok: false, reason: "platform_mismatch" };
  if (account.status !== "linked") return { ok: false, reason: "account_not_linked" };
  // AC-MC.7 (amendment 2): the frozen-source fence runs at request AND mint.
  if (await clipSourceSuperseded(supabase, post)) return { ok: false, reason: "source_superseded" };
  return { ok: true, post, platform };
}

export type RequestCardResult =
  | { ok: true; approval: PublishApproval }
  | { ok: false; reason: CardRefusalReason };

export async function requestPublishCard(
  supabase: DB,
  creatorId: string,
  input: {
    socialPostId: string;
    socialAccountId: string;
    proposedScheduledFor?: string | null;
    requestedBy?: "creator" | "agent";
    /** M-AG: chat-filed cards carry their conversation for the follow-up
     *  resume. Non-chat surfaces omit it. */
    conversationId?: string | null;
  }
): Promise<RequestCardResult> {
  const target = await validateTarget(supabase, creatorId, input.socialPostId, input.socialAccountId);
  if (!target.ok) return target;
  const approval = await createApprovalRequest(supabase, {
    creatorId,
    socialPostId: input.socialPostId,
    socialAccountId: input.socialAccountId,
    platform: target.platform,
    contentHash: contentHashForPost(target.post),
    kind: "card",
    requestedBy: input.requestedBy ?? "creator",
    proposedScheduledFor: input.proposedScheduledFor ?? null,
    conversationId: input.conversationId ?? null,
  });
  return { ok: true, approval };
}

export type MintResult =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; reason: CardRefusalReason | "approval_not_open" | "approval_stale" };

/** Mint the card's single-use token AT RENDER. The plaintext token exists
 *  only in this response; only its sha256 is stored. */
export async function mintCardToken(
  supabase: DB,
  creatorId: string,
  approvalId: string,
  nowIso = now()
): Promise<MintResult> {
  const approval = await getApproval(supabase, approvalId);
  if (!approval || approval.creatorId !== creatorId) return { ok: false, reason: "approval_not_open" };
  if (approval.consumedAt || approval.declinedAt || approval.voidedAt) {
    return { ok: false, reason: "approval_not_open" };
  }
  const target = await validateTarget(
    supabase,
    creatorId,
    approval.socialPostId,
    approval.socialAccountId
  );
  if (!target.ok) return { ok: false, reason: target.reason };
  if (contentHashForPost(target.post) !== approval.contentHash) {
    // The post changed since the card was requested — a stale card must
    // never be shown, let alone approved.
    await voidOpenApprovalsForPost(supabase, approval.socialPostId, nowIso);
    return { ok: false, reason: "approval_stale" };
  }
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(
    new Date(nowIso).getTime() + APPROVAL_TOKEN_TTL_MINUTES * 60_000
  ).toISOString();
  const stamped = await stampMintedToken(supabase, approvalId, sha256(token), nowIso, expiresAt);
  if (!stamped) return { ok: false, reason: "approval_not_open" };
  return { ok: true, token, expiresAt };
}

export type ApproveCardResult =
  | { ok: true; manifest: PublishManifest }
  | {
      ok: false;
      reason: "invalid_or_expired_token" | "approval_stale" | CardRefusalReason;
    };

/** THE approve — consumes the token exactly once and is the sole caller of
 *  requestPublish (grep-fenced). */
export async function approvePublishCard(
  supabase: DB,
  creatorId: string,
  token: string,
  opts: { scheduledFor?: string | null } = {},
  nowIso = now()
): Promise<ApproveCardResult> {
  const approval = await consumeByTokenHash(supabase, sha256(token), nowIso);
  if (!approval || approval.creatorId !== creatorId) {
    return { ok: false, reason: "invalid_or_expired_token" };
  }
  const target = await validateTarget(
    supabase,
    creatorId,
    approval.socialPostId,
    approval.socialAccountId
  );
  if (!target.ok) return { ok: false, reason: target.reason };
  if (contentHashForPost(target.post) !== approval.contentHash) {
    await voidOpenApprovalsForPost(supabase, approval.socialPostId, nowIso);
    return { ok: false, reason: "approval_stale" };
  }
  const scheduledFor = opts.scheduledFor ?? approval.proposedScheduledFor ?? null;
  const effectiveSchedule = scheduledFor && scheduledFor > nowIso ? scheduledFor : null;
  const manifest = await requestPublish(supabase, creatorId, approval, effectiveSchedule);
  await emitPublishEvent(supabase, target.post.course_id, "social_publish_card_approved", {
    approvalId: approval.id,
    manifestId: manifest.id,
    postId: approval.socialPostId,
    platform: approval.platform,
    scheduledFor: effectiveSchedule,
  });
  const { sendPublishRequested } = await import("@/lib/inngest/publishEvents");
  await sendPublishRequested({
    manifestId: manifest.id,
    creatorId,
    scheduledFor: effectiveSchedule,
  });
  return { ok: true, manifest };
}

export async function rejectPublishCard(
  supabase: DB,
  creatorId: string,
  approvalId: string,
  nowIso = now()
): Promise<{ ok: boolean }> {
  const approval = await getApproval(supabase, approvalId);
  if (!approval || approval.creatorId !== creatorId) return { ok: false };
  const declined = await declineApproval(supabase, approvalId, nowIso);
  if (declined) {
    const post = await loadPost(supabase, approval.socialPostId);
    await emitPublishEvent(supabase, post?.course_id ?? null, "social_publish_card_rejected", {
      approvalId,
      postId: approval.socialPostId,
      platform: approval.platform,
    });
  }
  return { ok: declined };
}
