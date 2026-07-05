/**
 * Lead list, segment, profile, and double-opt-in tools (Amendments 4 & 7).
 *
 * Consent is a PRECONDITION, not a checkbox: `import_leads` REQUIRES the
 * explicit confirmation string; a list only becomes `consentConfirmed` when
 * every member is `confirmed` (course-interest-signup lists start confirmed
 * because the on-page consent line IS the confirmation — see ingest.ts).
 */

import { z } from "zod";
import { consentConfirmUrl } from "../tokens";
import {
  listLeadListMemberIds,
  listLeadListsWithCounts,
  loadCourseMarketingContext,
  loadLeadList,
} from "../persistence";
import { engagementScore, getLeadSegment, loadLeadProfile } from "../segments";
import type { LeadSegmentKey } from "../types";
import { defineMarketingTool, MarketingToolError, type MarketingToolContext } from "./types";

const SEGMENT_KEYS = ["clicked_not_enrolled", "opened_not_clicked", "not_opened", "engaged_30d", "most_engaged", "by_source"] as const;

const REQUIRED_CONSENT_TEXT =
  "I confirm these contacts gave permission to receive marketing emails from me. This list is not purchased, scraped, or unsolicited.";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ─────────────────────────────── read ────────────────────────────────── */

const getLeadList = defineMarketingTool({
  name: "get_lead_list",
  description: "Get a lead list's totals, eligible/suppressed counts, and consent state.",
  params: z.object({ listId: z.string().min(1) }),
  reversibility: "read",
  async execute(args, ctx) {
    const list = await loadLeadList(ctx.supabase, args.listId);
    if (!list) throw new MarketingToolError(`Lead list ${args.listId} not found`);
    const [withCounts] = (await listLeadListsWithCounts(ctx.supabase, ctx.courseId)).filter((l) => l.id === list.id);
    return {
      summary: `"${list.name}" — ${withCounts?.eligibleLeads ?? 0}/${withCounts?.totalLeads ?? 0} eligible.`,
      data: { ...list, totalLeads: withCounts?.totalLeads ?? 0, eligibleLeads: withCounts?.eligibleLeads ?? 0 },
    };
  },
});

const listLeadListsTool = defineMarketingTool({
  name: "list_lead_lists",
  description: "List this course's lead lists with totals/eligible counts.",
  params: z.object({}),
  reversibility: "read",
  async execute(_args, ctx) {
    const lists = await listLeadListsWithCounts(ctx.supabase, ctx.courseId);
    return { summary: `${lists.length} list(s).`, data: { lists } };
  },
});

const validateLeadConsent = defineMarketingTool({
  name: "validate_lead_consent",
  description: "Assess a lead list's consent status and source risk (the read side of import).",
  params: z.object({ listId: z.string().min(1) }),
  reversibility: "read",
  async execute(args, ctx) {
    const list = await loadLeadList(ctx.supabase, args.listId);
    if (!list) throw new MarketingToolError(`Lead list ${args.listId} not found`);
    const [withCounts] = (await listLeadListsWithCounts(ctx.supabase, ctx.courseId)).filter((l) => l.id === list.id);
    const risk = list.sourceType === "manual_import" && !list.consentConfirmed ? "high" : list.sourceType === "manual_import" ? "medium" : "low";
    return {
      summary: `Risk: ${risk}. ${withCounts?.eligibleLeads ?? 0}/${withCounts?.totalLeads ?? 0} eligible.`,
      data: { risk, ...withCounts },
    };
  },
});

const getLeadSegmentTool = defineMarketingTool({
  name: "get_lead_segment",
  description:
    "Get the leads in a predefined behavioral segment (clicked_not_enrolled, opened_not_clicked, not_opened, engaged_30d, most_engaged, by_source). Pure query over the event stream — never a materialized list.",
  params: z.object({
    segment: z.enum(SEGMENT_KEYS),
    campaignId: z.string().min(1).nullable(),
    source: z.string().min(1).nullable(),
  }),
  reversibility: "read",
  async execute(args, ctx) {
    const result = await getLeadSegment(ctx.supabase, ctx.courseId, args.segment as LeadSegmentKey, {
      campaignId: args.campaignId,
      source: args.source,
    });
    return {
      summary: `${result.leads.length} lead(s) in "${args.segment}"${result.caveat ? ` (${result.caveat})` : ""}.`,
      data: result,
    };
  },
});

const getLeadProfileTool = defineMarketingTool({
  name: "get_lead_profile",
  description: "Get one lead's full profile: timeline, lifecycle stage, consent record, per-campaign engagement, engagement score, suppression state.",
  params: z.object({ subscriberId: z.string().min(1) }),
  reversibility: "read",
  async execute(args, ctx) {
    const profile = await loadLeadProfile(ctx.supabase, args.subscriberId);
    if (!profile) throw new MarketingToolError(`Subscriber ${args.subscriberId} not found`);
    return {
      summary: `${profile.email} — ${profile.lifecycleStatus}, engagement ${profile.engagement.bucket} (${profile.engagement.score}).`,
      data: profile,
    };
  },
});

/* ───────────────────────────── reversible ────────────────────────────── */

const createLeadList = defineMarketingTool({
  name: "create_lead_list",
  description: "Create a named lead list (manual_import | course_interest_signup | previous_students | custom). Stages as reversible.",
  params: z.object({
    name: z.string().min(1).max(120),
    sourceType: z.enum(["manual_import", "course_interest_signup", "previous_students", "custom"]),
  }),
  reversibility: "reversible",
  actionKind: "create_lead_list",
  async execute(args, ctx) {
    const { data, error } = await ctx.supabase
      .from("lead_list")
      .insert({
        course_id: ctx.courseId,
        campaign_id: ctx.campaignId,
        name: args.name,
        source_type: args.sourceType,
        consent_confirmed: args.sourceType === "course_interest_signup",
      })
      .select("id")
      .single();
    if (error || !data) throw new MarketingToolError(`create_lead_list: ${error?.message}`);
    return { summary: `Created lead list "${args.name}".`, data: { listId: data.id }, target: { entity: "lead_list", id: data.id } };
  },
});

const importLeads = defineMarketingTool({
  name: "import_leads",
  description:
    `Import contacts into a manual list. REQUIRES the exact consent confirmation string: "${REQUIRED_CONSENT_TEXT}". Rejects rows with invalid emails. Stages as reversible.`,
  params: z.object({
    listId: z.string().min(1),
    contacts: z.array(z.object({ email: z.string().min(1).max(254), name: z.string().max(120).nullable() })).min(1).max(2000),
    consentConfirmationText: z.string().min(1),
  }),
  reversibility: "reversible",
  actionKind: "import_leads",
  existingTarget(args) {
    return { entity: "lead_list", id: args.listId };
  },
  async execute(args, ctx) {
    if (args.consentConfirmationText.trim() !== REQUIRED_CONSENT_TEXT) {
      throw new MarketingToolError("The exact consent confirmation text is required to import contacts.");
    }
    const list = await loadLeadList(ctx.supabase, args.listId);
    if (!list) throw new MarketingToolError(`Lead list ${args.listId} not found`);

    // Contacts are COURSE-level people; a campaign association is optional
    // context. Recipient selection happens via lead_list_member + the launch
    // audience snapshot, never subscriber.campaign_id.
    const campaignId = ctx.campaignId ?? list.campaignId ?? null;

    let imported = 0;
    let rejected = 0;
    for (const c of args.contacts) {
      const email = c.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        rejected++;
        continue;
      }
      // Dedupe course-wide: the same person imported twice (or already captured
      // by a landing page) must stay ONE subscriber, whatever campaign they
      // first appeared under.
      const { data: existing } = await ctx.supabase
        .from("subscriber")
        .select("id")
        .eq("course_id", ctx.courseId)
        .eq("email", email)
        .limit(1)
        .maybeSingle();
      let subscriberId = existing?.id;
      if (!subscriberId) {
        const { data: inserted, error } = await ctx.supabase
          .from("subscriber")
          .insert({
            campaign_id: campaignId,
            course_id: ctx.courseId,
            email,
            name: c.name,
            status: "lead",
            source: "manual_import",
            consent_status: "pending",
            consent_requested_at: null,
            consent: { source: "manual_import", importedAt: ctx.services.clock.now() },
          })
          .select("id")
          .single();
        if (error || !inserted) {
          rejected++;
          continue;
        }
        subscriberId = inserted.id;
      }
      await ctx.supabase.from("lead_list_member").upsert({ list_id: args.listId, subscriber_id: subscriberId }, { onConflict: "list_id,subscriber_id" });
      imported++;
    }

    // A manual list only becomes "consent confirmed" once every member has
    // actually confirmed (via double opt-in) — never at import time.
    return {
      summary: `Imported ${imported} contact(s)${rejected ? ` (${rejected} rejected — invalid email)` : ""}. They are PENDING until they confirm consent.`,
      data: { imported, rejected },
      target: { entity: "lead_list", id: args.listId },
    };
  },
});

/* ────────────── reversible: audience membership (list building) ──────────
 * The "put my existing contacts on a list" tools. Adding/removing membership
 * SENDS NOTHING (reversible — quiet log + revert window); actually emailing a
 * list stays behind the irreversible gate. The lead_list snapshotter is
 * composite (list row + membership), so reverting any of these restores the
 * exact prior membership. */

const AUDIENCE_STATUSES = ["lead", "subscribed", "engaged", "enrolled", "all"] as const;

const AudienceFilterSchema = z.object({
  consent: z
    .enum(["confirmed", "pending", "any"])
    .describe("confirmed = completed double opt-in (eligible to email NOW); pending = awaiting opt-in; any = both"),
  status: z
    .enum(AUDIENCE_STATUSES)
    .describe("funnel stage filter; 'all' = every stage (suppressed contacts are always excluded)"),
});

export type AudienceFilter = z.infer<typeof AudienceFilterSchema>;

/** Course-level contacts matching a filter — suppressed (unsubscribed/bounced)
 *  contacts are ALWAYS excluded, whatever the filter says. */
export async function matchAudience(
  ctx: Pick<MarketingToolContext, "supabase" | "courseId">,
  filter: AudienceFilter
): Promise<{ id: string; email: string; status: string; consent_status: string }[]> {
  const { data } = await ctx.supabase
    .from("subscriber")
    .select("id,email,status,consent_status")
    .eq("course_id", ctx.courseId);
  return (data ?? []).filter(
    (s) =>
      s.status !== "unsubscribed" &&
      s.status !== "bounced" &&
      (filter.status === "all" || s.status === filter.status) &&
      (filter.consent === "any" || s.consent_status === filter.consent)
  );
}

function filterLabel(filter: AudienceFilter): string {
  const consent = filter.consent === "any" ? "" : `${filter.consent} `;
  const stage = filter.status === "all" ? "contacts" : `"${filter.status}" contacts`;
  return `${consent}${stage}`.trim();
}

const buildAudienceList = defineMarketingTool({
  name: "build_audience_list",
  description:
    "Create a lead list AND fill it from the course's EXISTING contacts in one step — e.g. every consent-confirmed contact, or everyone at a funnel stage. Sends nothing; reversible (revert removes the list). Use consent 'confirmed' for a mailable audience.",
  params: z.object({
    name: z.string().min(1).max(120),
    filter: AudienceFilterSchema,
  }),
  reversibility: "reversible",
  actionKind: "build_audience_list",
  async execute(args, ctx) {
    const matches = await matchAudience(ctx, args.filter);
    if (matches.length === 0) {
      throw new MarketingToolError(
        `No existing contacts match (${filterLabel(args.filter)}). Check get_subscriber_segments / list the audience first.`
      );
    }
    const { data: list, error } = await ctx.supabase
      .from("lead_list")
      .insert({
        course_id: ctx.courseId,
        campaign_id: ctx.campaignId,
        name: args.name,
        source_type: "custom",
        // A list built purely from confirmed contacts IS consent-confirmed at
        // birth; anything looser stays false until every member confirms.
        consent_confirmed: args.filter.consent === "confirmed",
      })
      .select("id")
      .single();
    if (error || !list) throw new MarketingToolError(`build_audience_list: ${error?.message}`);
    const { error: me } = await ctx.supabase
      .from("lead_list_member")
      .upsert(
        matches.map((m) => ({ list_id: list.id, subscriber_id: m.id })),
        { onConflict: "list_id,subscriber_id" }
      );
    if (me) throw new MarketingToolError(`build_audience_list(members): ${me.message}`);
    const eligible = matches.filter((m) => m.consent_status === "confirmed").length;
    return {
      summary: `Created "${args.name}" with ${matches.length} ${filterLabel(args.filter)} (${eligible} eligible to email now).`,
      data: { listId: list.id, added: matches.length, eligible },
      target: { entity: "lead_list", id: list.id },
    };
  },
});

const addLeadsToList = defineMarketingTool({
  name: "add_leads_to_list",
  description:
    "Add EXISTING course contacts to a lead list — by filter (consent state + funnel stage) or by explicit subscriber ids. Already-members are skipped. Sends nothing; reversible (revert restores the exact prior membership).",
  params: z.object({
    listId: z.string().min(1),
    filter: AudienceFilterSchema.nullable().describe("match contacts by consent + funnel stage; null when passing explicit ids"),
    subscriberIds: z.array(z.string().min(1)).max(2000).nullable().describe("explicit contacts to add; null when using the filter"),
  }),
  reversibility: "reversible",
  actionKind: "add_leads_to_list",
  existingTarget(args) {
    return { entity: "lead_list", id: args.listId };
  },
  async execute(args, ctx) {
    if (args.filter === null && (args.subscriberIds?.length ?? 0) === 0) {
      throw new MarketingToolError("Provide a filter or at least one subscriberId.");
    }
    const list = await loadLeadList(ctx.supabase, args.listId);
    if (!list) throw new MarketingToolError(`Lead list ${args.listId} not found`);

    let candidates: { id: string }[];
    if (args.filter) {
      candidates = await matchAudience(ctx, args.filter);
    } else {
      // Explicit ids — only accept contacts that belong to THIS course.
      const { data } = await ctx.supabase
        .from("subscriber")
        .select("id")
        .eq("course_id", ctx.courseId)
        .in("id", args.subscriberIds ?? []);
      candidates = data ?? [];
    }
    const existing = new Set(await listLeadListMemberIds(ctx.supabase, args.listId));
    const fresh = candidates.filter((c) => !existing.has(c.id));
    if (fresh.length) {
      const { error } = await ctx.supabase
        .from("lead_list_member")
        .upsert(
          fresh.map((c) => ({ list_id: args.listId, subscriber_id: c.id })),
          { onConflict: "list_id,subscriber_id" }
        );
      if (error) throw new MarketingToolError(`add_leads_to_list: ${error.message}`);
    }
    const skipped = candidates.length - fresh.length;
    return {
      summary: `Added ${fresh.length} contact(s) to "${list.name}"${skipped ? ` (${skipped} already on it)` : ""}.`,
      data: { added: fresh.length, skipped },
      target: { entity: "lead_list", id: args.listId },
    };
  },
});

const removeLeadsFromList = defineMarketingTool({
  name: "remove_leads_from_list",
  description:
    "Remove contacts from a lead list (membership only — the contacts themselves are kept). Reversible (revert restores the exact prior membership).",
  params: z.object({
    listId: z.string().min(1),
    subscriberIds: z.array(z.string().min(1)).min(1).max(2000),
  }),
  reversibility: "reversible",
  actionKind: "remove_leads_from_list",
  existingTarget(args) {
    return { entity: "lead_list", id: args.listId };
  },
  async execute(args, ctx) {
    const list = await loadLeadList(ctx.supabase, args.listId);
    if (!list) throw new MarketingToolError(`Lead list ${args.listId} not found`);
    const { error } = await ctx.supabase
      .from("lead_list_member")
      .delete()
      .eq("list_id", args.listId)
      .in("subscriber_id", args.subscriberIds);
    if (error) throw new MarketingToolError(`remove_leads_from_list: ${error.message}`);
    return {
      summary: `Removed ${args.subscriberIds.length} contact(s) from "${list.name}".`,
      data: { removed: args.subscriberIds.length },
      target: { entity: "lead_list", id: args.listId },
    };
  },
});

/* ─────────────────────── irreversible: consent confirmation ─────────────── */

/** The one consent-confirmation email — shared by the single + bulk tools so
 *  both send the identical one-time, non-marketing message. */
async function deliverConsentEmail(
  ctx: MarketingToolContext,
  sub: { id: string; email: string },
  courseTitle: string | null
): Promise<void> {
  const url = consentConfirmUrl(sub.id);
  await ctx.services.email.send({
    to: sub.email,
    subject: `Please confirm: receive emails about ${courseTitle ?? "this course"}?`,
    body: {
      blocks: [
        { kind: "paragraph", text: `Someone added ${sub.email} to a mailing list for ${courseTitle ?? "a course"}. If that was you, please confirm — this is a one-time, non-marketing message.` },
        { kind: "button", label: "Yes, send me course emails", href: url },
      ],
    },
    unsubscribeUrl: url,
    meta: { transactional: true, subscriberId: sub.id },
  });
  await ctx.supabase.from("subscriber").update({ consent_requested_at: ctx.services.clock.now() }).eq("id", sub.id);
}

const sendConsentConfirmation = defineMarketingTool({
  name: "send_consent_confirmation",
  description:
    "Send a one-time, non-marketing opt-in confirmation email to a pending imported contact (double opt-in). Rate-limited to once per contact. Irreversible (reaches a real inbox) — requires approval.",
  params: z.object({ subscriberId: z.string().min(1) }),
  reversibility: "irreversible",
  actionKind: "send_consent_confirmation",
  async execute(args, ctx) {
    const { data: sub } = await ctx.supabase
      .from("subscriber")
      .select("id,email,consent_status,consent_requested_at")
      .eq("id", args.subscriberId)
      .maybeSingle();
    if (!sub) throw new MarketingToolError(`Subscriber ${args.subscriberId} not found`);
    if (sub.consent_status !== "pending") {
      throw new MarketingToolError(`Subscriber consent is "${sub.consent_status}", not pending — nothing to confirm.`);
    }
    if (sub.consent_requested_at) {
      throw new MarketingToolError("A confirmation email was already sent to this contact (rate-limited to once).");
    }

    if (!ctx.approved) {
      return {
        summary: `Send a one-time opt-in confirmation to ${sub.email}.`,
        approvalPreview: { to: sub.email, effectLabel: `send to ${sub.email}` },
      };
    }

    const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
    await deliverConsentEmail(ctx, sub, course?.title ?? null);
    return { summary: `Sent a confirmation email to ${sub.email}.`, data: { sent: 1 } };
  },
});

const sendConsentConfirmations = defineMarketingTool({
  name: "send_consent_confirmations",
  description:
    "Send the one-time opt-in confirmation email to EVERY pending, not-yet-asked contact in a lead list (double opt-in, bulk). One approval covers the batch; already-asked or already-confirmed contacts are skipped. Irreversible (reaches real inboxes) — requires approval.",
  params: z.object({ listId: z.string().min(1) }),
  reversibility: "irreversible",
  actionKind: "send_consent_confirmations",
  async execute(args, ctx) {
    const list = await loadLeadList(ctx.supabase, args.listId);
    if (!list) throw new MarketingToolError(`Lead list ${args.listId} not found`);
    const memberIds = await listLeadListMemberIds(ctx.supabase, args.listId);
    const { data: members } = memberIds.length
      ? await ctx.supabase
          .from("subscriber")
          .select("id,email,consent_status,consent_requested_at")
          .in("id", memberIds)
      : { data: [] as { id: string; email: string; consent_status: string; consent_requested_at: string | null }[] };
    const due = (members ?? []).filter((m) => m.consent_status === "pending" && !m.consent_requested_at);

    if (due.length === 0) {
      throw new MarketingToolError(
        `No contacts in "${list.name}" need a confirmation — everyone is either confirmed, lapsed, or already asked (one ask per contact).`
      );
    }

    if (!ctx.approved) {
      return {
        summary: `Send the opt-in confirmation to ${due.length} pending contact(s) in "${list.name}".`,
        approvalPreview: {
          count: due.length,
          to: due.slice(0, 10).map((m) => m.email),
          effectLabel: `send to ${due.length} contact${due.length === 1 ? "" : "s"}`,
        },
      };
    }

    const course = await loadCourseMarketingContext(ctx.supabase, ctx.courseId);
    for (const sub of due) {
      await deliverConsentEmail(ctx, sub, course?.title ?? null);
    }
    return { summary: `Sent ${due.length} confirmation email(s) for "${list.name}".`, data: { sent: due.length } };
  },
});

export const leadTools = [
  getLeadList,
  listLeadListsTool,
  validateLeadConsent,
  getLeadSegmentTool,
  getLeadProfileTool,
  createLeadList,
  importLeads,
  buildAudienceList,
  addLeadsToList,
  removeLeadsFromList,
  sendConsentConfirmation,
  sendConsentConfirmations,
];

export { engagementScore };
export const CONSENT_CONFIRMATION_TEXT = REQUIRED_CONSENT_TEXT;
