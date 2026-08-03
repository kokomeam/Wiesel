"use server";

/**
 * Publish-review server actions (M-C) — the ONLY UI writes into the
 * governance flow. Approve consumes the card token (single-use, server-
 * enforced); everything returns typed results the card renders inline
 * (the agent-chat precedent: no toast layer here).
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  approvePublishCard,
  mintCardToken,
  rejectPublishCard,
  requestPublishCard,
} from "@/lib/marketing/publish/approvalService";
import {
  cancelPublishManifest,
  reschedulePublishAndRefire,
  retryPublishManifest,
  unpublishLocally,
} from "@/lib/marketing/publish/publishService";
import { getPublishManifest } from "@/lib/marketing/publish/manifestRepository";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("not signed in");
  return { supabase, userId: user.id };
}

const REVIEW_PATH = "/marketing/publish";

export async function requestCardAction(input: {
  socialPostId: string;
  socialAccountId: string;
  proposedScheduledFor: string | null;
}) {
  const { supabase, userId } = await requireUser();
  const res = await requestPublishCard(supabase, userId, {
    ...input,
    requestedBy: "creator",
  });
  revalidatePath(REVIEW_PATH);
  return res.ok ? { ok: true as const } : { ok: false as const, reason: res.reason };
}

export async function approveCardAction(token: string, scheduledFor: string | null) {
  const { supabase, userId } = await requireUser();
  const res = await approvePublishCard(supabase, userId, token, { scheduledFor });
  revalidatePath(REVIEW_PATH);
  if (!res.ok) return { ok: false as const, reason: res.reason };
  return {
    ok: true as const,
    manifestId: res.manifest.id,
    scheduledFor: res.manifest.scheduledFor,
  };
}

export async function rejectCardAction(approvalId: string) {
  const { supabase, userId } = await requireUser();
  const res = await rejectPublishCard(supabase, userId, approvalId);
  revalidatePath(REVIEW_PATH);
  return res;
}

/** Re-mint on demand (a card whose token expired mid-review). */
export async function remintTokenAction(approvalId: string) {
  const { supabase, userId } = await requireUser();
  return mintCardToken(supabase, userId, approvalId);
}

export async function cancelManifestAction(manifestId: string) {
  const { supabase, userId } = await requireUser();
  const manifest = await getPublishManifest(supabase, manifestId);
  if (!manifest || manifest.creatorId !== userId) return { cancelled: false as const, reason: "not_found" as const };
  const res = await cancelPublishManifest(supabase, manifestId);
  revalidatePath(REVIEW_PATH);
  return res.cancelled ? { cancelled: true as const } : { cancelled: false as const, reason: res.reason };
}

export async function rescheduleManifestAction(manifestId: string, scheduledFor: string | null) {
  const { supabase, userId } = await requireUser();
  const manifest = await getPublishManifest(supabase, manifestId);
  if (!manifest || manifest.creatorId !== userId) return { ok: false as const, reason: "not_found" };
  try {
    await reschedulePublishAndRefire(supabase, userId, manifest, scheduledFor);
    revalidatePath(REVIEW_PATH);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, reason: err instanceof Error ? err.message : "reschedule failed" };
  }
}

export async function retryManifestAction(manifestId: string) {
  const { supabase, userId } = await requireUser();
  const res = await retryPublishManifest(supabase, userId, manifestId);
  revalidatePath(REVIEW_PATH);
  return res.ok ? { ok: true as const, manifestId: res.manifest.id } : { ok: false as const, reason: res.reason };
}

/** M-D: request-and-assemble for the queue/editor modal — the SAME card,
 *  the SAME assembly (lib/marketing/publish/cardPayload.ts). Creates nothing
 *  beyond the M-C approval request path (AC-MD.2). */
export async function openCardAction(input: {
  socialPostId: string;
  socialAccountId: string;
  proposedScheduledFor: string | null;
}) {
  const { supabase, userId } = await requireUser();
  const res = await requestPublishCard(supabase, userId, { ...input, requestedBy: "creator" });
  if (!res.ok) return { ok: false as const, reason: res.reason };
  const { data: post } = await supabase
    .from("social_post")
    .select("*")
    .eq("id", input.socialPostId)
    .single();
  if (!post) return { ok: false as const, reason: "post_not_found" as const };
  const { assembleCardPayload } = await import("@/lib/marketing/publish/cardPayload");
  const payload = await assembleCardPayload(supabase, userId, res.approval, post);
  if (!payload) return { ok: false as const, reason: "account_not_found" as const };
  revalidatePath(REVIEW_PATH);
  return { ok: true as const, card: payload };
}

/** M-D: the posted_api history drawer's data (manifest chain + approval
 *  lineage incl. retry parents). READ ONLY. */
export async function manifestHistoryAction(postId: string) {
  const { supabase } = await requireUser();
  const { listPublishManifestsForPost } = await import("@/lib/marketing/publish/manifestRepository");
  const { listApprovalsForPost } = await import("@/lib/marketing/publish/approvalRepository");
  const [manifests, approvals] = await Promise.all([
    listPublishManifestsForPost(supabase, postId),
    listApprovalsForPost(supabase, postId),
  ]);
  return {
    manifests: manifests.map((m) => ({
      id: m.id,
      status: m.status,
      platform: m.platform,
      approvalId: m.approvalId,
      scheduledFor: m.scheduledFor,
      holdReason: m.holdReason,
      postUrl: m.postUrl,
      platformPostId: m.platformPostId,
      providerRequestId: m.providerRequestId,
      attempt: m.attempt,
      lastError: (m.lastError as { message?: string } | null)?.message ?? null,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })),
    approvals: approvals.map((a) => ({
      id: a.id,
      kind: a.kind,
      requestedBy: a.requestedBy,
      parentApprovalId: a.parentApprovalId,
      consumedAt: a.consumedAt,
      declinedAt: a.declinedAt,
      voidedAt: a.voidedAt,
      createdAt: a.createdAt,
    })),
  };
}

/** The unpublish valve's CONFIRM (the rendered confirm card is the card —
 *  the agent path goes through the hard-denied gate tool instead). */
export async function unpublishConfirmedAction(postId: string) {
  const { supabase, userId } = await requireUser();
  const res = await unpublishLocally(supabase, userId, postId);
  revalidatePath(REVIEW_PATH);
  return res;
}
