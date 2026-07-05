/**
 * Email Campaigns list — every campaign, its goal, blueprint, and lifecycle
 * status at a glance (Screen 2). Status pills map 1:1 to the campaign state
 * machine; "Create campaign" opens the wizard.
 */

import Link from "next/link";
import { ArrowLeft, Mail, Plus } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { getBlueprint } from "@/lib/marketing/blueprints";
import { selectCourseForAuthor } from "@/lib/marketing/persistence";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "slate" | "sky" | "amber" | "green" | "rose" | "brand"> = {
  draft: "slate",
  generated: "sky",
  in_review: "amber",
  approved: "green",
  scheduled: "sky",
  sending: "brand",
  active: "brand",
  paused: "sky",
  completed: "green",
  cancelled: "rose",
  failed: "rose",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  generated: "Generated",
  in_review: "In Review",
  approved: "Approved",
  scheduled: "Scheduled",
  sending: "Sending",
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
};

export default async function EmailCampaignsPage({
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
        <PageHeader title="Email Campaigns" description="Create a course first — campaigns are grounded in a course's own content." />
      </div>
    );
  }

  const { data: campaigns } = await supabase
    .from("marketing_campaign")
    .select("id,name,goal,status,compliance_status,config,created_at")
    .eq("course_id", course.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 lg:p-8">
      <Link href="/marketing" className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900">
        <ArrowLeft className="size-4" /> Marketing
      </Link>
      <PageHeader
        title="Email Campaigns"
        description={`Goal-driven sequences for “${course.title}” — generated from the course, reviewed by you, sent automatically.`}
        actions={
          <Link
            href="/marketing/email/new"
            className="inline-flex h-9 items-center gap-2 rounded-full brand-gradient px-4 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
          >
            <Plus className="size-4" /> Create campaign
          </Link>
        }
      />

      {(campaigns ?? []).length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 p-10 text-center">
          <Mail className="mx-auto size-8 text-stone-300" />
          <p className="mt-3 text-sm text-stone-600">
            Your course is ready to sell. Pick a goal and the AI drafts a full email campaign you can review.
          </p>
          <Link
            href="/marketing/email/new"
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-full brand-gradient px-4 text-sm font-medium text-white shadow-sm shadow-brand-600/25 hover:opacity-95"
          >
            <Plus className="size-4" /> Create campaign
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {(campaigns ?? []).map((c) => {
            const blueprintKey = (c.config as { blueprintKey?: string } | null)?.blueprintKey;
            const blueprint = blueprintKey ? getBlueprint(blueprintKey) : c.goal ? getBlueprint(c.goal) : null;
            return (
              <Link
                key={c.id}
                href={`/marketing/email/${c.id}`}
                className="flex flex-wrap items-center gap-3 rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(68,48,28,0.05)] transition-all hover:border-brand-200 hover:shadow-md"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-stone-900">{c.name}</p>
                  <p className="mt-0.5 text-xs text-stone-500">
                    {blueprint ? `Goal · ${blueprint.label}` : c.goal ? `Goal · ${c.goal}` : "No goal set"}
                  </p>
                </div>
                {c.compliance_status === "blocked" && <Badge tone="rose">Compliance blocked</Badge>}
                <Badge tone={STATUS_TONE[c.status] ?? "slate"} dot>
                  {STATUS_LABEL[c.status] ?? c.status}
                </Badge>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
