/**
 * Social Posts (Marketing Phase 1) — the generation screen + content queue.
 * Server-loads the author's course scope (source pickers), the existing queue,
 * and the voice profile (WITHOUT deriving — derivation happens on first
 * generate or when the sheet asks), then hands everything to the client view.
 * All mutations flow through the REST surface → the shared tool layer → the
 * gate (same three-surface architecture as the rest of the marketing suite).
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient } from "@/lib/supabase/server";
import {
  listAuthorCourses,
  selectCourseForAuthor,
} from "@/lib/marketing/persistence";
import { listBatches, listSocialPosts, loadSocialVoiceProfile } from "@/lib/marketing/social/repository";
import { SocialPostsView } from "@/components/marketing/social/SocialPostsView";

export const dynamic = "force-dynamic";

export default async function SocialPostsPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null; // the (app) layout redirects signed-out visitors

  const { course: coursePref } = await searchParams;
  const course = await selectCourseForAuthor(supabase, user.id, coursePref ?? null);
  const courses = await listAuthorCourses(supabase, user.id);

  if (!course) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <PageHeader title="Social Posts" description="Generate platform-ready drafts from real course content." />
        <p className="mt-6 text-sm text-stone-500">
          Create a course first — social posts are grounded in your actual course content.
        </p>
        <Link href="/studio" className="mt-4 inline-block text-sm font-medium text-brand-700 hover:underline">
          Open the studio →
        </Link>
      </div>
    );
  }

  const [{ posts }, batches, voiceProfile, modulesRes] = await Promise.all([
    listSocialPosts(supabase, {}, { limit: 100 }),
    listBatches(supabase),
    loadSocialVoiceProfile(supabase),
    supabase.from("modules").select("id,title,course_id").eq("course_id", course.id).order("order"),
  ]);
  const modules = modulesRes.data ?? [];
  const { data: lessons } = await supabase
    .from("lessons")
    .select("id,title,module_id")
    .eq("course_id", course.id)
    .order("order");

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href={`/marketing?course=${course.id}`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-stone-500 hover:text-stone-800"
        >
          <ArrowLeft className="size-3.5" /> Marketing
        </Link>
      </div>
      <PageHeader
        title="Social Posts"
        description="Generate platform-ready drafts from your real course content — then copy and post them yourself."
      />
      <div className="mt-6">
        <SocialPostsView
          course={course}
          courses={courses}
          modules={modules.map((m) => ({ id: m.id, title: m.title }))}
          lessons={(lessons ?? []).map((l) => ({ id: l.id, title: l.title, moduleId: l.module_id }))}
          initialPosts={posts}
          initialBatches={batches}
          initialVoiceProfile={voiceProfile}
        />
      </div>
    </div>
  );
}
