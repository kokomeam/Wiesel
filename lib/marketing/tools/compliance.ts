/**
 * reviewCampaignCompliance — the trust + quality gate (Amendment 2 + §21).
 *
 * BLOCKING findings (set complianceStatus='blocked', disable launch):
 *   missing consent/risky list · missing sender identity or mailing address ·
 *   a step not approved · a CTA URL that doesn't resolve · a merge variable
 *   with no fallback AND missing data for ≥1 eligible lead · fake urgency /
 *   guaranteed outcomes / fake scarcity language.
 * ADVISORY findings (never block): the copy quality rubric score per step ·
 *   generic "spammy tone" · aggressive send frequency.
 *
 * REVERSIBLE: it writes compliance_status/compliance_report onto the campaign
 * row (a real mutation — the "last reviewed" state persists for the UI), so it
 * routes the SAME gate as everything else, snapshotted for (harmless) revert.
 */

import { z } from "zod";
import type { Json } from "@/lib/database.types";
import type { EmailTouch } from "../types";
import { resolveCtaDestinations, resolveSendTimeButtonHref, siteUrlFinding } from "../ctaDestination";
import { findMissingFallbacks, type MergeVarContext } from "../mergeVars";
import {
  loadCampaign,
  loadCourseMarketingContext,
  loadEmailSequence,
  loadLeadList,
  loadSenderIdentity,
  listLeadListsWithCounts,
  listLeadListMemberIds,
} from "../persistence";
import { scoreEmailStep } from "../quality";
import { defineMarketingTool, MarketingToolError, type MarketingToolContext } from "./types";

/** Phrases that trip the "AI cannot ... guarantee outcomes / fake urgency /
 *  fake scarcity" hard rule (§21). Deliberately blunt — false positives are
 *  cheap (the creator edits and re-reviews); false negatives are not. */
const BLOCKING_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bguarantee[ds]?\b/i, label: "Guaranteed-outcome language (\"guarantee\")" },
  { re: /\b100%\s*(results|success|guaranteed)\b/i, label: "Guaranteed-outcome language (\"100% results/success\")" },
  { re: /\bonly \d+ (spots?|seats?|left)\b/i, label: "Scarcity claim (\"only N spots left\") — must be a real, verifiable count" },
  { re: /\bact now\b/i, label: "Fake-urgency phrase (\"act now\")" },
  { re: /\blast chance\b.*\bforever\b/i, label: "Fake-urgency phrase implying a false permanent deadline" },
];

const SPAMMY_TONE_WORDS = ["free!!!", "$$$", "buy now", "click here", "risk free"];

function bodyText(body: EmailTouch["body"]): string {
  return body.blocks
    .map((b) => ("text" in b ? b.text : "items" in b ? b.items.join(" ") : ""))
    .join(" ");
}

async function urlResolves(url: string): Promise<boolean> {
  if (url.startsWith("/")) return true; // internal route — validated by Next.js routing, not fetch.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { method: "HEAD", signal: ctrl.signal }).catch(() =>
      fetch(url, { method: "GET", signal: ctrl.signal })
    );
    clearTimeout(timer);
    return res.ok || (res.status >= 300 && res.status < 400);
  } catch {
    return false;
  }
}

export interface ComplianceFinding {
  key: string;
  label: string;
  severity: "blocking" | "warning";
  detail: string;
}

export interface QualityFinding {
  touchId: string;
  stageName: string | null;
  score: number;
  failedCriteria: string[];
}

const reviewCampaignCompliance = defineMarketingTool({
  name: "review_campaign_compliance",
  description:
    "Run the pre-launch compliance + copy-quality review for the campaign: consent/list risk, sender identity, CTA URLs, merge-variable fallbacks, fake urgency/guaranteed outcomes (blocking); quality rubric scores, tone, frequency (advisory). Writes the result onto the campaign. Stages as reversible.",
  params: z.object({ campaignId: z.string().min(1) }),
  reversibility: "reversible",
  actionKind: "review_campaign_compliance",
  existingTarget(args) {
    return { entity: "campaign", id: args.campaignId };
  },
  async execute(args, ctx: MarketingToolContext) {
    const campaign = await loadCampaign(ctx.supabase, args.campaignId);
    if (!campaign) throw new MarketingToolError(`Campaign ${args.campaignId} not found`);
    const course = await loadCourseMarketingContext(ctx.supabase, campaign.courseId);
    if (!course) throw new MarketingToolError("Course not found");

    const findings: ComplianceFinding[] = [];
    const quality: QualityFinding[] = [];

    // 0 · site URL sanity — a wrong base URL makes EVERY emailed link 404
    // (observed live: NEXT_PUBLIC_SITE_URL set to the Vercel dashboard path).
    const siteIssue = siteUrlFinding();
    if (siteIssue) {
      findings.push({
        key: "site_url_misconfigured",
        label: "Site URL misconfigured — emailed links would break",
        severity: siteIssue.severity,
        detail: siteIssue.detail,
      });
    }

    // 1 · lead source risk + consent status
    const list = campaign.leadListId ? await loadLeadList(ctx.supabase, campaign.leadListId) : null;
    if (!list) {
      findings.push({ key: "no_list", label: "No lead list attached", severity: "blocking", detail: "Attach a consent-confirmed lead list before launch." });
    } else {
      const [withCounts] = (await listLeadListsWithCounts(ctx.supabase, campaign.courseId)).filter((l) => l.id === list.id);
      if (!list.consentConfirmed) {
        findings.push({ key: "consent_unconfirmed", label: "List consent not confirmed", severity: "blocking", detail: `"${list.name}" has not been marked consent-confirmed.` });
      }
      if ((withCounts?.eligibleLeads ?? 0) === 0) {
        findings.push({ key: "no_eligible_leads", label: "No eligible leads", severity: "blocking", detail: `"${list.name}" has 0 eligible (consented, non-suppressed) leads.` });
      }
      if (list.sourceType === "manual_import" && (withCounts?.eligibleLeads ?? 0) < (withCounts?.totalLeads ?? 0)) {
        findings.push({ key: "list_risk", label: "Imported list has unconfirmed/suppressed contacts", severity: "warning", detail: "Some imported contacts are excluded automatically from sends." });
      }
    }

    // 2 · sender identity
    const sender = campaign.senderIdentityId ? await loadSenderIdentity(ctx.supabase, campaign.senderIdentityId) : null;
    if (!sender) {
      findings.push({ key: "no_sender", label: "Missing sender identity", severity: "blocking", detail: "Set a sender name, email, and mailing address." });
    } else if (!sender.mailingAddress) {
      findings.push({ key: "no_mailing_address", label: "Sender identity is missing a mailing address", severity: "blocking", detail: "A mailing address (or virtual business address) is required in every marketing email footer." });
    }

    // 3 · steps: approval, CTA URLs, merge vars, blocking language, quality
    const { data: seqRows } = await ctx.supabase
      .from("email_sequence")
      .select("id")
      .eq("campaign_id", campaign.id)
      .order("created_at", { ascending: true })
      .limit(1);
    const sequence = seqRows?.[0] ? await loadEmailSequence(ctx.supabase, seqRows[0].id) : null;

    const dest = await resolveCtaDestinations(ctx.supabase, { courseId: ctx.courseId, campaignId: campaign.id });
    const eligibleContexts: MergeVarContext[] = [];
    if (list) {
      const memberIds = await listLeadListMemberIds(ctx.supabase, list.id);
      if (memberIds.length) {
        const { data: subs } = await ctx.supabase.from("subscriber").select("name,status,consent_status").in("id", memberIds);
        for (const s of subs ?? []) {
          if (s.status === "unsubscribed" || s.status === "bounced" || s.consent_status !== "confirmed") continue;
          eligibleContexts.push({
            firstName: s.name?.split(" ")[0] ?? null,
            courseName: course.title,
            creatorName: sender?.fromName ?? null,
            freeLessonUrl: dest.freeLessonUrl,
            ctaUrl: dest.ctaUrl,
            offerDeadline: (campaign.config.brief?.offerDeadlineIso as string | undefined) ?? null,
          });
        }
      }
    }

    if (!sequence || sequence.touches.length === 0) {
      findings.push({ key: "no_sequence", label: "No email sequence drafted", severity: "blocking", detail: "Generate the sequence before requesting a review." });
    } else {
      const notApproved = sequence.touches.filter((t) => t.approvalStatus !== "approved");
      if (notApproved.length > 0) {
        findings.push({ key: "steps_not_approved", label: "Not every step is approved", severity: "blocking", detail: `${notApproved.length} of ${sequence.touches.length} step(s) still need approval.` });
      }

      const allTexts = sequence.touches.map((t) => `${t.subject} ${bodyText(t.body)}`);
      const missingFallbacks = findMissingFallbacks(allTexts, eligibleContexts);
      for (const mf of missingFallbacks.filter((m) => m.blocking)) {
        findings.push({
          key: `merge_var_${mf.varName}`,
          label: `Merge variable {{${mf.varName}}} has no fallback and is missing for at least one eligible lead`,
          severity: "blocking",
          detail: `Add a fallback (e.g. {{${mf.varName}|"..."}}) or ensure every eligible lead has this field.`,
        });
      }

      for (const touch of sequence.touches) {
        const text = `${touch.subject} ${bodyText(touch.body)}`;
        for (const p of BLOCKING_PATTERNS) {
          if (p.re.test(text)) {
            findings.push({ key: `blocked_language_${touch.id}`, label: p.label, severity: "blocking", detail: `Step "${touch.stageName ?? touch.subject}" — rewrite before launch.` });
          }
        }
        const lower = text.toLowerCase();
        if (SPAMMY_TONE_WORDS.some((w) => lower.includes(w))) {
          findings.push({ key: `spammy_${touch.id}`, label: "Spammy tone", severity: "warning", detail: `Step "${touch.stageName ?? touch.subject}" uses spam-associated phrasing.` });
        }
        for (const block of touch.body.blocks) {
          if (block.kind !== "button") continue;
          // Validate the href AS IT WILL RENDER at send time — the SAME
          // resolution the scheduler applies ({{ctaUrl}} merge + dead-href
          // rescue + landing→preview upgrade), so a finding here means a
          // subscriber would actually see a broken link.
          const renderedHref = resolveSendTimeButtonHref(block.href, {
            courseName: course.title,
            freeLessonUrl: dest.freeLessonUrl,
            ctaUrl: dest.ctaUrl,
          });
          if (!(await urlResolves(renderedHref))) {
            findings.push({ key: `broken_cta_${touch.id}`, label: "CTA URL does not resolve", severity: "blocking", detail: `Step "${touch.stageName ?? touch.subject}" links to "${renderedHref}".` });
          }
        }
        const score = scoreEmailStep({
          subject: touch.subject,
          previewText: touch.previewText,
          body: touch.body,
          framework: "PAS",
          isOfferStage: (touch.stageName ?? "").toLowerCase().includes("offer") || (touch.stageName ?? "").toLowerCase().includes("chance"),
          course: { modules: course.modules, outcomes: course.outcomes },
        });
        quality.push({ touchId: touch.id, stageName: touch.stageName, score: score.score, failedCriteria: score.failedCriteria });
      }

      // Aggressive frequency: any two consecutive touches < 1 day apart.
      const sorted = [...sequence.touches].sort((a, b) => (a.delaySeconds ?? 0) - (b.delaySeconds ?? 0));
      for (let i = 1; i < sorted.length; i++) {
        const gap = (sorted[i].delaySeconds ?? 0) - (sorted[i - 1].delaySeconds ?? 0);
        if (gap < 86400) {
          findings.push({ key: "brisk_cadence", label: "Brisk send cadence", severity: "warning", detail: "Two steps are scheduled less than a day apart." });
          break;
        }
      }
    }

    const blocking = findings.filter((f) => f.severity === "blocking");
    const complianceStatus = blocking.length > 0 ? "blocked" : findings.length > 0 ? "warnings" : "passed";
    const report = { findings, quality, reviewedAt: ctx.services.clock.now() };

    const { error } = await ctx.supabase
      .from("marketing_campaign")
      .update({ compliance_status: complianceStatus, compliance_report: report as unknown as Json })
      .eq("id", campaign.id);
    if (error) throw new MarketingToolError(`review_campaign_compliance: ${error.message}`);

    return {
      summary: `Compliance review: ${complianceStatus} — ${blocking.length} blocking, ${findings.length - blocking.length} advisory finding(s). Avg quality score ${quality.length ? Math.round(quality.reduce((a, q) => a + q.score, 0) / quality.length) : 0}/100.`,
      data: report,
      target: { entity: "campaign", id: campaign.id },
    };
  },
});

export const complianceTools = [reviewCampaignCompliance];
