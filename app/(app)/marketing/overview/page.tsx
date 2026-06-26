/**
 * Marketing overview — the ACCOUNT-level view across all the creator's courses:
 * total distinct audience, aggregate funnel, a card per course (→ its per-course
 * hub), and the master mailing list. Per-course detail lives at /marketing.
 */

import Link from "next/link";
import { ArrowRight, Users } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { createClient } from "@/lib/supabase/server";
import { getAccountSummary } from "@/lib/marketing/analytics";
import { loadAudienceContacts } from "@/lib/marketing/persistence";

export const dynamic = "force-dynamic";

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">{label}</div>
      <div className="mt-1 text-3xl font-light text-brand-700 [font-family:var(--font-display)]">{value}</div>
    </div>
  );
}

export default async function MarketingOverviewPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const summary = await getAccountSummary(supabase, user!.id);
  const contacts = await loadAudienceContacts(supabase, user!.id, 50);
  const f = summary.funnel;

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6 lg:p-8">
      <PageHeader
        title="Marketing overview"
        description="Your whole audience and funnel across every course. Open a course to run its campaign."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Audience (people)" value={summary.totalContacts} />
        <Stat label="Page views" value={f.views} />
        <Stat label="Leads" value={f.leads} />
        <Stat label="Enrollments" value={f.enrollments} />
      </div>

      {/* Courses */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-stone-900">Courses</h2>
        {summary.courses.length === 0 ? (
          <p className="text-sm text-stone-400">No courses yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {summary.courses.map((c) => (
              <Link
                key={c.id}
                href={`/marketing?course=${c.id}`}
                className="group rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)] transition-all hover:border-brand-200 hover:shadow-md"
              >
                <div className="font-medium text-stone-900">{c.title}</div>
                <div className="mt-2 text-xs text-stone-500">
                  {c.funnel.views} views · {c.funnel.leads} leads · {c.funnel.enrollments} enrolled
                </div>
                <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-600 transition-all group-hover:gap-2">
                  Open campaign <ArrowRight className="size-3.5" />
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Master mailing list */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
          <Users className="size-4 text-brand-500" /> Mailing list · {summary.totalContacts} contacts
        </h2>
        {contacts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 p-10 text-center text-stone-500">
            No contacts yet. Publish a landing page and capture leads, or seed one from a course’s Audience page.
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-100 text-left text-xs uppercase tracking-wide text-stone-400">
                  <th className="px-4 py-2.5 font-medium">Contact</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-b border-stone-50 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium text-stone-800">{c.name ?? "—"}</div>
                      <div className="text-xs text-stone-400">{c.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      {c.unsubscribedAt ? <Badge tone="rose">unsubscribed</Badge> : <Badge tone="green" dot>subscribed</Badge>}
                    </td>
                    <td className="px-4 py-3 text-xs text-stone-400">{new Date(c.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
