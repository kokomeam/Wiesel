/**
 * Campaign lifecycle mechanics — the launch-checklist PREDICATE (§3's "one
 * eligibility predicate", not a chain of sequential UI states) and the launch
 * orchestration (audience snapshot + sequence activation). Used by the
 * lifecycle tools (tools/campaignLifecycle.ts); kept out of the tools file so
 * the predicate is independently testable.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { listLeadListsWithCounts, loadCourseMarketingContext, loadEmailSequence, loadLeadList, loadSenderIdentity, listLeadListMemberIds } from "./persistence";
import type { MarketingCampaign } from "./types";

type DB = SupabaseClient<Database>;

export interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface LaunchChecklist {
  items: ChecklistItem[];
  /** The single eligibility predicate: launch iff every item is ok. */
  canLaunch: boolean;
}

/**
 * §3's launch predicate, evaluated fresh every time (never cached): course has
 * a title · a lead list with confirmed consent + ≥1 eligible lead is attached ·
 * a sender identity (with a mailing address) is set · every step is approved ·
 * compliance is not blocked · a primary sequence with touches exists.
 */
export async function evaluateLaunchChecklist(supabase: DB, campaign: MarketingCampaign): Promise<LaunchChecklist> {
  const items: ChecklistItem[] = [];

  const course = await loadCourseMarketingContext(supabase, campaign.courseId);
  items.push({
    key: "course_title",
    label: "Course has a title",
    ok: !!course?.title,
    detail: course?.title ?? "No course title set.",
  });

  const list = campaign.leadListId ? await loadLeadList(supabase, campaign.leadListId) : null;
  let eligibleCount = 0;
  if (list) {
    const [withCounts] = (await listLeadListsWithCounts(supabase, campaign.courseId)).filter((l) => l.id === list.id);
    eligibleCount = withCounts?.eligibleLeads ?? 0;
  }
  items.push({
    key: "lead_list",
    label: "Lead list attached with confirmed consent and ≥1 eligible lead",
    ok: !!list && list.consentConfirmed && eligibleCount > 0,
    detail: list
      ? `"${list.name}" — ${eligibleCount} eligible${list.consentConfirmed ? "" : " (consent not confirmed)"}`
      : "No lead list attached.",
  });

  const sender = campaign.senderIdentityId ? await loadSenderIdentity(supabase, campaign.senderIdentityId) : null;
  items.push({
    key: "sender_identity",
    label: "Sender identity set (name, email, mailing address)",
    ok: !!sender && !!sender.mailingAddress,
    detail: sender ? `${sender.fromName} <${sender.fromEmail}>` : "No sender identity set.",
  });

  const { data: seqRows } = await supabase
    .from("email_sequence")
    .select("id")
    .eq("campaign_id", campaign.id)
    .order("created_at", { ascending: true })
    .limit(1);
  const sequence = seqRows?.[0] ? await loadEmailSequence(supabase, seqRows[0].id) : null;
  const allApproved = !!sequence && sequence.touches.length > 0 && sequence.touches.every((t) => t.approvalStatus === "approved");
  items.push({
    key: "steps_approved",
    label: "Every email step is approved",
    ok: allApproved,
    detail: sequence ? `${sequence.touches.filter((t) => t.approvalStatus === "approved").length}/${sequence.touches.length} approved` : "No sequence drafted yet.",
  });

  items.push({
    key: "compliance",
    label: "Compliance review is not blocked",
    ok: campaign.complianceStatus !== "blocked",
    detail: `Compliance status: ${campaign.complianceStatus}`,
  });

  items.push({
    key: "schedule",
    label: "A schedule is chosen",
    ok: !!campaign.config.sendWindow || !!campaign.config.blueprintKey,
    detail: campaign.config.sendWindow ? "Send window configured." : "Using default send window.",
  });

  return { items, canLaunch: items.every((i) => i.ok) };
}

/** Snapshot the lead list's CURRENT eligible members into a fixed id list — the
 *  approved audience the launch covers, per Amendment 4c ("operates only
 *  within the approved list"). Later opt-ins are NOT auto-added; a fresh
 *  enroll_segment_in_sequence call (still gated) is required to add them. */
export async function snapshotApprovedAudience(supabase: DB, leadListId: string): Promise<string[]> {
  const memberIds = await listLeadListMemberIds(supabase, leadListId);
  if (memberIds.length === 0) return [];
  const { data } = await supabase
    .from("subscriber")
    .select("id,status,consent_status")
    .in("id", memberIds);
  return (data ?? [])
    .filter((s) => s.status !== "unsubscribed" && s.status !== "bounced" && s.consent_status === "confirmed")
    .map((s) => s.id);
}
