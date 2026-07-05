/**
 * Audience view — makes the subscriber funnel legible: each person's lifecycle
 * status, their active sequence enrollments (which touch they're on), and the
 * next scheduled sends. Plus dev controls to seed + advance the scheduler.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { createClient } from "@/lib/supabase/server";
import {
  listLeadListsWithCounts,
  listSubscribersForCourse,
  loadAudience,
  loadCampaignForCourse,
  selectCourseForAuthor,
} from "@/lib/marketing/persistence";
import { ListBuilder } from "@/components/marketing/ListBuilder";
import { AudienceControls } from "./AudienceControls";

export const dynamic = "force-dynamic";

const STAGES = ["lead", "subscribed", "engaged", "enrolled"] as const;
const STATUS_TONE: Record<string, "slate" | "sky" | "amber" | "green" | "rose"> = {
  lead: "slate",
  subscribed: "sky",
  engaged: "amber",
  enrolled: "green",
  unsubscribed: "rose",
  bounced: "rose",
};

export default async function AudiencePage({
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
        <PageHeader title="Audience" description="No course yet." />
      </div>
    );
  }

  const campaign = await loadCampaignForCourse(supabase, course.id);
  const [audience, subscribers, lists] = await Promise.all([
    campaign ? loadAudience(supabase, course.id) : Promise.resolve([]),
    listSubscribersForCourse(supabase, course.id),
    listLeadListsWithCounts(supabase, course.id),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 lg:p-8">
      <div>
        <Link href="/marketing" className="mb-3 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700">
          <ArrowLeft className="size-4" /> Marketing
        </Link>
        <PageHeader title="Audience" description={`Your mailing list for “${course.title}” and where each person sits in the funnel.`} />
      </div>

      <AudienceControls courseId={course.id} />

      <ListBuilder
        courseId={course.id}
        contacts={subscribers.map((s) => ({ consentStatus: s.consentStatus, status: s.status }))}
        lists={lists.map((l) => ({ id: l.id, name: l.name }))}
      />

      <div className="flex flex-wrap items-center gap-2 text-xs text-stone-400">
        Lifecycle:
        {STAGES.map((s, i) => (
          <span key={s} className="inline-flex items-center gap-2">
            <Badge tone={STATUS_TONE[s]}>{s}</Badge>
            {i < STAGES.length - 1 ? <span>→</span> : null}
          </span>
        ))}
      </div>

      {audience.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 p-10 text-center text-stone-500">
          No subscribers yet. Seed a test lead above, or publish a landing page and submit its form.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(68,48,28,0.05)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-100 text-left text-xs uppercase tracking-wide text-stone-400">
                <th className="px-4 py-2.5 font-medium">Subscriber</th>
                <th className="px-4 py-2.5 font-medium">Stage</th>
                <th className="px-4 py-2.5 font-medium">In sequence</th>
                <th className="px-4 py-2.5 font-medium">Next send</th>
              </tr>
            </thead>
            <tbody>
              {audience.map((a) => (
                <tr key={a.id} className="border-b border-stone-50 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-stone-800">{a.name ?? "—"}</div>
                    <div className="text-xs text-stone-400">{a.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONE[a.status] ?? "slate"} dot>
                      {a.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-stone-600">
                    {a.enrollments.length === 0
                      ? <span className="text-stone-400">—</span>
                      : a.enrollments.map((e, i) => (
                          <div key={i} className="text-xs">
                            {e.sequence} · touch {e.position + 1} <span className="text-stone-400">({e.status})</span>
                          </div>
                        ))}
                  </td>
                  <td className="px-4 py-3 text-xs text-stone-500">
                    {a.pending.length === 0 ? (
                      <span className="text-stone-400">—</span>
                    ) : (
                      <div>
                        <div className="text-stone-700">{a.pending[0].subject}</div>
                        <div className="text-stone-400">{new Date(a.pending[0].scheduledFor).toLocaleString()}</div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
