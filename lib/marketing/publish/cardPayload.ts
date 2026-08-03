/**
 * Card payload assembly — SERVER ONLY, the ONE place a PublishApprovalCard's
 * content is built (M-D answer 1: queue/editor modals and the review page
 * render the SAME card from the SAME assembly; no forked composition). Text
 * comes from composePublishText — the byte-identity anchor (AC-MC.2); the
 * token is minted here (AT RENDER semantics hold for modals too); clip video
 * is admin-signed after the caller's own RLS read proved ownership.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { composePublishText, FIRST_COMMENT_SUPPORT } from "./manifest";
import { mintCardToken } from "./approvalService";
import { getApproval, type PublishApproval } from "./approvalRepository";
import { listAccounts } from "@/lib/marketing/accounts/accountsRepository";
import { PLATFORM_LABELS } from "@/lib/marketing/accounts/constants";

type DB = SupabaseClient<Database>;
type PostRow = Database["public"]["Tables"]["social_post"]["Row"];

export interface AssembledCardPayload {
  approvalId: string;
  token: string | null;
  tokenExpiresAt: string | null;
  finalText: string;
  firstComment: string | null;
  firstCommentSupport: "proven" | "unverified";
  platform: string;
  platformLabel: string;
  accountName: string | null;
  accountHandle: string | null;
  avatarUrl: string | null;
  proposedScheduledFor: string | null;
  videoUrl: string | null;
  requestedBy: "creator" | "agent";
}

export async function assembleCardPayload(
  supabase: DB,
  creatorId: string,
  approval: PublishApproval,
  post: PostRow,
  accounts?: Awaited<ReturnType<typeof listAccounts>>
): Promise<AssembledCardPayload | null> {
  const accountList = accounts ?? (await listAccounts(supabase, creatorId));
  const account = accountList.find((a) => a.id === approval.socialAccountId);
  if (!account) return null;
  const mint = await mintCardToken(supabase, creatorId, approval.id);
  let videoUrl: string | null = null;
  if (post.post_type === "clip" && post.video_path && isAdminConfigured()) {
    const { data: signed } = await createAdminClient()
      .storage.from("clip-media")
      .createSignedUrl(post.video_path, 1800);
    videoUrl = signed?.signedUrl ?? null;
  }
  return {
    approvalId: approval.id,
    token: mint.ok ? mint.token : null,
    tokenExpiresAt: mint.ok ? mint.expiresAt : null,
    finalText: composePublishText({ body: post.body, cta: post.cta, hashtags: post.hashtags ?? [] }),
    firstComment: post.first_comment,
    firstCommentSupport: FIRST_COMMENT_SUPPORT[approval.platform],
    platform: approval.platform,
    platformLabel: PLATFORM_LABELS[approval.platform],
    accountName: account.displayName,
    accountHandle: account.handle,
    avatarUrl: account.avatarUrl,
    proposedScheduledFor: approval.proposedScheduledFor,
    videoUrl,
    requestedBy: approval.requestedBy,
  };
}

/**
 * M-AG: assemble payloads for freshly-FILED approvals (the chat inline
 * render). Same assembly, batched — skips anything not the caller's, already
 * decided, or unassemblable; the review page remains the durable home for
 * whatever chat couldn't show.
 */
export async function assembleCardPayloadsForApprovals(
  supabase: DB,
  creatorId: string,
  approvalIds: string[]
): Promise<AssembledCardPayload[]> {
  if (!approvalIds.length) return [];
  const accounts = await listAccounts(supabase, creatorId);
  const out: AssembledCardPayload[] = [];
  for (const id of approvalIds) {
    const approval = await getApproval(supabase, id);
    if (!approval || approval.creatorId !== creatorId) continue;
    if (approval.consumedAt || approval.declinedAt || approval.voidedAt) continue;
    const { data: post } = await supabase
      .from("social_post")
      .select("*")
      .eq("id", approval.socialPostId)
      .maybeSingle();
    if (!post) continue;
    const payload = await assembleCardPayload(supabase, creatorId, approval, post, accounts);
    if (payload) out.push(payload);
  }
  return out;
}
