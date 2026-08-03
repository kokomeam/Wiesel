import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CourseGallery } from "@/components/editor/CourseGallery";
import { StudioLoader } from "@/components/editor/StudioLoader";
import { courseDocFromRows } from "@/lib/course/persistence";
import { loadStudioCourse } from "@/lib/editor/studioLoad";
import { createClient, getSessionUser } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Creator Studio — WiseSel",
};

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string; lesson?: string; block?: string }>;
}) {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) redirect("/login"); // layout already gates; satisfies the type

  const sp = await searchParams;

  // No explicit course → ALWAYS show the gallery (never auto-open or auto-create).
  // The author picks a course to open, or creates one (createNewCourse action).
  if (!sp.course) {
    // cover_image_url ships in migration 20260711000000 (course covers) —
    // a pre-migration DB errors on the column, so retry with the old list.
    const withCovers = await supabase
      .from("courses")
      .select("id, title, description, status, level, updated_at, cover_image_url")
      .eq("author_id", user.id)
      .order("updated_at", { ascending: false });
    if (!withCovers.error) return <CourseGallery courses={withCovers.data ?? []} />;
    const { data: courses } = await supabase
      .from("courses")
      .select("id, title, description, status, level, updated_at")
      .eq("author_id", user.id)
      .order("updated_at", { ascending: false });
    return <CourseGallery courses={courses ?? []} />;
  }

  const courseId = sp.course;

  // Load the requested course + its whole tree + pending change-set state +
  // the findings badge in ONE definer round trip (PERF-1 C1 — was 7 queries
  // over a 5-hop chain). The RPC author-gates internally: a missing/forbidden
  // id returns null → back to the gallery. Being a single statement it is
  // also atomic — the partial-read failure mode the old Promise.all defended
  // against (a lossy tree the first autosave would orphan-delete from)
  // cannot occur.
  const bundle = await loadStudioCourse(supabase, courseId);
  if (!bundle) {
    redirect("/studio"); // stale/forbidden ?course= — back to the gallery
  }

  const doc = courseDocFromRows(bundle.course, bundle.modules, bundle.lessons, bundle.blocks);

  return (
    <StudioLoader
      initialDoc={doc}
      courseId={courseId}
      ownerId={user.id}
      pendingBlocks={bundle.pendingBlocks.map((p) => ({ blockId: p.blockId, changeSetId: p.changeSetId, evidence: p.evidence }))}
      pendingNodes={bundle.pendingNodes.map((p) => ({ nodeId: p.nodeId, nodeType: p.nodeType, changeSetId: p.changeSetId, op: p.op }))}
      focusLessonId={sp.lesson ?? null}
      focusBlockId={sp.block ?? null}
      openFindingsCount={bundle.openFindings}
    />
  );
}
