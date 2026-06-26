/**
 * Email & sequences hub — every sequence, its schedule (what goes out when),
 * subjects, and per-touch send counts (who's been sent / who's queued). Click a
 * sequence to read the full emails + recipients.
 */

import Link from "next/link";
import { ArrowLeft, ArrowRight, Clock, Mail } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { createClient } from "@/lib/supabase/server";
import { loadCampaignForCourse, loadSequencesOverview, selectCourseForAuthor } from "@/lib/marketing/persistence";
import { isEmailConfigured } from "@/lib/marketing/services/factory";

export const dynamic = "force-dynamic";

export function fmtSchedule(t: { delaySeconds: number | null; triggerEvent: string | null }): string {
  const d = t.delaySeconds ?? 0;
  const delay = d === 0 ? "" : d % 86400 === 0 ? `+${d / 86400}d` : d % 3600 === 0 ? `+${d / 3600}h` : `+${Math.round(d / 60)}m`;
  if (t.triggerEvent) return `on ${t.triggerEvent}${delay ? ` ${delay}` : ""}`;
  return d === 0 ? "on signup" : delay;
}

export default async function SequencesPage({
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
        <PageHeader title="Email & sequences" description="No course yet." />
      </div>
    );
  }

  const campaign = await loadCampaignForCourse(supabase, course.id);
  const sequences = campaign ? await loadSequencesOverview(supabase, campaign.id) : [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 lg:p-8">
      <div>
        <Link href={`/marketing?course=${course.id}`} className="mb-3 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700">
          <ArrowLeft className="size-4" /> Marketing
        </Link>
        <PageHeader title="Email & sequences" description={`What “${course.title}” sends, when, and to whom.`} />
      </div>

      {!isEmailConfigured() ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Mock mode — sends are simulated (no real email). Add <code className="font-mono text-xs">RESEND_API_KEY</code> to send for real.
        </div>
      ) : null}

      {sequences.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 p-10 text-center text-stone-500">
          No sequences yet. Use <strong>Generate Kit</strong> on the Marketing hub to draft a launch sequence + a followup.
        </div>
      ) : (
        <div className="space-y-4">
          {sequences.map((seq) => (
            <Link
              key={seq.id}
              href={`/marketing/sequences/${seq.id}`}
              className="group block rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)] transition-all hover:border-brand-200 hover:shadow-md"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Mail className="size-4 text-brand-500" />
                <span className="font-medium text-stone-900">{seq.name}</span>
                <Badge tone={seq.kind === "time_launch" ? "sky" : "brand"}>
                  {seq.kind === "time_launch" ? "timed launch" : "event-triggered"}
                </Badge>
                <Badge tone={seq.status === "active" ? "green" : seq.status === "draft" ? "amber" : "slate"} dot>
                  {seq.status}
                </Badge>
                <span className="text-xs text-stone-400">{seq.enrolledCount} enrolled</span>
                <span className="flex-1" />
                <span className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 transition-all group-hover:gap-2">
                  Open <ArrowRight className="size-3.5" />
                </span>
              </div>
              <ol className="mt-4 space-y-1.5">
                {seq.touches.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 text-sm">
                    <span className="inline-flex w-24 shrink-0 items-center gap-1 font-mono text-[11px] text-brand-700">
                      <Clock className="size-3" /> {fmtSchedule(t)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-stone-700">{t.subject}</span>
                    <span className="shrink-0 text-xs text-stone-400">
                      {t.sent} sent{t.queued ? ` · ${t.queued} queued` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
