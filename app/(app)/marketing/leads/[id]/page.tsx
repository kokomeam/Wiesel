/**
 * Lead profile (Screen 8b / Amendment 4a) — the full picture of one lead:
 * event timeline (newest first), lifecycle stage (displayed from the reducer's
 * materialized state, never re-derived here), source + consent audit record,
 * per-campaign engagement, the read-time engagement score, and suppression
 * state. Read-only in MVP except consent-confirmation request + remove.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Flame, MailQuestion, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { createClient } from "@/lib/supabase/server";
import { loadLeadProfile } from "@/lib/marketing/segments";
import { loadSubscriberRow } from "@/lib/marketing/persistence";
import { LeadProfileActions } from "./LeadProfileActions";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "slate" | "sky" | "amber" | "green" | "rose"> = {
  lead: "slate",
  subscribed: "sky",
  engaged: "amber",
  enrolled: "green",
  unsubscribed: "rose",
  bounced: "rose",
};

const BUCKET_CLS: Record<string, string> = {
  hot: "bg-brand-50 text-brand-700 ring-brand-200",
  warm: "bg-amber-50 text-amber-700 ring-amber-100",
  cool: "bg-sky-50 text-sky-700 ring-sky-100",
  cold: "bg-stone-100 text-stone-500 ring-stone-200",
};

const EVENT_LABEL: Record<string, string> = {
  page_view: "Viewed the landing page",
  form_submit: "Submitted the signup form",
  free_lesson_capture: "Claimed the free lesson",
  email_sent: "Email sent",
  email_delivered: "Email delivered",
  email_open: "Opened an email (approximate)",
  email_click: "Clicked a link",
  email_bounce: "Email bounced",
  email_unsubscribe: "Unsubscribed",
  spam_complaint: "Marked as spam",
  consent_confirmed: "Confirmed consent (double opt-in)",
  enrollment: "Enrolled in the course",
};

export default async function LeadProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const [profile, row] = await Promise.all([loadLeadProfile(supabase, id), loadSubscriberRow(supabase, id)]);
  if (!profile || !row) notFound();

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6 lg:p-8">
      <Link href="/marketing/leads" className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900">
        <ArrowLeft className="size-4" /> Leads
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[1.7rem] font-light tracking-tight text-stone-900 [font-family:var(--font-display)]">{profile.email}</h1>
          {profile.name && <p className="text-sm text-stone-500">{profile.name}</p>}
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset ${BUCKET_CLS[profile.engagement.bucket]}`}>
          <Flame className="size-3.5" /> {profile.engagement.bucket} · {profile.engagement.score}
        </span>
        <Badge tone={STATUS_TONE[profile.lifecycleStatus] ?? "slate"} dot>
          {profile.lifecycleStatus}
        </Badge>
      </div>

      {profile.suppressed && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <ShieldAlert className="size-4" /> Suppressed ({profile.suppressionReason}) — no campaign can email this contact.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* consent audit record */}
        <div className="rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">Source & consent record</p>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Source</dt>
              <dd className="text-stone-800">{(profile.source ?? "—").replace(/_/g, " ")}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-500">Consent status</dt>
              <dd>
                <Badge tone={profile.consentStatus === "confirmed" ? "green" : profile.consentStatus === "pending" ? "amber" : "rose"}>{profile.consentStatus}</Badge>
              </dd>
            </div>
            {profile.consentText && (
              <div>
                <dt className="text-stone-500">Consent text shown</dt>
                <dd className="mt-1 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">{profile.consentText}</dd>
              </div>
            )}
            {profile.consentRequestedAt && (
              <div className="flex justify-between gap-4">
                <dt className="text-stone-500">Confirmation requested</dt>
                <dd className="text-stone-800">{new Date(profile.consentRequestedAt).toLocaleDateString()}</dd>
              </div>
            )}
          </dl>
          {profile.consentStatus === "pending" && !profile.consentRequestedAt && (
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <MailQuestion className="mt-0.5 size-4 shrink-0" />
              <span>This imported contact hasn’t confirmed consent — request a one-time opt-in confirmation below.</span>
            </div>
          )}
          <LeadProfileActions
            courseId={row.courseId}
            subscriberId={profile.subscriberId}
            consentStatus={profile.consentStatus}
            confirmationRequested={!!profile.consentRequestedAt}
          />
        </div>

        {/* per-campaign engagement */}
        <div className="rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">Engagement by campaign</p>
          {profile.perCampaign.length === 0 ? (
            <p className="mt-3 text-sm text-stone-400">No emails received yet.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm text-stone-700">
              {profile.perCampaign.map((c, i) => (
                <li key={c.campaignId ?? i} className="flex items-center justify-between gap-3">
                  <span className="truncate text-stone-500">{c.campaignId ? `Campaign ${i + 1}` : "Broadcasts"}</span>
                  <span className="shrink-0 font-mono text-xs">
                    {c.received} received · {c.opened} opened<span className="text-stone-400">*</span> · {c.clicked} clicked
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-stone-400">* Opens are approximate — inflated by mail-privacy prefetching. Clicks are the reliable signal.</p>
        </div>
      </div>

      {/* timeline */}
      <div className="rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">Timeline ({profile.timeline.length} events, newest first)</p>
        {profile.timeline.length === 0 ? (
          <p className="mt-3 text-sm text-stone-400">No events yet.</p>
        ) : (
          <ol className="mt-3 space-y-0">
            {profile.timeline.slice(0, 100).map((e, i) => (
              <li key={i} className="relative flex gap-3 border-l-2 border-stone-100 pb-3 pl-4 last:pb-0">
                <span className="absolute -left-[5px] top-1.5 size-2 rounded-full bg-brand-300" />
                <span className="text-sm text-stone-700">{EVENT_LABEL[e.type] ?? e.type}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-stone-400">{new Date(e.occurredAt).toLocaleString()}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
