import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CourseGallery } from "@/components/editor/CourseGallery";
import { StudioLoader } from "@/components/editor/StudioLoader";
import { getPendingBlocks, getPendingNodes } from "@/lib/ai/changeSet";
import { courseDocFromRows } from "@/lib/course/persistence";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Creator Studio — WiseSel",
};

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string; lesson?: string; block?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login"); // layout already gates; satisfies the type

  const sp = await searchParams;

  // No explicit course → ALWAYS show the gallery (never auto-open or auto-create).
  // The author picks a course to open, or creates one (createNewCourse action).
  if (!sp.course) {
    const { data: courses } = await supabase
      .from("courses")
      .select("id, title, description, status, level, updated_at")
      .eq("author_id", user.id)
      .order("updated_at", { ascending: false });
    return <CourseGallery courses={courses ?? []} />;
  }

  const courseId = sp.course;

  // Load the requested course + its tree. RLS guarantees we only read our own
  // (or published-public) courses; a missing/forbidden id falls back to the
  // gallery.
  const { data: course } = await supabase
    .from("courses")
    .select("*")
    .eq("id", courseId)
    .maybeSingle();
  if (!course) {
    redirect("/studio"); // stale/forbidden ?course= — back to the gallery
  }

  const [
    { data: modules, error: modErr },
    { data: lessons, error: lessonErr },
    { data: blocks, error: blockErr },
    pendingBlocks,
    pendingNodes,
    openFindings,
  ] = await Promise.all([
    supabase.from("modules").select("*").eq("course_id", courseId),
    supabase.from("lessons").select("*").eq("course_id", courseId),
    supabase.from("blocks").select("*").eq("course_id", courseId),
    getPendingBlocks(supabase, courseId),
    getPendingNodes(supabase, courseId),
    // Open threshold-filed findings → the header badge + the agent panel's
    // "Review flagged issues" invite.
    supabase
      .from("agent_findings")
      .select("id", { count: "exact", head: true })
      .eq("course_id", courseId)
      .eq("status", "open"),
  ]);
  // A partial read failure must NOT hydrate a doc missing rows: the first autosave
  // would then orphan-delete those "missing" blocks/lessons course-wide. Fall back
  // to the gallery rather than build a lossy tree.
  if (modErr || lessonErr || blockErr) redirect("/studio");

  const doc = courseDocFromRows(course, modules ?? [], lessons ?? [], blocks ?? []);

  return (
    <StudioLoader
      initialDoc={doc}
      courseId={courseId}
      ownerId={user.id}
      pendingBlocks={pendingBlocks.map((p) => ({ blockId: p.blockId, changeSetId: p.changeSetId, evidence: p.evidence ?? null }))}
      pendingNodes={pendingNodes.map((p) => ({ nodeId: p.nodeId, nodeType: p.nodeType, changeSetId: p.changeSetId, op: p.op }))}
      focusLessonId={sp.lesson ?? null}
      focusBlockId={sp.block ?? null}
      openFindingsCount={openFindings.count ?? 0}
    />
  );
}
