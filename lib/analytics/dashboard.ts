/**
 * Server-side data access for the creator analytics dashboard (Milestone 4).
 * Reads ONLY rollup tables (author-select RLS) and the two author-gated
 * definer RPCs — never raw learning_events scans (those are reserved for the
 * learner-detail timeline, which pages over an indexed path).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/lib/database.types";
import type { PublicationSnapshot } from "@/lib/course/publish/schemas";

type DB = SupabaseClient<Database>;

export type FunnelRow = Database["public"]["Tables"]["rollup_lesson_funnel"]["Row"];
export type QuestionStatsRow = Database["public"]["Tables"]["rollup_question_stats"]["Row"];
export type SlideDwellRow = Database["public"]["Tables"]["rollup_slide_dwell"]["Row"];
export type VideoRetentionRow = Database["public"]["Tables"]["rollup_video_retention"]["Row"];
export type LearnerFlagRow = Database["public"]["Tables"]["learner_flags"]["Row"];
export type RosterRow =
  Database["public"]["Functions"]["course_roster"]["Returns"][number];

/** Shape of the course_analytics_overview RPC's jsonb (validated — the RPC is
 *  ours, but a parse failure should be a loud 500, not a silent wrong chart). */
export const OverviewSchema = z.object({
  totalEnrollments: z.number(),
  activeEnrollments: z.number(),
  completedEnrollments: z.number(),
  active7d: z.number(),
  enrollmentsByDay: z.array(z.object({ day: z.string(), count: z.number() })),
});
export type OverviewData = z.infer<typeof OverviewSchema>;

export interface CourseAnalytics {
  overview: OverviewData;
  funnel: FunnelRow[];
  questionStats: QuestionStatsRow[];
  slideDwell: SlideDwellRow[];
  videoRetention: VideoRetentionRow[];
  flags: LearnerFlagRow[];
  roster: RosterRow[];
  /** Newest rollup computed_at (null = rollups never ran for this pub). */
  computedAt: string | null;
}

export async function loadCourseAnalytics(
  supabase: DB,
  courseId: string,
  publicationId: string
): Promise<CourseAnalytics> {
  const [funnel, questions, dwell, video, flags, overviewRes, rosterRes] =
    await Promise.all([
      supabase
        .from("rollup_lesson_funnel")
        .select("*")
        .eq("publication_id", publicationId)
        .order("lesson_order"),
      supabase
        .from("rollup_question_stats")
        .select("*")
        .eq("publication_id", publicationId),
      supabase
        .from("rollup_slide_dwell")
        .select("*")
        .eq("publication_id", publicationId),
      supabase
        .from("rollup_video_retention")
        .select("*")
        .eq("publication_id", publicationId),
      supabase.from("learner_flags").select("*").eq("course_id", courseId),
      supabase.rpc("course_analytics_overview", { cid: courseId }),
      supabase.rpc("course_roster", { cid: courseId }),
    ]);

  for (const res of [funnel, questions, dwell, video, flags, overviewRes, rosterRes]) {
    if (res.error) throw res.error;
  }

  const computedAt =
    (funnel.data ?? [])
      .map((r) => r.computed_at)
      .sort()
      .at(-1) ?? null;

  return {
    overview: OverviewSchema.parse(overviewRes.data),
    funnel: funnel.data ?? [],
    questionStats: questions.data ?? [],
    slideDwell: dwell.data ?? [],
    videoRetention: video.data ?? [],
    flags: flags.data ?? [],
    roster: rosterRes.data ?? [],
    computedAt,
  };
}

/* ───────────────── Snapshot lookups (titles for ids) ───────────────────── */

export interface SnapshotBlockInfo {
  id: string;
  type: string;
  title: string;
  lessonId: string;
  lessonTitle: string;
}

export interface SnapshotMaps {
  lessonTitles: Map<string, string>;
  blocks: Map<string, SnapshotBlockInfo>;
  /** questionId → prompt + owning block (quiz blocks only). */
  questions: Map<string, { prompt: string; blockId: string }>;
  /** choiceId → choice label, across all quiz questions (ids are unique). */
  choiceLabels: Map<string, string>;
  hasQuiz: boolean;
}

export function buildSnapshotMaps(snapshot: PublicationSnapshot): SnapshotMaps {
  const lessonTitles = new Map<string, string>();
  const blocks = new Map<string, SnapshotBlockInfo>();
  const questions = new Map<string, { prompt: string; blockId: string }>();
  const choiceLabels = new Map<string, string>();
  let hasQuiz = false;

  for (const courseModule of snapshot.modules) {
    for (const lesson of courseModule.lessons) {
      lessonTitles.set(lesson.id, lesson.title);
      for (const block of lesson.blocks) {
        blocks.set(block.id, {
          id: block.id,
          type: block.type,
          title: block.title ?? "",
          lessonId: lesson.id,
          lessonTitle: lesson.title,
        });
        if (block.type === "quiz") {
          hasQuiz = true;
          for (const q of block.questions) {
            questions.set(q.id, { prompt: q.prompt, blockId: block.id });
            if ("choices" in q && Array.isArray(q.choices)) {
              for (const c of q.choices) choiceLabels.set(c.id, c.text);
            }
          }
        }
      }
    }
  }
  return { lessonTitles, blocks, questions, choiceLabels, hasQuiz };
}

/** Render a distribution bucket (choiceId / 'a+b' / 'true' / raw text) as a
 *  human label using the snapshot's choice texts. */
export function bucketLabel(bucket: string, maps: SnapshotMaps): string {
  if (bucket === "(blank)") return "(blank)";
  const parts = bucket.split("+");
  const labeled = parts.map((p) => maps.choiceLabels.get(p) ?? p);
  return labeled.join(" + ");
}

/** The studio deep-link for a flagged row. Focus params are wired by
 *  StudioLoader (?lesson= selects the lesson, ?block= scrolls to the block). */
export function editorBlockHref(courseId: string, lessonId: string, blockId?: string): string {
  const base = `/studio?course=${courseId}&lesson=${lessonId}`;
  return blockId ? `${base}&block=${blockId}` : base;
}
