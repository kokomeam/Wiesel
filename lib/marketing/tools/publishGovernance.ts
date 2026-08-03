/**
 * M-C publish-governance tools — the assistant's surface onto the
 * card-SOLE-path. THE INVARIANT: no tool publishes anything. The three
 * irreversible tools are HARD-DENIED in the autonomy config (a gate approval
 * card in manual, assisted, AND auto — AC-MC.6), and even their approved
 * execute only REQUESTS a preview-then-decide card (publish/schedule) or
 * marks locally (unpublish) — a manifest is born exclusively inside
 * approvalService.approvePublishCard when the creator consumes a card token.
 *
 * propose_publish_plan is reversible: it files card REQUESTS (inert rows —
 * nothing can fire without the creator minting + consuming a token on the
 * review surface); revert declines them (approvals are no-delete, the
 * social-post archive-on-revert precedent).
 */

import { z } from "zod";
import { defineMarketingTool } from "./types";
import {
  requestPublishCard,
  type CardRefusalReason,
} from "@/lib/marketing/publish/approvalService";
import { unpublishLocally } from "@/lib/marketing/publish/publishService";
import { MANUAL_DELETE_GUIDANCE } from "@/lib/marketing/publish/cardCopy";

const REFUSAL_EXPLANATIONS: Record<CardRefusalReason, string> = {
  post_not_found: "that post does not exist",
  post_deleted: "the post was deleted",
  clip_missing_video: "the clip has no rendered video yet",
  platform_unmapped: "the post's platform can't be matched to a connected account",
  platform_not_yet_publishable:
    "only LinkedIn and YouTube are publishable so far (the other platforms are still being verified)",
  account_not_found: "that connected account does not exist",
  platform_mismatch: "the post's platform does not match that account",
  account_not_linked: "the account needs re-linking first (Connected accounts page)",
  source_superseded:
    "the source lesson was re-recorded after this clip was rendered — render a fresh clip first",
};

function explainRefusal(reason: CardRefusalReason): string {
  return `Could not request the review card: ${REFUSAL_EXPLANATIONS[reason]}.`;
}

const publishSocialPost = defineMarketingTool({
  name: "publish_social_post",
  description:
    "Request a preview-then-decide review card to publish a post through a connected account NOW. The card — not this tool — is the only thing that can publish: the creator sees the exact final text and destination and approves or rejects it. NEVER claim a post is published until its status is posted_api.",
  params: z.object({
    postId: z.string().min(1),
    accountId: z.string().min(1).describe("The connected social account id (linkedin/youtube)"),
  }),
  reversibility: "irreversible",
  actionKind: "publish_social_post",
  async execute(args, ctx) {
    if (!ctx.approved) {
      return {
        summary: "Will file a review card — the creator decides on the card; nothing publishes here.",
        data: { effectLabel: "Files a publish review card (creator decides on the card)" },
      };
    }
    const res = await requestPublishCard(ctx.supabase, ctx.ownerId, {
      socialPostId: args.postId,
      socialAccountId: args.accountId,
      requestedBy: ctx.requestedBy === "agent" ? "agent" : "creator",
      conversationId: ctx.conversationId ?? null,
    });
    if (!res.ok) return { summary: explainRefusal(res.reason) };
    return {
      summary:
        "Review card filed — it is now waiting on the publish review surface. APPROVAL IS PENDING: nothing has been published, and nothing will be until the creator approves that card.",
      data: { approvalId: res.approval.id },
      target: { entity: "social_publish_approval", id: res.approval.id },
    };
  },
});

const scheduleSocialPost = defineMarketingTool({
  name: "schedule_social_post",
  description:
    "Request a preview-then-decide review card proposing a FUTURE fire time for a post on a connected account. Approving the card schedules it (our runtime owns the fire time); the card shows the time in the creator's timezone. NEVER claim scheduled until the card is approved.",
  params: z.object({
    postId: z.string().min(1),
    accountId: z.string().min(1),
    scheduledFor: z.string().min(1).describe("ISO 8601 UTC fire time, must be in the future"),
  }),
  reversibility: "irreversible",
  actionKind: "schedule_social_post",
  async execute(args, ctx) {
    if (!ctx.approved) {
      return {
        summary: "Will file a scheduling review card — the creator decides on the card.",
        data: { effectLabel: `Files a schedule review card (proposed ${args.scheduledFor})` },
      };
    }
    const res = await requestPublishCard(ctx.supabase, ctx.ownerId, {
      socialPostId: args.postId,
      socialAccountId: args.accountId,
      proposedScheduledFor: args.scheduledFor,
      requestedBy: ctx.requestedBy === "agent" ? "agent" : "creator",
      conversationId: ctx.conversationId ?? null,
    });
    if (!res.ok) return { summary: explainRefusal(res.reason) };
    return {
      summary: `Review card filed proposing ${args.scheduledFor} — APPROVAL IS PENDING; nothing is scheduled until the creator approves the card.`,
      data: { approvalId: res.approval.id },
      target: { entity: "social_publish_approval", id: res.approval.id },
    };
  },
});

const unpublishSocialPost = defineMarketingTool({
  name: "unpublish_social_post",
  description:
    "Mark a connected-published post as unpublished INSIDE WiseSel. HONEST LIMIT (verified): the provider has no deletion API, so the platform copy REMAINS LIVE — this records the local state and gives the creator the platform link plus manual-deletion steps. Zero provider calls are made.",
  params: z.object({ postId: z.string().min(1) }),
  reversibility: "irreversible",
  actionKind: "unpublish_social_post",
  async execute(args, ctx) {
    if (!ctx.approved) {
      return {
        summary:
          "Will mark the post unpublished in WiseSel only — the platform copy stays live (no deletion API exists).",
        data: { effectLabel: "Marks unpublished locally; platform copy remains live" },
      };
    }
    const res = await unpublishLocally(ctx.supabase, ctx.ownerId, args.postId, ctx.services.clock.now());
    if (!res.ok) {
      return {
        summary:
          res.reason === "not_published_api"
            ? "This post was not published through a connected account — nothing to unpublish."
            : "Post not found.",
      };
    }
    return {
      summary: `Marked unpublished in WiseSel. The ${res.platform} copy REMAINS LIVE${res.postUrl ? ` (${res.postUrl})` : ""} — to remove it there: ${MANUAL_DELETE_GUIDANCE[res.platform]}`,
      data: { postUrl: res.postUrl, platform: res.platform, platformCopyRemainsLive: true },
      target: { entity: "social_post", id: args.postId },
    };
  },
});

const proposePublishPlan = defineMarketingTool({
  name: "propose_publish_plan",
  description:
    "Assemble a publish plan: file one preview-then-decide review card PER post/account/time. This REQUESTS cards only — it never approves, never publishes, never mints tokens; every card waits for the creator on the review surface, each individually approvable.",
  params: z.object({
    items: z
      .array(
        z.object({
          postId: z.string().min(1),
          accountId: z.string().min(1),
          scheduledFor: z.string().nullable().describe("ISO UTC fire time or null for immediate"),
        })
      )
      .min(1)
      .max(5),
  }),
  reversibility: "reversible",
  actionKind: "propose_publish_plan",
  async execute(args, ctx) {
    const filed: string[] = [];
    const refused: string[] = [];
    for (const item of args.items) {
      const res = await requestPublishCard(ctx.supabase, ctx.ownerId, {
        socialPostId: item.postId,
        socialAccountId: item.accountId,
        proposedScheduledFor: item.scheduledFor,
        requestedBy: ctx.requestedBy === "agent" ? "agent" : "creator",
        conversationId: ctx.conversationId ?? null,
      });
      if (res.ok) filed.push(res.approval.id);
      else refused.push(`${item.postId.slice(0, 8)}: ${REFUSAL_EXPLANATIONS[res.reason]}`);
    }
    return {
      summary: `Filed ${filed.length} review card${filed.length === 1 ? "" : "s"}${refused.length ? `; refused ${refused.length} (${refused.join(" · ")})` : ""}. Every card waits for the creator — nothing publishes from this plan by itself.`,
      data: { approvalIds: filed, refused },
      target: filed.length === 1 ? { entity: "social_publish_approval", id: filed[0] } : undefined,
    };
  },
});

export const publishGovernanceTools = [
  publishSocialPost,
  scheduleSocialPost,
  unpublishSocialPost,
  proposePublishPlan,
];
