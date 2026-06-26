/**
 * Marketing Agent page — hosts the chat panel for the author's current course.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { selectCourseForAuthor } from "@/lib/marketing/persistence";
import { AgentPanel } from "@/components/marketing/agent/AgentPanel";

export const dynamic = "force-dynamic";

export default async function MarketingAgentPage({
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
      <div className="mx-auto max-w-3xl p-6 lg:p-8">
        <p className="text-stone-600">Create a course first to use the Marketing Agent.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-6 lg:p-8">
      <Link href="/marketing" className="mb-3 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-700">
        <ArrowLeft className="size-4" /> Marketing
      </Link>
      <h1 className="text-2xl font-light tracking-tight text-stone-900 [font-family:var(--font-display)]">
        Marketing Agent
      </h1>
      <p className="mb-4 mt-1 text-sm text-stone-500">
        Working on “{course.title}.” Generations stage for review; anything outward-facing waits for your approval.
      </p>
      <div className="min-h-0 flex-1">
        <AgentPanel courseId={course.id} />
      </div>
    </div>
  );
}
