/**
 * Lesson Clips (Marketing Phase 1.5, M-E) — the clips screen: pick a lesson
 * with a ready video → find moments (ranked candidates with FR-9 layout
 * chips) → queue renders → copy the posting kit. Server-loads the course
 * scope, lessons-with-video, existing candidates/jobs/kits, and the usage
 * meter; the client view drives everything through the REST surface → the
 * shared tool layer → the gate.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { listAuthorCourses, selectCourseForAuthor } from "@/lib/marketing/persistence";
import { clipRenderConfig } from "@/lib/marketing/clips/constants";
import { costMinutesThisMonth, jobsCreatedToday, rowToRenderJob } from "@/lib/marketing/clips/render/jobs";
import { rowToCandidate } from "@/lib/marketing/clips/repository";
import { pickCurrentVideoRow } from "@/lib/marketing/clips/transcripts";
import { ClipsView } from "@/components/marketing/clips/ClipsView";

export const dynamic = "force-dynamic";

export default async function LessonClipsPage({
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
        <PageHeader title="Lesson Clips" description="Short vertical clips cut from your real lesson recordings." />
        <p className="mt-6 text-sm text-stone-500">
          Create a course with a recorded lesson first — clips are cut from your actual lesson videos.
        </p>
        <Link href="/studio" className="mt-4 inline-block text-sm font-medium text-brand-700 hover:underline">
          Open the studio →
        </Link>
      </div>
    );
  }

  const nowIso = new Date().toISOString();
  const cfg = clipRenderConfig();
  const [lessonsRes, videosRes, candidatesRes, jobsRes, postsRes, kitsRes, jobsToday, minutesMonth] =
    await Promise.all([
      supabase.from("lessons").select("id,title,module_id").eq("course_id", course.id).order("order"),
      supabase
        .from("video_assets")
        .select("lesson_id,duration_seconds,metadata,transcript_vtt,created_at")
        .eq("course_id", course.id)
        .eq("status", "ready"),
      supabase
        .from("clip_moment_candidate")
        .select("*")
        .eq("course_id", course.id)
        .neq("status", "dismissed")
        .order("created_at", { ascending: false })
        .order("rank"),
      supabase
        .from("clip_render_job")
        .select("*")
        .eq("course_id", course.id)
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("social_post")
        .select("id, clip_job_id, platform, body")
        .eq("post_type", "clip")
        .eq("course_id", course.id)
        .is("deleted_at", null),
      supabase.from("posting_kit").select("*").eq("course_id", course.id).eq("status", "active"),
      jobsCreatedToday(supabase, user.id, nowIso),
      costMinutesThisMonth(supabase, user.id, nowIso),
    ]);
  const { data: linkRows } = await supabase
    .from("short_link")
    .select("id, code")
    .eq("course_id", course.id);
  const codeByLinkId = new Map((linkRows ?? []).map((l) => [l.id, l.code]));

  // Lessons with a renderable (non-dual-track) ready video ≥ the span floor.
  // The label shows the lesson's CURRENT take — the SAME pick the transcript
  // and render paths make (newest ready captioned video), so the duration the
  // creator sees is the video clips will actually be cut from.
  const rowsByLesson = new Map<string, (typeof videosRes.data & object)[number][]>();
  for (const v of videosRes.data ?? []) {
    if (!v.lesson_id) continue;
    const list = rowsByLesson.get(v.lesson_id) ?? [];
    list.push(v);
    rowsByLesson.set(v.lesson_id, list);
  }
  const videoByLesson = new Map<string, number>();
  for (const [lessonId, rows] of rowsByLesson) {
    const current = pickCurrentVideoRow(rows);
    if (current?.duration_seconds) videoByLesson.set(lessonId, current.duration_seconds);
  }
  const lessons = (lessonsRes.data ?? [])
    .filter((l) => (videoByLesson.get(l.id) ?? 0) >= 20)
    .map((l) => ({ id: l.id, title: l.title, videoSeconds: Math.round(videoByLesson.get(l.id) ?? 0) }));

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
        title="Lesson Clips"
        description="Cut the most teachable moments of your lesson recordings into short vertical clips — then copy the kit and post them yourself."
      />
      <div className="mt-6">
        <ClipsView
          course={{ id: course.id, title: course.title }}
          courses={courses.map((c) => ({ id: c.id, title: c.title }))}
          lessons={lessons}
          initialCandidates={(candidatesRes.data ?? []).map((r) => rowToCandidate(r))}
          initialJobs={(jobsRes.data ?? []).map((r) => rowToRenderJob(r))}
          clipPosts={(postsRes.data ?? []).map((p) => ({
            id: p.id,
            clipJobId: p.clip_job_id,
            platform: p.platform,
            body: p.body,
          }))}
          kits={(kitsRes.data ?? []).map((k) => ({
            postId: k.post_id,
            caption: k.caption,
            hashtags: (k.hashtags as string[]) ?? [],
            commentKeyword: k.comment_keyword,
            disclosureLine: k.disclosure_line,
            shortCode: k.short_link_id ? (codeByLinkId.get(k.short_link_id) ?? null) : null,
          }))}
          usage={{
            jobsToday,
            jobsPerDay: cfg.jobsPerDay,
            minutesThisMonth: Math.round(minutesMonth * 10) / 10,
            minutesPerMonth: cfg.minutesPerMonth,
          }}
        />
      </div>
    </div>
  );
}
