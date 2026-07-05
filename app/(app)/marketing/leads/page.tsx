/**
 * Leads (Screen 8) — named lists with computed eligible counts, the consent-
 * gated import, and the full contact table with lifecycle status, consent
 * state, and the read-time engagement score (opens ≈ approximate — MPP).
 */

import Link from "next/link";
import { ArrowLeft, MailQuestion, ShieldCheck, Upload } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { listPendingApprovals } from "@/lib/marketing/gate";
import { listLeadListsWithCounts, listSubscribersForCourse, selectCourseForAuthor } from "@/lib/marketing/persistence";
import { engagementScores } from "@/lib/marketing/segments";
import { createMarketingServices } from "@/lib/marketing/services/factory";
import { getMarketingTool, previewMarketingAction } from "@/lib/marketing/tools";
import { ListBuilder } from "@/components/marketing/ListBuilder";
import { LeadImport } from "./LeadImport";
import { ConsentApprovalStrip, SendConsentButton } from "./LeadConsentControls";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "slate" | "sky" | "amber" | "green" | "rose"> = {
  lead: "slate",
  subscribed: "sky",
  engaged: "amber",
  enrolled: "green",
  unsubscribed: "rose",
  bounced: "rose",
};

const CONSENT_TONE: Record<string, "green" | "amber" | "rose"> = {
  confirmed: "green",
  pending: "amber",
  lapsed: "rose",
};

const BUCKET_CLS: Record<string, string> = {
  hot: "bg-brand-50 text-brand-700 ring-brand-200",
  warm: "bg-amber-50 text-amber-700 ring-amber-100",
  cool: "bg-sky-50 text-sky-700 ring-sky-100",
  cold: "bg-stone-100 text-stone-500 ring-stone-200",
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { course: preferCourse } = await searchParams;
  const course = await selectCourseForAuthor(supabase, user!.id, preferCourse);

  if (!course) {
    return (
      <div className="mx-auto max-w-5xl p-6 lg:p-8">
        <PageHeader title="Leads" description="Create a course first." />
      </div>
    );
  }

  const [lists, subscribers, scores, pendingAll] = await Promise.all([
    listLeadListsWithCounts(supabase, course.id),
    listSubscribersForCourse(supabase, course.id),
    engagementScores(supabase, course.id),
    listPendingApprovals(supabase, course.id),
  ]);
  const services = createMarketingServices();
  const consentApprovals = await Promise.all(
    pendingAll
      .filter((a) => a.toolName === "send_consent_confirmation" || a.toolName === "send_consent_confirmations")
      .map(async (a) => ({
        actionId: a.id,
        toolName: a.toolName,
        summary: a.summary ?? "Send consent confirmation email(s).",
        preview: await previewMarketingAction(a, { supabase, ownerId: user!.id, services }),
        editableParams: getMarketingTool(a.toolName)?.editableParams ?? null,
        requestedBy: a.requestedBy,
      }))
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 lg:p-8">
      <Link href="/marketing" className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900">
        <ArrowLeft className="size-4" /> Marketing
      </Link>
      <PageHeader
        title="Leads"
        description={`Permission-based contacts for “${course.title}”.`}
      />

      {/* the 3-step flow, spelled out */}
      <ol className="flex flex-wrap gap-x-6 gap-y-2 rounded-2xl border border-stone-200/80 bg-white px-5 py-3.5 text-sm text-stone-600 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        <li className="flex items-center gap-2">
          <Upload className="size-4 text-brand-600" />
          <span>
            <b className="text-stone-800">1 · Import</b> contacts (they start <i>pending</i>)
          </span>
        </li>
        <li className="flex items-center gap-2">
          <MailQuestion className="size-4 text-brand-600" />
          <span>
            <b className="text-stone-800">2 · Ask them to confirm</b> — one opt-in email you approve
          </span>
        </li>
        <li className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-emerald-600" />
          <span>
            <b className="text-stone-800">3 · They click confirm</b> → eligible for campaigns (unasked contacts lapse in 30 days)
          </span>
        </li>
      </ol>

      <ConsentApprovalStrip approvals={consentApprovals} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          {/* one-step list building from existing contacts */}
          <ListBuilder
            courseId={course.id}
            contacts={subscribers.map((s) => ({ consentStatus: s.consentStatus, status: s.status }))}
            lists={lists.map((l) => ({ id: l.id, name: l.name }))}
          />

          {/* lists */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-stone-900">Lists</h2>
            {lists.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-stone-300 bg-white/60 p-6 text-center text-sm text-stone-500">
                No lists yet — create one with the import panel.
              </p>
            ) : (
              <div className="space-y-2">
                {lists.map((l) => (
                  <div key={l.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-stone-900">{l.name}</p>
                      <p className="text-xs text-stone-500">{l.sourceType.replace(/_/g, " ")}</p>
                    </div>
                    <span className="text-sm text-stone-600">
                      <b className="text-emerald-700">{l.eligibleLeads}</b>/{l.totalLeads} eligible
                    </span>
                    {l.consentConfirmed ? <Badge tone="green">Consent confirmed</Badge> : <Badge tone="amber">Consent pending</Badge>}
                    <SendConsentButton courseId={course.id} listId={l.id} awaiting={l.awaitingConsentRequest} />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* contacts table */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-stone-900">Contacts ({subscribers.length})</h2>
            <div className="overflow-x-auto rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50/60 text-left font-mono text-[10px] uppercase tracking-[0.1em] text-stone-400">
                    <th className="px-4 py-2.5 font-medium">Email</th>
                    <th className="px-4 py-2.5 font-medium">Source</th>
                    <th className="px-4 py-2.5 font-medium">Consent</th>
                    <th className="px-4 py-2.5 font-medium">Stage</th>
                    <th className="px-4 py-2.5 font-medium" title="opens×1 + clicks×3, 30-day half-life. Opens are approximate (mail-privacy prefetching).">
                      Engagement
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {subscribers.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-stone-400">
                        No contacts yet — import some, or capture them from your landing page.
                      </td>
                    </tr>
                  )}
                  {subscribers.slice(0, 200).map((s) => {
                    const score = scores.get(s.id);
                    return (
                      <tr key={s.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50/50">
                        <td className="px-4 py-2.5">
                          <Link href={`/marketing/leads/${s.id}`} className="font-medium text-brand-700 hover:text-brand-800">
                            {s.email}
                          </Link>
                          {s.name && <span className="ml-2 text-xs text-stone-400">{s.name}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-stone-500">{(s.source ?? "—").replace(/_/g, " ")}</td>
                        <td className="px-4 py-2.5">
                          <Badge tone={CONSENT_TONE[s.consentStatus] ?? "amber"}>{s.consentStatus}</Badge>
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge tone={STATUS_TONE[s.status] ?? "slate"} dot>
                            {s.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BUCKET_CLS[score?.bucket ?? "cold"]}`}>
                            {score?.bucket ?? "cold"} · {score?.score ?? 0}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {subscribers.length > 200 && <p className="text-xs text-stone-400">Showing the first 200 contacts.</p>}
          </section>
        </div>

        {/* import panel */}
        <LeadImport courseId={course.id} lists={lists.map((l) => ({ id: l.id, name: l.name }))} />
      </div>
    </div>
  );
}
