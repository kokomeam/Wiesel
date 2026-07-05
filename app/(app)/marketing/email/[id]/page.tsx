/**
 * Campaign builder (Screen 4 + 6 + 7) — a guided stepper (Audience → Sender →
 * Review emails → Compliance → Launch) over three columns: left = setup
 * (attach/create audience + sender, send window, collapsed analysis/brief/
 * voice); center = the sequence's step cards + follow-up rules; right =
 * delivery outbox, compliance, launch, and the Marketing Assistant. Server
 * component loads everything; the client builder drives interactions through
 * the gated server actions.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { evaluateLaunchChecklist } from "@/lib/marketing/campaignLifecycle";
import { listPendingApprovals } from "@/lib/marketing/gate";
import { getBlueprint } from "@/lib/marketing/blueprints";
import { describeSendWindow, sendWindowState } from "@/lib/marketing/scheduler";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { getMarketingTool, previewMarketingAction } from "@/lib/marketing/tools";
import { DEFAULT_SEND_WINDOW, type SendWindow } from "@/lib/marketing/types";
import {
  defaultVoiceRules,
  listFollowUpRules,
  listLeadListsWithCounts,
  listSenderIdentities,
  loadCampaign,
  loadCourseMarketingContext,
  loadDeliveryStats,
  loadEmailSequence,
  loadSenderIdentity,
  loadVoiceProfile,
} from "@/lib/marketing/persistence";
import { CampaignBuilder } from "./CampaignBuilder";

export const dynamic = "force-dynamic";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const campaign = await loadCampaign(supabase, id);
  if (!campaign) notFound();

  const [course, checklist, pendingAll, rules, lists, voiceProfile, senders, delivery] = await Promise.all([
    loadCourseMarketingContext(supabase, campaign.courseId),
    evaluateLaunchChecklist(supabase, campaign),
    listPendingApprovals(supabase, campaign.courseId),
    listFollowUpRules(supabase, campaign.id),
    listLeadListsWithCounts(supabase, campaign.courseId),
    loadVoiceProfile(supabase, user!.id),
    listSenderIdentities(supabase, campaign.courseId),
    loadDeliveryStats(supabase, campaign.id),
  ]);

  const { data: seqRows } = await supabase
    .from("email_sequence")
    .select("id")
    .eq("campaign_id", campaign.id)
    .order("created_at", { ascending: true })
    .limit(1);
  const sequence = seqRows?.[0] ? await loadEmailSequence(supabase, seqRows[0].id) : null;

  // Delivery-timing truth for the Delivery card: is the send window open, when
  // does it next open, and are queued sends due-but-held RIGHT NOW.
  const services = createMarketingServices();
  const windowCfg = (campaign.config.sendWindow as SendWindow | undefined) ?? DEFAULT_SEND_WINDOW;
  const nowMs = services.clock.epochMs();
  const windowNow = sendWindowState(nowMs, windowCfg);
  const sendWindowInfo = {
    description: describeSendWindow(windowCfg),
    openNow: windowNow.openNow,
    nextOpenAt: windowNow.nextOpenMs !== null ? new Date(windowNow.nextOpenMs).toISOString() : null,
    heldNow:
      delivery !== null &&
      delivery.queued > 0 &&
      delivery.nextDueAt !== null &&
      new Date(delivery.nextDueAt).getTime() <= nowMs &&
      !windowNow.openNow,
  };

  const sender = campaign.senderIdentityId ? await loadSenderIdentity(supabase, campaign.senderIdentityId) : null;
  const list = lists.find((l) => l.id === campaign.leadListId) ?? null;
  const blueprint = campaign.config.blueprintKey ? getBlueprint(campaign.config.blueprintKey) : campaign.goal ? getBlueprint(campaign.goal) : null;
  const pending = await Promise.all(
    pendingAll
      .filter((a) => a.campaignId === campaign.id)
      .map(async (a) => ({
        actionId: a.id,
        toolName: a.toolName,
        summary: a.summary ?? "",
        preview: await previewMarketingAction(a, { supabase, ownerId: user!.id, services }),
        editableParams: getMarketingTool(a.toolName)?.editableParams ?? null,
        requestedBy: a.requestedBy,
      }))
  );

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
      <Link href="/marketing/email" className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900">
        <ArrowLeft className="size-4" /> Email Campaigns
      </Link>
      <CampaignBuilder
        campaign={{
          id: campaign.id,
          courseId: campaign.courseId,
          name: campaign.name,
          status: campaign.status,
          complianceStatus: campaign.complianceStatus,
          complianceReport: campaign.complianceReport as never,
          goalLabel: blueprint?.label ?? campaign.goal ?? "—",
          brief: (campaign.config.brief ?? {}) as Record<string, string | undefined>,
          sendWindow: campaign.config.sendWindow ?? null,
          autoPauseReason: campaign.config.autoPauseReason ?? null,
        }}
        courseTitle={course?.title ?? "—"}
        analysis={{
          audience: course?.audience ?? campaign.config.brief?.audienceNotes ?? null,
          outcomes: course?.outcomes ?? [],
          proofPoints: campaign.config.brief?.proofPoints ?? null,
        }}
        sequence={
          sequence
            ? {
                id: sequence.id,
                status: sequence.status,
                touches: sequence.touches.map((t) => ({
                  id: t.id,
                  position: t.position,
                  stageName: t.stageName,
                  subject: t.subject,
                  previewText: t.previewText,
                  body: t.body,
                  delaySeconds: t.delaySeconds,
                  approvalStatus: t.approvalStatus,
                  aiRationale: t.aiRationale,
                  personalizationVariables: t.personalizationVariables,
                  qualityScore: t.qualityScore,
                })),
              }
            : null
        }
        rules={rules.map((r) => ({ id: r.id, name: r.name, trigger: r.trigger, delayDays: r.delayDays, status: r.status }))}
        sender={sender ? { fromName: sender.fromName, fromEmail: sender.fromEmail, mailingAddress: sender.mailingAddress } : null}
        senders={senders.map((s) => ({ id: s.id, fromName: s.fromName, fromEmail: s.fromEmail, mailingAddress: s.mailingAddress }))}
        list={list ? { name: list.name, totalLeads: list.totalLeads, eligibleLeads: list.eligibleLeads, consentConfirmed: list.consentConfirmed } : null}
        lists={lists.map((l) => ({ id: l.id, name: l.name, totalLeads: l.totalLeads, eligibleLeads: l.eligibleLeads, awaitingConsentRequest: l.awaitingConsentRequest }))}
        attachedListId={campaign.leadListId}
        delivery={delivery}
        sendWindowInfo={sendWindowInfo}
        checklist={checklist}
        pendingApprovals={pending}
        voiceRules={voiceProfile?.rules ?? defaultVoiceRules(course?.teachingStyle ?? null)}
        creatorEmail={user?.email ?? ""}
      />
    </div>
  );
}
