/**
 * Marketing analytics dashboard — renders the funnel from the SINGLE event
 * stream via getAnalyticsSummary (the exact snapshot the agent observes). Pure
 * display; author-scoped reads.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { createClient } from "@/lib/supabase/server";
import { getAnalyticsSummary, queryAnalyticsEvents } from "@/lib/marketing/analytics";
import { selectCourseForAuthor } from "@/lib/marketing/persistence";
import type { SubscriberStatus } from "@/lib/marketing/types";

export const dynamic = "force-dynamic";

function pct(n: number | null): string {
  return n === null ? "—" : `${Math.round(n * 100)}%`;
}

function FunnelRow({
  label,
  value,
  base,
  rate,
}: {
  label: string;
  value: number;
  base: number;
  rate?: number | null;
}) {
  const width = base > 0 ? Math.max((value / base) * 100, value > 0 ? 4 : 0) : 0;
  return (
    <div className="grid grid-cols-[130px_1fr_92px] items-center gap-3 text-sm sm:grid-cols-[160px_1fr_104px]">
      <span className="font-medium text-stone-600">{label}</span>
      <div className="h-7 overflow-hidden rounded-lg bg-stone-100">
        <div
          className="brand-gradient flex h-7 items-center rounded-lg px-2.5 text-xs font-medium text-white"
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="text-right font-mono text-xs text-stone-700">
        {value.toLocaleString()}
        {rate !== undefined ? <span className="ml-1 text-stone-400">{pct(rate)}</span> : null}
      </span>
    </div>
  );
}

const STATUS_ORDER: SubscriberStatus[] = [
  "lead",
  "subscribed",
  "engaged",
  "enrolled",
  "unsubscribed",
  "bounced",
];

export default async function MarketingAnalyticsPage({
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
        <PageHeader title="Marketing analytics" description="No course yet." />
      </div>
    );
  }

  const summary = await getAnalyticsSummary(supabase, course.id);
  const recent = await queryAnalyticsEvents(supabase, course.id, { limit: 12 });
  const { funnel, rates } = summary;
  const base = Math.max(funnel.views, funnel.leads, 1);

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6 lg:p-8">
      <div>
        <Link
          href="/marketing"
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700"
        >
          <ArrowLeft className="size-4" /> Marketing
        </Link>
        <PageHeader
          title="Marketing analytics"
          description={`One event stream for “${course.title}” — the same numbers the agent observes.`}
        />
      </div>

      {/* Funnel */}
      <section className="rounded-2xl border border-stone-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-stone-400">Funnel</h2>
        <div className="mt-5 space-y-3">
          <FunnelRow label="Page views" value={funnel.views} base={base} />
          <FunnelRow label="Leads" value={funnel.leads} base={base} rate={rates.viewToLead} />
          <FunnelRow label="Email opens" value={funnel.emailOpens} base={base} rate={rates.openRate} />
          <FunnelRow label="Email clicks" value={funnel.emailClicks} base={base} rate={rates.clickRate} />
          <FunnelRow label="Enrollments" value={funnel.enrollments} base={base} rate={rates.leadToEnroll} />
        </div>
        {funnel.views === 0 && funnel.leads === 0 ? (
          <p className="mt-5 text-sm text-stone-400">
            No events yet. Publish a landing page and share its link — views and leads will appear here.
          </p>
        ) : null}
      </section>

      {/* Subscribers by status */}
      <section className="rounded-2xl border border-stone-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-stone-400">
          Subscribers by status · {summary.totalSubscribers} total
        </h2>
        <div className="mt-4 flex flex-wrap gap-2">
          {STATUS_ORDER.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-sm"
            >
              <span className="text-stone-600">{s}</span>
              <span className="font-mono text-xs font-semibold text-stone-900">
                {summary.subscribersByStatus[s]}
              </span>
            </span>
          ))}
        </div>
      </section>

      {/* Recent events */}
      <section className="rounded-2xl border border-stone-200/80 bg-white p-6 shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-stone-400">Recent events</h2>
        {recent.length === 0 ? (
          <p className="mt-4 text-sm text-stone-400">No events recorded yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-stone-100">
            {recent.map((e) => (
              <li key={e.id} className="flex items-center gap-3 py-2.5 text-sm">
                <Badge tone="slate">{e.type}</Badge>
                {e.source ? <span className="text-xs text-stone-400">{e.source}</span> : null}
                <span className="flex-1" />
                <span className="font-mono text-xs text-stone-400">
                  {new Date(e.occurredAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
