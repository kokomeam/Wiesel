/**
 * M-AG publish operations — the agent's READ + ACT surface onto the connected
 * publishing runtime, closing the gap the M-C prompt left open (it told the
 * agent to check posted_api and "offer the retry" with no backing tools).
 *
 * THE INVARIANT HOLDS: nothing here publishes. The two reads are pure lookups;
 * retry_publish re-fires an ALREADY card-approved run via the A2 clone
 * (content byte-identical, approval lineage preserved — no new publish card),
 * and cancel_scheduled_publish stops a queued/held run. Both act tools are
 * IRREVERSIBLE-tier (a gate card in manual/assisted; policy-routable in auto)
 * but deliberately NOT hard-denied: unlike publish/schedule they never put
 * NEW content in front of an audience — retry re-fires approved bytes, cancel
 * is the safe direction. A manifest is still born exclusively inside
 * approvalService.approvePublishCard.
 */

import { z } from "zod";
import { defineMarketingTool } from "./types";
import { listAccounts } from "@/lib/marketing/accounts/accountsRepository";
import { accountsUsage } from "@/lib/marketing/accounts/accountsService";
import { PLATFORM_LABELS } from "@/lib/marketing/accounts/constants";
import {
  canRetryManifest,
  PROVEN_PUBLISH_PLATFORMS,
} from "@/lib/marketing/publish/manifest";
import {
  listOpenApprovals,
  listApprovalsForPost,
  type PublishApproval,
} from "@/lib/marketing/publish/approvalRepository";
import {
  getPublishManifest,
  listPublishManifestsForPost,
  listRecentPublishManifests,
  type PublishManifest,
} from "@/lib/marketing/publish/manifestRepository";
import {
  cancelPublishManifest,
  retryPublishManifest,
} from "@/lib/marketing/publish/publishService";

/** Human explanations for manifest hold reasons — what's wrong AND how it
 *  heals (the queue chips' copy, restated for the agent to relay). */
const HOLD_EXPLANATIONS: Record<string, string> = {
  account_not_linked:
    "the destination account needs re-linking (Connected accounts page); the run self-heals and fires once it is linked again",
  source_superseded:
    "the source lesson was re-recorded after this clip was rendered — render a fresh clip; this run will not fire",
  quota_exceeded:
    "the monthly upload quota is used up; the run self-heals when the month rolls over (or the cap is raised)",
  send_window:
    "held by a legacy send-window rule from before card fire times became authoritative",
};

function compactManifest(m: PublishManifest) {
  const err = m.lastError as { message?: string } | null;
  return {
    manifestId: m.id,
    postId: m.socialPostId,
    platform: m.platform,
    status: m.status,
    scheduledFor: m.scheduledFor,
    holdReason: m.holdReason,
    holdExplanation: m.holdReason ? (HOLD_EXPLANATIONS[m.holdReason] ?? m.holdReason) : null,
    postUrl: m.postUrl,
    attempt: m.attempt,
    error: err?.message?.slice(0, 140) ?? null,
    /** Retry is legal ONLY from transient `failed` (platform_failed needs an
     *  edit → fresh card; everything else is not a failure). */
    retryable: canRetryManifest(m.status),
    cancellable: m.status === "queued" || m.status === "held",
    updatedAt: m.updatedAt,
  };
}

function compactOpenApproval(a: PublishApproval) {
  return {
    approvalId: a.id,
    postId: a.socialPostId,
    platform: a.platform,
    proposedScheduledFor: a.proposedScheduledFor,
    requestedBy: a.requestedBy,
    createdAt: a.createdAt,
  };
}

const getConnectedAccounts = defineMarketingTool({
  name: "get_connected_accounts",
  description:
    "List the creator's connected social accounts: id, platform, health (linked/expired/revoked), handle, and this month's upload usage. Call this BEFORE publish_social_post / schedule_social_post / propose_publish_plan — those tools need an accountId from here. publishableNow=true means linked AND on a proven platform (LinkedIn/YouTube today).",
  params: z.object({}),
  reversibility: "read",
  async execute(_args, ctx) {
    const accounts = await listAccounts(ctx.supabase, ctx.ownerId);
    const usage = await accountsUsage(ctx.supabase, ctx.ownerId, accounts, ctx.services.clock.now());
    const usageByAccount = new Map(usage.map((u) => [u.accountId, u]));
    const mapped = accounts.map((a) => {
      const u = usageByAccount.get(a.id);
      return {
        accountId: a.id,
        platform: a.platform,
        platformLabel: PLATFORM_LABELS[a.platform],
        status: a.status,
        displayName: a.displayName,
        handle: a.handle,
        publishableNow: a.status === "linked" && PROVEN_PUBLISH_PLATFORMS.includes(a.platform),
        monthlyUploads: u ? { used: u.count, cap: u.uploadsPerMonth, level: u.level } : null,
      };
    });
    const publishable = mapped.filter((a) => a.publishableNow);
    if (!mapped.length) {
      return {
        summary:
          "No connected accounts yet — the creator links them on the Connected accounts page (/marketing/accounts). Until then only the manual copy-and-post path exists.",
        data: { accounts: [] },
      };
    }
    return {
      summary: `${mapped.length} connected account(s); ${publishable.length} publishable now (linked + LinkedIn/YouTube).`,
      data: { accounts: mapped },
    };
  },
});

const getPublishStatus = defineMarketingTool({
  name: "get_publish_status",
  description:
    "THE truth source for connected publishing state — answer every 'did my post go out?' from THIS, never from memory. Returns publish runs (manifests: status, fire time, hold reason with explanation, typed failure, postUrl, attempt) and open review cards awaiting the creator. A post is published ONLY when a run is `live` (the post's status becomes posted_api and postUrl is set); queued/submitted/verifying are in flight, `held` explains itself, `failed` is transient (retryable), `platform_failed` needs an edit + fresh card. Scope to one post via postId, or pass null for recent activity.",
  params: z.object({
    postId: z
      .string()
      .nullable()
      .describe("Scope to one social post; null = the creator's recent publish activity"),
    limit: z.number().int().min(1).max(20).nullable().describe("Recent-activity mode only; default 10"),
  }),
  reversibility: "read",
  async execute(args, ctx) {
    if (args.postId) {
      const [manifests, approvals, { data: post }] = await Promise.all([
        listPublishManifestsForPost(ctx.supabase, args.postId),
        listApprovalsForPost(ctx.supabase, args.postId),
        ctx.supabase
          .from("social_post")
          .select("id,status,platform,body")
          .eq("id", args.postId)
          .maybeSingle(),
      ]);
      const own = manifests.filter((m) => m.creatorId === ctx.ownerId);
      const openCards = approvals.filter(
        (a) => a.creatorId === ctx.ownerId && !a.consumedAt && !a.declinedAt && !a.voidedAt
      );
      const live = own.find((m) => m.status === "live");
      const summary = !post
        ? "Post not found."
        : live
          ? `Published (posted_api): live on ${PLATFORM_LABELS[live.platform]}${live.postUrl ? ` — ${live.postUrl}` : ""}.`
          : own.length
            ? `Post status ${post.status}; latest run: ${compactManifest(own[own.length - 1]).status}${openCards.length ? `; ${openCards.length} card(s) awaiting the creator` : ""}.`
            : openCards.length
              ? `${openCards.length} review card(s) awaiting the creator — nothing has fired.`
              : `No publish activity for this post (status ${post.status}).`;
      return {
        summary,
        data: {
          postStatus: post?.status ?? null,
          manifests: own.map(compactManifest),
          openCards: openCards.map(compactOpenApproval),
        },
      };
    }
    const [manifests, openCards] = await Promise.all([
      listRecentPublishManifests(ctx.supabase, ctx.ownerId, args.limit ?? 10),
      listOpenApprovals(ctx.supabase, ctx.ownerId),
    ]);
    const counts = new Map<string, number>();
    for (const m of manifests) counts.set(m.status, (counts.get(m.status) ?? 0) + 1);
    const countLine = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(" · ");
    return {
      summary: `${manifests.length} recent publish run(s)${countLine ? ` (${countLine})` : ""}; ${openCards.length} card(s) awaiting the creator.`,
      data: {
        manifests: manifests.map(compactManifest),
        openCards: openCards.map(compactOpenApproval),
      },
    };
  },
});

const retryPublish = defineMarketingTool({
  name: "retry_publish",
  description:
    "Re-fire a publish run that hit a TRANSIENT fault (manifest status `failed` only). The content is byte-identical to what the creator already approved, so NO new publish card is minted — the retry rides the original card's approval lineage. platform_failed is NOT retryable (the platform rejected the content: edit the post, which re-cards). The re-fired run is immediate.",
  params: z.object({ manifestId: z.string().min(1) }),
  reversibility: "irreversible",
  actionKind: "retry_publish",
  async execute(args, ctx) {
    const manifest = await getPublishManifest(ctx.supabase, args.manifestId);
    if (!manifest || manifest.creatorId !== ctx.ownerId) {
      return { summary: "Publish run not found." };
    }
    if (!ctx.approved) {
      if (!canRetryManifest(manifest.status)) {
        return {
          summary: `Not retryable — the run is ${manifest.status}. Retry exists only for transient failures (status failed)${manifest.status === "platform_failed" ? "; the platform rejected this content, so the fix is an edit + a fresh review card" : ""}.`,
        };
      }
      return {
        summary:
          "Will re-fire the already-approved publish. Content is byte-identical to the approved card — no new publish card; the re-fired run goes immediately.",
        data: {
          effectLabel: `Re-fires the approved ${PLATFORM_LABELS[manifest.platform]} publish (attempt ${manifest.attempt + 1}, immediate)`,
        },
      };
    }
    const res = await retryPublishManifest(
      ctx.supabase,
      ctx.ownerId,
      args.manifestId,
      ctx.services.clock.now()
    );
    if (!res.ok) {
      const why: Record<typeof res.reason, string> = {
        not_found: "the run no longer exists",
        not_retryable: "the run is not in a retryable state (only transient `failed` retries)",
        needs_fresh_card:
          "the post changed since the approval — a fresh review card is needed (file one)",
      };
      return { summary: `Retry refused: ${why[res.reason]}.` };
    }
    return {
      summary: `Retry queued as a fresh run — it fires immediately with the exact bytes the creator approved. NOT posted yet: only a live run (posted_api + postUrl) counts as published; check get_publish_status.`,
      data: { manifestId: res.manifest.id },
      target: { entity: "social_publish_approval", id: res.manifest.approvalId },
    };
  },
});

const cancelScheduledPublish = defineMarketingTool({
  name: "cancel_scheduled_publish",
  description:
    "Cancel a publish run that has NOT fired yet (manifest status queued or held only). Past the point of submission there is no recall — the provider has no delete API — so later states are an honest refusal. Cancelling is permanent for that run: publishing the post later needs a fresh review card.",
  params: z.object({ manifestId: z.string().min(1) }),
  reversibility: "irreversible",
  actionKind: "cancel_scheduled_publish",
  async execute(args, ctx) {
    const manifest = await getPublishManifest(ctx.supabase, args.manifestId);
    if (!manifest || manifest.creatorId !== ctx.ownerId) {
      return { summary: "Publish run not found." };
    }
    if (!ctx.approved) {
      if (manifest.status !== "queued" && manifest.status !== "held") {
        return {
          summary: `Nothing to cancel — the run is already ${manifest.status}${manifest.status === "live" ? " (for a live post, unpublish_social_post records the local state; the platform copy stays up)" : ""}.`,
        };
      }
      return {
        summary: `Will cancel the ${PLATFORM_LABELS[manifest.platform]} run${manifest.scheduledFor ? ` scheduled for ${manifest.scheduledFor}` : ""} — nothing fires; re-publishing later needs a fresh card.`,
        data: {
          effectLabel: `Cancels the ${manifest.scheduledFor ? "scheduled" : "pending"} ${PLATFORM_LABELS[manifest.platform]} publish${manifest.scheduledFor ? ` (${manifest.scheduledFor})` : ""}`,
        },
      };
    }
    const res = await cancelPublishManifest(ctx.supabase, args.manifestId);
    if (!res.cancelled) {
      const why: Record<typeof res.reason, string> = {
        not_found: "the run no longer exists",
        already_terminal: "the run already finished (live/failed/cancelled)",
        past_submission:
          "submission already began — there is no recall once the provider call is in flight",
      };
      return { summary: `Cancel refused: ${why[res.reason]}.` };
    }
    return {
      summary:
        "Cancelled — nothing will fire for this run. The post itself is untouched (still ready); publishing it later needs a fresh review card.",
      data: { manifestId: manifest.id },
      target: { entity: "social_publish_approval", id: manifest.approvalId },
    };
  },
});

export const publishOpsTools = [
  getConnectedAccounts,
  getPublishStatus,
  retryPublish,
  cancelScheduledPublish,
];
