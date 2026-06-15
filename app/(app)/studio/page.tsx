import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StudioLoader } from "@/components/editor/StudioLoader";
import { courseDocFromRows, defaultCourseTheme } from "@/lib/course/persistence";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/database.types";

export const metadata: Metadata = {
  title: "Creator Studio — CourseGen Pro",
};

/** Insert a brand-new empty course for this author and return its id. */
async function createEmptyCourse(
  supabase: Awaited<ReturnType<typeof createClient>>,
  authorId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("courses")
    .insert({
      author_id: authorId,
      title: "Untitled course",
      plan: { outcomes: [], prerequisites: [] } as Json,
      theme: defaultCourseTheme() as unknown as Json,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Could not create course");
  return data.id;
}

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login"); // layout already gates; satisfies the type

  const sp = await searchParams;

  // Resolve the course to edit: explicit ?course= → most-recent → bootstrap a
  // first empty one. (Explicit "New Course" goes through the server action.)
  let courseId = sp.course ?? null;
  if (!courseId) {
    const { data: latest } = await supabase
      .from("courses")
      .select("id")
      .eq("author_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    courseId = latest?.id ?? null;
  }
  if (!courseId) {
    courseId = await createEmptyCourse(supabase, user.id);
  }

  // Load the course + its tree. RLS guarantees we only read our own (or
  // published-public) courses; a missing/forbidden id falls back to a new one.
  const { data: course } = await supabase
    .from("courses")
    .select("*")
    .eq("id", courseId)
    .maybeSingle();
  if (!course) {
    redirect("/studio"); // stale ?course= — re-resolve to latest/new
  }

  const [{ data: modules }, { data: lessons }, { data: blocks }] = await Promise.all([
    supabase.from("modules").select("*").eq("course_id", courseId),
    supabase.from("lessons").select("*").eq("course_id", courseId),
    supabase.from("blocks").select("*").eq("course_id", courseId),
  ]);

  const doc = courseDocFromRows(course, modules ?? [], lessons ?? [], blocks ?? []);

  return <StudioLoader initialDoc={doc} courseId={courseId} ownerId={user.id} />;
}
