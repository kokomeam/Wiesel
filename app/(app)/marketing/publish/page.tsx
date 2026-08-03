/**
 * Publish review (M-C) — the preview-then-decide surface. The card payload
 * is assembled HERE with the SAME composePublishText the workflow sends to
 * the provider (AC-MC.2 byte-identity by construction: one function, one
 * call site each), one single-use token minted per open approval AT RENDER
 * (AC-MC.3: N cards = N independent tokens), clip video via a short-lived
 * signed URL. This route (+ components/marketing/publish/) is the ONE
 * surface where publish/schedule vocabulary is allowed (AC-MC.4).
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { listOpenApprovals } from "@/lib/marketing/publish/approvalRepository";
import { listRecentPublishManifests } from "@/lib/marketing/publish/manifestRepository";
import { assembleCardPayload } from "@/lib/marketing/publish/cardPayload";
import { MANUAL_DELETE_GUIDANCE } from "@/lib/marketing/publish/cardCopy";
import { listAccounts } from "@/lib/marketing/accounts/accountsRepository";
import { PLATFORM_LABELS } from "@/lib/marketing/accounts/constants";
import {
  PublishReviewView,
} from "@/components/marketing/publish/PublishReviewView";
import { DevInngestBanner } from "@/components/marketing/social/connected/PublishStates";
import type { PublishCardPayload } from "@/components/marketing/publish/PublishApprovalCard";

export const dynamic = "force-dynamic";

export default async function PublishReviewPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [approvals, manifests, accounts] = await Promise.all([
    listOpenApprovals(supabase, user.id),
    listRecentPublishManifests(supabase, user.id, 20),
    listAccounts(supabase, user.id),
  ]);
  const postIds = [
    ...new Set([
      ...approvals.map((a) => a.socialPostId),
      ...manifests.map((m) => m.socialPostId),
    ]),
  ];
  const { data: postRows } = postIds.length
    ? await supabase.from("social_post").select("*").in("id", postIds)
    : { data: [] };
  const postById = new Map((postRows ?? []).map((p) => [p.id, p]));

  // ONE assembly path (lib/marketing/publish/cardPayload.ts) shared with the
  // queue/editor modal — same component, same composition (M-D answer 1).
  const cards: PublishCardPayload[] = [];
  for (const approval of approvals) {
    const post = postById.get(approval.socialPostId);
    if (!post) continue;
    const payload = await assembleCardPayload(supabase, user.id, approval, post, accounts);
    if (payload) cards.push(payload);
  }

  const manifestRows = manifests.map((m) => {
    const post = postById.get(m.socialPostId);
    const err = m.lastError as { message?: string } | null;
    return {
      id: m.id,
      status: m.status,
      platform: PLATFORM_LABELS[m.platform],
      postExcerpt: (post?.body ?? "").slice(0, 80),
      scheduledFor: m.scheduledFor,
      holdReason: m.holdReason,
      postUrl: m.postUrl,
      errorMessage: err?.message?.slice(0, 140) ?? null,
    };
  });

  // Unpublish confirm cards: posts currently posted_api.
  const { data: publishedRows } = await supabase
    .from("social_post")
    .select("*")
    .eq("creator_id", user.id)
    .eq("status", "posted_api")
    .is("deleted_at", null)
    .limit(10);
  const liveByPost = new Map(
    manifests.filter((m) => m.status === "live").map((m) => [m.socialPostId, m])
  );
  const unpublishables = (publishedRows ?? []).map((p) => {
    const live = liveByPost.get(p.id);
    const platform = live?.platform ?? "linkedin";
    return {
      postId: p.id,
      excerpt: p.body.slice(0, 80),
      platform: PLATFORM_LABELS[platform],
      postUrl: live?.postUrl ?? null,
      guidance: MANUAL_DELETE_GUIDANCE[platform],
    };
  });

  // New-card form options: publishable posts (ready/planned, linkedin or
  // youtube_shorts) × linked accounts on proven platforms.
  const { data: readyRows } = await supabase
    .from("social_post")
    .select("id,body,platform,post_type,video_path")
    .eq("creator_id", user.id)
    .in("status", ["ready", "planned"])
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(25);
  const postOptions = (readyRows ?? [])
    .filter(
      (p) =>
        (p.platform === "linkedin" || p.platform === "youtube_shorts") &&
        (p.post_type !== "clip" || p.video_path)
    )
    .map((p) => ({ id: p.id, label: `${p.platform === "linkedin" ? "LinkedIn" : "YouTube"} · ${p.body.slice(0, 48)}` }));
  const accountOptions = accounts
    .filter((a) => a.status === "linked" && (a.platform === "linkedin" || a.platform === "youtube"))
    .map((a) => ({ id: a.id, label: `${PLATFORM_LABELS[a.platform]} — ${a.displayName ?? a.handle ?? "account"}` }));

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href="/marketing"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-stone-500 hover:text-stone-800"
        >
          <ArrowLeft className="size-3.5" /> Marketing
        </Link>
      </div>
      <PageHeader
        title="Publish review"
        description="Every publish goes through one of these cards — you see exactly what ships, where, and when, and decide per post. LinkedIn and YouTube for now."
      />
      <div className="mt-6 space-y-4">
        <DevInngestBanner />
        <PublishReviewView
          cards={cards}
          manifests={manifestRows}
          unpublishables={unpublishables}
          postOptions={postOptions}
          accountOptions={accountOptions}
        />
      </div>
    </div>
  );
}
