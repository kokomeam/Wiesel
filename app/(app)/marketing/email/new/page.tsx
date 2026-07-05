/**
 * Create-campaign wizard (Screen 3) — goal → lead list & consent → sender →
 * brief & schedule. Server component loads the choices; the client wizard
 * collects everything and submits ONE server action (which routes each setup
 * step through the same gate as everything else).
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { listLeadListsWithCounts, listSenderIdentities, selectCourseForAuthor } from "@/lib/marketing/persistence";
import { CampaignWizard } from "./CampaignWizard";

export const dynamic = "force-dynamic";

export default async function NewCampaignPage({
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
      <div className="mx-auto max-w-4xl p-6 lg:p-8">
        <PageHeader title="Create campaign" description="Create a course first." />
      </div>
    );
  }

  const [lists, senders] = await Promise.all([
    listLeadListsWithCounts(supabase, course.id),
    listSenderIdentities(supabase, course.id),
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6 lg:p-8">
      <Link href="/marketing/email" className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900">
        <ArrowLeft className="size-4" /> Email Campaigns
      </Link>
      <PageHeader
        title="Create campaign"
        description={`For “${course.title}” — pick a goal, attach a consented list, set the sender, and the AI drafts the sequence.`}
      />
      <CampaignWizard
        courseId={course.id}
        courseTitle={course.title}
        lists={lists.map((l) => ({ id: l.id, name: l.name, totalLeads: l.totalLeads, eligibleLeads: l.eligibleLeads, consentConfirmed: l.consentConfirmed }))}
        senders={senders.map((s) => ({ id: s.id, fromName: s.fromName, fromEmail: s.fromEmail }))}
      />
    </div>
  );
}
