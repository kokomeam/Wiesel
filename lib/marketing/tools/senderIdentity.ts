/**
 * Sender identity tools (Amendment 9). MVP = one platform-verified sender per
 * course; `mailingAddress` is REQUIRED (the compliance footer needs it and the
 * platform cannot supply a creator's address). Per-creator verified domains
 * (SPF/DKIM/DMARC) are the existing later seam — `verified` stays false until
 * that lands.
 */

import { z } from "zod";
import { listSenderIdentities, loadSenderIdentity } from "../persistence";
import { defineMarketingTool, MarketingToolError } from "./types";

const getSenderIdentity = defineMarketingTool({
  name: "get_sender_identity",
  description: "Get this course's sender identity (from name/email, reply-to, mailing address).",
  params: z.object({}),
  reversibility: "read",
  async execute(_args, ctx) {
    const list = await listSenderIdentities(ctx.supabase, ctx.courseId);
    const sender = list[0] ?? null;
    return { summary: sender ? `${sender.fromName} <${sender.fromEmail}>` : "No sender identity set.", data: sender };
  },
});

const createSenderIdentity = defineMarketingTool({
  name: "create_sender_identity",
  description: "Create the course's sender identity — from name, from email, reply-to, and a REQUIRED mailing address. Stages as reversible.",
  params: z.object({
    fromName: z.string().min(1).max(120),
    fromEmail: z.string().min(1).max(254),
    replyTo: z.string().max(254).nullable(),
    mailingAddress: z.string().min(1).max(400),
    businessName: z.string().max(200).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "create_sender_identity",
  async execute(args, ctx) {
    // Idempotent on identical fields — a double-submit (slow action + a second
    // click) must return the existing identity, not mint a duplicate.
    const existing = (await listSenderIdentities(ctx.supabase, ctx.courseId)).find(
      (s) => s.fromEmail === args.fromEmail && s.fromName === args.fromName && s.mailingAddress === args.mailingAddress
    );
    if (existing) {
      return {
        summary: `Sender identity already exists: ${args.fromName} <${args.fromEmail}>.`,
        data: { senderIdentityId: existing.id },
        target: { entity: "sender_identity", id: existing.id },
      };
    }
    const { data, error } = await ctx.supabase
      .from("sender_identity")
      .insert({
        course_id: ctx.courseId,
        from_name: args.fromName,
        from_email: args.fromEmail,
        reply_to: args.replyTo,
        mailing_address: args.mailingAddress,
        business_name: args.businessName,
      })
      .select("id")
      .single();
    if (error || !data) throw new MarketingToolError(`create_sender_identity: ${error?.message}`);
    return { summary: `Set sender identity: ${args.fromName} <${args.fromEmail}>.`, data: { senderIdentityId: data.id }, target: { entity: "sender_identity", id: data.id } };
  },
});

const updateSenderIdentity = defineMarketingTool({
  name: "update_sender_identity",
  description: "Update the sender identity's fields. Stages as reversible.",
  params: z.object({
    senderIdentityId: z.string().min(1),
    fromName: z.string().min(1).max(120).nullable(),
    fromEmail: z.string().min(1).max(254).nullable(),
    replyTo: z.string().max(254).nullable(),
    mailingAddress: z.string().min(1).max(400).nullable(),
    businessName: z.string().max(200).nullable(),
  }),
  reversibility: "reversible",
  actionKind: "update_sender_identity",
  existingTarget(args) {
    return { entity: "sender_identity", id: args.senderIdentityId };
  },
  async execute(args, ctx) {
    const existing = await loadSenderIdentity(ctx.supabase, args.senderIdentityId);
    if (!existing) throw new MarketingToolError(`Sender identity ${args.senderIdentityId} not found`);
    const { error } = await ctx.supabase
      .from("sender_identity")
      .update({
        from_name: args.fromName ?? existing.fromName,
        from_email: args.fromEmail ?? existing.fromEmail,
        reply_to: args.replyTo ?? existing.replyTo,
        mailing_address: args.mailingAddress ?? existing.mailingAddress,
        business_name: args.businessName ?? existing.businessName,
      })
      .eq("id", args.senderIdentityId);
    if (error) throw new MarketingToolError(`update_sender_identity: ${error.message}`);
    return { summary: "Updated sender identity.", target: { entity: "sender_identity", id: args.senderIdentityId } };
  },
});

const attachSenderIdentityToCampaign = defineMarketingTool({
  name: "attach_sender_identity_to_campaign",
  description: "Attach a sender identity to a campaign. Stages as reversible.",
  params: z.object({ campaignId: z.string().min(1), senderIdentityId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "attach_sender_identity_to_campaign",
  existingTarget(args) {
    return { entity: "campaign", id: args.campaignId };
  },
  async execute(args, ctx) {
    const { error } = await ctx.supabase
      .from("marketing_campaign")
      .update({ sender_identity_id: args.senderIdentityId })
      .eq("id", args.campaignId);
    if (error) throw new MarketingToolError(`attach_sender_identity_to_campaign: ${error.message}`);
    return { summary: "Attached the sender identity to the campaign.", target: { entity: "campaign", id: args.campaignId } };
  },
});

const attachLeadListToCampaign = defineMarketingTool({
  name: "attach_lead_list_to_campaign",
  description: "Attach a lead list to a campaign as its audience. Stages as reversible.",
  params: z.object({ campaignId: z.string().min(1), listId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "attach_lead_list_to_campaign",
  existingTarget(args) {
    return { entity: "campaign", id: args.campaignId };
  },
  async execute(args, ctx) {
    const { error } = await ctx.supabase.from("marketing_campaign").update({ lead_list_id: args.listId }).eq("id", args.campaignId);
    if (error) throw new MarketingToolError(`attach_lead_list_to_campaign: ${error.message}`);
    return { summary: "Attached the lead list to the campaign.", target: { entity: "campaign", id: args.campaignId } };
  },
});

const createSendingSchedule = defineMarketingTool({
  name: "create_sending_schedule",
  description:
    "Set the campaign's schedule: send-now / drip / scheduled-start, plus the send window (default 9–11am creator time, weekends skipped). Stages as reversible.",
  params: z.object({
    campaignId: z.string().min(1),
    startHour: z.number().int().min(0).max(23).nullable(),
    endHour: z.number().int().min(0).max(23).nullable(),
    timezone: z.string().min(1).max(64).nullable(),
    skipWeekends: z.boolean().nullable(),
  }),
  reversibility: "reversible",
  actionKind: "create_sending_schedule",
  existingTarget(args) {
    return { entity: "campaign", id: args.campaignId };
  },
  async execute(args, ctx) {
    const { data: campaign } = await ctx.supabase.from("marketing_campaign").select("config").eq("id", args.campaignId).maybeSingle();
    if (!campaign) throw new MarketingToolError(`Campaign ${args.campaignId} not found`);
    const prevConfig = (campaign.config as Record<string, unknown>) ?? {};
    const prevWindow = (prevConfig.sendWindow as Record<string, unknown>) ?? {};
    const sendWindow = {
      startHour: args.startHour ?? (prevWindow.startHour as number) ?? 9,
      endHour: args.endHour ?? (prevWindow.endHour as number) ?? 11,
      timezone: args.timezone ?? (prevWindow.timezone as string) ?? "UTC",
      skipWeekends: args.skipWeekends ?? (prevWindow.skipWeekends as boolean) ?? true,
    };
    const { error } = await ctx.supabase
      .from("marketing_campaign")
      .update({ config: { ...prevConfig, sendWindow } })
      .eq("id", args.campaignId);
    if (error) throw new MarketingToolError(`create_sending_schedule: ${error.message}`);
    return { summary: `Send window set to ${sendWindow.startHour}:00–${sendWindow.endHour}:00 ${sendWindow.timezone}${sendWindow.skipWeekends ? ", weekends skipped" : ""}.`, target: { entity: "campaign", id: args.campaignId } };
  },
});

export const senderIdentityTools = [
  getSenderIdentity,
  createSenderIdentity,
  updateSenderIdentity,
  attachSenderIdentityToCampaign,
  attachLeadListToCampaign,
  createSendingSchedule,
];
