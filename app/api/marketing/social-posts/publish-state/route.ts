/**
 * Publish-state for the queue (M-D) — per-post manifest + open-approval
 * summaries plus the creator's connected accounts, so PostQueue can render
 * scheduled/held/failed/live chips and the editor can offer health-aware
 * account picking. READ ONLY — every mutation stays on the M-C paths
 * (AC-MD.2: this route creates nothing).
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listRecentPublishManifests } from "@/lib/marketing/publish/manifestRepository";
import { listOpenApprovals } from "@/lib/marketing/publish/approvalRepository";
import { listAccounts } from "@/lib/marketing/accounts/accountsRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const [manifests, approvals, accounts] = await Promise.all([
    listRecentPublishManifests(supabase, user.id, 100),
    listOpenApprovals(supabase, user.id),
    listAccounts(supabase, user.id),
  ]);

  return NextResponse.json({
    manifests: manifests.map((m) => ({
      id: m.id,
      postId: m.socialPostId,
      accountId: m.socialAccountId,
      platform: m.platform,
      status: m.status,
      scheduledFor: m.scheduledFor,
      holdReason: m.holdReason,
      postUrl: m.postUrl,
      platformPostId: m.platformPostId,
      approvalId: m.approvalId,
      attempt: m.attempt,
      lastError: (m.lastError as { message?: string } | null)?.message ?? null,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      version: m.version,
    })),
    approvals: approvals.map((a) => ({
      id: a.id,
      postId: a.socialPostId,
      accountId: a.socialAccountId,
      platform: a.platform,
      kind: a.kind,
      requestedBy: a.requestedBy,
      proposedScheduledFor: a.proposedScheduledFor,
      parentApprovalId: a.parentApprovalId,
      createdAt: a.createdAt,
    })),
    accounts: accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      status: a.status,
      displayName: a.displayName,
      handle: a.handle,
    })),
  });
}
